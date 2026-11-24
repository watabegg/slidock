import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildHub } from '../dist/node/build.js';
import { normalizeHubConfig } from '../dist/node/config.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

async function temporary(t, prefix = 'slidock-collection-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeDeck(root, path) {
  const file = join(root, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, '# Collection fixture\n');
}

test('include/exclude globs map metadata before overrides and remove drafts', async (t) => {
  const root = await temporary(t);
  const sourceRoot = join(root, 'slides');
  await Promise.all(
    ['alpha/slides.md', 'beta/slides.md', 'gamma/slides.md', 'misc.md', 'README.md'].map((path) =>
      writeDeck(sourceRoot, path),
    ),
  );
  const cover = join(root, 'brand.svg');
  await writeFile(cover, '<svg xmlns="http://www.w3.org/2000/svg"/>\n');

  const config = await normalizeHubConfig({
    baseDir: root,
    sourceRoot: './slides',
    outDir: './out',
    include: ['**/slides.md', 'misc.md'],
    exclude: ['beta/**'],
    deckOptions: {
      alpha: { id: 'later', title: 'Alpha override', order: 2, cover: 'brand.svg' },
      gamma: { id: 'hidden', draft: true },
      misc: { id: 'early', order: -1 },
      temporarilyAbsent: { title: 'Future deck' },
    },
    allowEmpty: true,
  });

  assert.equal(config.selection, 'discover');
  assert.deepEqual(
    config.decks.map(({ id, title, order, draft }) => ({ id, title, order, draft })),
    [
      { id: 'early', title: undefined, order: -1, draft: false },
      { id: 'later', title: 'Alpha override', order: 2, draft: false },
    ],
  );
  assert.equal(config.decks[1].cover, cover);
  assert.equal(config.deckOptions.temporarilyAbsent.title, 'Future deck');

  await assert.rejects(
    normalizeHubConfig({
      baseDir: root,
      sourceRoot: './slides',
      outDir: './invalid-options',
      deckOptions: { temporarilyAbsent: { order: Number.NaN } },
    }),
    /finite number/,
  );
  await assert.rejects(
    normalizeHubConfig({
      baseDir: root,
      sourceRoot: './slides',
      outDir: './invalid-id',
      deckOptions: { '../invalid': { title: 'Future deck' } },
    }),
    /invalid deck id/,
  );
});

