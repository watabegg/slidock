import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDeckRoute } from '../dist/node/internal/dev.mjs';
import {
  normalizeBasePath,
  stripBasePath,
  withBasePath,
} from '../dist/node/internal/base-path.mjs';
import { injectHomeConfig, injectSiteBase } from '../dist/node/internal/home-config.mjs';

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
