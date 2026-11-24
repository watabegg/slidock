import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildHub } from '../dist/node/build.js';
import { compileContract, stableJson } from '../dist/node/internal/profile-contract.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'slidock-profile-groups-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function compileOptions(userRoot, themeRoot = '/themes/default') {
  return {
    userRoot,
    data: { config: { themeConfig: {} }, features: { monaco: false } },
    roots: [themeRoot, userRoot],
    clientRoot: '/slidev/client',
  };
}

test('only plain deck roots normalize while local shared inputs and theme roots remain isolated', async (t) => {
  const root = await temporary(t);
  const first = join(root, 'slides', 'first');
  const second = join(root, 'slides', 'second');
  await Promise.all(
    [first, second].map((deckRoot) =>
      mkdir(join(deckRoot, 'node_modules', '.slidev', 'virtual'), { recursive: true }),
    ),
  );
  await writeFile(join(root, 'package.json'), '{}\n');

  const firstOptions = compileOptions(first);
  const secondOptions = compileOptions(second);
  assert.equal(
    stableJson(compileContract(firstOptions)),
    stableJson(compileContract(secondOptions)),
  );

  const otherProject = join(root, 'other-project');
  const otherDeck = join(otherProject, 'slides', 'second');
  await mkdir(otherDeck, { recursive: true });
  await writeFile(join(otherProject, 'package.json'), '{}\n');
  assert.notEqual(
    stableJson(compileContract(secondOptions)),
    stableJson(compileContract(compileOptions(otherDeck))),
  );

  await writeFile(join(first, 'style.css'), '.deck { color: red; }\n');
  assert.notEqual(
    stableJson(compileContract(firstOptions)),
    stableJson(compileContract(secondOptions)),
  );

  const differentTheme = compileOptions(second, '/themes/seriph');
  assert.notEqual(
    stableJson(compileContract(secondOptions)),
    stableJson(compileContract(differentTheme)),
  );
});

test(
  'separate directories with the same theme build in one compatibility group',
  { timeout: 240_000 },
  async (t) => {
    const root = await temporary(t);
    const result = await buildHub({
      baseDir: repository,
      sourceRoot: join(repository, 'examples/fixtures'),
      outDir: join(root, 'site'),
      offline: false,
      thumbnails: 'none',
      compatibilityGroups: true,
      decks: [
        {
          id: 'first',
          entry: join(repository, 'examples/fixtures/aaa/aaa1/slides.md'),
        },
        {
          id: 'second',
          entry: join(repository, 'examples/fixtures/bbb/bbb1/slides.md'),
        },
      ],
    });

    assert.equal(result.diagnostics.groupSummary?.length, 1);
    assert.deepEqual(result.diagnostics.groupSummary?.[0]?.deckIds, ['first', 'second']);
    assert.equal(result.diagnostics.groupSummary?.[0]?.reason, 'compatible');
  },
);
