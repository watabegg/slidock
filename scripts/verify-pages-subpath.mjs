import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright-chromium';
import { buildHub, loadProject, normalizeHubConfig } from '@slidock/slidock';
import { createServer } from '@slidock/slidock/serve';

const require = createRequire(import.meta.url);
const work = await mkdtemp(join(tmpdir(), 'slidock-pages-subpath-'));
const evidence = resolve('artifacts/pages-subpath');
const basePath = '/docs/slides/';
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
});
let server;
const checks = [];
const errors = [];
const failedResponses = [];
try {
  await mkdir(evidence, { recursive: true });
  await mkdir(join(work, 'slides'), { recursive: true });
  await mkdir(join(work, 'pages'));
  await symlink(resolve('node_modules'), join(work, 'node_modules'), 'dir');
  for (const id of ['first', 'second', 'other']) {
    await mkdir(join(work, 'slides', id));
    await writeFile(
      join(work, 'slides', id, 'slides.md'),
      `---\ntitle: ${id}\nbackground: '#fff'\nfonts:\n  webfonts: []\n  sans: Arial\n  mono: monospace\n---\n# ${id}\n\n---\n\n# ${id} page two\n`,
    );
  }
  const cover = join(work, 'cover.svg');
  await writeFile(
    cover,
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#456"/></svg>',
  );
  const pageFile = join(work, 'pages/index.vue');
  await writeFile(
    pageFile,
    `<script setup>
import { ref } from 'vue';
import { SlidockHome, useCatalog } from '@slidock/slidock/frontend';
const { catalog, error } = useCatalog();
const count = ref(0);
</script>
<template>
  <button @click="count++">Custom counter {{ count }}</button>
  <p v-if="error">Catalog failed</p>
  <SlidockHome v-if="catalog" :catalog="catalog" title="Automatic Vue page" />
</template>`,
  );
  const defaults = await normalizeHubConfig({
    sourceRoot: join(work, 'slides'),
    outDir: join(work, 'site'),
  });
  await writeFile(
    join(work, 'slidock.config.json'),
    JSON.stringify({
      sourceRoot: './slides',
      outDir: './site',
      basePath,
      offline: true,
      thumbnails: 'auto',
      ...(process.env.CHROMIUM_EXECUTABLE
        ? { chromiumExecutable: process.env.CHROMIUM_EXECUTABLE }
        : {}),
      profiles: {
        same: { dependencyRoot: defaults.dependencyRoot, theme: defaults.theme },
        other: {
          dependencyRoot: defaults.dependencyRoot,
          theme: dirname(require.resolve('@slidev/theme-seriph/package.json')),
        },
      },
      decks: [
        { id: 'Group One/first', entry: './slides/first/slides.md', profile: 'same', cover },
        { id: 'second', entry: './slides/second/slides.md', profile: 'same' },
        { id: 'other', entry: './slides/other/slides.md', profile: 'other' },
      ],
    }),
  );
  const project = await loadProject({ root: work });
  assert.equal(project.options.frontendEntry, pageFile);
  const result = await buildHub(project.options);
  assert.equal(result.diagnostics.groupSummary.length, 2);
  assert(
    result.diagnostics.groupSummary.some(
      (group) => group.deckIds.includes('Group One/first') && group.deckIds.includes('second'),
    ),
  );
  assert.equal(result.native.decks.length, 0);
  assert.equal(result.native.unsupportedDecks.length, 3);
  const manifest = JSON.parse(await readFile(join(result.output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.basePath, basePath);
  assert(manifest.commonAssets.every((asset) => !asset.startsWith(basePath)));
  checks.push(
    'Automatic Vue home, offline assets, two compatibility groups and Web-only native metadata build below a nested mount',
  );
  server = createServer(result.output);
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400)
      failedResponses.push({ url: response.url(), status: response.status() });
  });
  const requested = [];
  page.on('request', (request) => requested.push(request.url()));
  await page.goto(`${origin}${basePath}`);
  await page.getByRole('button', { name: 'Custom counter 0' }).click();
  await page.getByRole('button', { name: 'Custom counter 1' }).waitFor();
  await page.locator('.deck-card').first().waitFor();
  assert(requested.includes(`${origin}${basePath}catalog.json`));
  assert.equal(await page.locator('.brand').getAttribute('href'), basePath);
  assert.equal(await page.locator('.deck-card').count(), 3);
  checks.push(
    'Vue mounts without main.ts, reactive state works, and useCatalog plus brand URLs follow the mount',
  );
  for (const deck of result.catalog.decks) {
    assert(deck.entry.startsWith(basePath));
    assert(deck.thumbnail.src.startsWith(basePath));
    const image = await fetch(`${origin}${deck.thumbnail.src}`);
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type'), /^image\//);
    const deepLink = deck.entry.replace(/\/1$/, '/2');
    await page.goto(`${origin}${deepLink}`);
    await page.locator('.slidev-page[data-slidev-no="2"]').waitFor({ state: 'visible' });
    await page.reload();
    await page.locator('.slidev-page[data-slidev-no="2"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.slide-library-home').getAttribute('href'), basePath);
    await page.locator('.slide-library-home').click();
    await page.getByRole('button', { name: 'Custom counter 0' }).waitFor();
  }
  checks.push(
    'Encoded deck IDs, different themes, deep-link reload, return-home links, automatic thumbnails and SVG covers work',
  );
  assert(
    requested
      .filter((url) => url.startsWith(origin))
      .every((url) => new URL(url).pathname.startsWith(basePath)),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(failedResponses, []);
  await page.screenshot({ path: join(evidence, 'custom-home.png'), fullPage: true });
  await new Promise((accept) => server.close(accept));
  server = undefined;
  await rm(pageFile);
  const empty = await buildHub({
    ...project.options,
    frontendEntry: undefined,
    decks: [],
    profiles: undefined,
    allowEmpty: true,
    outDir: join(work, 'empty'),
    offline: false,
    thumbnails: 'none',
  });
  server = createServer(empty.output);
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  await page.goto(`http://127.0.0.1:${server.address().port}${basePath}`);
  await page.getByText('スライドがありません。', { exact: true }).waitFor();
  assert.equal(await page.locator('.brand').getAttribute('href'), basePath);
  assert.deepEqual(errors, []);
  assert.deepEqual(failedResponses, []);
  checks.push('Empty standard home also works under the mount');
  await writeFile(
    join(evidence, 'static-browser.json'),
    JSON.stringify({ status: 'passed', checks, errors, failedResponses }, null, 2),
  );
  console.log(JSON.stringify({ status: 'passed', checks, errors, failedResponses }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ errors, failedResponses }));
  throw error;
} finally {
  await browser.close();
  if (server) await new Promise((accept) => server.close(accept));
  await rm(work, { recursive: true, force: true });
}