test(
  'built output omits drafts, preserves explicit order and emits correct static image assets',
  {
    timeout: 240_000,
  },
  async (t) => {
    const root = await temporary(t);
    const cover = join(root, 'brand.svg');
    await writeFile(
      cover,
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675"><rect width="1200" height="675" fill="green"/></svg>\n',
    );
    const result = await buildHub({
      baseDir: root,
      sourceRoot: join(repository, 'examples/fixtures'),
      outDir: join(root, 'site'),
      offline: false,
      thumbnails: 'none',
      compatibilityGroups: true,
      include: ['aaa/**', 'bbb/bbb1/**'],
      deckOptions: {
        'aaa/aaa1': { id: 'z-deck', title: 'Covered title', order: 5, cover: 'brand.svg' },
        'aaa/aaa2': { draft: true },
        'bbb/bbb1': { id: 'a-deck', title: 'Placeholder title', order: -1 },
      },
      home: { title: 'Example </script><script>bad()</script>', hero: true },
    });

    const site = join(root, 'site');
    const expectedIds = ['a-deck', 'z-deck'];
    assert.deepEqual(
      result.catalog.decks.map(({ id }) => id),
      expectedIds,
    );
    assert.deepEqual(
      result.diagnostics.groupSummary.flatMap((group) => group.deckIds),
      expectedIds,
    );
    const manifest = JSON.parse(await readFile(join(site, 'manifest.json'), 'utf8'));
    assert.deepEqual(
      manifest.groups.flatMap((group) => group.decks),
      expectedIds,
    );
    assert(!JSON.stringify(manifest).includes('aaa/aaa2'));
    assert(!JSON.stringify(result.receipt).includes('aaa/aaa2'));

    const placeholder = manifest.decks.find(({ id }) => id === 'a-deck');
    const covered = manifest.decks.find(({ id }) => id === 'z-deck');
    assert.equal(placeholder.thumbnail.src, '/thumbnails/a-deck.svg');
    assert.equal(covered.thumbnail.src, '/covers/z-deck.svg');
    assert(placeholder.assets.includes('thumbnails/a-deck.svg'));
    assert(covered.assets.includes('covers/z-deck.svg'));
    assert(!placeholder.assets.some((asset) => asset.endsWith('.png')));
    assert(!covered.assets.some((asset) => asset.endsWith('.png')));
    await stat(join(site, 'thumbnails/a-deck.svg'));
    await stat(join(site, 'covers/z-deck.svg'));

    for (const group of manifest.groups) {
      const groupRoot = join(site, '_profiles', group.id);
      const groupCatalog = JSON.parse(await readFile(join(groupRoot, 'catalog.json'), 'utf8'));
      const groupManifest = JSON.parse(await readFile(join(groupRoot, 'manifest.json'), 'utf8'));
      for (const rootDeckId of group.decks) {
        const rootDeck = manifest.decks.find(({ id }) => id === rootDeckId);
        assert(rootDeck, `missing root deck ${rootDeckId}`);
        for (const groupDocument of [groupCatalog, groupManifest]) {
          const groupDeck = groupDocument.decks.find(({ id }) => id === rootDeckId);
          assert(groupDeck, `missing ${rootDeckId} in ${group.id} metadata`);
          assert.deepEqual(groupDeck.thumbnail, rootDeck.thumbnail);
          await stat(join(site, decodeURIComponent(rootDeck.thumbnail.src.slice(1))));
          if (groupDocument === groupManifest)
            assert(!groupDeck.assets.includes(decodeURIComponent(rootDeck.thumbnail.src.slice(1))));
        }
      }
    }

    const catalogDeck = result.catalog.decks.find(({ id }) => id === 'z-deck');
    assert.equal(catalogDeck.title, 'Covered title');
    assert.equal(catalogDeck.thumbnail.src, '/covers/z-deck.svg');
    const home = await readFile(join(site, 'index.html'), 'utf8');
    const deckFallback = await readFile(join(site, '404.html'), 'utf8');
    assert(home.includes('id="slidock-home-config" type="application/json"'));
    assert(home.includes('\\u003c/script\\u003e'));
    assert(!home.includes('</script><script>bad()'));
    assert(!deckFallback.includes('slidock-home-config'));
    assert(result.diagnostics.groupSummary.every((group) => group.reason === 'compatible'));
  },
);

test(
  'allowEmpty builds an offline home without deck runtime or thumbnail capture',
  { timeout: 120_000 },
  async (t) => {
    const root = await temporary(t, 'slidock-empty-collection-');
    const sourceRoot = join(root, 'slides');
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'README.md'), 'No deck here.\n');
    const result = await buildHub({
      baseDir: root,
      sourceRoot,
      outDir: join(root, 'site'),
      allowEmpty: true,
      thumbnails: 'none',
      offline: true,
      home: { title: 'Empty collection' },
    });

    assert.deepEqual(result.catalog.decks, []);
    assert.deepEqual(result.diagnostics.groupSummary, []);
    const manifest = JSON.parse(await readFile(join(root, 'site', 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.decks, []);
    assert(manifest.commonAssets.includes('favicon.svg'));
    assert(manifest.commonAssets.some((asset) => asset.startsWith('assets/')));
    assert.deepEqual(JSON.parse(await readFile(join(root, 'site', 'native-player.json'), 'utf8')), {
      schemaVersion: 1,
      protocolVersion: 1,
      decks: [],
      unsupportedDecks: [],
    });
  },
);
