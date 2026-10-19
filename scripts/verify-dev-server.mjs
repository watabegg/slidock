import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-chromium';
import { devHub } from '@slidock/slidock';
import { repositoryRoot as root } from './runtime-environment.mjs';

const require = createRequire(import.meta.url);
const output = join(root, 'artifacts/hot-reload');
const sourceRoot = join(output, 'slides');
await mkdir(join(sourceRoot, 'Default'), { recursive: true });
await mkdir(join(sourceRoot, 'Apple Basic'), { recursive: true });
const source = join(sourceRoot, 'Default/demo.md');
const other = join(sourceRoot, 'Apple Basic/demo.md');
const markdown = (title, body, extra = '') =>
  `---\ntitle: ${title}\nfonts:\n  webfonts: []\n  sans: Arial\n  mono: monospace\n---\n# First slide\n\n---\n\n# ${body}\n${extra}`;
await writeFile(source, markdown('Initial deck', 'Before edit'));
await writeFile(other, markdown('Other theme', 'Other slide'));
const app = join(output, 'Home.vue');
const sfc = (label) =>
  `<script setup>\nimport { SlidockHome, useCatalog } from '@slidock/slidock/frontend';\nconst { catalog, error } = useCatalog();\n</script>\n<template><SlidockHome v-if="catalog" :catalog="catalog"><template #nav><span id="custom-label">${label}</span></template></SlidockHome><p v-else-if="error">{{ String(error) }}</p></template>`;
