import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { frameworkVersion, packFramework } from './pack-framework.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const artifactRoot = join(repository, 'artifacts/framework-v01');
const frontendToolVersions = {
  '@vitejs/plugin-vue': '6.0.10',
  vite: '8.3.3',
  vue: '3.5.43',
  'vue-tsc': '3.3.12',
  typescript: '6.0.3',
};

function processResult(command, args, { cwd, env = process.env, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      accept({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function loadPreviouslyPackedFramework() {
  const output = join(repository, 'artifacts/framework-v01/packed');
  const savedReport = JSON.parse(await readFile(join(output, 'pack-report.json'), 'utf8'));
  assert(
    savedReport.status === 'passed',
    'existing pack report is not a successful framework pack',
  );
  assert(
    savedReport.version === frameworkVersion,
    `existing pack version is ${savedReport.version}`,
  );
  const tarballRoot = join(output, 'tarballs');
  const digestItems = [];
  const packages = [];
  for (const item of savedReport.packages) {
    const bytes = await readFile(join(tarballRoot, item.filename));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const sha512 = createHash('sha512').update(bytes).digest('base64');
    const shasum = createHash('sha1').update(bytes).digest('hex');
    assert(sha256 === item.sha256, `${item.filename} no longer matches pack-report.json`);
    assert(sha512 === item.sha512, `${item.filename} SHA-512 differs from pack-report.json`);
    assert(shasum === item.shasum, `${item.filename} SHA-1 differs from pack-report.json`);
    digestItems.push(`${item.name}\0${sha256}`);
    const manifest =
      item.manifest ??
      JSON.parse(
        await readFile(join(output, 'stage', item.name.split('/').at(-1), 'package.json'), 'utf8'),
      );
    assert(manifest.name === item.name, `${item.filename} manifest package name differs`);
    assert(manifest.version === frameworkVersion, `${item.filename} manifest version differs`);
    packages.push({ ...item, manifest });
  }
  const releaseSetHash = createHash('sha256').update(digestItems.join('\n')).digest('hex');
  assert(
    releaseSetHash === savedReport.releaseSetHash,
    'existing release set hash does not match its tarballs',
  );
  return { output, tarballRoot, report: { ...savedReport, packages } };
}

function assertInside(parent, child, label) {
  const rel = relative(parent, child);
  assert(
    rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)),
    `${label} escaped its expected root: ${child}`,
  );
}

function parseJsonOutput(result, label) {
  if (result.code !== 0) {
    throw new Error(
      `${label} exited ${result.code}${result.signal ? ` (${result.signal})` : ''}: ${result.stderr}\n${result.stdout}`,
    );
  }
  const lines = result.stdout.trim().split(/\r?\n/u);
  assert(lines.length === 1, `${label} must emit exactly one JSON line, got ${lines.length}`);
  let value;
  try {
    value = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`${label} emitted invalid JSON: ${error.message}; output=${result.stdout}`);
  }
  assert(
    value && typeof value === 'object' && value.ok === true,
    `${label} returned a failure envelope: ${JSON.stringify(value)}`,
  );
  return value;
}

async function runChecked(command, args, options = {}) {
  const result = await processResult(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.code}${result.signal ? ` (${result.signal})` : ''}: ${result.stderr}\n${result.stdout}`,
    );
  }
  return result;
}

async function writeConsumerConfig(directory, registryUrl) {
  await writeFile(
    join(directory, '.npmrc'),
    `@slidock:registry=${registryUrl}\nregistry=https://registry.npmjs.org/\nstrict-ssl=true\n`,
  );
}

function registryHandler(packages, tarballRoot) {
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  const byFilename = new Map(packages.map((entry) => [entry.filename, entry]));
  return async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('access-control-allow-origin', '*');
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const packageName = decodeURIComponent(path.replace(/^\//u, ''));
    const selected = byName.get(packageName);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    if (selected) {
      const registryUrl = `http://${request.headers.host}`;
      response.writeHead(200, { 'content-type': 'application/vnd.npm.install-v1+json' });
      response.end(
        JSON.stringify({
          name: selected.name,
          'dist-tags': { latest: frameworkVersion },
          versions: {
            [frameworkVersion]: {
              ...selected.manifest,
              dist: {
                tarball: `${registryUrl}/_pack/${selected.filename}`,
                shasum: selected.shasum,
                integrity: `sha512-${selected.sha512}`,
              },
            },
          },
        }),
      );
      return;
    }
    const filename = path.startsWith('/_pack/') ? path.slice('/_pack/'.length) : undefined;
    const tarball = filename ? byFilename.get(filename) : undefined;
    if (tarball) {
      const bytes = await readFile(join(tarballRoot, tarball.filename));
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': bytes.length,
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: `Not found: ${path}` }));
  };
}

