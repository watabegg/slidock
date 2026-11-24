import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-chromium';
import { devHub, loadProject } from '@slidock/slidock';
import { repositoryRoot as root } from './runtime-environment.mjs';

const projectRoot = await mkdtemp(join(root, 'artifacts/pages-dev-'));
const sourceRoot = join(projectRoot, 'slides');
const pagesRoot = join(projectRoot, 'pages');
const homePagePath = join(pagesRoot, 'index.vue');
const configPath = join(projectRoot, 'slidock.config.json');
const reloadFile = join(projectRoot, 'config.watch');
const deckPath = join(sourceRoot, 'Default/slides.md');
const encodedDeckPath = join(sourceRoot, 'Apple Basic/demo/slides.md');
const configValue = {
  basePath: '/slides/',
  sourceRoot: './slides',
  outDir: './dist',
  allowEmpty: true,
  thumbnails: 'none',
  chromiumExecutable: join(projectRoot, 'missing-chromium'),
};
await mkdir(dirname(deckPath), { recursive: true });
await mkdir(dirname(encodedDeckPath), { recursive: true });
await writeFile(
  deckPath,
  '---\ntitle: Live deck\nfonts:\n  webfonts: []\n  sans: Arial\n  mono: monospace\n---\n# First slide\n\n---\n\n# Before edit\n',
);
await writeFile(
  encodedDeckPath,
  '---\ntitle: Encoded deck\nfonts:\n  webfonts: []\n  sans: Arial\n  mono: monospace\n---\n# Encoded first slide\n\n---\n\n# Encoded deep link\n',
);
await writeFile(configPath, JSON.stringify(configValue, null, 2));
await writeFile(reloadFile, 'initial\n');

const project = await loadProject({ root: projectRoot });
const server = await devHub({
  ...project.options,
  port: 0,
  resolveOptions: async () => (await loadProject({ root: projectRoot })).options,
  watchFiles: [configPath, reloadFile, project.homePagePath, pagesRoot],
});
const siteUrl = new URL('/slides/', server.url).href;
let browser;
const checks = [];
const errors = [];
const requests = [];

