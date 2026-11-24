import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHttpCatalogSource,
  createPaginatedCatalogSource,
  getSiteBasePath,
} from '../dist/client/index.js';

async function withBaseMeta(content, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector(selector) {
        assert.equal(selector, 'meta[name="slidock-base"]');
        return content === undefined ? null : { getAttribute: () => content };
      },
    },
  });
  try {
    await run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  }
}

test('getSiteBasePath accepts canonical mounts and falls back for invalid metadata', async () => {
  await withBaseMeta('/slides/', () => assert.equal(getSiteBasePath(), '/slides/'));
  for (const invalid of ['slides/', '//slides/', '/a/../b/', '/a%2fb/', '/a//', '/a?x/']) {
    await withBaseMeta(invalid, () => assert.equal(getSiteBasePath(), '/'));
  }
  await withBaseMeta(undefined, () => assert.equal(getSiteBasePath(), '/'));
});

test('default catalog requests use the site mount and explicit URLs remain unchanged', async () => {
  await withBaseMeta('/slides/', async () => {
    const requested = [];
    const fetch = async (url) => {
      requested.push(url);
      return { ok: true, json: async () => ({ schemaVersion: 1, categories: [], decks: [] }) };
    };

    await createHttpCatalogSource({ fetch }).load();
    await createPaginatedCatalogSource({ fetch }).load();
    await createHttpCatalogSource({ url: '/api/catalog.json', fetch }).load();

    assert.deepEqual(requested, [
      '/slides/catalog.json',
      '/slides/catalog.json',
      '/api/catalog.json',
    ]);
  });
});
