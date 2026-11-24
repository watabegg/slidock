import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright-chromium';
import { buildHub, devHub } from '../dist/node/index.js';
import { createServer } from '../dist/node/internal/serve.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const theme = dirname(require.resolve('@slidev/theme-apple-basic/package.json'));
const basePath = '/docs/slides/';

async function fixture(t) {
  await mkdir(join(repository, 'artifacts'), { recursive: true });
  const root = await mkdtemp(join(repository, 'artifacts/relative-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'slides');
  const decks = [];
  for (const [name, color] of [
    ['Apple Basic', '#234567'],
    ['Second', '#987654'],
  ]) {
    const folder = join(sourceRoot, name);
    await mkdir(join(folder, 'assets'), { recursive: true });
    for (const asset of ['background', 'left', 'right'])
      await writeFile(
        join(folder, 'assets', `${asset}.svg`),
        `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675"><rect width="1200" height="675" fill="${color}"/></svg>`,
      );
    const entry = join(folder, 'slides.md');
    await writeFile(entry, markdown(undefined, name, `../${name}/assets/background.svg`));
    decks.push({ id: `${name}/example`, entry });
  }
  return {
    baseDir: repository,
    dependencyRoot: repository,
    sourceRoot,
    outDir: join(root, 'site'),
    theme,
    decks,
    basePath,
    offline: false,
    thumbnails: 'none',
  };
}

function markdown(image = './assets/background.svg', name = 'Apple Basic', secondaryImage = image) {
  return `---
layout: intro-image
image: ${image}
defaults:
  imageBottomRight: ./assets/right.svg
fonts:
  webfonts: []
  sans: Arial
  mono: monospace
---
# Relative background

---
layout: intro-image
image: ${secondaryImage}
---
# Relative image

---
layout: 3-images
imageLeft: ../${name}/assets/left.svg
imageTopRight: ./assets/right.svg
---
`;
}

async function checkImages(page, origin, deck, colors) {
  const id = deck.id.split('/').map(encodeURIComponent).join('/');
  for (const [number, count] of [
    [1, 1],
    [2, 1],
    [3, 3],
  ]) {
    const expectedColor = typeof colors === 'string' ? colors : colors[number - 1];
    await page.goto(`${origin}${basePath}${id}/${number}`);
    const slide = page.locator(`.slidev-page[data-slidev-no="${number}"]`);
    await page.waitForFunction(
      ({ number, count }) => {
        const element = document.querySelector(`.slidev-page[data-slidev-no="${number}"]`);
        return (
          element &&
          [element, ...element.querySelectorAll('*')].filter((child) =>
            getComputedStyle(child).backgroundImage.includes('url('),
          ).length === count
        );
      },
      { number, count },
    );
    const urls = await slide.evaluate((element) =>
      [element, ...element.querySelectorAll('*')].flatMap((child) =>
        [...getComputedStyle(child).backgroundImage.matchAll(/url\("([^"]+)"\)/g)].map(
          (match) => match[1],
        ),
      ),
    );
    assert.equal(urls.length, count, `slide ${number} background count`);
    for (const url of urls) {
      assert(url.startsWith(`${origin}${basePath}`), `image must use mounted URL: ${url}`);
      const response = await page.request.get(url);
      assert.equal(response.status(), 200, url);
      assert((await response.text()).includes(expectedColor), `wrong deck asset: ${url}`);
      await page.evaluate(
        (url) =>
          new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = resolve;
            image.onerror = () => reject(new Error(`Image did not decode: ${url}`));
            image.src = url;
          }),
        url,
      );
    }
  }
}

for (const runtime of ['.', 'examples/slidev52']) {
  test(
    `relative frontmatter images render in a shared subpath build (${runtime})`,
    { timeout: 240_000 },
    async (t) => {
      const options = await fixture(t);
      options.dependencyRoot = join(repository, runtime);
      const result = await buildHub(options);
      assert.equal(result.diagnostics.groupSummary.length, 1);
      const server = createServer(options.outDir);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_EXECUTABLE,
      });
      try {
        const page = await browser.newPage();
        await page.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
        const failures = [];
        page.on('response', (response) => {
          if (response.status() >= 400) failures.push(response.url());
        });
        page.on('pageerror', (error) => failures.push(error.message));
        const origin = `http://127.0.0.1:${server.address().port}`;
        await checkImages(page, origin, options.decks[0], '#234567');
        await checkImages(page, origin, options.decks[1], '#987654');
        assert.deepEqual(failures, []);
      } finally {
        await browser.close();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );
}

test(
  'development resolves relative frontmatter images and updates their paths through HMR',
  { timeout: 180_000 },
  async (t) => {
    const options = await fixture(t);
    const server = await devHub({ ...options, port: 0 });
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE,
    });
    try {
      const page = await browser.newPage();
      await page.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
      const origin = new URL(server.url).origin;
      const failedImages = [];
      page.on('response', (response) => {
        if (response.status() >= 400 && response.request().resourceType() === 'image')
          failedImages.push(response.url());
      });
      await checkImages(page, origin, options.decks[0], '#234567');
      const entry = options.decks[0].entry;
      await page.goto(`${origin}${basePath}Apple%20Basic/example/2`);
      await page.locator('.slidev-page[data-slidev-no="2"]').waitFor({ state: 'visible' });
      const updated = './assets/updated.svg';
      await writeFile(
        join(dirname(entry), updated),
        (await readFile(join(dirname(entry), 'assets/background.svg'), 'utf8')).replace(
          '#234567',
          '#abcdef',
        ),
      );
      await writeFile(entry, markdown(updated));
      await page.waitForFunction(() =>
        document
          .querySelector('.slidev-page[data-slidev-no="2"] .intro-image')
          ?.getAttribute('style')
          ?.includes('updated.svg'),
      );
      await checkImages(page, origin, options.decks[0], ['#abcdef', '#abcdef', '#234567']);
      assert.deepEqual(failedImages, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test(
  'relative cover backgrounds render in generated subpath thumbnails',
  { timeout: 180_000 },
  async (t) => {
    const options = await fixture(t);
    const entry = options.decks[0].entry;
    await writeFile(
      entry,
      (await readFile(entry, 'utf8')).replace(
        'layout: intro-image\nimage:',
        'layout: cover\nbackground:',
      ),
    );
    const result = await buildHub({
      ...options,
      theme: dirname(require.resolve('@slidev/theme-default/package.json')),
      decks: [options.decks[0]],
      thumbnails: 'auto',
      chromiumExecutable: process.env.CHROMIUM_EXECUTABLE,
    });
    assert.equal(
      result.catalog.decks[0].thumbnail.src,
      `${basePath}thumbnails/Apple%20Basic/example.png`,
    );
    const png = await readFile(join(options.outDir, 'thumbnails/Apple Basic/example.png'));
    assert(png.length > 1000);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
  },
);
