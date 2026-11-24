import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { HubBuildError, normalizeHubConfig } from '../dist/node/config.js';
import { defineConfig, loadProject } from '../dist/node/project.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'dist/node/bin/slidock.js');

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slidock-project-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function run(args, cwd) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function envelope(result) {
  assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
  return JSON.parse(result.stdout);
}

function configError(pattern) {
  return (error) =>
    error instanceof HubBuildError && error.code === 'CONFIG' && pattern.test(error.message);
}

test('defineConfig preserves its argument and new defaults are rooted at the config directory', async () => {
  const config = { home: { title: 'Typed home' } };
  assert.equal(defineConfig(config), config);

  await withTempDir(async (root) => {
    const configDir = path.join(root, 'nested', 'site');
    const sourceRoot = path.join(configDir, 'slides');
    await mkdir(path.join(sourceRoot, 'welcome'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'welcome', 'slides.md'), '# Welcome\n');
    await writeFile(
      path.join(configDir, 'slidock.config.mjs'),
      "export default { sourceRoot: './slides', outDir: './public', home: { title: 'Nested' } };\n",
    );

    const loaded = await loadProject({ root, config: 'nested/site/slidock.config.mjs' });
    assert.equal(loaded.root, root);
    assert.equal(loaded.configPath, path.join(configDir, 'slidock.config.mjs'));
    assert.equal(loaded.options.baseDir, configDir);
    assert.equal(loaded.options.sourceRoot, './slides');
    assert.equal(loaded.options.outDir, './public');
    assert.deepEqual(loaded.options.include, ['**/slides.md']);
    assert.equal(loaded.options.offline, false);
    assert.equal(loaded.options.thumbnails, 'none');
    assert.equal(loaded.options.compatibilityGroups, true);
    assert.equal(loaded.options.allowEmpty, true);

    const normalized = await normalizeHubConfig(loaded.options);
    assert.equal(normalized.sourceRoot, sourceRoot);
    assert.equal(normalized.outDir, path.join(configDir, 'public'));
    assert.deepEqual(
      normalized.decks.map((deck) => deck.id),
      ['welcome'],
    );
  });
});

test('TypeScript config imports work and theme package names resolve from the project/toolchain', async () => {
  await withTempDir(async (root) => {
    await writeFile(
      path.join(root, 'slidock.config.ts'),
      "const config = { theme: '@slidev/theme-default', home: { title: 'TS config' } } satisfies { theme: string; home: { title: string } };\nexport default config;\n",
    );
    const loaded = await loadProject({ root });
    assert.equal(loaded.configPath, path.join(root, 'slidock.config.ts'));
    assert.equal(loaded.options.home.title, 'TS config');
    assert.match(loaded.options.theme, /theme-default/u);
    assert.equal(path.isAbsolute(loaded.options.theme), true);
  });
});

test('legacy JSON config requires schemaVersion and retains legacy build defaults', async () => {
  await withTempDir(async (root) => {
    const sourceRoot = path.join(root, 'slides', 'course');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, 'slides.md'), '# Course\n');
    const configPath = path.join(root, 'hub.config.json');
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, sourceRoot: './slides', outDir: './dist' }),
    );

    const loaded = await loadProject({ root });
    assert.equal(loaded.configPath, configPath);
    assert.equal(loaded.options.include, undefined);
    assert.equal(loaded.options.thumbnails, undefined);
    assert.equal(loaded.options.compatibilityGroups, undefined);
    const normalized = await normalizeHubConfig(loaded.options);
    assert.equal(normalized.offline, true);
    assert.equal(normalized.thumbnails, 'auto');
    assert.deepEqual(
      normalized.decks.map((deck) => deck.id),
      ['course'],
    );

    await writeFile(configPath, JSON.stringify({ sourceRoot: './slides' }));
    await assert.rejects(loadProject({ root }), configError(/requires schemaVersion 1/u));
  });
});

test('project config normalizes subpaths and rejects malformed paths and unknown fields', async () => {
  await withTempDir(async (root) => {
    await writeFile(path.join(root, 'slidock.config.json'), JSON.stringify({ basePath: '/docs' }));
    assert.equal((await loadProject({ root })).options.basePath, '/docs/');
    for (const basePath of ['https://example.com/', '//docs/', '/a/../b/', '/a?query', '/a%2fb/']) {
      await writeFile(path.join(root, 'slidock.config.json'), JSON.stringify({ basePath }));
      await assert.rejects(loadProject({ root }), configError(/basePath/u));
    }
    await writeFile(
      path.join(root, 'slidock.config.json'),
      JSON.stringify({ unknownSetting: true }),
    );
    await assert.rejects(loadProject({ root }), configError(/unknown key unknownSetting/u));
    await writeFile(
      path.join(root, 'slidock.config.json'),
      JSON.stringify({ home: { unknownHomeOption: true } }),
    );
    await assert.rejects(
      loadProject({ root }),
      configError(/home contains unknown key unknownHomeOption/u),
    );
  });
});

