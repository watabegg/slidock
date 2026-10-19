import { waitForRenderedSlide } from './thumbnails.mjs';
import { chromium } from 'playwright-chromium';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startSlidevDev, readDevDeck } from '@slidock/slidev-adapter/dev-runtime';
import { resolveRuntime } from '@slidock/slidev-adapter/runtime';
import { categoriesForDecks, encodeDeckPath, publicFrontmatter } from './catalog.mjs';

const prefix = '/__slidock_dev/';
const asFsUrl = (path) => `/@fs/${path.split('/').map(encodeURIComponent).join('/')}`;

export async function startDev(config, port) {
  const backends = [];
  let home;
  let browserPromise;
  let closed = false;
  let timer;
  let refresh = Promise.resolve();
  let captures = Promise.resolve();
  const thumbnails = new Map();
  const pendingFiles = new Set();
  async function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    await home?.close();
    await refresh.catch(() => {});
    await browserPromise?.then((browser) => browser.close()).catch(() => {});
    await Promise.all(backends.map((deck) => deck.server.close()));
  }
  try {
    const { cliRequire } = await resolveRuntime(config.dependencyRoot);
    const { createServer, searchForWorkspaceRoot } = await import(
      pathToFileURL(cliRequire.resolve('vite'))
    );
    const { default: vue } = await import(pathToFileURL(cliRequire.resolve('@vitejs/plugin-vue')));
    for (const deck of config.decks) {
      const profile = config.profiles?.[deck.profile] ?? config;
      const options = {
        entry: deck.entry,
        theme: profile.theme,
        dependencyRoot: profile.dependencyRoot,
      };
      const snapshot = await readDevDeck(options);
      const base = `/${encodeDeckPath(deck.id)}/`;
      const server = await startSlidevDev({ ...options, base: `/${deck.id}/` });
      const theme = JSON.parse(await readFile(join(profile.theme, 'package.json'), 'utf8'));
      backends.push({
        ...deck,
        base,
        options,
        snapshot,
        server,
        theme: `${theme.name}@${theme.version}`,
        version: 0,
      });
    }
    function catalogDeck(deck, index) {
      const revision = createHash('sha256')
        .update(JSON.stringify([deck.snapshot.sources, deck.version]))
        .digest('hex');
      return {
        id: deck.id,
        title: deck.snapshot.title || deck.id,
        entry: `${deck.base}1`,
        pages: deck.snapshot.pages,
        revision,
        categoryPath: deck.categoryPath,
        frontmatter: publicFrontmatter(deck.snapshot.headmatter),
        thumbnail: {
          src: `${prefix}thumbnail/${index}.png?revision=${revision}`,
          width: 640,
          height: 360,
        },
        runtimeVersion: deck.snapshot.runtimeVersion,
        theme: deck.theme,
        profile: deck.profile ?? 'default',
      };
    }
    const catalog = () => ({
      schemaVersion: 1,
      categories: categoriesForDecks(backends),
      decks: backends.map(catalogDeck),
    });
    function changed(file) {
      pendingFiles.add(resolve(file));
      clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...pendingFiles];
        pendingFiles.clear();
        refresh = refresh
          .then(async () => {
            if (closed) return;
            const changedDecks = backends.filter((deck) =>
              files.some(
                (file) =>
                  deck.snapshot.watchFiles.includes(file) ||
                  file.startsWith(`${dirname(deck.entry)}/`),
              ),
            );
            if (!changedDecks.length) return;
            for (const deck of changedDecks) {
              deck.snapshot = await readDevDeck(deck.options);
              deck.version++;
              home.watcher.add(deck.snapshot.watchFiles);
            }
            thumbnails.clear();
            home.ws.send({ type: 'custom', event: 'slidock:catalog', data: {} });
          })
          .catch((error) => {
            home.config.logger.error(error.stack || error.message);
            home.ws.send({
              type: 'error',
              err: { message: error.message, stack: error.stack || '' },
            });
          });
      }, 250);
    }
    async function thumbnail(index) {
      const deck = backends[index];
      if (!deck) return null;
      const key = catalogDeck(deck, index).revision;
      if (!thumbnails.has(key)) {
        const capture = captures.then(async () => {
          if (closed) throw new Error('Development server closed');
          browserPromise ??= chromium.launch({
            headless: true,
            executablePath: config.chromiumExecutable,
          });
          const browser = await browserPromise;
          const page = await browser.newPage({
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: 0.5,
          });
          try {
            await page.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
            await page.goto(`${deck.server.origin}${deck.base}1`, {
              waitUntil: 'domcontentloaded',
              timeout: 60_000,
            });
            await page
              .locator('.slidev-page[data-slidev-no="1"] .slidev-layout')
              .waitFor({ state: 'visible', timeout: 60_000 });
            await waitForRenderedSlide(page, deck.id);
            const slide = page.locator('.slidev-page[data-slidev-no="1"]');
            return await slide.screenshot({ timeout: 15_000 });
          } finally {
            await page.close();
          }
        });
        captures = capture.catch(() => {});
        thumbnails.set(key, capture);
        capture.catch(() => thumbnails.delete(key));
      }
      return thumbnails.get(key);
    }
    const proxy = Object.fromEntries(
      backends.map((deck) => [
        deck.base,
        {
          target: deck.server.origin,
          changeOrigin: true,
          ws: true,
          selfHandleResponse: true,
          configure(proxy) {
            proxy.on('proxyRes', (incoming, request, response) => {
              const headers = { ...incoming.headers, 'cache-control': 'no-store' };
              if (incoming.headers['content-type']?.includes('text/html')) {
                const chunks = [];
                incoming.on('data', (chunk) => chunks.push(chunk));
                incoming.on('end', () => {
                  const html = Buffer.concat(chunks)
                    .toString()
                    .replace(
                      '</body>',
                      `<script type="module" src="${prefix}navigation.js"></script></body>`,
                    );
                  delete headers['content-length'];
                  response.writeHead(incoming.statusCode ?? 200, headers);
                  response.end(html);
                });
              } else {
                response.writeHead(incoming.statusCode ?? 200, headers);
                incoming.pipe(response);
              }
            });
          },
        },
      ]),
    );
    home = await createServer({
      configFile: false,
      root: dirname(config.frontendEntry),
      cacheDir: join(config.outDir, '.vite-home'),
      appType: 'custom',
      plugins: [
        vue(),
        {
          name: 'slidock:dev',
          resolveId(id) {
            if (id === `${prefix}catalog.js`) return id;
          },
          load(id) {
            if (id === `${prefix}catalog.js`)
              return `if (import.meta.hot) import.meta.hot.on('slidock:catalog', () => { document.querySelector('vite-error-overlay')?.remove(); window.dispatchEvent(new Event('slidock:catalog-update')); });`;
          },
          configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
              const url = new URL(request.url, 'http://localhost');
              try {
                response.setHeader('cache-control', 'no-store');
                if (url.pathname === '/catalog.json') {
                  response.setHeader('content-type', 'application/json');
                  response.end(JSON.stringify(catalog()));
                } else if (url.pathname.startsWith(`${prefix}thumbnail/`)) {
                  const match = url.pathname.match(/\/thumbnail\/(\d+)\.png$/);
                  const bytes = match ? await thumbnail(Number(match[1])) : null;
                  response.statusCode = bytes ? 200 : 404;
                  response.setHeader('content-type', bytes ? 'image/png' : 'text/plain');
                  response.end(bytes ?? 'Not found');
                } else if (url.pathname === `${prefix}navigation.js`) {
                  response.setHeader('content-type', 'text/javascript');
                  response.end(
                    `import { mountNavigation } from ${JSON.stringify(asFsUrl(join(config.frontendRoot, 'navigation.ts')))};\nmountNavigation(${JSON.stringify(config.navigation)});`,
                  );
                } else if (url.pathname === '/' || url.pathname === '/index.html') {
                  const html = `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Slidock</title><link rel="icon" href="${asFsUrl(join(config.frontendRoot, 'assets/slidock.svg'))}"></head><body><div id="app"></div><script type="module" src="${asFsUrl(config.frontendEntry)}"></script><script type="module" src="${prefix}catalog.js"></script></body></html>`;
                  response.setHeader('content-type', 'text/html');
                  response.end(await server.transformIndexHtml('/', html));
                } else next();
              } catch (error) {
                if (closed) {
                  response.statusCode = 503;
                  response.end('Development server closed');
                } else next(error);
              }
            });
          },
        },
      ],
      server: {
        host: '127.0.0.1',
        port,
        strictPort: true,
        watch: { usePolling: true, interval: 200 },
        proxy,
        fs: {
          allow: [
            searchForWorkspaceRoot(config.sourceRoot),
            config.frontendRoot,
            dirname(config.frontendEntry),
          ],
        },
      },
    });
    home.watcher.add([config.sourceRoot, ...backends.flatMap((deck) => deck.snapshot.watchFiles)]);
    for (const event of ['change', 'add', 'unlink']) home.watcher.on(event, changed);
    await home.listen();
    return { url: home.resolvedUrls.local[0], close };
  } catch (error) {
    await close();
    throw error;
  }
}
