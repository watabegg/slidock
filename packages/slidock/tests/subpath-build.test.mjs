import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildHub } from '../dist/node/build.js';
import { fingerprintOfflineSite } from '../src/node/internal/fingerprint-offline.mjs';
import { makeNativeUnsupportedForSubpath } from '../src/node/internal/native-base-path.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const chromiumExecutable = process.env.CHROMIUM_EXECUTABLE || '/usr/bin/google-chrome';

async function temporary(t, prefix = 'slidock-subpath-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function theme(name) {
  return dirname(require.resolve(`@slidev/theme-${name}/package.json`, { paths: [repository] }));
}

test(
  'profile builds prefix public URLs while keeping files and manifest assets relative',
  { timeout: 300_000 },
  async (t) => {
    const root = await temporary(t);
    const sourceRoot = join(repository, 'examples/fixtures');
    const site = join(root, 'site');
    const cover = join(root, 'first-cover.svg');
    const ids = ['first', 'second', 'alternate'];
    await writeFile(
      cover,
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675"><rect width="1200" height="675" fill="navy"/></svg>\n',
    );
    const result = await buildHub({
      baseDir: repository,
      sourceRoot,
      outDir: site,
      basePath: '/slides/',
      offline: false,
      thumbnails: 'none',
      profiles: {
        standard: { dependencyRoot: repository, theme: theme('default') },
        serif: { dependencyRoot: repository, theme: theme('seriph') },
      },
      decks: [
        {
          id: 'first',
          entry: join(sourceRoot, 'aaa/aaa1/slides.md'),
          profile: 'standard',
          order: 1,
          cover,
        },
        {
          id: 'second',
          entry: join(sourceRoot, 'bbb/bbb1/slides.md'),
          profile: 'standard',
          order: 2,
        },
        {
          id: 'alternate',
          entry: join(sourceRoot, 'aaa/aaa2/slides.md'),
          profile: 'serif',
          order: 3,
        },
      ],
    });

    const manifest = JSON.parse(await readFile(join(site, 'manifest.json'), 'utf8'));
    const catalog = JSON.parse(await readFile(join(site, 'catalog.json'), 'utf8'));
    assert.equal(manifest.basePath, '/slides/');
    assert.equal(result.diagnostics.groupSummary.length, 2);
    assert.deepEqual(
      result.diagnostics.groupSummary.find((group) => group.deckIds.includes('first')).deckIds,
      ['first', 'second'],
    );
    assert.deepEqual(
      manifest.decks.map((deck) => deck.id),
      ids,
    );

    for (const deck of manifest.decks) {
      assert.equal(deck.entry, `/slides/${deck.id}/1`);
      const expectedAsset = deck.id === 'first' ? 'covers/first.svg' : `thumbnails/${deck.id}.svg`;
      assert.equal(deck.thumbnail.src, `/slides/${expectedAsset}`);
      assert(deck.assets.every((asset) => !asset.startsWith('/')));
      assert(deck.assets.includes(expectedAsset));
      await stat(join(site, expectedAsset));
      const catalogDeck = catalog.decks.find((item) => item.id === deck.id);
      assert.equal(catalogDeck.entry, deck.entry);
      assert.equal(catalogDeck.thumbnail.src, deck.thumbnail.src);
    }

    for (const group of manifest.groups) {
      assert.equal(group.assetBase, `/slides/_profiles/${group.id}/`);
      const groupRoot = join(site, '_profiles', group.id);
      const groupManifest = JSON.parse(await readFile(join(groupRoot, 'manifest.json'), 'utf8'));
      const groupCatalog = JSON.parse(await readFile(join(groupRoot, 'catalog.json'), 'utf8'));
      assert.equal(groupManifest.basePath, '/slides/');
      assert(
        (await readFile(join(groupRoot, 'index.html'), 'utf8')).includes('content="/slides/"'),
      );
      for (const id of group.decks) {
        const rootDeck = manifest.decks.find((deck) => deck.id === id);
        assert(
          (await readFile(join(site, id, 'index.html'), 'utf8')).includes('content="/slides/"'),
        );
        for (const document of [groupManifest, groupCatalog]) {
          const groupDeck = document.decks.find((deck) => deck.id === id);
          assert.deepEqual(groupDeck.thumbnail, rootDeck.thumbnail);
          assert.equal(groupDeck.entry, `/slides/${id}/1`);
          if (document === groupManifest)
            assert(groupDeck.assets.every((asset) => !asset.startsWith('/')));
        }
      }
    }

    assert(manifest.commonAssets.every((asset) => !asset.startsWith('/slides/')));
    const home = await readFile(join(site, 'index.html'), 'utf8');
    const fallback = await readFile(join(site, '404.html'), 'utf8');
    assert(home.includes('<meta name="slidock-base" content="/slides/">'));
    assert(fallback.includes('<meta name="slidock-base" content="/slides/">'));
    const native = JSON.parse(await readFile(join(site, 'native-player.json'), 'utf8'));
    assert.deepEqual(native.decks, []);
    assert.deepEqual(
      native.unsupportedDecks.map((deck) => deck.id),
      [...ids].sort(),
    );
    assert(native.unsupportedDecks.every((deck) => /root deployment path/u.test(deck.reason)));
    assert.equal(new Set(native.unsupportedDecks.map((deck) => deck.id)).size, ids.length);
  },
);

