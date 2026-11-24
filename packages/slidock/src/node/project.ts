import { readFile, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HubBuildError, type HubBuildOptions } from './config.js';
import { normalizeBasePath } from './internal/base-path.mjs';

export type SlidockConfig = Omit<
  HubBuildOptions,
  'baseDir' | 'configPath' | 'onProgress' | 'sourceRoot' | 'outDir'
> & {
  sourceRoot?: string;
  outDir?: string;
};

export interface LoadProjectOptions {
  root?: string;
  config?: string;
}

export interface LoadedProject {
  root: string;
  homePagePath: string;
  configPath?: string;
  options: HubBuildOptions;
}

const configNames = [
  'slidock.config.ts',
  'slidock.config.mjs',
  'slidock.config.js',
  'slidock.config.json',
  'hub.config.json',
] as const;

const configKeys = new Set([
  'frontendEntry',
  'navigation',
  'sourceRoot',
  'outDir',
  'dependencyRoot',
  'theme',
  'decks',
  'profiles',
  'offline',
  'chromiumExecutable',
  'bootstrap',
  'isolateDecks',
  'include',
  'exclude',
  'deckOptions',
  'thumbnails',
  'compatibilityGroups',
  'allowEmpty',
  'home',
  'basePath',
]);

/** Return the supplied typed config unchanged so callers keep their literal types. */
export function defineConfig<const T extends SlidockConfig>(config: T): T {
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKnownKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (!isRecord(value)) return;
  const known = new Set(allowed);
  for (const key of Object.keys(value))
    if (!known.has(key)) throw configError(`${label} contains unknown key ${key}`);
}

function validateNestedKeys(config: Record<string, unknown>): void {
  assertKnownKeys(config.navigation, ['enabled', 'homeHref', 'homeLabel'], 'navigation');
  assertKnownKeys(
    config.home,
    ['title', 'logo', 'hero', 'description', 'links', 'footer', 'categoryLabels'],
    'home',
  );
  if (isRecord(config.home) && Array.isArray(config.home.links)) {
    config.home.links.forEach((link, index) =>
      assertKnownKeys(link, ['label', 'href'], `home.links[${index}]`),
    );
  }
  if (Array.isArray(config.decks)) {
    config.decks.forEach((deck, index) =>
      assertKnownKeys(
        deck,
        ['id', 'entry', 'profile', 'title', 'order', 'draft', 'cover'],
        `decks[${index}]`,
      ),
    );
  }
  for (const [name, allowed] of [
    ['profiles', ['dependencyRoot', 'theme']],
    ['deckOptions', ['id', 'title', 'order', 'draft', 'cover']],
  ] as const) {
    const collection = config[name];
    if (isRecord(collection))
      for (const [id, value] of Object.entries(collection))
        assertKnownKeys(value, allowed, `${name}.${id}`);
  }
}

function configError(message: string, cause?: unknown): HubBuildError {
  return new HubBuildError('CONFIG', message, cause === undefined ? undefined : { cause });
}

async function resolveRoot(root: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(resolve(root));
    if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw configError(`Project root is not an accessible directory: ${resolve(root)}`, error);
  }
  return resolved;
}

async function findConfig(root: string, explicit?: string): Promise<string | undefined> {
  if (explicit !== undefined) {
    const path = resolve(root, explicit);
    try {
      if (!(await stat(path)).isFile()) throw new Error('not a file');
      return await realpath(path);
    } catch (error) {
      throw configError(`Project config could not be read: ${path}`, error);
    }
  }

  for (const name of configNames) {
    const path = resolve(root, name);
    try {
      if (!(await stat(path)).isFile()) throw configError(`Project config must be a file: ${path}`);
      return await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (error instanceof HubBuildError) throw error;
      throw configError(`Project config could not be inspected: ${path}`, error);
    }
  }
  return undefined;
}

function validateConfig(value: unknown, configPath?: string): Record<string, unknown> {
  if (!isRecord(value))
    throw configError('Project config must export an object as its default value');
  const legacyJson =
    configPath?.endsWith('/hub.config.json') || configPath?.endsWith('\\hub.config.json');
  const newJson =
    configPath?.endsWith('/slidock.config.json') || configPath?.endsWith('\\slidock.config.json');
  for (const key of Object.keys(value)) {
    if (key === 'schemaVersion' && (legacyJson || newJson)) continue;
    if (!configKeys.has(key)) throw configError(`Project config contains unknown key ${key}`);
  }

  if (legacyJson) {
    if (value.schemaVersion !== 1) throw configError('hub.config.json requires schemaVersion 1');
  }

  try {
    normalizeBasePath(value.basePath as string | undefined);
  } catch (error) {
    throw configError(error instanceof Error ? error.message : String(error), error);
  }

  if (value.schemaVersion !== undefined) {
    if (legacyJson && value.schemaVersion === 1) {
      // The legacy JSON config keeps its existing required schema version.
    } else if (!newJson || value.schemaVersion !== 1) {
      throw configError('schemaVersion is allowed only as 1 in slidock.config.json');
    }
  }

  const { schemaVersion: _schemaVersion, ...config } = value;
  validateNestedKeys(config);
  return config;
}

