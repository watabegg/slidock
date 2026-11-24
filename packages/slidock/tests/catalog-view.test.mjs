import assert from 'node:assert/strict';
import test from 'node:test';
import { selectCatalogDecks } from '../dist/client/index.js';

function deck(id, title, categoryPath, frontmatter = {}) {
  return {
    id,
    title,
    entry: `/${id}/`,
    pages: 4,
    revision: `revision-${id}`,
    categoryPath,
    frontmatter,
    thumbnail: { src: `/${id}.png`, width: 1200, height: 675 },
    runtimeVersion: '53.0.0',
    theme: 'default',
    profile: 'slidev53',
  };
}

const decks = [
  deck('science/physics/waves', 'Wave Motion', ['science', 'physics'], {
    description: 'An introduction to sound and light.',
    author: 'Mina Sato',
    tags: ['science', 'intro'],
    date: '2025-01-01',
  }),
  deck('science/chemistry', 'Atoms', ['science', 'chemistry'], {
    description: 'Matter at the smallest scale.',
    author: 'Riku Ito',
    tags: 'chemistry',
    date: 'not a date',
  }),
  deck('science-fiction/story', 'Wave Stories', ['science-fiction'], {
    author: 'A. Writer',
    tags: ['fiction', 'Science'],
    date: '2026-03-10',
  }),
  deck('history/astronomy', 'Atoms', ['history', 'astronomy'], {
    tags: ['intro'],
    date: '2026-03-10',
  }),
  deck('uncategorized', 'Unsorted', [], {}),
];

test('selectCatalogDecks applies trimmed case-insensitive public text query and category descendants', () => {
  assert.deepEqual(
    selectCatalogDecks(decks, { query: '  SOUND ', category: 'science' }).map(({ id }) => id),
    ['science/physics/waves'],
  );
  assert.deepEqual(
    selectCatalogDecks(decks, { query: 'mina', category: 'science' }).map(({ id }) => id),
    ['science/physics/waves'],
  );
  assert.deepEqual(
    selectCatalogDecks(decks, { category: 'science' }).map(({ id }) => id),
    ['science/physics/waves', 'science/chemistry'],
  );
  assert.deepEqual(
    selectCatalogDecks(decks, { category: 'science-fiction' }).map(({ id }) => id),
    ['science-fiction/story'],
  );
});

test('tag selection is exact and combines with query and category filters', () => {
  assert.deepEqual(
    selectCatalogDecks(decks, { category: 'science', tag: 'intro', query: 'wave' }).map(
      ({ id }) => id,
    ),
    ['science/physics/waves'],
  );
  assert.deepEqual(
    selectCatalogDecks(decks, { tag: 'Science' }).map(({ id }) => id),
    ['science-fiction/story'],
  );
  assert.deepEqual(
    selectCatalogDecks(decks, { tag: 'science' }).map(({ id }) => id),
    ['science/physics/waves'],
  );
});

test('sort modes are deterministic, preserve incoming ties, and return a new array', () => {
  const originalOrder = decks.map(({ id }) => id);
  const catalogOrder = selectCatalogDecks(decks);
  assert.deepEqual(
    catalogOrder.map(({ id }) => id),
    originalOrder,
  );
  assert.notEqual(catalogOrder, decks);
  assert.deepEqual(
    selectCatalogDecks(decks, { sort: 'title' }).map(({ id }) => id),
    [
      'history/astronomy',
      'science/chemistry',
      'uncategorized',
      'science/physics/waves',
      'science-fiction/story',
    ],
  );
  assert.deepEqual(
    selectCatalogDecks(decks, { sort: 'date' }).map(({ id }) => id),
    [
      'science-fiction/story',
      'history/astronomy',
      'science/physics/waves',
      'science/chemistry',
      'uncategorized',
    ],
  );
  assert.deepEqual(
    decks.map(({ id }) => id),
    originalOrder,
  );
});

test('search excludes catalog fields outside the public search contract', () => {
  assert.deepEqual(selectCatalogDecks(decks, { query: '53.0.0' }), []);
  assert.deepEqual(selectCatalogDecks(decks, { query: 'revision-science' }), []);
});
