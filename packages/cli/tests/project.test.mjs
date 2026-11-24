import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'dist/bin/slidock.js');

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slidock-cli-project-'));
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

function json(result) {
  assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
  return JSON.parse(result.stdout);
}

test('legacy CLI delegates create and new config checks to the framework project CLI', async () => {
  await withTempDir(async (cwd) => {
    const created = run(['create', 'slides-site', '--json'], cwd);
    assert.equal(created.status, 0, created.stderr);
    const createdEnvelope = json(created);
    assert.equal(createdEnvelope.command, 'slidock create');
    assert.deepEqual(createdEnvelope.result.files.slice(0, 3), [
      'slidock.config.ts',
      'slides/welcome/slides.md',
      'slides/second/slides.md',
    ]);
    const scaffoldFiles = createdEnvelope.result.files;
    assert.ok(scaffoldFiles.includes('package.json'));
    assert.ok(scaffoldFiles.includes('.gitignore'));
    assert.deepEqual(createdEnvelope.result.instructions, ['npm install', 'npm run dev']);
    const projectManifest = JSON.parse(
      await readFile(path.join(cwd, 'slides-site/package.json'), 'utf8'),
    );
    const frameworkManifest = JSON.parse(
      await readFile(path.resolve(packageRoot, '../slidock/package.json'), 'utf8'),
    );
    assert.equal(projectManifest.devDependencies['@slidock/slidock'], frameworkManifest.version);
    assert.deepEqual(projectManifest.scripts, {
      dev: 'slidock dev',
      build: 'slidock build',
      preview: 'slidock preview',
    });

    const humanCreate = run(['create', 'human-site'], cwd);
    assert.equal(humanCreate.status, 0, humanCreate.stderr);
    assert.equal(humanCreate.stdout, '');
    assert.match(humanCreate.stderr, /cd "human-site"/u);
    assert.match(humanCreate.stderr, /npm install/u);
    assert.match(humanCreate.stderr, /npm run dev/u);

    const configDir = path.join(cwd, 'configured');
    const sourceRoot = path.join(configDir, 'talks');
    await mkdir(path.join(sourceRoot, 'intro'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'intro', 'slides.md'), '# Intro\n');
    await writeFile(
      path.join(configDir, 'slidock.config.mjs'),
      "export default { sourceRoot: './talks', outDir: './built' };\n",
    );
    const checked = run(['check', '--config', 'configured/slidock.config.mjs', '--json'], cwd);
    assert.equal(checked.status, 0, checked.stderr);
    const checkedEnvelope = json(checked);
    assert.equal(checkedEnvelope.command, 'slidock check');
    assert.deepEqual(checkedEnvelope.result.deckIds, ['intro']);
    assert.equal(checkedEnvelope.result.sourceRoot, sourceRoot);
    assert.equal(checkedEnvelope.result.outDir, path.join(configDir, 'built'));
  });
});

test('legacy hub.config.json still uses the remote CLI check envelope and its existing schema', async () => {
  await withTempDir(async (cwd) => {
    const sourceRoot = path.join(cwd, 'slides', 'course');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, 'slides.md'), '# Course\n');
    await writeFile(
      path.join(cwd, 'hub.config.json'),
      JSON.stringify({ schemaVersion: 1, sourceRoot: './slides', outDir: './dist' }),
    );

    const checked = run(['check', '--json'], cwd);
    assert.equal(checked.status, 0, checked.stderr);
    const result = json(checked);
    assert.equal(result.command, 'slidock check');
    assert.deepEqual(result.data.deckIds, ['course']);
    assert.equal(result.data.sourceRoot, path.join(cwd, 'slides'));
    await assert.rejects(readFile(result.data.outDir));
  });
});