async function readConfig(configPath: string): Promise<Record<string, unknown>> {
  const extension = configPath.slice(configPath.lastIndexOf('.')).toLowerCase();
  try {
    if (extension === '.json') {
      return validateConfig(JSON.parse(await readFile(configPath, 'utf8')), configPath);
    }
    if (!['.ts', '.mjs', '.js'].includes(extension))
      throw configError('Project config must use .ts, .mjs, .js, or .json');

    const url = pathToFileURL(configPath);
    // Config imports are trusted project code. A unique URL makes repeated dev
    // reloads observe the current config without promising helper-module HMR.
    url.searchParams.set('slidock-reload', randomUUID());
    const imported = (await import(url.href)) as { default?: unknown };
    return validateConfig(imported.default, configPath);
  } catch (error) {
    if (error instanceof HubBuildError) throw error;
    const isTypeScriptLoadFailure =
      extension === '.ts' &&
      error instanceof Error &&
      /unknown file extension|typescript.*(disabled|unsupported)|strip.*typescript/i.test(
        error.message,
      );
    if (isTypeScriptLoadFailure)
      throw configError('TypeScript config requires Node.js 24.22.1 or newer', error);
    throw configError(
      `Could not load project config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

function isPackageName(value: string): boolean {
  return /^(?:@[a-z\d][\w.-]*\/)?[a-z\d][\w.-]*$/iu.test(value);
}

async function packageRoot(requireFrom: NodeRequire, name: string): Promise<string | undefined> {
  for (const request of [`${name}/package.json`, name]) {
    try {
      const resolved = requireFrom.resolve(request);
      if (request.endsWith('/package.json')) return dirname(resolved);

      let directory = dirname(resolved);
      while (true) {
        try {
          const manifest = JSON.parse(
            await readFile(resolve(directory, 'package.json'), 'utf8'),
          ) as {
            name?: unknown;
          };
          if (manifest.name === name) return directory;
        } catch {
          // Continue to the package boundary; the resolved entry can be nested.
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    } catch {
      // Try the next resolution source.
    }
  }
  return undefined;
}

async function resolveThemeName(value: unknown, root: string, baseDir: string): Promise<unknown> {
  if (typeof value !== 'string' || !value || isAbsolute(value) || !isPackageName(value))
    return value;
  if (value.startsWith('.') || value.startsWith('..')) return value;

  // A bare local directory is an explicit path when it exists beside the config.
  try {
    await stat(resolve(baseDir, value));
    return value;
  } catch {
    // Otherwise interpret the value as a package name.
  }

  const fromProject = createRequire(resolve(root, 'package.json'));
  const fromToolchain = createRequire(import.meta.url);
  const resolved =
    (await packageRoot(fromProject, value)) ?? (await packageRoot(fromToolchain, value));
  if (!resolved)
    throw configError(
      `Theme package ${value} could not be resolved from the project or Slidock toolchain; install it or use a local path`,
    );
  return resolved;
}

async function resolveConfiguredThemes(
  config: Record<string, unknown>,
  root: string,
  baseDir: string,
) {
  const result = { ...config };
  result.theme = await resolveThemeName(result.theme, root, baseDir);
  if (isRecord(result.profiles)) {
    result.profiles = Object.fromEntries(
      await Promise.all(
        Object.entries(result.profiles).map(async ([id, profile]) =>
          isRecord(profile)
            ? [id, { ...profile, theme: await resolveThemeName(profile.theme, root, baseDir) }]
            : [id, profile],
        ),
      ),
    );
  }
  return result;
}

/** Load the selected project config and attach its directory as the path base. */
export async function loadProject(options: LoadProjectOptions = {}): Promise<LoadedProject> {
  const root = await resolveRoot(options.root ?? process.cwd());
  const configPath = await findConfig(root, options.config);
  const baseDir = configPath === undefined ? root : dirname(configPath);
  const homePagePath = resolve(baseDir, 'pages/index.vue');
  const hasLegacyConfig =
    configPath?.endsWith('/hub.config.json') || configPath?.endsWith('\\hub.config.json');
  const loaded = configPath === undefined ? {} : await readConfig(configPath);
  const configured = await resolveConfiguredThemes(loaded, root, baseDir);
  if (!hasLegacyConfig && configured.frontendEntry === undefined) {
    try {
      if (!(await stat(homePagePath)).isFile())
        throw configError(`Home page must be a file: ${homePagePath}`);
      configured.frontendEntry = homePagePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const defaults: Record<string, unknown> = {
    basePath: '/',
    sourceRoot: './slides',
    outDir: './dist',
  };
  if (!hasLegacyConfig) {
    Object.assign(defaults, {
      include: ['**/slides.md'],
      offline: false,
      thumbnails: 'none',
      compatibilityGroups: true,
      allowEmpty: true,
    });
  }

  const projectOptions = {
    ...defaults,
    ...configured,
    basePath: normalizeBasePath(configured.basePath as string | undefined),
    baseDir,
  } as HubBuildOptions;
  return {
    root,
    homePagePath,
    ...(configPath === undefined ? {} : { configPath }),
    options: projectOptions,
  };
}
