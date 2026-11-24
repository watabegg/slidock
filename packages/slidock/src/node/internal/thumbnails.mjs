import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createServer } from './serve.mjs';
import { normalizeBasePath, stripBasePath, withBasePath } from './base-path.mjs';

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 675;
const MAX_PNG_BYTES = 10 * 1024 * 1024;
const SLIDE_SELECTOR = '.slidev-page[data-slidev-no="1"]';
const URL_RESERVED = new Set(":/?#[]@!$&'()*+,;=%");

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function splitSafeDeckId(id) {
  if (typeof id !== 'string') return null;
  const segments = id.split('/');
  if (
    !segments.length ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\\') ||
        // oxlint-disable-next-line no-control-regex -- Reject control characters at the URL/path boundary.
        /[\u0000-\u001f\u007f]/u.test(segment) ||
        [...segment].some((character) => URL_RESERVED.has(character)),
    )
  )
    return null;
  return segments;
}

function encodePathSegments(segments) {
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function decodePathSegments(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  try {
    return pathname
      .slice(1)
      .split('/')
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function sameSegments(actual, expected) {
  return (
    actual !== null &&
    actual.length === expected.length &&
    actual.every((segment, index) => segment === expected[index])
  );
}

function validateDecks(manifest, { allowEmpty = false, basePath = '/' } = {}) {
  if (!Array.isArray(manifest?.decks) || (!allowEmpty && manifest.decks.length === 0)) {
    throw new Error('manifest.json must contain a decks array');
  }

  const ids = new Set();
  return manifest.decks.map((deck, index) => {
    const id = deck?.id;
    const segments = splitSafeDeckId(id);
    if (!segments) {
      throw new Error(`manifest.json deck ${index + 1} has an invalid id`);
    }
    if (ids.has(id)) throw new Error(`manifest.json contains duplicate deck id: ${id}`);
    ids.add(id);

    if (typeof deck.entry !== 'string' || !Number.isInteger(deck.pages) || deck.pages < 1) {
      throw new Error(`manifest.json deck ${id} must include an entry and a positive pages count`);
    }
    const expectedEntry = withBasePath(basePath, `/${encodePathSegments(segments)}/1`);
    let entry;
    try {
      entry = new URL(deck.entry, 'http://slidev-lab.invalid');
    } catch (error) {
      throw new Error(`manifest.json deck ${id} has an invalid entry: ${error.message}`);
    }
    const localPathname = stripBasePath(entry.pathname, basePath);
    if (
      entry.origin !== 'http://slidev-lab.invalid' ||
      localPathname === null ||
      !sameSegments(decodePathSegments(localPathname), [...segments, '1'])
    ) {
      throw new Error(`manifest.json deck ${id} entry must be ${expectedEntry}`);
    }

    const src = withBasePath(basePath, `/thumbnails/${encodePathSegments(segments)}.png`);
    if (deck.thumbnail?.src !== undefined && deck.thumbnail.src !== src) {
      throw new Error(`manifest.json deck ${id} thumbnail src must be ${src}`);
    }
    return { id, segments, src };
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
    server.closeAllConnections?.();
  });
}

async function closeQuietly(resource) {
  try {
    await resource?.close();
  } catch {
    /* Preserve the generation error while still attempting cleanup. */
  }
}

export async function waitForRenderedSlide(page, id) {
  await page.locator(SLIDE_SELECTOR).waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(
    (selector) => {
      const slide = document.querySelector(selector);
      if (!slide) return false;
      const rect = slide.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    },
    SLIDE_SELECTOR,
    { timeout: 30_000 },
  );

  await page.waitForFunction(() => document.fonts.status === 'loaded', null, { timeout: 30_000 });
  await page.waitForFunction(() => [...document.images].every((image) => image.complete), null, {
    timeout: 30_000,
  });

  // CSS backgrounds do not appear in document.images, but are part of the slide.
  await page.evaluate(async (selector) => {
    const slide = document.querySelector(selector);
    const urls = new Set();
    for (const element of [slide, ...slide.querySelectorAll('*')]) {
      for (const pseudo of [null, '::before', '::after']) {
        const background = getComputedStyle(element, pseudo).backgroundImage;
        for (const match of background.matchAll(/url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/g)) {
          urls.add(match[1] ?? match[2] ?? match[3]);
        }
      }
    }
    await Promise.all(
      [...urls].map(
        (url) =>
          new Promise((accept, reject) => {
            const image = new Image();
            const timeout = setTimeout(
              () => reject(new Error(`Background image timed out: ${url}`)),
              30_000,
            );
            image.onload = () => {
              clearTimeout(timeout);
              image.decode().then(accept, reject);
            };
            image.onerror = () => {
              clearTimeout(timeout);
              reject(new Error(`Background image failed: ${url}`));
            };
            image.src = url;
          }),
      ),
    );
  }, SLIDE_SELECTOR);

  const state = await page.evaluate((selector) => {
    const slide = document.querySelector(selector);
    return {
      images: [...document.images].map((image) => ({
        src: image.currentSrc || image.src,
        complete: image.complete,
        width: image.naturalWidth,
      })),
      slideVisible: Boolean(slide && getComputedStyle(slide).display !== 'none'),
    };
  }, SLIDE_SELECTOR);

  if (!state.slideVisible) throw new Error(`deck ${id} first slide is not visible`);
  const brokenImages = state.images.filter((image) => !image.complete || image.width === 0);
  if (brokenImages.length) {
    throw new Error(
      `deck ${id} has image load errors: ${brokenImages.map((image) => image.src).join(', ')}`,
    );
  }
}

async function generateDeckThumbnail({
  browser,
  origin,
  root,
  deck,
  outputWidth,
  outputHeight,
  basePath,
}) {
  const context = await browser.newContext({
    viewport: { width: outputWidth, height: outputHeight },
  });
  try {
    const page = await context.newPage();
    const failures = [];
    page.on('pageerror', (error) => failures.push(`page error: ${error.message}`));
    page.on('requestfailed', (request) => {
      failures.push(
        `request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText || 'unknown error'})`,
      );
    });
    page.on('response', (response) => {
      if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${response.url()}`);
    });

    const routeSegments = [...deck.segments, '1'];
    const routePath = withBasePath(basePath, `/${encodePathSegments(routeSegments)}`);
    const route = new URL(routePath, origin);
    route.searchParams.set('embedded', 'true');
    route.searchParams.set('labThumbnail', 'true');
    const response = await page.goto(route.href, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    if (!response || response.status() >= 400) {
      throw new Error(
        `deck ${deck.id} first slide request failed${response ? ` with HTTP ${response.status()}` : ''}`,
      );
    }
    const localPathname = stripBasePath(new URL(page.url()).pathname, basePath);
    if (!sameSegments(decodePathSegments(localPathname), routeSegments)) {
      throw new Error(`deck ${deck.id} navigated to an unexpected route: ${page.url()}`);
    }

    await waitForRenderedSlide(page, deck.id);
    if (failures.length)
      throw new Error(`deck ${deck.id} has browser request errors: ${failures.join('; ')}`);

    const screenshot = await page.locator(SLIDE_SELECTOR).screenshot({
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    });
    if (screenshot.length > MAX_PNG_BYTES) {
      throw new Error(`deck ${deck.id} thumbnail exceeds ${MAX_PNG_BYTES} bytes`);
    }
    if (!screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`deck ${deck.id} did not produce a PNG thumbnail`);
    }
    const actualWidth = screenshot.readUInt32BE(16);
    const actualHeight = screenshot.readUInt32BE(20);
    if (actualWidth !== outputWidth || actualHeight !== outputHeight) {
      throw new Error(
        `deck ${deck.id} thumbnail is ${actualWidth}x${actualHeight}; expected ${outputWidth}x${outputHeight}`,
      );
    }

    const src = deck.src;
    const filename = `${deck.segments.at(-1)}.png`;
    const destination = resolve(root, 'thumbnails', ...deck.segments.slice(0, -1), filename);
    if (!isInside(root, destination))
      throw new Error(`deck ${deck.id} thumbnail path escapes the site root`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, screenshot);
    const file = await stat(destination);
    if (file.size !== screenshot.length)
      throw new Error(`deck ${deck.id} thumbnail was not fully written`);
    return {
      id: deck.id,
      src,
      width: outputWidth,
      height: outputHeight,
      asset: join('thumbnails', ...deck.segments.slice(0, -1), `${deck.segments.at(-1)}.png`)
        .split(sep)
        .join('/'),
    };
  } catch (error) {
    throw new Error(`thumbnail generation failed for deck ${deck.id}: ${error.message}`, {
      cause: error,
    });
  } finally {
    await closeQuietly(context);
  }
}

const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><rect width="1200" height="675" fill="#f1f5f9"/><path d="M0 505 330 255l210 160 170-130 490 350v40H0z" fill="#dbe5ee"/><circle cx="900" cy="170" r="58" fill="#dbe5ee"/></svg>\n';

function imageAsset(deckId, extension) {
  const segments = deckId.split('/');
  const last = segments.pop();
  return join('covers', ...segments, `${last}${extension}`)
    .split(sep)
    .join('/');
}

function assetUrl(asset, basePath) {
  return withBasePath(basePath, `/${asset.split('/').map(encodeURIComponent).join('/')}`);
}

/** Prepare every collection thumbnail and launch Chromium only for missing captures. */
export async function prepareBuildThumbnails({
  siteRoot,
  mode = 'auto',
  covers = {},
  outputWidth = DEFAULT_WIDTH,
  outputHeight = DEFAULT_HEIGHT,
  chromiumExecutable,
  allowEmpty = false,
  basePath: requestedBasePath,
} = {}) {
  if (!siteRoot) throw new Error('siteRoot is required');
  if (!isAbsolute(siteRoot)) throw new Error('siteRoot must be an absolute path');
  if (
    !Number.isInteger(outputWidth) ||
    outputWidth < 1 ||
    !Number.isInteger(outputHeight) ||
    outputHeight < 1
  ) {
    throw new Error('outputWidth and outputHeight must be positive integers');
  }
  if (chromiumExecutable !== undefined && !isAbsolute(chromiumExecutable)) {
    throw new Error('chromiumExecutable must be an absolute path');
  }
  if (mode !== 'auto' && mode !== 'none') throw new Error('mode must be auto or none');

  const root = resolve(siteRoot);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new Error(`could not read ${resolve(root, 'manifest.json')}: ${error.message}`, {
      cause: error,
    });
  }
  const basePath = normalizeBasePath(requestedBasePath ?? manifest.basePath);
  const decks = validateDecks(manifest, { allowEmpty, basePath });
  const results = [];
  const captures = [];
  for (const deck of decks) {
    const cover = Object.hasOwn(covers, deck.id) ? covers[deck.id] : undefined;
    if (cover) {
      const extension = extname(cover).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(extension))
        throw new Error(`deck ${deck.id} cover must be a PNG, JPEG, WebP, or SVG file`);
      const asset = imageAsset(deck.id, extension);
      const destination = resolve(root, asset);
      if (!isInside(root, destination))
        throw new Error(`deck ${deck.id} cover path escapes the site root`);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(cover, destination);
      results.push({
        id: deck.id,
        src: assetUrl(asset, basePath),
        width: outputWidth,
        height: outputHeight,
        asset,
      });
    } else if (mode === 'none') {
      const asset = join('thumbnails', ...deck.segments.slice(0, -1), `${deck.segments.at(-1)}.svg`)
        .split(sep)
        .join('/');
      const destination = resolve(root, asset);
      if (!isInside(root, destination))
        throw new Error(`deck ${deck.id} thumbnail path escapes the site root`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, PLACEHOLDER_SVG);
      results.push({
        id: deck.id,
        src: assetUrl(asset, basePath),
        width: outputWidth,
        height: outputHeight,
        asset,
      });
    } else {
      captures.push(deck);
    }
  }
  if (!captures.length) return results;

  const { chromium } = await import('playwright-core');
  const server = createServer(root, { basePath });
  let browser;

  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', rejectListen);
        resolveListen();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('temporary thumbnail server did not expose a TCP port');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
    });

    for (const deck of captures) {
      results.push(
        await generateDeckThumbnail({
          browser,
          origin,
          root,
          deck,
          outputWidth,
          outputHeight,
          basePath,
        }),
      );
    }
    return results;
  } finally {
    await closeQuietly(browser);
    await closeServer(server);
  }
}

export async function generateThumbnails(options = {}) {
  const results = await prepareBuildThumbnails(options);
  return results.map(({ asset: _asset, ...thumbnail }) => thumbnail);
}
