import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startSlidevDev, readDevDeck } from '@slidock/slidev-adapter/dev-runtime';
import { resolveRuntime } from '@slidock/slidev-adapter/runtime';
import { categoriesForDecks, encodeDeckPath, publicFrontmatter } from './catalog.mjs';
import { normalizeBasePath, stripBasePath, withBasePath } from './base-path.mjs';
import {
  createFrontendEntryPlugin,
  frontendEntryId,
  frontendEntryResolvedId,
  resolveFrontendVue,
} from './frontend-entry.mjs';
import { injectHomeConfig, injectSiteBase } from './home-config.mjs';
import { waitForRenderedSlide } from './thumbnails.mjs';

const prefix = '/__slidock_dev/';
const asFsUrl = (path) => `/@fs/${path.split('/').map(encodeURIComponent).join('/')}`;
const placeholder = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#e9edf5"/><stop offset="1" stop-color="#cbd6e8"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><path d="M0 290 170 145l106 98 93-72 271 189H0Z" fill="#8b9bb7" opacity=".35"/></svg>',
);
const mimeTypes = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function decodePath(pathname) {
  try {
    return pathname
      .split('/')
      .slice(1)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/** Match encoded deck routes by path segment, preferring the deepest matching ID. */
export function resolveDeckRoute(pathname, decks) {
  const segments = decodePath(pathname);
  if (!segments) return null;
  const ordered = [...decks].sort((left, right) => {
    const leftParts = left.id.split('/');
    const rightParts = right.id.split('/');
    return (
      rightParts.length - leftParts.length ||
      right.id.length - left.id.length ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    );
  });
  return (
    ordered.find((deck) => {
      const id = deck.id.split('/');
      return (
        segments.length > id.length && id.every((segment, index) => segments[index] === segment)
      );
    }) ?? null
  );
}

function isUnknownSlidePage(pathname) {
  const segments = decodePath(pathname);
  return Boolean(segments && segments.length > 1 && /^\d+$/u.test(segments.at(-1)));
}

function configForDeck(config, deck) {
  return config.profiles?.[deck.profile] ?? config;
}

function runtimeKey(config, deck) {
  const profile = configForDeck(config, deck);
  return JSON.stringify([deck.id, deck.entry, profile.theme, profile.dependencyRoot]);
}

function catalogInput(deck) {
  return JSON.stringify([
    deck.id,
    deck.title,
    deck.order,
    deck.categoryPath,
    deck.cover,
    deck.profile,
  ]);
}

async function readThemeLabel(profile) {
  const theme = JSON.parse(await readFile(join(profile.theme, 'package.json'), 'utf8'));
  return `${theme.name}@${theme.version}`;
}

async function createBackend(config, deck) {
  const profile = configForDeck(config, deck);
  const options = {
    entry: deck.entry,
    theme: profile.theme,
    dependencyRoot: profile.dependencyRoot,
  };
  const [snapshot, theme] = await Promise.all([readDevDeck(options), readThemeLabel(profile)]);
  const base = withBasePath(config.basePath, `/${deck.id}/`);
  const server = await startSlidevDev({ ...options, base });
  return {
    ...deck,
    base,
    options,
    snapshot,
    server,
    theme,
    version: 0,
    runtimeKey: runtimeKey(config, deck),
  };
}

function coversPath(deck) {
  return deck.cover ? resolve(deck.cover) : undefined;
}

function changedDeckFiles(deck, files) {
  const cover = coversPath(deck);
  return files.some(
    (file) =>
      deck.snapshot.watchFiles.includes(file) ||
      file === deck.entry ||
      file.startsWith(`${dirname(deck.entry)}/`) ||
      (cover !== undefined && file === cover),
  );
}

function thumbnailSource(deck, config, revision) {
  const id = encodeDeckPath(deck.id);
  const query = `?revision=${revision}`;
  if (deck.cover) {
    const extension = extname(deck.cover).toLowerCase();
    return withBasePath(config.basePath, `/covers/${id}${extension}${query}`);
  }
  return config.thumbnails === 'none'
    ? withBasePath(config.basePath, `/thumbnails/${id}.svg${query}`)
    : withBasePath(config.basePath, `/thumbnails/${id}.png${query}`);
}

function writeNotFound(response) {
  response.statusCode = 404;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.end('Not found');
}

function proxyHttp(request, response, deck, basePath) {
  const target = new URL(deck.server.origin);
  const upstream = httpRequest({
    hostname: target.hostname,
    port: target.port,
    method: request.method,
    path: request.url,
    headers: {
      ...request.headers,
      host: target.host,
      'accept-encoding': 'identity',
    },
  });
  request.pipe(upstream);
  upstream.on('response', (incoming) => {
    const headers = { ...incoming.headers, 'cache-control': 'no-store' };
    if (incoming.headers['content-type']?.includes('text/html')) {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => {
        let html = Buffer.concat(chunks).toString();
        if (!/<meta\b(?=[^>]*\bname=["']slidock-base["'])/iu.test(html))
          html = injectSiteBase(html, basePath);
        html = html.replace(
          /<\/body\s*>/iu,
          `<script type="module" src="${withBasePath(basePath, `${prefix}navigation.js`)}"></script></body>`,
        );
        delete headers['content-length'];
        delete headers['transfer-encoding'];
        delete headers['content-encoding'];
        if (!response.headersSent) response.writeHead(incoming.statusCode ?? 200, headers);
        response.end(html);
      });
    } else {
      response.writeHead(incoming.statusCode ?? 200, headers);
      incoming.pipe(response);
    }
    incoming.on('error', (error) => response.destroy(error));
  });
  upstream.on('error', () => {
    if (!response.headersSent) {
      response.statusCode = 502;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end('Slidev development runtime is unavailable');
    } else response.destroy();
  });
}

function writeSocketResponse(socket, status, statusMessage, headers = {}) {
  const lines = [`HTTP/1.1 ${status} ${statusMessage}`];
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
  }
  lines.push('', '');
  socket.write(lines.join('\r\n'));
}

function proxyWebSocket(request, socket, head, deck, sockets) {
  const target = new URL(deck.server.origin);
  const upstreamRequest = httpRequest({
    hostname: target.hostname,
    port: target.port,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, host: target.host },
  });
  let upstreamSocket;
  const cleanup = () => {
    sockets.delete(socket);
    upstreamSocket?.destroy();
  };
  sockets.set(socket, undefined);
  socket.once('close', cleanup);
  socket.once('error', cleanup);
  upstreamRequest.once('upgrade', (response, upstream, upstreamHead) => {
    upstreamSocket = upstream;
    sockets.set(socket, upstream);
    upstream.once('close', () => socket.destroy());
    writeSocketResponse(
      socket,
      response.statusCode ?? 101,
      response.statusMessage ?? 'Switching Protocols',
      response.headers,
    );
    if (head.length) socket.unshift(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    socket.pipe(upstream).pipe(socket);
  });
  upstreamRequest.once('response', (response) => {
    writeSocketResponse(
      socket,
      response.statusCode ?? 502,
      response.statusMessage ?? 'Bad Gateway',
      response.headers,
    );
    socket.end();
  });
  upstreamRequest.once('error', () => {
    if (!socket.destroyed) writeSocketResponse(socket, 502, 'Bad Gateway');
    socket.destroy();
  });
  upstreamRequest.end();
}

export async function startDev(initialConfig, port, resolveConfig, watchFiles = []) {
  let config = initialConfig;
  const basePath = normalizeBasePath(initialConfig.basePath);
  let backends = [];
  let home;
  let browserPromise;
  let closed = false;
  let closePromise;
  let timer;
  let refresh = Promise.resolve();
  let captures = Promise.resolve();
  let refreshFailed = false;
  const thumbnails = new Map();
  const pendingFiles = new Set();
  const tunnelSockets = new Map();

  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    clearTimeout(timer);
    pendingFiles.clear();
    for (const [socket, upstream] of tunnelSockets) {
      socket.destroy();
      upstream?.destroy();
    }
    closePromise = (async () => {
      await home?.close().catch(() => {});
      await refresh.catch(() => {});
      await captures.catch(() => {});
      await browserPromise?.then((browser) => browser.close()).catch(() => {});
      await Promise.allSettled(backends.map((deck) => deck.server.close()));
    })();
    return closePromise;
  }

  try {
    const { cliRequire } = await resolveRuntime(config.dependencyRoot);
    const { createServer, searchForWorkspaceRoot } = await import(
      pathToFileURL(cliRequire.resolve('vite'))
    );
    const { default: vue } = await import(pathToFileURL(cliRequire.resolve('@vitejs/plugin-vue')));
    for (const deck of config.decks) backends.push(await createBackend(config, deck));

    function catalogDeck(deck) {
      const revision = createHash('sha256')
        .update(JSON.stringify([deck.snapshot.sources, deck.version, deck.cover ?? null]))
        .digest('hex');
      return {
        id: deck.id,
        title: deck.title ?? (deck.snapshot.title || deck.id),
        entry: withBasePath(basePath, `/${encodeDeckPath(deck.id)}/1`),
        pages: deck.snapshot.pages,
        revision,
        categoryPath: deck.categoryPath,
        frontmatter: publicFrontmatter(deck.snapshot.headmatter),
        thumbnail: {
          src: thumbnailSource(deck, config, revision),
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

    function emitCatalogUpdate() {
      try {
        home?.ws.send({ type: 'custom', event: 'slidock:catalog', data: {} });
      } catch {
        // The home server may be closing while a final filesystem event drains.
      }
    }

    function showError(error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack || '' : '';
      home?.config.logger.error(stack || message);
      try {
        home?.ws.send({ type: 'error', err: { message, stack } });
      } catch {
        // A failed refresh must not crash the development server during shutdown.
      }
      refreshFailed = true;
    }

    async function captureThumbnail(deck, key) {
      if (!thumbnails.has(key)) {
        const capture = captures.then(async () => {
          if (closed) throw new Error('Development server closed');
          if (!browserPromise) {
            const launching = import('playwright-core').then(({ chromium }) =>
              chromium.launch({
                headless: true,
                ...(config.chromiumExecutable ? { executablePath: config.chromiumExecutable } : {}),
              }),
            );
            browserPromise = launching;
            launching.catch(() => {
              if (browserPromise === launching) browserPromise = undefined;
            });
          }
          const browser = await browserPromise;
          const page = await browser.newPage({
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: 0.5,
          });
          const diagnostics = { pageErrors: [], consoleErrors: [], failedRequests: [] };
          page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
          page.on('console', (message) => {
            if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
          });
          page.on('requestfailed', (request) => {
            diagnostics.failedRequests.push({
              url: request.url(),
              error: request.failure()?.errorText,
            });
          });
          try {
            await page.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
            await page.goto(`${deck.server.origin}${deck.base}1`, {
              waitUntil: 'domcontentloaded',
              timeout: 60_000,
            });
            await waitForRenderedSlide(page, deck.id);
            return await page.locator('.slidev-page[data-slidev-no="1"]').screenshot({
              timeout: 15_000,
            });
          } catch (error) {
            const state = await page
              .evaluate(() => ({
                url: location.href,
                title: document.title,
                slideCount: document.querySelectorAll('.slidev-page').length,
                body: document.body?.innerText.slice(0, 500),
              }))
              .catch(() => null);
            home?.config.logger.error(
              `Thumbnail capture failed for ${deck.id}: ${JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
                state,
                ...diagnostics,
              })}`,
            );
            throw error;
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

    async function serveThumbnail(url, response, localPath) {
      const deck = backends.find((candidate) => {
        const id = encodeDeckPath(candidate.id);
        if (candidate.cover) {
          const extension = extname(candidate.cover).toLowerCase();
          return localPath === `/covers/${id}${extension}`;
        }
        return config.thumbnails === 'none'
          ? localPath === `/thumbnails/${id}.svg`
          : localPath === `/thumbnails/${id}.png`;
      });
      if (!deck) return writeNotFound(response);
      response.setHeader('cache-control', 'no-store');
      if (deck.cover) {
        const extension = extname(deck.cover).toLowerCase();
        try {
          const bytes = await readFile(deck.cover);
          response.setHeader('content-type', mimeTypes[extension] ?? 'application/octet-stream');
          response.end(bytes);
        } catch (error) {
          if (error?.code === 'ENOENT') return writeNotFound(response);
          throw error;
        }
        return;
      }
      if (config.thumbnails === 'none') {
        response.setHeader('content-type', 'image/svg+xml');
        response.end(placeholder);
        return;
      }
      const key = `${deck.id}:${url.searchParams.get('revision') ?? ''}`;
      try {
        const bytes = await captureThumbnail(deck, key);
        response.setHeader('content-type', 'image/png');
        response.end(bytes);
      } catch (error) {
        if (closed) return writeNotFound(response);
        throw error;
      }
    }

    async function refreshCollection(files) {
      if (closed) return;
      const nextConfig = await resolveConfig();
      const nextBasePath = normalizeBasePath(nextConfig.basePath);
      if (nextBasePath !== basePath)
        throw new Error(
          `basePath changed from "${basePath}" to "${nextBasePath}"; restart the dev server to apply it`,
        );
      const previous = backends;
      const previousById = new Map(previous.map((deck) => [deck.id, deck]));
      const next = [];
      const staged = [];
      let collectionChanged = false;
      const oldHome = JSON.stringify(config.home ?? {});
      const oldNavigation = JSON.stringify(config.navigation ?? {});
      const oldFrontendEntry = JSON.stringify([config.frontendEntry, config.frontendRoot]);
      const oldThumbnails = config.thumbnails;
      try {
        for (const deck of nextConfig.decks) {
          const existing = previousById.get(deck.id);
          const nextRuntimeKey = runtimeKey(nextConfig, deck);
          if (!existing || existing.runtimeKey !== nextRuntimeKey) {
            const started = await createBackend(nextConfig, deck);
            staged.push(started);
            next.push(started);
            collectionChanged = true;
            continue;
          }
          previousById.delete(deck.id);
          let snapshot = existing.snapshot;
          let version = existing.version;
          const sourceChanged = changedDeckFiles(existing, files);
          const cover = coversPath(existing);
          const coverChanged = cover !== undefined && files.includes(cover);
          if (sourceChanged && !coverChanged) {
            snapshot = await readDevDeck(existing.options);
            version++;
          }
          if (coverChanged) version++;
          const updated = {
            ...existing,
            ...deck,
            base: existing.base,
            options: existing.options,
            snapshot,
            version,
            server: existing.server,
            theme: existing.theme,
            runtimeKey: nextRuntimeKey,
          };
          if (
            catalogInput(updated) !== catalogInput(existing) ||
            snapshot !== existing.snapshot ||
            version !== existing.version
          )
            collectionChanged = true;
          next.push(updated);
        }
        if (previousById.size) collectionChanged = true;
        if (
          JSON.stringify(next.map((deck) => deck.id)) !==
          JSON.stringify(previous.map((deck) => deck.id))
        )
          collectionChanged = true;
        if (oldThumbnails !== nextConfig.thumbnails) collectionChanged = true;
        if (closed) {
          await Promise.allSettled(staged.map((deck) => deck.server.close()));
          return;
        }

        home.watcher.add([
          nextConfig.sourceRoot,
          ...watchFiles,
          ...next.flatMap((deck) => [
            ...deck.snapshot.watchFiles,
            ...(deck.cover ? [deck.cover] : []),
          ]),
        ]);
        config = nextConfig;
        backends = next;
        const retainedServers = new Set(backends.map((deck) => deck.server));
        const stale = previous.filter((deck) => !retainedServers.has(deck.server));
        if (stale.length) {
          await captures.catch(() => {});
          await Promise.allSettled(stale.map((deck) => deck.server.close()));
          for (const key of thumbnails.keys())
            if (stale.some((deck) => key.startsWith(`${deck.id}:`))) thumbnails.delete(key);
        }
        const homeChanged = oldHome !== JSON.stringify(config.home ?? {});
        const navigationChanged = oldNavigation !== JSON.stringify(config.navigation ?? {});
        const frontendEntryChanged =
          oldFrontendEntry !== JSON.stringify([config.frontendEntry, config.frontendRoot]);
        if (frontendEntryChanged) {
          const entryModule = home.moduleGraph.getModuleById(frontendEntryResolvedId);
          if (entryModule) home.moduleGraph.invalidateModule(entryModule);
        }
        if (homeChanged || navigationChanged || frontendEntryChanged) {
          try {
            home.ws.send({ type: 'full-reload', path: '*' });
          } catch {
            // A successful config update remains published if the home socket is closing.
          }
        }
        if (collectionChanged || refreshFailed) emitCatalogUpdate();
        refreshFailed = false;
      } catch (error) {
        await Promise.allSettled(staged.map((deck) => deck.server.close()));
        throw error;
      }
    }

    function changed(file) {
      if (closed || typeof file !== 'string') return;
      pendingFiles.add(resolve(file));
      clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...pendingFiles];
        pendingFiles.clear();
        refresh = refresh.then(async () => {
          if (closed) return;
          try {
            await refreshCollection(files);
          } catch (error) {
            showError(error);
          }
        });
      }, 250);
    }

    home = await createServer({
      configFile: false,
      root: dirname(config.frontendEntry),
      cacheDir: join(config.outDir, '.vite-home'),
      base: basePath,
      appType: 'custom',
      resolve: {
        alias: [{ find: /^vue$/u, replacement: resolveFrontendVue(config.frontendEntry) }],
      },
      plugins: [
        vue(),
        {
          name: 'slidock:home-entry-delete',
          hotUpdate({ file, type }) {
            if (
              resolve(file) === resolve(config.frontendEntry) &&
              (type === 'delete' || (type === 'update' && !existsSync(file)))
            )
              return [];
          },
        },
        createFrontendEntryPlugin(() => ({
          frontendEntry: config.frontendEntry,
          frontendRoot: config.frontendRoot,
        })),
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
              if (basePath !== '/' && url.pathname === basePath.slice(0, -1)) {
                response.statusCode = 308;
                response.setHeader('location', `${basePath}${url.search}`);
                response.end();
                return;
              }
              const localPath = stripBasePath(url.pathname, basePath);
              if (localPath === null) {
                if (
                  /^\/@(?:vite|id|fs|react-refresh)(?:\/|$)/u.test(url.pathname) ||
                  url.pathname.startsWith('/node_modules/.vite/')
                )
                  return next();
                return writeNotFound(response);
              }
              try {
                response.setHeader('cache-control', 'no-store');
                if (localPath === '/catalog.json') {
                  response.setHeader('content-type', 'application/json');
                  response.end(JSON.stringify(catalog()));
                } else if (
                  localPath.startsWith('/thumbnails/') ||
                  localPath.startsWith('/covers/')
                ) {
                  await serveThumbnail(url, response, localPath);
                } else if (localPath === `${prefix}navigation.js`) {
                  response.setHeader('content-type', 'text/javascript');
                  response.end(
                    `import { mountNavigation } from ${JSON.stringify(withBasePath(basePath, asFsUrl(join(config.frontendRoot, 'navigation.ts'))))};\nmountNavigation(${JSON.stringify(config.navigation)});`,
                  );
                } else if (localPath === '/' || localPath === '/index.html') {
                  const baseHtml = `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Slidock</title><link rel="icon" href="${asFsUrl(join(config.frontendRoot, 'assets/slidock.svg'))}"></head><body><div id="app"></div><script type="module" src="${frontendEntryId}"></script><script type="module" src="${prefix}catalog.js"></script></body></html>`;
                  const html = injectHomeConfig(injectSiteBase(baseHtml, basePath), config.home);
                  response.setHeader('content-type', 'text/html');
                  response.end(await server.transformIndexHtml(basePath, html));
                } else {
                  const deck = resolveDeckRoute(localPath, backends);
                  if (deck) proxyHttp(request, response, deck, basePath);
                  else if (isUnknownSlidePage(localPath)) writeNotFound(response);
                  else next();
                }
              } catch (error) {
                if (closed) writeNotFound(response);
                else next(error);
              }
            });
            server.httpServer?.on('upgrade', (request, socket, head) => {
              const protocol = String(request.headers['sec-websocket-protocol'] ?? '')
                .split(',')
                .map((item) => item.trim());
              const pathname = new URL(request.url, 'http://localhost').pathname;
              const localPath = stripBasePath(pathname, basePath);
              const deck = localPath === null ? null : resolveDeckRoute(localPath, backends);
              if (deck) proxyWebSocket(request, socket, head, deck, tunnelSockets);
              else if (protocol.includes('vite-hmr') || protocol.includes('vite-ping')) return;
              else {
                writeSocketResponse(socket, 404, 'Not Found');
                socket.end();
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
        fs: {
          allow: [
            searchForWorkspaceRoot(config.sourceRoot),
            config.frontendRoot,
            dirname(config.frontendEntry),
            ...watchFiles.map((file) => dirname(resolve(file))),
          ],
        },
      },
    });
    home.watcher.add([
      config.sourceRoot,
      ...watchFiles,
      ...backends.flatMap((deck) => [
        ...deck.snapshot.watchFiles,
        ...(deck.cover ? [deck.cover] : []),
      ]),
    ]);
    for (const event of ['change', 'add', 'unlink']) home.watcher.on(event, changed);
    await home.listen();
    return { url: home.resolvedUrls.local[0], close };
  } catch (error) {
    await close();
    throw error;
  }
}