async function openRegistry(pack, tarballRoot) {
  const server = createServer((request, response) => {
    registryHandler(packages, tarballRoot)(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  const packages = pack.packages;
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      accept();
    });
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'local registry did not bind a TCP port');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function assertInstalledPackage(consumerRoot, packageName) {
  const packagePath = join(consumerRoot, 'node_modules', ...packageName.split('/'));
  const realPackagePath = await realpath(packagePath);
  const realConsumerRoot = await realpath(consumerRoot);
  const realRepository = await realpath(repository);
  assertInside(realConsumerRoot, realPackagePath, `${packageName} install`);
  assert(
    !realPackagePath.startsWith(`${realRepository}${sep}`),
    `${packageName} resolved back into the source repository: ${realPackagePath}`,
  );
  const manifest = JSON.parse(await readFile(join(realPackagePath, 'package.json'), 'utf8'));
  assert(manifest.name === packageName, `${packageName} resolved to a different package`);
  assert(manifest.version === frameworkVersion, `${packageName} installed at ${manifest.version}`);
  return { path: realPackagePath, manifest };
}

async function assertPackageDependency(consumerRoot, packageEntry, packageName) {
  const dependencyPath = join(dirname(packageEntry), packageName.split('/').at(-1));
  const realPackagePath = await realpath(dependencyPath);
  const realConsumerRoot = await realpath(consumerRoot);
  const realRepository = await realpath(repository);
  assertInside(realConsumerRoot, realPackagePath, `${packageName} dependency`);
  assert(
    !realPackagePath.startsWith(`${realRepository}${sep}`),
    `${packageName} resolved back into the source repository: ${realPackagePath}`,
  );
  const manifest = JSON.parse(await readFile(join(realPackagePath, 'package.json'), 'utf8'));
  assert(manifest.name === packageName, `${packageName} resolved to a different package`);
  assert(manifest.version === frameworkVersion, `${packageName} installed at ${manifest.version}`);
  return { path: realPackagePath, manifest };
}

async function installConsumer({ root, registryUrl, manager, lockDestination }) {
  await mkdir(root, { recursive: true });
  await writeConsumerConfig(root, registryUrl);
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: `slidock-${manager}-consumer`,
        private: true,
        type: 'module',
        dependencies: { '@slidock/slidock': frameworkVersion },
      },
      null,
      2,
    )}\n`,
  );
  const args =
    manager === 'npm'
      ? ['install', '--no-audit', '--no-fund', '--no-progress']
      : ['install', '--no-frozen-lockfile', '--no-color'];
  const installed = await runChecked(manager, args, {
    cwd: root,
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  const lockName = manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
  const lockPath = join(root, lockName);
  const lock = await readFile(lockPath, 'utf8');
  if (lockDestination) await cp(lockPath, lockDestination);
  const localReferences = lock
    .split(/\r?\n/u)
    .filter((line) =>
      /(?:^|\s|:\s*)(?:file|link|workspace):(?:\/\/|\/|\.|\*|\^|~|[0-9])/u.test(line),
    );
  assert(
    localReferences.length === 0,
    `${manager} lock contains a local or workspace dependency: ${localReferences.join(' | ')}`,
  );
  const browserDownloadDependency =
    manager === 'npm'
      ? Object.keys(JSON.parse(lock).packages ?? {}).some((path) =>
          /(?:^|\/)playwright-chromium$/u.test(path),
        )
      : /^  playwright-chromium@/mu.test(lock);
  assert(
    !browserDownloadDependency,
    `${manager} resolved playwright-chromium into the consumer dependency graph`,
  );
  const framework = await assertInstalledPackage(root, '@slidock/slidock');
  assert(
    framework.manifest.dependencies['playwright-core'] === '1.63.0',
    `${manager} framework package does not use the tested playwright-core runtime dependency`,
  );
  const protocol = await assertPackageDependency(root, framework.path, '@slidock/protocol');
  const adapter = await assertPackageDependency(root, framework.path, '@slidock/slidev-adapter');
  for (const internal of ['@slidock/protocol', '@slidock/slidev-adapter']) {
    assert(
      framework.manifest.dependencies[internal] === frameworkVersion,
      `Framework runtime dependency ${internal} is not alpha-pinned`,
    );
  }
  assert(
    Object.keys(
      JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies,
    ).join() === '@slidock/slidock',
    `${manager} consumer declared more than the single framework entry`,
  );
  return {
    root,
    lockName,
    lock,
    output: installed.stdout,
    browserDownloadDependency,
    packages: { framework, protocol, adapter },
  };
}

async function runCli(cliExecutable, args, cwd, env) {
  return processResult(cliExecutable, args, { cwd, env });
}

async function waitForReady(executable, args, cwd, env, timeoutMs = 120_000) {
  const child = spawn(executable, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer;
  const result = new Promise((accept, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Timed out waiting for ${executable} readiness; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (data) => {
      stdout += data;
      const line = stdout.split(/\r?\n/u).find((entry) => entry.trim());
      if (!line || settled) return;
      try {
        const envelope = JSON.parse(line);
        if (envelope.ok !== true) throw new Error(JSON.stringify(envelope));
        settled = true;
        clearTimeout(timer);
        accept({ child, envelope, stderr });
      } catch (error) {
        if (error instanceof SyntaxError) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(`${executable} exited before readiness (${code ?? signal}): ${stderr || stdout}`),
      );
    });
  });
  return result;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise((accept) => child.once('close', accept));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  timer.unref();
  await exit;
  clearTimeout(timer);
}

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    text: await response.text(),
  };
}

async function waitForCatalog(url, predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await get(url);
      if (response.status === 200) {
        const catalog = JSON.parse(response.text);
        last = catalog.decks?.map(({ id }) => id) ?? [];
        if (predicate(catalog)) return catalog;
      }
    } catch {
      // The watcher can briefly be between collection generations.
    }
    await new Promise((accept) => setTimeout(accept, 300));
  }
  throw new Error(`Timed out waiting for ${label}; last deck IDs=${JSON.stringify(last)}`);
}

function makeDeck(title, heading) {
  return `---\ntheme: '@slidev/theme-default'\ntitle: ${title}\nfonts:\n  sans: Arial\n  mono: monospace\n  webfonts: []\n---\n\n# ${heading}\n`;
}

