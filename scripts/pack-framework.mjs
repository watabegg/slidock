import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
export const frameworkVersion = '0.1.0-alpha.1';
export const packageNames = ['protocol', 'slidev-adapter', 'slidock'];
const outputRoot = join(repository, 'artifacts/framework-v01/packed');

function runProcess(command, args, { cwd = repository } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.once('error', reject);
    child.once('close', (code) => accept({ code, stdout, stderr }));
  });
}

function assertPackPath(path) {
  const rel = relative(outputRoot, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`Refusing to stage outside the generated packaging directory: ${path}`);
}

async function copyPackageFile(sourceRoot, stageRoot, file) {
  const source = resolve(sourceRoot, file);
  const destination = resolve(stageRoot, file);
  const rel = relative(stageRoot, destination);
  if (rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error(`Package files entry escapes its package: ${file}`);
  await cp(source, destination, { recursive: true, dereference: false });
}

function assertReleaseManifest(manifest, name) {
  if (manifest.private)
    throw new Error(
      `${name} is private in the source manifest; the release staging copy must be publishable`,
    );
  if (manifest.version !== frameworkVersion)
    throw new Error(`${name} staged at ${manifest.version}, expected ${frameworkVersion}`);
  if (manifest.license !== 'MIT') throw new Error(`${name} must declare the approved MIT license`);
  if (!manifest.files?.length) throw new Error(`${name} must define an npm files allowlist`);
  for (const dependencyType of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const dependencies = manifest[dependencyType] || {};
    for (const [dependency, version] of Object.entries(dependencies)) {
      if (dependency === '@slidock/cli') throw new Error(`${name} must not depend on @slidock/cli`);
      if (dependency.startsWith('@slidock/')) {
        if (!packageNames.some((packageName) => dependency === `@slidock/${packageName}`))
          throw new Error(`${name} has an unsupported internal release dependency: ${dependency}`);
        if (version !== frameworkVersion)
          throw new Error(
            `${name} dependency ${dependency} resolved to ${version}, expected ${frameworkVersion}`,
          );
      }
      if (typeof version === 'string' && /^(?:workspace:|file:|link:)/.test(version))
        throw new Error(`${name} contains a non-registry dependency: ${dependency}@${version}`);
    }
  }
}

function assertPackedFiles(name, files) {
  const paths = files.map(({ path }) => path);
  for (const path of paths) {
    if (
      path.startsWith('node_modules/') ||
      path.startsWith('artifacts/') ||
      path.startsWith('.git/') ||
      path === '.npmrc' ||
      path === 'package-lock.json' ||
      path === 'pnpm-lock.yaml' ||
      /(?:^|\/)(?:\.env(?:\.|$)|[^/]*\.log$|[^/]*\.local$)/.test(path)
    ) {
      throw new Error(`${name} tarball includes a local or generated file: ${path}`);
    }
  }
  for (const required of ['package.json', 'README.md', 'LICENSE']) {
    if (!paths.includes(required)) throw new Error(`${name} tarball is missing ${required}`);
  }
  return paths;
}

async function assertNoWorkspacePath(stagePackage, name, paths) {
  const workspacePath = Buffer.from(resolve(repository));
  for (const path of paths) {
    const contents = await readFile(join(stagePackage, path));
    if (contents.includes(workspacePath))
      throw new Error(`${name} package embeds the local repository path in ${path}`);
  }
}

export async function packFramework(destination = outputRoot) {
  const output = resolve(destination);
  assertPackPath(output);
  const stageRoot = join(output, 'stage');
  const tarballRoot = join(output, 'tarballs');
  const licensePath = join(repository, 'LICENSE');
  const license = await readFile(licensePath, 'utf8');
  if (!license.startsWith('MIT License\n'))
    throw new Error('Root LICENSE is not the approved MIT license');
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });
  await mkdir(tarballRoot, { recursive: true });

  const packages = [];
  for (const packageName of packageNames) {
    const sourceRoot = join(repository, 'packages', packageName);
    const sourceManifest = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
    const stagePackage = join(stageRoot, packageName);
    assertPackPath(stagePackage);
    await mkdir(stagePackage, { recursive: true });

    const manifest = structuredClone(sourceManifest);
    delete manifest.private;
    manifest.version = frameworkVersion;
    manifest.license = 'MIT';
    for (const dependencyType of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const dependency of Object.keys(manifest[dependencyType] || {})) {
        if (dependency.startsWith('@slidock/'))
          manifest[dependencyType][dependency] = frameworkVersion;
      }
    }
    assertReleaseManifest(manifest, manifest.name);
    await writeFile(join(stagePackage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(stagePackage, 'LICENSE'), license);

    for (const file of manifest.files) await copyPackageFile(sourceRoot, stagePackage, file);
    const readme = join(sourceRoot, 'README.md');
    try {
      await cp(readme, join(stagePackage, 'README.md'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const packed = await runProcess(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballRoot],
      { cwd: stagePackage },
    );
    if (packed.code !== 0)
      throw new Error(`npm pack failed for ${manifest.name}: ${packed.stderr || packed.stdout}`);
    const [packInfo] = JSON.parse(packed.stdout);
    const packedPaths = assertPackedFiles(manifest.name, packInfo.files);
    await assertNoWorkspacePath(stagePackage, manifest.name, packedPaths);
    const declaredFiles = [
      ...Object.values(manifest.exports || {}).flatMap((entry) => {
        if (typeof entry === 'string') return [entry];
        if (!entry || typeof entry !== 'object') return [];
        return Object.values(entry).filter((value) => typeof value === 'string');
      }),
      ...Object.values(manifest.bin || {}),
    ].map((path) => path.replace(/^\.\//, ''));
    for (const path of declaredFiles) {
      if (!packedPaths.includes(path))
        throw new Error(`${manifest.name} export/bin target is not packed: ${path}`);
    }
    const tarball = join(tarballRoot, packInfo.filename);
    const bytes = await readFile(tarball);
    packages.push({
      name: manifest.name,
      version: manifest.version,
      manifest,
      filename: packInfo.filename,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sha512: createHash('sha512').update(bytes).digest('base64'),
      shasum: createHash('sha1').update(bytes).digest('hex'),
      files: packedPaths,
      dependencies: manifest.dependencies || {},
    });
  }

  const framework = packages.find(({ name }) => name === '@slidock/slidock');
  if (!framework) throw new Error('Framework package was not staged');
  if (framework.dependencies['playwright-core'] !== '1.63.0')
    throw new Error(
      'Framework package must install playwright-core 1.63.0 without a browser download dependency',
    );
  if (Object.keys(framework.dependencies).includes('playwright-chromium'))
    throw new Error(
      'Framework package must not install the browser-bundling playwright-chromium package',
    );
  const frameworkFiles = new Set(framework.files);
  for (const required of ['dist/node/index.js', 'dist/node/index.d.ts', 'src/frontend/index.ts']) {
    if (!frameworkFiles.has(required))
      throw new Error(`Framework package tarball is missing public entry ${required}`);
  }
  const sourceVersions = {};
  for (const packageName of packageNames) {
    const manifest = JSON.parse(
      await readFile(join(repository, 'packages', packageName, 'package.json'), 'utf8'),
    );
    sourceVersions[manifest.name] = manifest.version;
    if (manifest.version !== '0.1.0')
      throw new Error(`${manifest.name} source version changed unexpectedly: ${manifest.version}`);
  }
  const releaseSetHash = createHash('sha256')
    .update(packages.map(({ name, sha256 }) => `${name}\0${sha256}`).join('\n'))
    .digest('hex');
  const report = {
    status: 'passed',
    version: frameworkVersion,
    installEntry: '@slidock/slidock',
    packageCount: packages.length,
    releaseSetHash,
    sourceVersions,
    sourceVersionPreserved: true,
    packages,
  };
  await writeFile(join(output, 'pack-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return { output, tarballRoot, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { report } = await packFramework();
  console.log(JSON.stringify(report, null, 2));
}
