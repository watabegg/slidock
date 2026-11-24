import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { configureInstallRetries } from './consumer-install.mjs';

const run = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'slidock-registry-retries-'));
try {
  for (const manager of ['npm', 'pnpm']) {
    const root = join(temporary, manager);
    const source = join(root, 'source');
    const consumer = join(root, 'consumer');
    const name = `@slidock-retries/${randomUUID()}`;
    await mkdir(source, { recursive: true });
    await mkdir(consumer);
    await writeFile(join(source, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
    await run('tar', ['-czf', 'package.tgz', '--transform=s,^,package/,', 'package.json'], {
      cwd: source,
    });
    const tarball = await readFile(join(source, 'package.tgz'));
    const attempts = { metadata: 0, tarball: 0 };
    const server = createServer((request, response) => {
      const resource =
        decodeURIComponent(request.url) === `/${name}`
          ? 'metadata'
          : request.url === '/package.tgz'
            ? 'tarball'
            : undefined;
      if (!resource) return response.writeHead(404).end();
      attempts[resource]++;
      // Exceed the default two retries for metadata; also exercise tarball retries.
      if (attempts[resource] <= (resource === 'metadata' ? 3 : 1)) {
        response.writeHead(503).end('temporary registry failure');
        return;
      }
      if (resource === 'tarball') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(tarball);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          name,
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name,
              version: '1.0.0',
              dist: {
                tarball: `http://127.0.0.1:${server.address().port}/package.tgz`,
                integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
              },
            },
          },
        }),
      );
    });
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', accept);
    });
    try {
      await writeFile(
        join(consumer, 'package.json'),
        JSON.stringify({
          private: true,
          packageManager: 'pnpm@12.3.4',
          dependencies: { [name]: '1.0.0' },
        }),
      );
      await writeFile(
        join(consumer, '.npmrc'),
        `@slidock-retries:registry=http://127.0.0.1:${server.address().port}/\n`,
      );
      await run(
        manager,
        [
          'install',
          '--ignore-scripts',
          ...(manager === 'npm' ? ['--no-audit', '--no-fund'] : []),
          ...(await configureInstallRetries(consumer, manager)),
        ],
        { cwd: consumer, timeout: 90_000 },
      );
      assert.ok(attempts.metadata >= 4, JSON.stringify(attempts));
      assert.ok(attempts.tarball >= 2, JSON.stringify(attempts));
      const installed = JSON.parse(
        await readFile(join(consumer, 'node_modules', name, 'package.json'), 'utf8'),
      );
      assert.equal(installed.name, name);
      console.log(
        `${manager}: installed after metadata 503 x3 and tarball 503 x1 (${JSON.stringify(attempts)})`,
      );
    } finally {
      await new Promise((accept) => {
        server.close(accept);
        server.closeAllConnections();
      });
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
