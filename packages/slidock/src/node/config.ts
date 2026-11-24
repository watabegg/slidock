import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, matchesGlob, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverDecks } from './internal/catalog.mjs';
import { normalizeBasePath } from './internal/base-path.mjs';

export class HubBuildError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HubBuildError';
  }
}
export interface HubProfile {
  dependencyRoot: string;
  theme: string;
}
export interface HubDeck {
  id: string;
  entry: string;
  profile?: string;
  title?: string;
  order?: number;
  draft?: boolean;
  cover?: string;
}
export interface HubDeckOptions {
  id?: string;
  title?: string;
  order?: number;
  draft?: boolean;
  cover?: string;
}
export interface HubNavigationOptions {
  enabled?: boolean;
  homeHref?: string;
  homeLabel?: string;
}
export interface HubHomeLink {
  label: string;
  href: string;
}
export interface HubHomeOptions {
  title?: string;
  logo?: string | false;
  hero?: boolean;
  description?: string;
  links?: HubHomeLink[];
  footer?: string;
  categoryLabels?: Record<string, string>;
}
export type HubThumbnailMode = 'auto' | 'none';
export interface HubBuildOptions {
  basePath?: string;
  frontendEntry?: string;
  navigation?: HubNavigationOptions;
  configPath?: string;
  baseDir?: string;
  sourceRoot?: string;
  outDir?: string;
  dependencyRoot?: string;
  theme?: string;
  decks?: HubDeck[];
  include?: string[];
  exclude?: string[];
  deckOptions?: Record<string, HubDeckOptions>;
  profiles?: Record<string, HubProfile>;
  thumbnails?: HubThumbnailMode;
  home?: HubHomeOptions;
  compatibilityGroups?: boolean;
  allowEmpty?: boolean;
  offline?: boolean;
  chromiumExecutable?: string;
  bootstrap?: 'sync' | 'tla';
  isolateDecks?: boolean;
  onProgress?: (event: { phase: string }) => void;
}
export interface NormalizedHubConfig {
  basePath: string;
  sourceRoot: string;
  outDir: string;
  dependencyRoot: string;
  theme: string;
  frontendRoot: string;
  frontendEntry: string;
  navigation: HubNavigationOptions;
  decks: Array<HubDeck & { categoryPath: string[]; order: number; draft: false }>;
  include: string[];
  exclude: string[];
  deckOptions: Record<string, HubDeckOptions>;
  selection: 'discover' | 'explicit';
  profiles?: Record<string, HubProfile>;
  thumbnails: HubThumbnailMode;
  home?: HubHomeOptions;
  compatibilityGroups: boolean;
  allowEmpty: boolean;
  offline: boolean;
  chromiumExecutable?: string;
  bootstrap: 'sync' | 'tla';
  isolateDecks: boolean;
}

export const hubRoot = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
export function defaultToolchain(): HubProfile {
  return {
    dependencyRoot: hubRoot,
    theme: dirname(require.resolve('@slidev/theme-default/package.json')),
  };
}
export function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
// oxlint-disable-next-line no-control-regex -- Match the existing catalog URL boundary.
const reservedId = /[\u0000-\u001f\u007f\\:?#[\]@!$&'()*+,;=%]/u;
const keys = new Set([
  'basePath',
  'frontendEntry',
  'navigation',
  'sourceRoot',
  'outDir',
  'dependencyRoot',
  'theme',
  'decks',
  'include',
  'exclude',
  'deckOptions',
  'profiles',
  'thumbnails',
  'home',
  'compatibilityGroups',
  'allowEmpty',
  'offline',
  'chromiumExecutable',
  'bootstrap',
  'isolateDecks',
]);
function knownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string) {
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new HubBuildError('CONFIG', `${label}: unknown key ${key}`);
}
function absolute(value: unknown, base: string | undefined, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new HubBuildError('CONFIG', `${label} must be a local path`);
  if (/^[a-z]+:\/\//i.test(value))
    throw new HubBuildError('CONFIG', `${label} must be a local path`);
  if (!isAbsolute(value) && !base)
    throw new HubBuildError('CONFIG', `${label} requires an absolute path or baseDir`);
  return isAbsolute(value) ? resolve(value) : resolve(base!, value);
}
async function canonicalOutput(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonicalOutput(parent), relative(parent, path));
  }
}

