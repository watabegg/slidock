import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { resolveRuntime } from '@slidock/slidev-adapter/runtime';
import { injectHomeConfig, injectSiteBase } from './home-config.mjs';
import { normalizeBasePath } from './base-path.mjs';
import {
  createFrontendEntryPlugin,
  frontendEntryId,
  resolveFrontendVue,
} from './frontend-entry.mjs';

async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files.push(file);
    }
  }
  await visit(root);
  return files;
}

export async function buildEmptyCollection(job) {
  const started = performance.now();
  const basePath = normalizeBasePath(job.basePath);
  const workDir = job.workDir;
  const site = join(workDir, 'site');
  const viteRoot = join(workDir, 'vite-root');
  await mkdir(viteRoot, { recursive: true });

  await writeFile(
    join(viteRoot, 'index.html'),
    `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Slidock</title></head><body><div id="app"></div><script type="module" src="${frontendEntryId}"></script></body></html>\n`,
  );

  const runtime = await resolveRuntime(job.dependencyRoot);
  const { build } = await import(pathToFileURL(runtime.cliRequire.resolve('vite')));
  const { default: vue } = await import(
    pathToFileURL(runtime.cliRequire.resolve('@vitejs/plugin-vue'))
  );
  const frontendEntryPlugin = createFrontendEntryPlugin(() => ({
    frontendEntry: job.frontendEntry,
    frontendRoot: job.frontendRoot,
  }));
  await build({
    configFile: false,
    root: viteRoot,
    base: basePath,
    cacheDir: join(workDir, 'vite-cache'),
    publicDir: false,
    plugins: [frontendEntryPlugin, vue()],
    build: { outDir: site, emptyOutDir: true, target: 'esnext', cssCodeSplit: true },
    define: { __VUE_PROD_DEVTOOLS__: false },
    resolve: { alias: [{ find: /^vue$/, replacement: resolveFrontendVue(job.frontendEntry) }] },
    server: {
      fs: {
        allow: [
          job.sourceRoot,
          job.frontendRoot,
          dirname(job.frontendEntry),
          job.dependencyRoot,
          dirname(runtime.cliEntry),
        ],
      },
    },
  });

  const indexPath = join(site, 'index.html');
  const baseHtml = injectSiteBase(await readFile(indexPath, 'utf8'), basePath);
  const homeHtml = job.home === undefined ? baseHtml : injectHomeConfig(baseHtml, job.home);
  await writeFile(indexPath, homeHtml);
  await writeFile(join(site, '404.html'), baseHtml);

  const catalog = { schemaVersion: 1, categories: [], decks: [] };
  const nativePlayer = { schemaVersion: 1, protocolVersion: 1, decks: [], unsupportedDecks: [] };
  const manifest = {
    schemaVersion: 1,
    runtimeVersion: 'none',
    bootstrap: 'preload-then-sync-facades',
    routeMode: 'history',
    switching: 'document-navigation',
    notes: 'stripped',
    groups: [],
    commonAssets: [],
    decks: [],
    ...(basePath === '/' ? {} : { basePath }),
  };
  await writeFile(join(site, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(join(site, 'native-player.json'), `${JSON.stringify(nativePlayer, null, 2)}\n`);
  await writeFile(join(site, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  manifest.commonAssets = (await listFiles(site))
    .map((file) => relative(site, file).split(sep).join('/'))
    .sort();
  await writeFile(join(site, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const files = await Promise.all(
    (await listFiles(site)).map(async (file) => {
      const bytes = await readFile(file);
      return {
        path: relative(site, file).split(sep).join('/'),
        rawBytes: bytes.length,
        gzipBytes: gzipSync(bytes).length,
      };
    }),
  );
  const metrics = {
    elapsedMs: Math.round(performance.now() - started),
    runtimeVersion: 'none',
    groupCount: 0,
    deckCount: 0,
    totalRawBytes: files.reduce((total, file) => total + file.rawBytes, 0),
    totalGzipBytes: files.reduce((total, file) => total + file.gzipBytes, 0),
    fileCount: files.length,
    files,
  };
  await writeFile(join(workDir, 'chunk-graph.json'), '[]\n');
  await writeFile(join(workDir, 'build-metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(
    JSON.stringify({
      outDir: site,
      ...Object.fromEntries(Object.entries(metrics).filter(([key]) => key !== 'files')),
    }),
  );
  return { site, manifest, catalog, nativePlayer, metrics };
}
