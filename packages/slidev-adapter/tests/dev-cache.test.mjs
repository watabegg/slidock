import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { startSlidevDev } from '@slidock/slidev-adapter/dev-runtime';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const defaultTheme = dirname(require.resolve('@slidev/theme-default/package.json'));
const cachePrefix = 'slidock-vite-cache-';

async function cacheDirectories() {
  return (await readdir(tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(cachePrefix))
    .map((entry) => join(tmpdir(), entry.name));
}

test(
  'concurrent Slidev children use and clean separate Vite caches',
  { timeout: 120_000 },
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'slidev-dev-cache-test-'));
    const cacheRoot = join(fixture, 'cache-root');
    const entries = [join(fixture, 'first.md'), join(fixture, 'second.md')];
    const originalTmpdir = process.env.TMPDIR;
    const children = [];
    try {
      await mkdir(cacheRoot);
      process.env.TMPDIR = cacheRoot;
      await Promise.all(
        entries.map((entry, index) =>
          writeFile(
            entry,
            `---\ntitle: Child ${index + 1}\nfonts:\n  webfonts: []\n---\n# Child ${index + 1}\n`,
          ),
        ),
      );
      const results = await Promise.allSettled(
        entries.map(async (entry, index) => {
          const child = await startSlidevDev({
            dependencyRoot: repositoryRoot,
            entry,
            theme: defaultTheme,
            base: `/cache-child-${index + 1}/`,
          });
          children.push(child);
          return child;
        }),
      );
      const servers = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      const liveCaches = await cacheDirectories();
      assert.equal(liveCaches.length, 2, 'each running worker owns a separate cache directory');
      assert.equal(new Set(liveCaches).size, 2);

      for (const [index, server] of servers.entries()) {
        const response = await fetch(new URL(`cache-child-${index + 1}/1`, server.origin));
        assert.equal(response.status, 200);
        assert.match(await response.text(), /Child/);
      }
    } finally {
      await Promise.allSettled(children.map((child) => child.close()));
      const remaining = await cacheDirectories();
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
      await rm(fixture, { recursive: true, force: true });
      assert.deepEqual(remaining, [], 'closing workers removes their temporary Vite caches');
    }
  },
);