test('subpath native conversion preserves existing unsupported IDs and avoids duplicates', () => {
  const document = {
    schemaVersion: 1,
    protocolVersion: 1,
    decks: [{ id: 'supported', revision: 'a'.repeat(64), entry: '/supported/1', clickTotals: [0] }],
    unsupportedDecks: [{ id: 'legacy', reason: 'already unsupported by the parser' }],
  };
  const output = makeNativeUnsupportedForSubpath(
    document,
    [{ id: 'supported' }, { id: 'legacy' }],
    '/slides/',
  );

  assert.deepEqual(output.decks, []);
  assert.deepEqual(output.unsupportedDecks, [
    { id: 'legacy', reason: 'already unsupported by the parser' },
    { id: 'supported', reason: 'Native playback requires a root deployment path.' },
  ]);
  assert.equal(new Set(output.unsupportedDecks.map((deck) => deck.id)).size, 2);
  assert.equal(makeNativeUnsupportedForSubpath(document, [], '/'), document);
});

test('offline fingerprinting rewrites mounted profile asset URLs and relative imports', async (t) => {
  const site = await temporary(t, 'slidock-subpath-fingerprint-');
  const files = {
    '_profiles/g/assets/entry.js':
      'import "./chunk.js"; const preload = ["assets/modules/entry.css", "assets/modules/lazy.js"]; export const publicChunk = "/slides/_profiles/g/assets/chunk.js";',
    '_profiles/g/assets/chunk.js': 'export const value = 42;',
    '_profiles/g/assets/modules/entry.css': '.entry { color: navy; }',
    '_profiles/g/assets/modules/lazy.js': 'export const lazy = true;',
    'index.html': '<script type="module" src="/slides/_profiles/g/assets/entry.js"></script>',
    'manifest.json': JSON.stringify({
      basePath: '/slides/',
      commonAssets: ['_profiles/g/assets/entry.js'],
      decks: [{ entry: '/slides/first/1', assets: ['_profiles/g/assets/chunk.js'] }],
    }),
  };
  for (const [path, content] of Object.entries(files)) {
    const destination = join(site, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }

  const fingerprint = await fingerprintOfflineSite(site);
  const assetMap = new Map(fingerprint.assets.map(({ from, to }) => [from, to]));
  const html = await readFile(join(site, 'index.html'), 'utf8');
  const entryPath = assetMap.get('_profiles/g/assets/entry.js');
  const chunkPath = assetMap.get('_profiles/g/assets/chunk.js');
  const entryCssPath = assetMap.get('_profiles/g/assets/modules/entry.css');
  const lazyJsPath = assetMap.get('_profiles/g/assets/modules/lazy.js');
  assert(html.includes(`/slides/${entryPath}`));
  const entry = await readFile(join(site, entryPath), 'utf8');
  assert(entry.includes(`./${chunkPath.split('/').at(-1)}`));
  assert(entry.includes(`assets/modules/${entryCssPath.split('/').at(-1)}`));
  assert(entry.includes(`assets/modules/${lazyJsPath.split('/').at(-1)}`));
  assert(entry.includes(`/slides/_profiles/g/assets/${chunkPath.split('/').at(-1)}`));
  await stat(join(site, chunkPath));
  const manifest = JSON.parse(await readFile(join(site, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.commonAssets, [entryPath]);
  assert.deepEqual(manifest.decks[0].assets, [chunkPath]);
});

test(
  'automatic thumbnails capture the prefixed deck route',
  { timeout: 180_000, skip: !existsSync(chromiumExecutable) },
  async (t) => {
    const root = await temporary(t, 'slidock-subpath-thumbnail-');
    const sourceRoot = join(repository, 'examples/fixtures');
    const site = join(root, 'site');
    await buildHub({
      baseDir: repository,
      sourceRoot,
      outDir: site,
      basePath: '/slides/',
      offline: false,
      thumbnails: 'auto',
      chromiumExecutable,
      decks: [{ id: 'captured', entry: join(sourceRoot, 'aaa/aaa1/slides.md') }],
    });

    const manifest = JSON.parse(await readFile(join(site, 'manifest.json'), 'utf8'));
    assert.equal(manifest.decks[0].thumbnail.src, '/slides/thumbnails/captured.png');
    assert(manifest.decks[0].assets.includes('thumbnails/captured.png'));
    await stat(join(site, 'thumbnails/captured.png'));
  },
);

test(
  'empty offline Vue home keeps its mounted URLs valid through fingerprinting',
  { timeout: 240_000 },
  async (t) => {
    const root = await temporary(t, 'slidock-subpath-empty-');
    const sourceRoot = join(root, 'slides');
    const frontendEntry = join(root, 'pages', 'index.vue');
    const site = join(root, 'site');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'README.md'), 'No slides yet.\n');
    await mkdir(dirname(frontendEntry), { recursive: true });
    await writeFile(
      frontendEntry,
      `<template><main>{{ count }}</main></template><script setup>import { ref } from 'vue'; const count = ref('Subpath home')</script>\n`,
    );

    const result = await buildHub({
      baseDir: root,
      sourceRoot,
      frontendEntry,
      outDir: site,
      basePath: '/slides/',
      allowEmpty: true,
      thumbnails: 'none',
      offline: true,
      home: { title: 'Subpath home' },
    });

    assert.deepEqual(result.catalog.decks, []);
    const manifest = JSON.parse(await readFile(join(site, 'manifest.json'), 'utf8'));
    assert.equal(manifest.basePath, '/slides/');
    assert.deepEqual(JSON.parse(await readFile(join(site, 'native-player.json'), 'utf8')), {
      schemaVersion: 1,
      protocolVersion: 1,
      decks: [],
      unsupportedDecks: [],
    });
    const html = await readFile(join(site, 'index.html'), 'utf8');
    assert(html.includes('<meta name="slidock-base" content="/slides/">'));
    assert(html.includes('id="slidock-home-config" type="application/json"'));
    const jsReference = html.match(/\b(?:src|href)="(\/slides\/assets\/[^" ]+\.js)"/u)?.[1];
    assert(jsReference, `expected a mounted static JavaScript URL in ${html}`);
    const jsPath = jsReference.slice('/slides/'.length);
    assert.match(jsPath, /-offline-[a-f0-9]{64}\.js$/u);
    const js = await readFile(join(site, jsPath), 'utf8');
    assert(js.includes('Subpath home'));
    assert(manifest.commonAssets.includes(jsPath));
    await stat(join(site, jsPath));
  },
);