const customHomeMarker = 'Packed consumer custom home';
const customHomePage = `<script setup lang="ts">
import { ref } from 'vue';
import { SlidockHome, useCatalog } from '@slidock/slidock/frontend';

const query = ref('');
const { catalog, pending, error } = useCatalog();
</script>

<template>
  <main data-testid="custom-home">
    <h1>${customHomeMarker}</h1>
    <p v-if="pending" data-testid="custom-home-pending">Loading catalog</p>
    <p v-else-if="error" data-testid="custom-home-error">Catalog failed</p>
    <section v-else-if="catalog" data-testid="custom-home-catalog">
      <p data-testid="custom-home-deck-count">{{ catalog.decks.length }}</p>
      <SlidockHome :catalog="catalog" v-model:query="query" title="Custom deck shelf" />
    </section>
  </main>
</template>
`;

async function enableCustomSubpathHome(projectRoot) {
  const configPath = join(projectRoot, 'slidock.config.ts');
  await writeFile(
    configPath,
    `import { defineConfig } from '@slidock/slidock';\n\nexport default defineConfig({\n  basePath: '/slides/',\n});\n`,
  );
  await mkdir(join(projectRoot, 'pages'), { recursive: true });
  await writeFile(join(projectRoot, 'pages/index.vue'), customHomePage);
  const config = await readFile(configPath, 'utf8');
  assert(
    !config.includes('frontendEntry'),
    'subpath fixture must use pages/index.vue auto-detection',
  );
  return { basePath: '/slides/', path: 'pages/index.vue' };
}

