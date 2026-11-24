import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { changedPaths, selectSuites } from './ci-changes.mjs';

const enabled = (paths) =>
  Object.entries(selectSuites(paths))
    .filter(([, value]) => value)
    .map(([key]) => key);
const all = ['portable', 'framework', 'server', 'native'];

test('shared inputs and unknown paths run every heavy suite', () => {
  for (const path of [
    '.github/workflows/checks.yml',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'scripts/verify-portable.mjs',
    'packages/protocol/src/index.ts',
    'packages/slidev-adapter/src/index.ts',
    'packages/slidock/src/node/index.ts',
    'packages/new-package/src/index.ts',
    'LICENSE',
  ]) {
    assert.deepEqual(enabled([path]), all, path);
  }
});

test('dedicated inputs select their consumers and combine across files', () => {
  assert.deepEqual(enabled(['docs/DEVELOPMENT.md', 'TODO.md']), []);
  assert.deepEqual(enabled(['apps/slidock-server/src/start.ts']), ['server']);
  assert.deepEqual(enabled(['packages/renderer-playwright/src/index.ts']), ['server']);
  assert.deepEqual(enabled(['apps/slive/src/home.ts']), ['portable', 'native']);
  assert.deepEqual(enabled(['apps/slidock-worker/runtime/entry.ts']), [
    'portable',
    'server',
    'native',
  ]);
  assert.deepEqual(enabled(['packages/cli/src/index.ts']), ['portable', 'server', 'native']);
  assert.deepEqual(enabled(['examples/custom-frontend/App.vue']), [
    'portable',
    'framework',
    'native',
  ]);
  assert.deepEqual(
    enabled(['examples/fixtures/aaa/slides.md', 'packages/storage-s3/src/index.ts']),
    all,
  );
});

test('push compares the entire pushed range and includes deleted paths', () => {
  const before = 'a'.repeat(40);
  const after = 'b'.repeat(40);
  const paths = changedPaths('push', { before, after }, (...args) => {
    assert.deepEqual(args, ['diff', '--name-only', '--no-renames', '-z', before, after, '--']);
    return Buffer.from('apps/slive/old.ts\0docs/new.md\0');
  });
  assert.deepEqual(enabled(paths), ['portable', 'native']);
});

test('pull request compares its merge base with the source head', () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const mergeBase = 'c'.repeat(40);
  const calls = [];
  const paths = changedPaths(
    'pull_request',
    { pull_request: { base: { sha: base }, head: { sha: head } } },
    (...args) => {
      calls.push(args);
      return calls.length === 1 ? `${mergeBase}\n` : 'packages/protocol/deleted.ts\0';
    },
  );
  assert.deepEqual(calls, [
    ['merge-base', base, head],
    ['diff', '--name-only', '--no-renames', '-z', mergeBase, head, '--'],
  ]);
  assert.deepEqual(enabled(paths), all);
});

test('manual runs, first pushes and unavailable history require all suites', () => {
  assert.throws(() => changedPaths('workflow_dispatch', {}), /run all suites/);
  assert.throws(
    () => changedPaths('push', { before: '0'.repeat(40), after: 'b'.repeat(40) }),
    /run all suites/,
  );
  assert.throws(() =>
    changedPaths('push', { before: 'a'.repeat(40), after: 'b'.repeat(40) }, () => {
      throw new Error('unavailable history');
    }),
  );
});

test('CLI writes all suite outputs when manual or comparison history is unavailable', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'slidock-ci-changes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const eventPath = join(directory, 'event.json');
  const outputPath = join(directory, 'outputs');
  for (const [eventName, event] of [
    ['workflow_dispatch', {}],
    ['push', { before: '0'.repeat(40), after: 'b'.repeat(40) }],
    ['push', { before: 'a'.repeat(40), after: 'b'.repeat(40) }],
  ]) {
    writeFileSync(eventPath, JSON.stringify(event));
    writeFileSync(outputPath, '');
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./ci-changes.mjs', import.meta.url))],
      {
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: eventName,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(outputPath, 'utf8'),
      'portable=true\nframework=true\nserver=true\nnative=true\n',
    );
  }
});
