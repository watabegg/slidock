import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadProject } from '../dist/node/project.js';
import { createServer } from '../dist/node/internal/serve.mjs';

test('project home follows pages/index.vue next to its config and explicit entries take priority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'slidock-pages-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'nested');
  const page = join(project, 'pages/index.vue');
  await mkdir(join(project, 'pages'), { recursive: true });
  const config = join(project, 'slidock.config.json');
  await writeFile(config, '{}');
  const load = () => loadProject({ root, config: 'nested/slidock.config.json' });
  assert.equal((await load()).options.frontendEntry, undefined);
  assert.equal((await load()).homePagePath, page);
  await writeFile(page, '<template>Custom home</template>');
  assert.equal((await load()).options.frontendEntry, page);
  await writeFile(config, JSON.stringify({ frontendEntry: './custom.ts' }));
  assert.equal((await load()).options.frontendEntry, './custom.ts');
  await writeFile(config, '{}');
  await rm(page);
  assert.equal((await load()).options.frontendEntry, undefined);
});

test('static server mounts built output below its recorded base and preserves deep links', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'slidock-mounted-serve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'course', 'intro'), { recursive: true });
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<h1>Home</h1>');
  await writeFile(join(root, 'course', 'intro', 'index.html'), '<h1>Deck</h1>');
  await writeFile(join(root, 'assets', 'test.js'), 'export const ready = true;');
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({ basePath: '/slides/', decks: [{ id: 'course/intro' }] }),
  );
  const server = createServer(root);
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  t.after(() => new Promise((accept) => server.close(accept)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const redirect = await fetch(`${origin}/slides?query=1`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/slides/?query=1');
  assert.match(await (await fetch(`${origin}/slides/`)).text(), /Home/);
  assert.match(await (await fetch(`${origin}/slides/course/intro/2`)).text(), /Deck/);
  assert.equal((await fetch(`${origin}/slides/assets/test.js`)).status, 200);
  assert.equal((await fetch(`${origin}/slides/course/intro/presenter/2`)).status, 200);
  for (const path of [
    '/',
    '/assets/test.js',
    '/slides-other/',
    '/slides/missing/1',
    '/slides/%2e%2e%2findex.html',
  ])
    assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
  assert.equal((await fetch(`${origin}/slides/assets/test.js`, { method: 'HEAD' })).status, 200);
});