test('help and global argument failures use one JSON envelope', async () => {
  await withTempDir(async (cwd) => {
    for (const args of [
      ['--help', '--json'],
      ['--json', '--help'],
    ]) {
      const help = run(args, cwd);
      assert.equal(help.status, 0, help.stderr);
      const helpEnvelope = envelope(help);
      assert.equal(helpEnvelope.ok, true);
      assert.equal(helpEnvelope.command, 'slidock');
      assert.match(helpEnvelope.result.help, /create\|dev\|build\|preview\|check/u);
    }

    const invalid = run(['--bogus', '--json'], cwd);
    assert.equal(invalid.status, 2);
    const errorEnvelope = envelope(invalid);
    assert.equal(errorEnvelope.ok, false);
    assert.equal(errorEnvelope.command, 'slidock');
    assert.equal(errorEnvelope.error.code, 'INVALID_ARGUMENTS');

    const invalidAfterJson = run(['--json', '--bogus'], cwd);
    assert.equal(invalidAfterJson.status, 2);
    assert.equal(envelope(invalidAfterJson).ok, false);
  });
});

test('create preserves existing manifest and gitignore while writing two minimal decks', async () => {
  await withTempDir(async (cwd) => {
    const project = path.join(cwd, 'new-project');
    await mkdir(project);
    await writeFile(path.join(project, 'package.json'), '{"private":true,"name":"keep-me"}\n');
    await writeFile(path.join(project, '.gitignore'), 'keep-this\n');

    const created = run(['create', 'new-project', '--json'], cwd);
    assert.equal(created.status, 0, created.stderr);
    const result = envelope(created);
    assert.equal(result.ok, true);
    assert.equal(result.command, 'slidock create');
    assert.deepEqual(result.result.files, [
      'slidock.config.ts',
      'slides/welcome/slides.md',
      'slides/second/slides.md',
    ]);
    assert.deepEqual(result.result.instructions, ['npx slidock dev', 'npx slidock build']);
    assert.equal(
      await readFile(path.join(project, 'package.json'), 'utf8'),
      '{"private":true,"name":"keep-me"}\n',
    );
    assert.equal(await readFile(path.join(project, '.gitignore'), 'utf8'), 'keep-this\n');
    assert.match(await readFile(path.join(project, 'slidock.config.ts'), 'utf8'), /defineConfig/u);
    for (const entry of ['welcome', 'second']) {
      const source = await readFile(path.join(project, 'slides', entry, 'slides.md'), 'utf8');
      assert.match(source, /theme: '@slidev\/theme-default'/u);
      assert.match(source, /webfonts: \[\]/u);
    }
  });
});

test('create preflights every mandatory file and does not leave a partial scaffold on collision', async () => {
  await withTempDir(async (cwd) => {
    const project = path.join(cwd, 'collision');
    await mkdir(project);
    await writeFile(path.join(project, 'slidock.config.ts'), 'keep config\n');

    const created = run(['create', 'collision', '--json'], cwd);
    assert.equal(created.status, 2);
    const result = envelope(created);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'FILE_EXISTS');
    assert.equal(await readFile(path.join(project, 'slidock.config.ts'), 'utf8'), 'keep config\n');
    await assert.rejects(readFile(path.join(project, 'slides/welcome/slides.md')));
    await assert.rejects(readFile(path.join(project, 'package.json')));
  });
});

test('check resolves an explicit config relative to a nondefault working directory', async () => {
  await withTempDir(async (root) => {
    const configDir = path.join(root, 'config');
    const sourceRoot = path.join(configDir, 'talks');
    await mkdir(path.join(sourceRoot, 'intro'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'intro', 'slides.md'), '# Intro\n');
    await writeFile(
      path.join(configDir, 'slidock.config.mjs'),
      "export default { sourceRoot: './talks', outDir: './built' };\n",
    );

    const checked = run(['check', '--config', 'config/slidock.config.mjs', '--json'], root);
    assert.equal(checked.status, 0, checked.stderr);
    const result = envelope(checked);
    assert.equal(result.ok, true);
    assert.equal(result.command, 'slidock check');
    assert.equal(result.result.sourceRoot, sourceRoot);
    assert.equal(result.result.outDir, path.join(configDir, 'built'));
    assert.deepEqual(result.result.deckIds, ['intro']);
  });
});

test('preview serves an existing build after its configured source directory is gone', async () => {
  await withTempDir(async (cwd) => {
    const site = path.join(cwd, 'site');
    await mkdir(site);
    await writeFile(path.join(site, 'index.html'), '<h1>built site</h1>\n');
    await writeFile(
      path.join(cwd, 'slidock.config.mjs'),
      "export default { sourceRoot: './removed-source', outDir: './site' };\n",
    );

    const child = spawn(process.execPath, [binPath, 'preview', '--port', '0', '--json'], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    const ready = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error(`preview did not start: ${stderr}`)), 10_000);
      child.stdout.on('data', () => {
        const line = stdout.split('\n')[0];
        if (!line) return;
        clearTimeout(timer);
        accept(JSON.parse(line));
      });
      child.once('error', reject);
      child.once('close', (status) => reject(new Error(`preview exited ${status}: ${stderr}`)));
    });
    assert.equal(ready.ok, true);
    assert.equal(ready.command, 'slidock preview');
    assert.match(await (await fetch(ready.result.url)).text(), /built site/u);
    child.kill('SIGTERM');
    const [status] = await once(child, 'close');
    assert.equal(status, 143);
    assert.equal(stdout.trim().split('\n').length, 1, stdout);
  });
});