await writeFile(app, sfc('Before home edit'));
const entry = join(output, 'entry.ts');
await writeFile(
  entry,
  `import { createApp } from 'vue';\nimport Home from './Home.vue';\nimport '@slidock/slidock/frontend/style.css';\ncreateApp(Home).mount('#app');`,
);
const server = await devHub({
  sourceRoot,
  frontendEntry: entry,
  outDir: join(output, 'unused-site'),
  port: 0,
  profiles: {
    default: {
      dependencyRoot: root,
      theme: dirname(require.resolve('@slidev/theme-default/package.json')),
    },
    apple: {
      dependencyRoot: root,
      theme: dirname(require.resolve('@slidev/theme-apple-basic/package.json')),
    },
  },
  decks: [
    { id: 'Default/demo', entry: source, profile: 'default' },
    { id: 'Apple Basic/demo', entry: other, profile: 'apple' },
  ],
  chromiumExecutable: process.env.CHROMIUM_EXECUTABLE,
});
console.log(`Dev verification: ${server.url}`);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
const checks = [];
const errors = [];
async function until(fn, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.locator('.deck-card').first().waitFor();
  assert.equal(await page.locator('.deck-card').count(), 2);
  await until(
    () =>
      page
        .locator('.deck-preview img')
        .evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0)),
    'live thumbnails',
    120_000,
  );
  checks.push('Home and live thumbnails work without a static site build');
  await page.evaluate(() => {
    window.hmrSentinel = 1;
  });
  await writeFile(app, sfc('After home edit'));
  await until(
    async () => (await page.locator('#custom-label').textContent()) === 'After home edit',
    'Vue home HMR',
  );
  assert.equal(await page.evaluate(() => window.hmrSentinel), 1);
  checks.push('Vue home edits hot-update without a document reload');
  const slide = await browser.newPage();
  await slide.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
  slide.on('pageerror', (error) => errors.push(error.message));
  let connected = false;
  slide.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'connected') connected = true;
      if (message.type === 'full-reload' || message.type === 'error')
        console.log('Slide HMR:', message);
    }),
  );
  await slide.goto(`${server.url}Default/demo/2`);
  const active = slide.locator('.slidev-page[data-slidev-no="2"]');
  await active.waitFor({ state: 'visible', timeout: 60_000 });
  await until(async () => (await active.textContent()).includes('Before edit'), 'slide rendered');
  await until(() => connected, 'Slidev HMR WebSocket connection');
  await slide.evaluate(() => {
    window.hmrSentinel = 2;
  });
  const oldThumb = await page.locator('a[href="/Default/demo/1"] img').getAttribute('src');
  const oldImage = Buffer.from(
    await fetch(new URL(oldThumb, server.url)).then((response) => response.arrayBuffer()),
  );
  await page.getByRole('button', { name: 'Default', exact: true }).click();
  await writeFile(
    source,
    markdown('Initial deck', 'After edit').replace('First slide', 'Revised cover'),
  );
  await until(async () => (await active.textContent()).includes('After edit'), 'Markdown HMR');
  assert.equal(await slide.evaluate(() => window.hmrSentinel), 2);
  assert.equal(new URL(slide.url()).pathname, '/Default/demo/2');
  await writeFile(
    source,
    markdown('Updated deck', 'After edit').replace('First slide', 'Revised cover'),
  );
  await until(
    async () =>
      (await page.locator('a[href="/Default/demo/1"]').textContent()).includes('Updated deck'),
    'home metadata update',
  );
  await until(
    async () =>
      (await page.locator('a[href="/Default/demo/1"] img').getAttribute('src')) !== oldThumb,
    'thumbnail revision update',
  );
  checks.push(
    'Markdown hot-updates in place on page 2; home metadata and thumbnail revision update',
  );
  assert.equal(await page.locator('.deck-card').count(), 1);
  assert.equal(
    await page.getByRole('button', { name: 'Default', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  const newThumb = await page.locator('a[href="/Default/demo/1"] img').getAttribute('src');
  const newImage = Buffer.from(
    await fetch(new URL(newThumb, server.url)).then((response) => response.arrayBuffer()),
  );
  assert.notDeepEqual(newImage, oldImage);
  assert.equal(new URL(slide.url()).pathname, '/Default/demo/2');
  checks.push('Catalog refresh preserves category selection and regenerates changed cover pixels');
  await writeFile(source, markdown('Updated deck', 'After edit', '\n---\n\n# Added slide\n'));
  await until(async () => {
    const catalog = await fetch(new URL('catalog.json', server.url)).then((response) =>
      response.json(),
    );
    return catalog.decks.find((deck) => deck.id === 'Default/demo').pages === 3;
  }, 'page count update');
  await slide.goto(`${server.url}Default/demo/3`);
  await slide
    .getByRole('heading', { name: 'Added slide', exact: true })
    .waitFor({ timeout: 30_000 });
  checks.push('Adding a slide updates the catalog and new deep link');
  await writeFile(source, '---\ntitle: [broken\n---\n# Broken\n');
  await page.locator('vite-error-overlay').waitFor();
  await writeFile(
    source,
    markdown('Recovered deck', 'Recovered slide', '\n---\n\n# Added slide\n'),
  );
  await until(
    async () =>
      (await page.locator('a[href="/Default/demo/1"]').textContent()).includes('Recovered deck'),
    'syntax error recovery',
  );
  await page.locator('vite-error-overlay').waitFor({ state: 'detached' });
  for (const n of [1, 2, 3])
    await writeFile(source, markdown(`Rapid ${n}`, `Final ${n}`, '\n---\n\n# Added slide\n'));
  await until(
    async () => (await page.locator('a[href="/Default/demo/1"]').textContent()).includes('Rapid 3'),
    'latest rapid save',
  );
  await until(
    async () =>
      (await slide.locator('.slidev-page[data-slidev-no="2"]').textContent()).includes('Final 3'),
    'latest slide content after recovery',
  );
  checks.push(
    'Syntax errors show an overlay, a valid save recovers, and rapid saves converge on the latest content',
  );
  await slide.goto(`${server.url}Apple%20Basic/demo/2`);
  await slide
    .locator('.slidev-page[data-slidev-no="2"]')
    .waitFor({ state: 'visible', timeout: 60_000 });
  await slide.getByRole('link', { name: 'ホームへ戻る', exact: true }).click();
  await slide.locator('.deck-card').first().waitFor();
  checks.push('Different themes and encoded deck paths work, with return navigation');
  await page.screenshot({ path: join(output, 'home.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  console.error(errors);
  throw error;
} finally {
  await browser.close();
  await server.close();
}
assert.equal(
  await fetch(server.url).then(
    () => true,
    () => false,
  ),
  false,
);
assert.ok((await readFile(source, 'utf8')).includes('Added slide'));