async function until(fn, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function waitForOverlay(page, expected) {
  await until(
    async () =>
      page
        .locator('vite-error-overlay')
        .evaluate((element) => element.shadowRoot?.textContent ?? '')
        .then((text) => text.includes(expected))
        .catch(() => false),
    `Vite overlay contains ${expected}`,
  );
}

async function writeConfig(value) {
  await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`);
}

function customPage(label) {
  return `<script setup>\nimport { SlidockHome, useCatalog } from '@slidock/slidock/frontend';\nconst { catalog, error } = useCatalog();\n</script>\n<template><main><h1 id="custom-label">${label}</h1><p id="custom-count">{{ catalog?.decks.length }}</p><SlidockHome v-if="catalog" :catalog="catalog" /><p v-else-if="error">Catalog failed</p></main></template>`;
}

let page;
let slide;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
  });
  page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  const homeSocketUrls = [];
  page.on('websocket', (socket) => homeSocketUrls.push(socket.url()));
  await page.goto(siteUrl);
  await page.locator('.deck-card').first().waitFor();
  assert.equal(await page.locator('meta[name="slidock-base"]').getAttribute('content'), '/slides/');
  assert.equal(await page.locator('.deck-card').count(), 2);
  await until(
    () => requests.some((url) => new URL(url).pathname === '/slides/catalog.json'),
    'default home catalog request under mount',
  );
  await until(() => homeSocketUrls.length > 0, 'home Vite WebSocket');
  assert.equal(
    homeSocketUrls.every((url) => new URL(url).pathname.startsWith('/slides/')),
    true,
  );
  checks.push('Default home and catalog client use the /slides/ mount');

  const redirect = await fetch(new URL('/slides?return=1', server.url), { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/slides/?return=1');
  assert.equal(await fetch(new URL('/', server.url)).then((response) => response.status), 404);
  assert.equal(
    await fetch(new URL('/catalog.json', server.url)).then((response) => response.status),
    404,
  );
  checks.push('/slides redirects with its query and paths outside the mount do not serve home');

  await writeConfig({ ...configValue, basePath: '/other/' });
  await waitForOverlay(page, 'restart the dev server');
  assert.equal(await fetch(siteUrl).then((response) => response.status), 200);
  assert.equal(
    await fetch(new URL('/other/', server.url)).then((response) => response.status),
    404,
  );
  await writeConfig(configValue);
  await page.locator('vite-error-overlay').waitFor({ state: 'detached' });
  checks.push('A live basePath change reports restart-required and keeps the old mount active');

  await mkdir(pagesRoot, { recursive: true });
  await writeFile(homePagePath, customPage('Custom page added'));
  await page.locator('#custom-label').getByText('Custom page added').waitFor();
  await page.locator('#custom-count').getByText('2').waitFor();
  assert.equal(await page.locator('.brand').getAttribute('href'), '/slides/');
  await until(
    () => requests.some((url) => new URL(url).pathname === '/slides/catalog.json'),
    'custom page catalog request under mount',
  );
  checks.push(
    'Adding pages/index.vue selects the automatic Vue home with prefixed catalog and home links',
  );

  await page.evaluate(() => {
    window.pagesHmrSentinel = 'kept';
  });
  await writeFile(homePagePath, customPage('Custom page edited'));
  await page.locator('#custom-label').getByText('Custom page edited').waitFor();
  assert.equal(await page.evaluate(() => window.pagesHmrSentinel), 'kept');
  checks.push('Editing pages/index.vue uses Vue HMR without a document reload');

  const catalogResponse = await fetch(new URL('/slides/catalog.json', server.url));
  const catalog = await catalogResponse.json();
  assert.equal(
    catalog.decks.find((deck) => deck.id === 'Apple Basic/demo').entry,
    '/slides/Apple%20Basic/demo/1',
  );
  assert.equal(catalog.decks.find((deck) => deck.id === 'Default').entry, '/slides/Default/1');
  assert.equal(catalog.decks[0].thumbnail.src.startsWith('/slides/thumbnails/'), true);
  const thumbnail = await fetch(new URL(catalog.decks[0].thumbnail.src, server.url));
  assert.equal(thumbnail.status, 200);
  assert.equal(thumbnail.headers.get('content-type'), 'image/svg+xml');
  assert.match(await thumbnail.text(), /<svg/u);

  slide = await browser.newPage();
  await slide.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
  slide.on('pageerror', (error) => errors.push(error.message));
  let hmrConnected = false;
  let hmrUrl;
  let socketCloses = 0;
  slide.on('websocket', (socket) => {
    hmrUrl = socket.url();
    socket.on('framereceived', ({ payload }) => {
      try {
        if (JSON.parse(String(payload)).type === 'connected') hmrConnected = true;
      } catch {}
    });
    socket.on('close', () => socketCloses++);
  });
  await slide.goto(new URL('/slides/Default/2', server.url).href);
  const activeSlide = slide.locator('.slidev-page[data-slidev-no="2"]');
  await activeSlide.waitFor({ state: 'visible', timeout: 60_000 });
  await until(
    () => activeSlide.textContent().then((text) => text.includes('Before edit')),
    'deep slide content',
  );
  await until(() => hmrConnected, 'Slidev HMR websocket');
  assert.match(new URL(hmrUrl).pathname, /^\/slides\/Default\//u);
  assert.equal(await slide.locator('.slide-library-home').getAttribute('href'), '/slides/');
  assert.match(
    await fetch(new URL('/slides/Default/2', server.url)).then((response) => response.text()),
    /meta name="slidock-base" content="\/slides\/"/u,
  );
  const encodedSlide = await browser.newPage();
  await encodedSlide.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
  await encodedSlide.goto(new URL('/slides/Apple%20Basic/demo/2', server.url).href);
  await encodedSlide.getByRole('heading', { name: 'Encoded deep link', exact: true }).waitFor();
  assert.equal(await encodedSlide.locator('.slide-library-home').getAttribute('href'), '/slides/');
  await encodedSlide.close();
  await slide.evaluate(() => {
    window.slideHmrSentinel = 'kept';
  });
  await writeFile(
    deckPath,
    '---\ntitle: Live deck\nfonts:\n  webfonts: []\n  sans: Arial\n  mono: monospace\n---\n# First slide\n\n---\n\n# After edit\n',
  );
  await until(
    () => activeSlide.textContent().then((text) => text.includes('After edit')),
    'deep slide Markdown HMR',
  );
  assert.equal(new URL(slide.url()).pathname, '/slides/Default/2');
  assert.equal(await slide.evaluate(() => window.slideHmrSentinel), 'kept');
  assert.equal(socketCloses, 0);
  checks.push(
    'Prefixed deck routing, WebSocket HMR, navigation, deep refresh, and SVG thumbnails work',
  );

  await rm(homePagePath);
  await page.locator('.deck-card').first().waitFor();
  await page.locator('#custom-label').waitFor({ state: 'detached' });
  const restoredDeckCount = await page.locator('.deck-card').count();
  if (restoredDeckCount !== 2) {
    console.error('Home after deleting pages/index.vue', {
      url: page.url(),
      body: await page.locator('body').innerText(),
      overlay: await page
        .locator('vite-error-overlay')
        .evaluate((element) => element.shadowRoot?.textContent ?? '')
        .catch(() => ''),
      catalog: await fetch(new URL('/slides/catalog.json', server.url))
        .then((response) => response.json())
        .catch((error) => String(error)),
    });
  }
  assert.equal(restoredDeckCount, 2);
  checks.push('Deleting pages/index.vue returns to the standard home without restarting');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await slide?.close().catch(() => {});
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server.close();
  await rm(projectRoot, { recursive: true, force: true });
}