async function verifyLifecycle({ manager, root, packageEntry, browserExecutable }) {
  assert(
    browserExecutable,
    'Deep-link refresh verification requires a local Chrome/Chromium test driver; set CHROMIUM_EXECUTABLE',
  );
  const cliExecutable = join(root, 'node_modules/.bin/slidock');
  assert((await stat(cliExecutable)).isFile(), `${manager} install did not expose the slidock bin`);
  const env = { ...process.env };
  delete env.CHROMIUM_EXECUTABLE;
  delete env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const projectRoot = join(root, 'sample-project');
  const created = parseJsonOutput(
    await runCli(cliExecutable, ['create', projectRoot, '--json'], root, env),
    `${manager} create`,
  );
  assert(
    created.command === 'slidock create',
    `${manager} create returned an unexpected command label`,
  );
  const initialFiles = created.result.files;
  assert(initialFiles.includes('slidock.config.ts'), 'create omitted slidock.config.ts');
  assert(
    initialFiles.includes('slides/welcome/slides.md') &&
      initialFiles.includes('slides/second/slides.md'),
    'create omitted one of the two same-theme decks',
  );

  const conflicted = await runCli(cliExecutable, ['create', projectRoot, '--json'], root, env);
  assert(
    conflicted.code === 2,
    `create should reject existing scaffold files with exit 2, got ${conflicted.code}`,
  );
  const conflictEnvelope = JSON.parse(conflicted.stdout.trim());
  assert(
    conflictEnvelope.ok === false && conflictEnvelope.error?.code === 'FILE_EXISTS',
    'create did not return the expected conflict envelope',
  );

  const customPage = manager === 'pnpm' ? await enableCustomSubpathHome(projectRoot) : undefined;
  const basePath = customPage?.basePath ?? '/';

  const check = parseJsonOutput(
    await runCli(cliExecutable, ['check', '--json'], projectRoot, env),
    `${manager} check`,
  );
  assert(
    check.result.deckCount === 2,
    `${manager} check found ${check.result.deckCount} decks instead of 2`,
  );
  const initialIds = check.result.deckIds;
  assert(Array.isArray(initialIds) && initialIds.length === 2, 'check omitted the two deck IDs');

  const build = parseJsonOutput(
    await runCli(cliExecutable, ['build', '--json'], projectRoot, env),
    `${manager} build`,
  );
  assert(
    build.result.deckCount === 2,
    `${manager} build reported ${build.result.deckCount} decks instead of 2`,
  );
  const groups = build.result.groups;
  assert(
    Array.isArray(groups) && groups.length === 1,
    `two same-theme decks should share one compatibility group, got ${JSON.stringify(groups)}`,
  );
  assert(
    initialIds.every((id) => groups[0].deckIds.includes(id)),
    'shared build group does not include both scaffold decks',
  );
  const siteRoot = join(projectRoot, 'dist');
  const catalog = JSON.parse(await readFile(join(siteRoot, 'catalog.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(siteRoot, 'manifest.json'), 'utf8'));
  assert(
    (manifest.basePath ?? '/') === basePath,
    `${manager} build manifest basePath should be ${basePath}`,
  );
  assert(
    catalog.decks.length === 2 && catalog.decks.every(({ id }) => initialIds.includes(id)),
    'built catalog does not contain both scaffold decks',
  );
  assert(
    catalog.decks.every(
      ({ entry, thumbnail }) => entry.startsWith(basePath) && thumbnail.src.startsWith(basePath),
    ),
    `${manager} catalog navigation and thumbnail URLs must use ${basePath}`,
  );
  const sharedGroupId = groups[0].id;
  const sharedManifestGroup = manifest.groups?.find(({ id }) => id === sharedGroupId);
  assert(
    sharedManifestGroup && initialIds.every((id) => sharedManifestGroup.decks.includes(id)),
    'built manifest does not place both scaffold decks in the shared runtime group',
  );
  assert(
    sharedManifestGroup.assetBase === `${basePath}_profiles/${sharedGroupId}/`,
    'shared runtime asset base did not include the configured public basePath',
  );
  assert(
    manifest.commonAssets?.length > 0,
    'shared output did not record any common static assets',
  );
  const sharedGroupAssetPrefix = `_profiles/${sharedGroupId}/assets/`;
  const sharedGroupCommonJs = manifest.commonAssets.filter(
    (asset) => asset.startsWith(sharedGroupAssetPrefix) && asset.endsWith('.js'),
  );
  assert(
    sharedGroupCommonJs.length > 0,
    'shared runtime group did not emit common JavaScript assets',
  );
  const sharedVueAsset = sharedGroupCommonJs.find((asset) =>
    /\/modules\/vue-[^/]+\.js$/u.test(asset),
  );
  assert(sharedVueAsset, 'shared runtime group did not emit its common Vue module');
  for (const asset of sharedGroupCommonJs) {
    const assetPath = resolve(siteRoot, asset);
    assertInside(siteRoot, assetPath, `shared group JavaScript asset ${asset}`);
    assert(
      (await stat(assetPath)).isFile(),
      `shared group JavaScript asset was not emitted: ${asset}`,
    );
  }
  const placeholders = catalog.decks.every((deck) => /\.svg(?:$|\?)/u.test(deck.thumbnail.src));
  assert(placeholders, 'thumbnails=none did not emit valid local SVG placeholders');
  const pngThumbnails = manifest.files?.some((file) => /thumbnails\/.*\.png$/u.test(file.path));
  assert(!pngThumbnails, 'thumbnails=none unexpectedly emitted screenshot PNG assets');

  const previewReady = await waitForReady(
    cliExecutable,
    ['preview', '--port', '0', '--json'],
    projectRoot,
    env,
  );
  const previewUrl = previewReady.envelope.result?.url;
  assert(typeof previewUrl === 'string', 'preview readiness did not include a URL');
  assert(
    new URL(previewUrl).pathname === basePath,
    `${manager} preview readiness URL must include basePath ${basePath}`,
  );
  const previewResponses = {};
  try {
    for (const relativePath of ['', ...initialIds.map((id) => `${id}/1`)]) {
      const routeUrl = new URL(relativePath, previewUrl);
      const response = await get(routeUrl);
      assert(
        response.status === 200,
        `preview refresh route ${routeUrl.pathname} returned ${response.status}`,
      );
      assert(
        response.text.includes('<html') || response.text.includes('<!doctype html'),
        `preview route ${routeUrl.pathname} did not return an HTML document`,
      );
      previewResponses[routeUrl.pathname] = response.status;
    }
    const requireFromFramework = createRequire(join(packageEntry, 'package.json'));
    const playwright = requireFromFramework('playwright-core');
    const browser = await playwright.chromium.launch({
      headless: true,
      executablePath: browserExecutable,
    });
    try {
      const browserErrors = [];
      let customPageEvidence;
      if (customPage) {
        const page = await browser.newPage();
        const catalogRequests = [];
        page.on('request', (request) => {
          const requestUrl = new URL(request.url());
          if (requestUrl.pathname.endsWith('/catalog.json'))
            catalogRequests.push(requestUrl.pathname);
        });
        page.on('pageerror', (error) => browserErrors.push(`custom home: ${error.message}`));
        await page.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
        try {
          const response = await page.goto(new URL('', previewUrl).href, {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
          });
          assert(response?.status() === 200, 'custom home root route did not load');
          await page.locator('[data-testid="custom-home"]').waitFor({
            state: 'visible',
            timeout: 60_000,
          });
          assert(
            (await page.locator('[data-testid="custom-home"] h1').textContent()) ===
              customHomeMarker,
            'pages/index.vue custom home marker was not visible',
          );
          await page.locator('[data-testid="custom-home-catalog"]').waitFor({
            state: 'visible',
            timeout: 60_000,
          });
          const customDeckCount = await page
            .locator('[data-testid="custom-home-deck-count"]')
            .textContent();
          assert(customDeckCount?.trim() === '2', 'custom home did not load both catalog decks');
          const deckLinks = await page
            .locator('a.deck-card')
            .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href')));
          assert(
            initialIds.every((id) => deckLinks.includes(`${basePath}${id}/1`)),
            'custom home deck links did not include the configured basePath',
          );
          const expectedCatalogPath = `${basePath}catalog.json`;
          assert(
            catalogRequests.includes(expectedCatalogPath),
            `useCatalog() did not request its default prefixed catalog URL ${expectedCatalogPath}`,
          );
          customPageEvidence = {
            path: customPage.path,
            marker: customHomeMarker,
            catalogPath: expectedCatalogPath,
            deckCount: Number(customDeckCount),
            deckLinks,
          };
        } finally {
          await page.close();
        }
      }

      const browserRequests = new Map();
      const sharedGroupPublicAssetPrefix = `${basePath}${sharedGroupAssetPrefix}`;
      const sharedVuePublicPath = `${basePath}${sharedVueAsset}`;
      for (const deckId of initialIds) {
        const page = await browser.newPage();
        const requests = new Set();
        browserRequests.set(deckId, requests);
        await page.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
        page.on('request', (request) => {
          const requestUrl = new URL(request.url());
          if (requestUrl.pathname.endsWith('.js')) requests.add(requestUrl.pathname);
        });
        page.on('pageerror', (error) => browserErrors.push(`${deckId}: ${error.message}`));
        try {
          const response = await page.goto(new URL(`${deckId}/1`, previewUrl).href, {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
          });
          assert(
            response?.status() === 200,
            `browser direct deep-link refresh failed for ${deckId}`,
          );
          await page.locator('.slidev-page').first().waitFor({ state: 'visible', timeout: 60_000 });
        } finally {
          await page.close();
        }
      }
      assert(
        browserErrors.length === 0,
        `browser reported page errors: ${browserErrors.join('; ')}`,
      );
      const firstDeckRequests = browserRequests.get(initialIds[0]);
      const secondDeckRequests = browserRequests.get(initialIds[1]);
      const sharedGroupJsRequests = [...firstDeckRequests].filter(
        (path) =>
          secondDeckRequests.has(path) &&
          path.startsWith(sharedGroupPublicAssetPrefix) &&
          path.endsWith('.js'),
      );
      assert(
        sharedGroupJsRequests.includes(sharedVuePublicPath),
        'the two same-theme deck pages did not request the shared group Vue module in common',
      );
      if (customPage) previewResponses.customPage = customPageEvidence;
      previewResponses.browserDeepLinks = initialIds;
      previewResponses.sharedGroupJsRequests = sharedGroupJsRequests;
    } finally {
      await browser.close();
    }
  } finally {
    await stopChild(previewReady.child);
  }

  const devReady = await waitForReady(
    cliExecutable,
    ['dev', '--port', '0', '--json'],
    projectRoot,
    env,
  );
  const devUrl = devReady.envelope.result?.url;
  assert(typeof devUrl === 'string', 'dev readiness did not include a URL');
  assert(
    new URL(devUrl).pathname === basePath,
    `${manager} dev readiness URL must include basePath ${basePath}`,
  );
  const devChanges = [];
  try {
    const devCatalogUrl = new URL('catalog.json', devUrl);
    assert(
      devCatalogUrl.pathname === `${basePath}catalog.json`,
      `${manager} dev catalog URL must use basePath ${basePath}`,
    );
    const devInitial = await waitForCatalog(
      devCatalogUrl,
      (value) => value.decks?.length === 2,
      'initial dev catalog',
    );
    assert(
      devInitial.decks.every(
        ({ entry, thumbnail }) => entry.startsWith(basePath) && thumbnail.src.startsWith(basePath),
      ),
      `${manager} dev catalog navigation and thumbnails must use ${basePath}`,
    );
    devChanges.push({ phase: 'initial', deckIds: devInitial.decks.map(({ id }) => id) });

    const thirdEntry = join(projectRoot, 'slides', 'third', 'slides.md');
    await mkdir(dirname(thirdEntry), { recursive: true });
    await writeFile(thirdEntry, makeDeck('Third deck', 'Added after startup'));
    const added = await waitForCatalog(
      devCatalogUrl,
      (value) => value.decks?.some(({ id }) => id === 'third'),
      'dev add',
    );
    devChanges.push({ phase: 'add', deckIds: added.decks.map(({ id }) => id) });

    const removedId = initialIds[1];
    await rm(join(projectRoot, 'slides', removedId, 'slides.md'));
    const removed = await waitForCatalog(
      devCatalogUrl,
      (value) => !value.decks?.some(({ id }) => id === removedId),
      'dev remove',
    );
    devChanges.push({ phase: 'remove', deckIds: removed.decks.map(({ id }) => id) });

    await rm(join(projectRoot, 'slides', initialIds[0], 'slides.md'));
    await rm(thirdEntry);
    const empty = await waitForCatalog(
      devCatalogUrl,
      (value) => value.decks?.length === 0,
      'empty dev collection',
    );
    devChanges.push({ phase: 'empty', deckIds: empty.decks.map(({ id }) => id) });

    const recoveredEntry = join(projectRoot, 'slides', 'recovered', 'slides.md');
    await mkdir(dirname(recoveredEntry), { recursive: true });
    await writeFile(recoveredEntry, makeDeck('Recovered deck', 'Recovery after empty collection'));
    const recovered = await waitForCatalog(
      devCatalogUrl,
      (value) => value.decks?.some(({ id }) => id === 'recovered'),
      'dev recovery',
    );
    devChanges.push({ phase: 'recovery', deckIds: recovered.decks.map(({ id }) => id) });
  } finally {
    await stopChild(devReady.child);
  }
  return {
    manager,
    mode: customPage ? 'custom-page-subpath' : 'default-root-home',
    basePath,
    customPage: customPage ? { ...customPage, autoDetected: true, marker: customHomeMarker } : null,
    create: { files: initialFiles, conflict: conflictEnvelope.error.code },
    check: { deckCount: check.result.deckCount, deckIds: initialIds },
    build: {
      deckCount: build.result.deckCount,
      groups,
      commonAssetCount: manifest.commonAssets.length,
      sharedGroupCommonJs,
      placeholders,
    },
    preview: { url: previewUrl, routes: previewResponses },
    dev: { url: devUrl, changes: devChanges },
  };
}

async function verifyFrontendConsumer(root, registryUrl) {
  const fixtureRoot = join(root, 'frontend-source-consumer');
  await mkdir(join(fixtureRoot, 'src'), { recursive: true });
  await writeConsumerConfig(fixtureRoot, registryUrl);
  const dependencies = {
    '@slidock/slidock': frameworkVersion,
    '@vitejs/plugin-vue': frontendToolVersions['@vitejs/plugin-vue'],
    vite: frontendToolVersions.vite,
    vue: frontendToolVersions.vue,
    'vue-tsc': frontendToolVersions['vue-tsc'],
    typescript: frontendToolVersions.typescript,
  };
  await writeFile(
    join(fixtureRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'slidock-frontend-source-consumer',
        private: true,
        type: 'module',
        scripts: { build: 'vite build', typecheck: 'vue-tsc --noEmit' },
        dependencies: { '@slidock/slidock': frameworkVersion, vue: frontendToolVersions.vue },
        devDependencies: Object.fromEntries(
          Object.entries(dependencies).filter(
            ([name]) => name !== '@slidock/slidock' && name !== 'vue',
          ),
        ),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(fixtureRoot, 'index.html'),
    '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>\n',
  );
  await writeFile(
    join(fixtureRoot, 'vite.config.ts'),
    `import { defineConfig } from 'vite';\nimport vue from '@vitejs/plugin-vue';\nexport default defineConfig({ plugins: [vue()] });\n`,
  );
  await writeFile(
    join(fixtureRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          skipLibCheck: true,
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          types: [],
          noEmit: true,
        },
        include: ['src/**/*.ts', 'src/**/*.vue', 'env.d.ts'],
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(join(fixtureRoot, 'env.d.ts'), '/// <reference types="vite/client" />\n');
  await writeFile(
    join(fixtureRoot, 'src', 'main.ts'),
    `import { createApp, ref } from 'vue';\nimport { SlidockHome } from '@slidock/slidock/frontend';\nimport '@slidock/slidock/frontend/style.css';\nimport App from './App.vue';\ncreateApp(App).mount('#app');\nexport { createApp, ref, SlidockHome };\n`,
  );
  await writeFile(
    join(fixtureRoot, 'src', 'App.vue'),
    `<script setup lang="ts">\nimport { ref } from 'vue';\nimport { SlidockHome } from '@slidock/slidock/frontend';\nimport type { Catalog } from '@slidock/slidock/client';\nconst catalog: Catalog = { schemaVersion: 1, categories: [], decks: [] };\nconst query = ref('');\nconst tag = ref('');\nconst sort = ref<'catalog' | 'title' | 'date'>('catalog');\n</script>\n<template>\n  <SlidockHome :catalog="catalog" v-model:query="query" v-model:tag="tag" v-model:sort="sort">\n    <template #card="{ deck, href }"><a :href="href">{{ deck.title }}</a></template>\n    <template #empty="{ reason }"><p>{{ reason }}</p></template>\n  </SlidockHome>\n</template>\n`,
  );
  const install = await runChecked('npm', ['install', '--no-audit', '--no-fund', '--no-progress'], {
    cwd: fixtureRoot,
    timeoutMs: 10 * 60_000,
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  const typecheck = await runChecked(
    process.execPath,
    [join(fixtureRoot, 'node_modules/vue-tsc/bin/vue-tsc.js'), '--noEmit'],
    {
      cwd: fixtureRoot,
      timeoutMs: 3 * 60_000,
    },
  );
  const build = await runChecked(
    process.execPath,
    [join(fixtureRoot, 'node_modules/vite/bin/vite.js'), 'build'],
    {
      cwd: fixtureRoot,
      timeoutMs: 3 * 60_000,
    },
  );
  const builtAssets = await (
    await import('node:fs/promises')
  ).readdir(join(fixtureRoot, 'dist', 'assets'));
  assert(
    builtAssets.some((filename) => filename.startsWith('index-') && filename.endsWith('.js')),
    'Vite source export fixture did not emit a JavaScript bundle',
  );
  assert(
    !/node_modules\/(?:\.pnpm\/)?@slidock\/(?:slidock|protocol|slidev-adapter)\//u.test(
      build.stdout + build.stderr,
    ),
    'frontend build output unexpectedly points into workspace packages',
  );
  return {
    root: fixtureRoot,
    dependencies,
    lockName: 'package-lock.json',
    installSummary: install.stdout.trim().split(/\r?\n/u).at(-1),
    typecheck: { code: 0, summary: typecheck.stdout.trim() },
    build: { code: 0, emitted: builtAssets },
  };
}

async function findBrowser() {
  const candidates = [
    process.env.CHROMIUM_EXECUTABLE,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  try {
    const testChromium = createRequire(join(repository, 'package.json'))('playwright-chromium');
    candidates.push(testChromium.chromium.executablePath());
  } catch {
    // The repository's optional browser test driver may not be installed.
  }
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next host test-browser candidate.
    }
  }
  return undefined;
}

export async function verifyPackedFramework({ installOnly = false, reusePacked = false } = {}) {
  assert(!(installOnly && reusePacked), '--install-only and --reuse-packed cannot be combined');
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  assert(
    nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 15),
    `Node.js 24.15.0 or newer is required; found ${process.version}`,
  );
  const pack = reusePacked ? await loadPreviouslyPackedFramework() : await packFramework();
  const resultRoot = join(artifactRoot, 'consumer', pack.report.releaseSetHash);
  await mkdir(resultRoot, { recursive: true });
  const registry = await openRegistry(pack.report, pack.tarballRoot);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'slidock-framework-consumer-'));
  const report = {
    status: 'running',
    version: frameworkVersion,
    mode: installOnly ? 'install-only' : reusePacked ? 'reuse-packed-diagnostic' : 'full-lifecycle',
    releaseSetHash: pack.report.releaseSetHash,
    npmVersion: (await runChecked('npm', ['--version'])).stdout.trim(),
    pnpmVersion: (await runChecked('pnpm', ['--version'])).stdout.trim(),
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    registry: 'ephemeral @slidock scope registry; npmjs.org for all other packages',
    consumers: {},
    browserDriver: (await findBrowser()) ?? 'unavailable',
  };
  try {
    const npm = await installConsumer({
      root: join(temporaryRoot, 'npm'),
      registryUrl: registry.url,
      manager: 'npm',
      lockDestination: join(resultRoot, 'npm-package-lock.json'),
    });
    report.consumers.npm = {
      packages: Object.fromEntries(
        Object.entries(npm.packages).map(([key, value]) => [
          key,
          { version: value.manifest.version, location: relative(npm.root, value.path) },
        ]),
      ),
      directDependencies: ['@slidock/slidock'],
      lock: 'npm-package-lock.json',
    };
    if (!installOnly) {
      report.lifecycles = {};
      report.lifecycles.npm = await verifyLifecycle({
        manager: 'npm',
        root: npm.root,
        packageEntry: npm.packages.framework.path,
        browserExecutable: await findBrowser(),
      });
    }

    const pnpm = await installConsumer({
      root: join(temporaryRoot, 'pnpm'),
      registryUrl: registry.url,
      manager: 'pnpm',
      lockDestination: join(resultRoot, 'pnpm-lock.yaml'),
    });
    report.consumers.pnpm = {
      packages: Object.fromEntries(
        Object.entries(pnpm.packages).map(([key, value]) => [
          key,
          { version: value.manifest.version, location: relative(pnpm.root, value.path) },
        ]),
      ),
      directDependencies: ['@slidock/slidock'],
      lock: 'pnpm-lock.yaml',
    };
    if (!installOnly) {
      report.lifecycles.pnpm = await verifyLifecycle({
        manager: 'pnpm',
        root: pnpm.root,
        packageEntry: pnpm.packages.framework.path,
        browserExecutable: await findBrowser(),
      });
    }
    const frontendSourceConsumer = await verifyFrontendConsumer(temporaryRoot, registry.url);
    await cp(
      join(frontendSourceConsumer.root, frontendSourceConsumer.lockName),
      join(resultRoot, 'frontend-source-package-lock.json'),
    );
    report.frontendSourceConsumer = {
      toolVersions: frontendSourceConsumer.dependencies,
      lock: 'frontend-source-package-lock.json',
      installSummary: frontendSourceConsumer.installSummary,
      typecheck: frontendSourceConsumer.typecheck,
      build: frontendSourceConsumer.build,
    };
    report.status = 'passed';
    report.artifacts = relative(repository, resultRoot);
    await writeFile(
      join(resultRoot, 'verification-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    return report;
  } catch (error) {
    report.status = 'failed';
    report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await writeFile(
      join(resultRoot, 'verification-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    throw error;
  } finally {
    await new Promise((accept) => registry.server.close(accept));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await verifyPackedFramework({
    installOnly: process.argv.includes('--install-only'),
    reusePacked: process.argv.includes('--reuse-packed'),
  });
  console.log(JSON.stringify(report, null, 2));
}
