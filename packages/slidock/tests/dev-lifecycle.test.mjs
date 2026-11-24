import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { devHub } from '../dist/node/index.js';
import { resolveDeckRoute } from '../dist/node/internal/dev.mjs';
import {
  normalizeBasePath,
  stripBasePath,
  withBasePath,
} from '../dist/node/internal/base-path.mjs';
import { injectHomeConfig, injectSiteBase } from '../dist/node/internal/home-config.mjs';

test(
  'development discovers a deck created during the initial watcher scan',
  { timeout: 120_000 },
  async (t) => {
    const repository = fileURLToPath(new URL('../../../', import.meta.url));
    const require = createRequire(import.meta.url);
    await mkdir(join(repository, 'artifacts'), { recursive: true });
    const root = await mkdtemp(join(repository, 'artifacts/dev-scan-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourceRoot = join(root, 'slides');
    await mkdir(sourceRoot);
    const markdown = (title) => `---\ntitle: ${title}\nfonts:\n  webfonts: []\n---\n# ${title}\n`;
    await writeFile(join(sourceRoot, 'welcome.md'), markdown('Welcome'));

    let createdDuringScan = false;
    const readdir = fs.readdir;
    // Chokidar uses callback readdir; catalog discovery uses fs/promises. Insert
    // the deck after the catalog snapshot, before the watcher's first read.
    t.mock.method(fs, 'readdir', function (path, ...args) {
      if (String(path) === sourceRoot && !createdDuringScan) {
        createdDuringScan = true;
        fs.mkdirSync(join(sourceRoot, 'third'));
        fs.writeFileSync(join(sourceRoot, 'third/slides.md'), markdown('Third'));
      }
      return readdir.call(this, path, ...args);
    });

    const server = await devHub({
      sourceRoot,
      outDir: join(root, 'dist'),
      dependencyRoot: repository,
      theme: dirname(require.resolve('@slidev/theme-default/package.json')),
      allowEmpty: true,
      thumbnails: 'none',
      offline: false,
      port: 0,
    });
    try {
      const deadline = Date.now() + 30_000;
      let ids;
      while (Date.now() < deadline) {
        const response = await fetch(new URL('catalog.json', server.url), {
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200);
        ids = (await response.json()).decks.map(({ id }) => id);
        if (ids.includes('third')) break;
        await delay(100);
      }
      assert.equal(createdDuringScan, true, 'the initial watcher scan must exercise the race');
      assert.deepEqual(ids, ['third', 'welcome']);
    } finally {
      await server.close();
    }
  },
);

test('development routing decodes IDs and chooses the longest overlapping deck route', () => {
  const decks = [{ id: 'Guide' }, { id: 'Guide/Advanced' }, { id: 'Apple Basic/demo' }];

  assert.equal(resolveDeckRoute('/Guide/1', decks).id, 'Guide');
  assert.equal(resolveDeckRoute('/Guide/Advanced/2', decks).id, 'Guide/Advanced');
  assert.equal(resolveDeckRoute('/Apple%20Basic/demo/3', decks).id, 'Apple Basic/demo');
  assert.equal(resolveDeckRoute('/Guides/1', decks), null);
  assert.equal(resolveDeckRoute('/Guide/%E0%A4%A', decks), null);
});

test('development base paths normalize, route, and prefix public URLs', () => {
  const base = normalizeBasePath('/slides');

  assert.equal(base, '/slides/');
  assert.equal(withBasePath(base, '/catalog.json'), '/slides/catalog.json');
  assert.equal(stripBasePath('/slides/Apple%20Basic/demo/1', base), '/Apple%20Basic/demo/1');
  assert.equal(stripBasePath('/catalog.json', base), null);
});

test('development documents carry the canonical site base metadata', () => {
  const html = injectSiteBase('<html><head></head><body></body></html>', '/slides/');

  assert.match(html, /<meta name="slidock-base" content="\/slides\/">/u);
});

test('home settings are inert JSON with script-breaking characters escaped', () => {
  const home = { title: '</script><script>alert(1)</script>', description: 'a&b\u2028c' };
  const html = injectHomeConfig('<html><head></head><body></body></html>', home);
  const script = html.match(
    /<script id="slidock-home-config" type="application\/json">([\s\S]*?)<\/script>/u,
  )[0];
  const payload = html.match(
    /<script id="slidock-home-config" type="application\/json">([\s\S]*?)<\/script>/u,
  )[1];

  assert.equal(JSON.parse(payload).title, home.title);
  assert.equal(JSON.parse(payload).description, home.description);
  assert.match(payload, /\\u003c\/script\\u003e/u);
  assert.doesNotMatch(payload, /<\/script/iu);
  assert.ok(html.indexOf(script) < html.indexOf('</head>'));
});