function validDeckId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.split('/').every((part) => !!part && part !== '.' && part !== '..' && !reservedId.test(part))
  );
}

function normalizeGlobs(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every(
      (pattern) =>
        typeof pattern === 'string' &&
        !!pattern &&
        !isAbsolute(pattern) &&
        !pattern.includes('\\') &&
        !pattern.includes('\0') &&
        !pattern.split('/').includes('..'),
    )
  )
    throw new HubBuildError('CONFIG', `${label} must be an array of relative glob patterns`);
  for (const pattern of value as string[]) {
    try {
      matchesGlob('__slidock_glob_validation__.md', pattern);
    } catch (error) {
      throw new HubBuildError(
        'CONFIG',
        `${label} contains an invalid glob pattern: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return [...(value as string[])];
}

function validateMetadata(value: unknown, label: string): HubDeckOptions {
  if (!record(value)) throw new HubBuildError('CONFIG', `${label} must be an object`);
  knownKeys(value, new Set(['id', 'title', 'order', 'draft', 'cover']), label);
  if (value.id !== undefined && !validDeckId(value.id))
    throw new HubBuildError('CONFIG', `${label}.id is invalid`);
  if (value.title !== undefined && (typeof value.title !== 'string' || !value.title.trim()))
    throw new HubBuildError('CONFIG', `${label}.title must be a nonempty string`);
  if (
    value.order !== undefined &&
    (typeof value.order !== 'number' || !Number.isFinite(value.order))
  )
    throw new HubBuildError('CONFIG', `${label}.order must be a finite number`);
  if (value.draft !== undefined && typeof value.draft !== 'boolean')
    throw new HubBuildError('CONFIG', `${label}.draft must be boolean`);
  if (value.cover !== undefined && typeof value.cover !== 'string')
    throw new HubBuildError('CONFIG', `${label}.cover must be a local image path`);
  return value as HubDeckOptions;
}

async function normalizeCover(value: unknown, base: string | undefined, label: string) {
  const path = absolute(value, base, label);
  if (!/\.(?:png|jpe?g|webp|svg)$/i.test(path))
    throw new HubBuildError('CONFIG', `${label} must be a PNG, JPEG, WebP, or SVG file`);
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isFile())
    throw new HubBuildError('CONFIG', `${label} must be a file`);
  return canonical;
}

async function normalizeDeckOptions(value: unknown, base: string | undefined) {
  if (value === undefined) return {} as Record<string, HubDeckOptions>;
  if (!record(value)) throw new HubBuildError('CONFIG', 'deckOptions must be an object');
  const result: Record<string, HubDeckOptions> = Object.create(null);
  for (const [id, rawOptions] of Object.entries(value)) {
    if (!validDeckId(id))
      throw new HubBuildError('CONFIG', `deckOptions has invalid deck id: ${id}`);
    const options = validateMetadata(rawOptions, `deckOptions.${id}`);
    result[id] = {
      ...options,
      ...(options.cover === undefined
        ? {}
        : { cover: await normalizeCover(options.cover, base, `deckOptions.${id}.cover`) }),
    };
  }
  return result;
}

function normalizeHome(value: unknown): HubHomeOptions | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new HubBuildError('CONFIG', 'home must be an object');
  knownKeys(
    value,
    new Set(['title', 'logo', 'hero', 'description', 'links', 'footer', 'categoryLabels']),
    'home',
  );
  for (const key of ['title', 'description', 'footer'])
    if (value[key] !== undefined && typeof value[key] !== 'string')
      throw new HubBuildError('CONFIG', `home.${key} must be a string`);
  if (value.title !== undefined && !String(value.title).trim())
    throw new HubBuildError('CONFIG', 'home.title must be a nonempty string');
  if (value.logo !== undefined && value.logo !== false && typeof value.logo !== 'string')
    throw new HubBuildError('CONFIG', 'home.logo must be a string or false');
  if (value.hero !== undefined && typeof value.hero !== 'boolean')
    throw new HubBuildError('CONFIG', 'home.hero must be boolean');
  if (value.links !== undefined) {
    if (!Array.isArray(value.links))
      throw new HubBuildError('CONFIG', 'home.links must be an array');
    for (const [index, link] of value.links.entries()) {
      if (!record(link))
        throw new HubBuildError('CONFIG', `home.links[${index}] must be an object`);
      knownKeys(link, new Set(['label', 'href']), `home.links[${index}]`);
      for (const key of ['label', 'href'])
        if (typeof link[key] !== 'string' || !link[key].trim())
          throw new HubBuildError(
            'CONFIG',
            `home.links[${index}].${key} must be a nonempty string`,
          );
    }
  }
  if (value.categoryLabels !== undefined) {
    if (!record(value.categoryLabels))
      throw new HubBuildError('CONFIG', 'home.categoryLabels must be an object');
    for (const [key, label] of Object.entries(value.categoryLabels))
      if (!key || typeof label !== 'string')
        throw new HubBuildError('CONFIG', 'home.categoryLabels must map nonempty keys to strings');
  }
  return value as HubHomeOptions;
}

export async function normalizeHubConfig(options: HubBuildOptions): Promise<NormalizedHubConfig> {
  try {
    if (!record(options)) throw new HubBuildError('CONFIG', 'build options must be an object');
    knownKeys(options, new Set([...keys, 'configPath', 'baseDir', 'onProgress']), 'options');
    if (options.onProgress !== undefined && typeof options.onProgress !== 'function')
      throw new HubBuildError('CONFIG', 'onProgress must be a function');
    let base =
      options.baseDir === undefined ? undefined : absolute(options.baseDir, undefined, 'baseDir');
    let configured: Record<string, unknown> = {};
    if (options.configPath !== undefined) {
      const path = absolute(options.configPath, base, 'configPath');
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!record(parsed) || parsed.schemaVersion !== 1)
        throw new HubBuildError('CONFIG', 'config schemaVersion must be 1');
      knownKeys(parsed, new Set([...keys, 'schemaVersion']), 'config');
      const { schemaVersion: _schemaVersion, ...fields } = parsed;
      configured = fields;
      // Paths in the file always belong to its directory, even with API overrides.
      const fileBase = dirname(path);
      for (const key of [
        'sourceRoot',
        'outDir',
        'dependencyRoot',
        'theme',
        'chromiumExecutable',
        'frontendEntry',
      ])
        if (configured[key] !== undefined)
          configured[key] = absolute(configured[key], fileBase, key);
      if (Array.isArray(configured.decks))
        configured.decks = configured.decks.map((deck) =>
          record(deck)
            ? {
                ...deck,
                entry: absolute(deck.entry, fileBase, 'deck entry'),
                ...(deck.cover === undefined
                  ? {}
                  : { cover: absolute(deck.cover, fileBase, 'deck cover') }),
              }
            : deck,
        );
      if (record(configured.deckOptions))
        configured.deckOptions = Object.fromEntries(
          Object.entries(configured.deckOptions).map(([id, options]) => [
            id,
            record(options) && options.cover !== undefined
              ? { ...options, cover: absolute(options.cover, fileBase, `deckOptions.${id}.cover`) }
              : options,
          ]),
        );
      if (record(configured.profiles))
        configured.profiles = Object.fromEntries(
          Object.entries(configured.profiles).map(([id, profile]) => [
            id,
            record(profile)
              ? {
                  ...profile,
                  dependencyRoot: absolute(profile.dependencyRoot, fileBase, 'dependencyRoot'),
                  theme: absolute(profile.theme, fileBase, 'theme'),
                }
              : profile,
          ]),
        );
      base ??= fileBase;
    }
    const input: Record<string, unknown> = { ...configured };
    for (const [key, value] of Object.entries(options))
      if (keys.has(key) && value !== undefined) input[key] = value;
    const defaults = defaultToolchain();
    const basePath = normalizeBasePath(input.basePath as string | undefined);
    const sourceRoot = await realpath(absolute(input.sourceRoot, base, 'sourceRoot'));
    if (!(await stat(sourceRoot)).isDirectory())
      throw new HubBuildError('CONFIG', 'sourceRoot must be a directory');
    const outDir = await canonicalOutput(absolute(input.outDir, base, 'outDir'));
    if (isInside(sourceRoot, outDir) || isInside(outDir, sourceRoot))
      throw new HubBuildError('CONFIG', 'sourceRoot and outDir must be separate trees');
    if (isInside(outDir, hubRoot))
      throw new HubBuildError('CONFIG', 'outDir must not contain the Hub package');
    const dependencyRoot = await realpath(
      absolute(input.dependencyRoot ?? defaults.dependencyRoot, base, 'dependencyRoot'),
    );
    const theme = await realpath(absolute(input.theme ?? defaults.theme, base, 'theme'));
    for (const flag of ['offline', 'isolateDecks'])
      if (input[flag] !== undefined && typeof input[flag] !== 'boolean')
        throw new HubBuildError('CONFIG', `${flag} must be boolean`);
    for (const flag of ['compatibilityGroups', 'allowEmpty'])
      if (input[flag] !== undefined && typeof input[flag] !== 'boolean')
        throw new HubBuildError('CONFIG', `${flag} must be boolean`);
    const include = normalizeGlobs(input.include, 'include');
    const exclude = normalizeGlobs(input.exclude, 'exclude');
    const thumbnails = input.thumbnails ?? 'auto';
    if (thumbnails !== 'auto' && thumbnails !== 'none')
      throw new HubBuildError('CONFIG', 'thumbnails must be auto or none');
    const home = normalizeHome(input.home);
    const deckOptions = await normalizeDeckOptions(input.deckOptions, base);
    const allowEmpty = input.allowEmpty === true;
    if (input.bootstrap !== undefined && input.bootstrap !== 'sync' && input.bootstrap !== 'tla')
      throw new HubBuildError('CONFIG', 'bootstrap must be sync or tla');
    const frontendRoot = resolve(hubRoot, 'src/frontend');
    const frontendEntry = await realpath(
      absolute(input.frontendEntry ?? resolve(frontendRoot, 'home.ts'), base, 'frontendEntry'),
    );
    if (!(await stat(frontendEntry)).isFile() || isInside(outDir, frontendEntry))
      throw new HubBuildError('CONFIG', 'frontendEntry must be a file outside outDir');
    const navigation = input.navigation === undefined ? {} : input.navigation;
    if (!record(navigation)) throw new HubBuildError('CONFIG', 'navigation must be an object');
    knownKeys(navigation, new Set(['enabled', 'homeHref', 'homeLabel']), 'navigation');
    if (navigation.enabled !== undefined && typeof navigation.enabled !== 'boolean')
      throw new HubBuildError('CONFIG', 'navigation.enabled must be boolean');
    for (const key of ['homeHref', 'homeLabel'])
      if (
        navigation[key] !== undefined &&
        (typeof navigation[key] !== 'string' || !navigation[key])
      )
        throw new HubBuildError('CONFIG', `navigation.${key} must be a nonempty string`);
    let profiles: Record<string, HubProfile> | undefined;
    if (input.profiles !== undefined) {
      if (!record(input.profiles) || !Object.keys(input.profiles).length)
        throw new HubBuildError('CONFIG', 'profiles must be a nonempty object');
      profiles = {};
      for (const [id, profile] of Object.entries(input.profiles)) {
        if (!/^[A-Za-z0-9_-]+$/.test(id) || !record(profile))
          throw new HubBuildError('CONFIG', `invalid profile ${id}`);
        knownKeys(profile, new Set(['dependencyRoot', 'theme']), `profile ${id}`);
        profiles[id] = {
          dependencyRoot: await realpath(absolute(profile.dependencyRoot, base, 'dependencyRoot')),
          theme: await realpath(absolute(profile.theme, base, 'theme')),
        };
      }
    }
    const selection = input.decks === undefined ? 'discover' : 'explicit';
    const rawDecks =
      selection === 'discover'
        ? await discoverDecks(sourceRoot, { include, exclude, allowEmpty })
        : (() => {
            if (!Array.isArray(input.decks) || (!input.decks.length && !allowEmpty))
              throw new HubBuildError(
                'CONFIG',
                'decks must be a nonempty array unless allowEmpty is true',
              );
            return input.decks as unknown[];
          })();
    const decks: NormalizedHubConfig['decks'] = [];
    const finalIds = new Set<string>();
    for (const rawDeck of rawDecks) {
      if (!record(rawDeck)) throw new HubBuildError('CONFIG', 'deck must be an object');
      const discoveredId = rawDeck.id;
      const deckOptionsValue =
        selection === 'discover' &&
        typeof discoveredId === 'string' &&
        Object.hasOwn(deckOptions, discoveredId)
          ? deckOptions[discoveredId]
          : undefined;
      const metadata =
        selection === 'discover'
          ? (deckOptionsValue ?? {})
          : validateMetadata(
              {
                ...(rawDeck.title === undefined ? {} : { title: rawDeck.title }),
                ...(rawDeck.order === undefined ? {} : { order: rawDeck.order }),
                ...(rawDeck.draft === undefined ? {} : { draft: rawDeck.draft }),
                ...(rawDeck.cover === undefined ? {} : { cover: rawDeck.cover }),
              },
              `deck ${String(rawDeck.id)}`,
            );
      if (selection === 'explicit')
        knownKeys(
          rawDeck,
          new Set(['id', 'entry', 'profile', 'title', 'order', 'draft', 'cover']),
          'deck',
        );
      const id = selection === 'discover' ? (metadata.id ?? discoveredId) : rawDeck.id;
      if (!validDeckId(id)) throw new HubBuildError('CONFIG', `invalid deck id: ${String(id)}`);
      if (finalIds.has(id)) throw new HubBuildError('CONFIG', `duplicate deck id: ${id}`);
      finalIds.add(id);
      const entry = await realpath(
        absolute(
          rawDeck.entry,
          selection === 'explicit' ? (base ?? sourceRoot) : undefined,
          'deck entry',
        ),
      );
      if (!isInside(sourceRoot, entry) || !(await stat(entry)).isFile())
        throw new HubBuildError('CONFIG', `deck ${id} is outside sourceRoot or not a file`);
      if (
        selection === 'explicit' &&
        rawDeck.profile !== undefined &&
        (typeof rawDeck.profile !== 'string' || !rawDeck.profile)
      )
        throw new HubBuildError('CONFIG', 'deck profile must be a nonempty string');
      if (
        profiles
          ? selection !== 'explicit' ||
            !rawDeck.profile ||
            !Object.hasOwn(profiles, rawDeck.profile as string)
          : selection === 'explicit' && rawDeck.profile !== undefined
      )
        throw new HubBuildError('CONFIG', `deck ${id} requires a declared profile`);
      const cover =
        metadata.cover === undefined
          ? undefined
          : await normalizeCover(metadata.cover, base, `deck ${id} cover`);
      if (metadata.draft === true) continue;
      decks.push({
        id,
        entry,
        categoryPath: id.split('/').slice(0, -1),
        ...(selection === 'explicit' && rawDeck.profile
          ? { profile: rawDeck.profile as string }
          : {}),
        ...(metadata.title === undefined ? {} : { title: metadata.title }),
        order: metadata.order ?? 0,
        draft: false,
        ...(cover === undefined ? {} : { cover }),
      });
    }
    decks.sort((left, right) =>
      left.order !== right.order
        ? left.order - right.order
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0,
    );
    if (!decks.length && !allowEmpty)
      throw new HubBuildError('CONFIG', `No Slidev decks found in ${sourceRoot}`);
    return {
      basePath,
      sourceRoot,
      outDir,
      dependencyRoot,
      theme,
      frontendRoot,
      frontendEntry,
      navigation: navigation as HubNavigationOptions,
      decks,
      include,
      exclude,
      deckOptions,
      selection,
      profiles,
      thumbnails,
      home,
      compatibilityGroups: input.compatibilityGroups === true,
      allowEmpty,
      offline: input.offline !== false,
      isolateDecks: input.isolateDecks === true,
      bootstrap: input.bootstrap === 'tla' ? 'tla' : 'sync',
      ...(input.chromiumExecutable !== undefined
        ? { chromiumExecutable: absolute(input.chromiumExecutable, base, 'chromiumExecutable') }
        : {}),
    };
  } catch (error) {
    if (error instanceof HubBuildError) throw error;
    throw new HubBuildError('CONFIG', error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}
