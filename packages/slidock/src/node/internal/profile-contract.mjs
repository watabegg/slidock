import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  compileContract as slidevCompileContract,
  stableJson,
} from '@slidock/slidev-adapter/static-runtime';

export { stableJson };

const rootSensitiveFiles = [
  'index.html',
  'og-image.png',
  'package.json',
  'custom-nav-controls.vue',
  ...['style', 'styles'].flatMap((name) =>
    ['.ts', '.js', '.css'].map((extension) => `${name}${extension}`),
  ),
  ...['vite', 'uno', 'unocss'].flatMap((name) =>
    ['.config.ts', '.config.js', '.config.mjs', '.config.mts', '.config.cjs', '.config.cts'].map(
      (suffix) => `${name}${suffix}`,
    ),
  ),
  ...[
    'global',
    'global-top',
    'GlobalTop',
    'global-bottom',
    'GlobalBottom',
    'slide-top',
    'SlideTop',
    'slide-bottom',
    'SlideBottom',
  ].flatMap((name) => ['.ts', '.js', '.vue'].map((extension) => `${name}${extension}`)),
];

const rootSensitiveDirectories = ['icons', 'public', 'setup', 'components', 'layouts', 'styles'];

function hasNodeModulesPackages(root) {
  const directory = join(root, 'node_modules');
  if (!existsSync(directory)) return false;
  try {
    // Slidev creates this cache while resolving a deck; it is not an input to
    // package resolution and must not make every deck root path-sensitive.
    return readdirSync(directory).some((name) => name !== '.slidev');
  } catch {
    return true;
  }
}

function hasRootSensitiveInputs(root) {
  return (
    rootSensitiveDirectories.some((name) => existsSync(join(root, name))) ||
    rootSensitiveFiles.some((name) => existsSync(join(root, name))) ||
    hasNodeModulesPackages(root)
  );
}

function packageContext(root) {
  let directory = root;
  while (true) {
    if (existsSync(join(directory, 'package.json')) || hasNodeModulesPackages(directory))
      return directory;
    const parent = dirname(directory);
    if (parent === directory) return directory;
    directory = parent;
  }
}

export function compileContract(options) {
  const contract = slidevCompileContract(options);
  const deckRoot = typeof options.userRoot === 'string' ? resolve(options.userRoot) : undefined;
  if (!deckRoot || hasRootSensitiveInputs(deckRoot)) return contract;
  const userRootIndex = contract.roots.lastIndexOf(deckRoot);
  if (userRootIndex < 0) return contract;

  // Slidev includes userRoot in roots. Plain deck roots have no shared inputs
  // whose resolution depends on that path, so normalize only this root entry.
  // Roots with local HTML, styling, icons, layers, or package context retain
  // their literal path to keep those decks isolated. The package context stays
  // in the sentinel because package lookup also walks above userRoot.
  return {
    ...contract,
    roots: contract.roots.map((root, index) =>
      index === userRootIndex ? `<deck-root@${packageContext(deckRoot)}>` : root,
    ),
  };
}
