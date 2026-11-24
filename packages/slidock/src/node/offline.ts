import { vendorFonts } from './internal/vendor-fonts.mjs';
import { fingerprintOfflineSite } from './internal/fingerprint-offline.mjs';
import { normalizeBasePath, withBasePath } from './internal/base-path.mjs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface PrepareOfflineSiteOptions {
  siteRoot: string;
  workDir: string;
  basePath?: string;
}

export interface PrepareOfflineSiteResult {
  snapshotSha256: string;
  renamedAssets: number;
}

interface OfflineFileMetric {
  path: string;
  rawBytes: number;
  gzipBytes: number;
}

interface OfflineManifest extends Record<string, unknown> {
  commonAssets?: Iterable<string> | null;
}

const DEFAULT_FAVICON = 'https://cdn.jsdelivr.net/gh/slidevjs/slidev/assets/favicon.png';
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function requireAbsolutePath(name: string, path: string): string {
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  return resolve(path);
}

async function listFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) paths.push(path);
    }
  }
  await visit(root);
  return paths;
}

export async function prepareOfflineSite(
  options: PrepareOfflineSiteOptions,
): Promise<PrepareOfflineSiteResult> {
  const sitePath = requireAbsolutePath('siteRoot', options.siteRoot);
  const workPath = requireAbsolutePath('workDir', options.workDir);
  const siteRoot = await realpath(sitePath);
  if (!(await stat(siteRoot)).isDirectory())
    throw new Error(`site root is not a directory: ${siteRoot}`);

  await mkdir(workPath, { recursive: true });
  const workDir = await realpath(workPath);
  if (isInside(siteRoot, workDir)) {
    throw new Error(`workDir must be outside the site root: ${workDir}`);
  }

  const manifestPath = join(siteRoot, 'manifest.json');
  const initialManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as OfflineManifest & {
    basePath?: string;
  };
  const basePath = normalizeBasePath(options.basePath ?? initialManifest.basePath);

  await vendorFonts({
    siteRoot,
    evidencePath: join(workDir, 'font-vendor.json'),
  });

  let changedFaviconFiles = 0;
  const paths = await listFiles(siteRoot);
  for (const path of paths.filter((filePath) => /\.(?:html|js|json)$/.test(filePath))) {
    const text = await readFile(path, 'utf8');
    let output = text;
    if (output.includes(DEFAULT_FAVICON)) {
      output = output.replaceAll(DEFAULT_FAVICON, withBasePath(basePath, '/favicon.svg'));
      changedFaviconFiles++;
    }
    if (basePath !== '/' && output.includes('/_fonts/'))
      output = output.replaceAll('/_fonts/', withBasePath(basePath, '/_fonts/'));
    if (output !== text) await writeFile(path, output);
  }
  if (basePath !== '/') {
    for (const path of paths.filter((filePath) => filePath.endsWith('.css'))) {
      const text = await readFile(path, 'utf8');
      const output = text.replaceAll('/_fonts/', withBasePath(basePath, '/_fonts/'));
      if (output !== text) await writeFile(path, output);
    }
  }
  await writeFile(
    join(siteRoot, 'favicon.svg'),
    await readFile(fileURLToPath(import.meta.resolve('@slidock/slidock/icon.svg'))),
  );

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as OfflineManifest;
  const commonAssets = [...(manifest.commonAssets || []), 'favicon.svg'];
  manifest.commonAssets = [
    ...new Set(
      commonAssets.map((asset) => {
        if (basePath === '/' || typeof asset !== 'string') return asset;
        return asset.startsWith(basePath) ? asset.slice(basePath.length) : asset.replace(/^\//, '');
      }),
    ),
  ].sort();
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const fingerprint = await fingerprintOfflineSite(siteRoot, { basePath });
  const files: OfflineFileMetric[] = await Promise.all(
    (await listFiles(siteRoot)).map(async (path) => {
      const bytes = await readFile(path);
      return {
        path: relative(siteRoot, path),
        rawBytes: bytes.length,
        gzipBytes: gzipSync(bytes).length,
      };
    }),
  );
  const result = {
    siteRoot,
    workDir,
    changedFaviconFiles,
    fingerprint,
    fileCount: files.length,
    rawBytes: files.reduce((total, file) => total + file.rawBytes, 0),
    gzipBytes: files.reduce((total, file) => total + file.gzipBytes, 0),
    files,
  };
  await writeFile(join(workDir, 'offline-metrics.json'), `${JSON.stringify(result, null, 2)}\n`);

  return {
    snapshotSha256: fingerprint.snapshotSha256,
    renamedAssets: fingerprint.renamedAssets,
  };
}
