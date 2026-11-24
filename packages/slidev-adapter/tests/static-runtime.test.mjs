import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolveRuntime } from '@slidock/slidev-adapter/runtime';
import {
  patchSlidevHtmlEntry,
  patchSlidevImageFrontmatter,
  patchStaticRuntimeModule,
  rewriteSlidevImports,
  stripPrivateSlideData,
} from '@slidock/slidev-adapter/static-runtime';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dependencyRoots = [repositoryRoot, resolve(repositoryRoot, 'examples/slidev52')];

for (const dependencyRoot of dependencyRoots) {
  test(`static runtime signatures patch for ${dependencyRoot}`, async () => {
    const runtime = await resolveRuntime(dependencyRoot);
    const envFile = join(runtime.clientRoot, 'env.ts');
    const mainFile = join(runtime.clientRoot, 'setup/main.ts');
    const rootFile = join(runtime.clientRoot, 'setup/root.ts');
    const preloadImagesFile = join(runtime.clientRoot, 'composables/usePreloadImages.ts');
    const [envSource, mainSource, rootSource, preloadImagesSource] = await Promise.all([
      readFile(envFile, 'utf8'),
      readFile(mainFile, 'utf8'),
      readFile(rootFile, 'utf8'),
      readFile(preloadImagesFile, 'utf8'),
    ]);

    const env = patchStaticRuntimeModule({
      code: envSource,
      id: envFile,
      clientRoot: runtime.clientRoot,
    });
    const main = patchStaticRuntimeModule({
      code: mainSource,
      id: mainFile,
      clientRoot: runtime.clientRoot,
    });
    const root = patchStaticRuntimeModule({
      code: rootSource,
      id: rootFile,
      clientRoot: runtime.clientRoot,
    });
    const preloadImages = patchStaticRuntimeModule({
      code: preloadImagesSource,
      id: preloadImagesFile,
      clientRoot: runtime.clientRoot,
    });
    assert.ok(env.includes("import { deckBase as __labDeckBase } from '/@lab/selection';"));
    assert.ok(!env.includes('import.meta.env.BASE_URL'));
    assert.ok(
      main.includes('window.__slidevLabNative = { router, slides: __labUnref(__labNativeSlides) }'),
    );
    assert.ok(root.includes('`${__labDeckId} - shared`'));
    assert.ok(root.includes('`${__labDeckId} - drawings`'));
    assert.ok(preloadImages.includes('siteBase as __labSiteBase'));
    assert.ok(preloadImages.includes('url.startsWith(__labSiteBase)'));
    assert.ok(!preloadImages.includes('import.meta.env.BASE_URL'));
  });
}

test('missing runtime signatures and HTML entry fail explicitly', () => {
  const clientRoot = '/slidev/client';
  assert.throws(
    () =>
      patchStaticRuntimeModule({
        code: 'export const base = "missing";',
        id: join(clientRoot, 'env.ts'),
        clientRoot,
      }),
    /Slidev router-base signature changed/,
  );
  assert.throws(
    () =>
      patchStaticRuntimeModule({
        code: 'import.meta.env.BASE_URL;',
        id: join(clientRoot, 'setup/main.ts'),
        clientRoot,
      }),
    /Slidev native-router signature changed/,
  );
  assert.throws(
    () =>
      patchStaticRuntimeModule({
        code: '`${slidesTitle} - shared`',
        id: join(clientRoot, 'setup/root.ts'),
        clientRoot,
      }),
    /Slidev sync-channel signature changed/,
  );
  assert.throws(
    () => patchSlidevHtmlEntry('<html><head></head><body></body></html>'),
    /HTML entry signature changed/,
  );
});

test('HTML and image rewrites preserve valid output and reject changed signatures', () => {
  assert.equal(
    patchSlidevHtmlEntry(
      '<html><head><link rel="preload" as="image" href="a.png"></head><body><script type="module" src="/entry.js"></script></body></html>',
    ),
    '<html><head></head><body><script type="module" src="/@lab/entry"></script></body></html>',
  );
  assert.equal(
    patchSlidevImageFrontmatter(
      'export default {"images":["./a.png"]};',
      ['./a.png'],
      ['__labImage0'],
      'deck.frontmatter',
    ),
    'export default {"images":[__labImage0]};',
  );
  assert.throws(
    () =>
      patchSlidevImageFrontmatter(
        'export default {};',
        ['./a.png'],
        ['__labImage0'],
        'deck.frontmatter',
      ),
    /Slidev image frontmatter signature changed: deck.frontmatter/,
  );
  assert.equal(
    rewriteSlidevImports("import x from '/@slidev/x';", '/deck'),
    "import x from '/deck/x';",
  );
});

test('private source fields and HTML comments are stripped before public loader creation', () => {
  const slide = {
    note: 'private note',
    frontmatterRaw: 'private yaml',
    content: '<!-- private -->visible',
    source: {
      note: 'private source note',
      frontmatterRaw: 'private source yaml',
      content: '<!-- private source -->source-visible',
    },
  };
  stripPrivateSlideData(slide);
  assert.deepEqual(slide, {
    note: '',
    frontmatterRaw: '',
    content: 'visible',
    source: { note: '', frontmatterRaw: '', content: 'source-visible' },
  });
});

test('relative image properties resolve without changing other frontmatter values', async () => {
  const { patchSlidevImageImports } = await import('@slidock/slidev-adapter/static-runtime');
  const frontmatter = {
    background: '../assets/image.svg',
    backgroundImage: '../assets/image.svg',
    imageLeft: '../assets/image.svg',
    imageTopRight: '../assets/image.svg',
    imageBottomRight: '../assets/image.svg',
    title: '../assets/image.svg',
    info: '$& $$',
    image: 'https://example.test/remote.svg',
    imageRight: '/public.svg',
    imageOpacity: 0.5,
  };
  const source = `export const frontmatterData = ${JSON.stringify(frontmatter)};`;
  const patched = patchSlidevImageImports(
    source,
    'deck.frontmatter',
    '/deck/slides.md',
    frontmatter,
    [],
  );
  const url = 'https://example.test/slides/assets/image-hash.svg';
  const executable = patched.replace(
    /^import __labImage0 from .*;$/m,
    `const __labImage0 = ${JSON.stringify(url)};`,
  );
  const module = await import(`data:text/javascript,${encodeURIComponent(executable)}`);
  assert.deepEqual(module.frontmatterData, {
    ...frontmatter,
    background: url,
    backgroundImage: url,
    imageLeft: url,
    imageTopRight: url,
    imageBottomRight: url,
  });
  assert.throws(
    () =>
      patchSlidevImageImports(
        'export const frontmatterData = {};',
        'changed.frontmatter',
        '/deck/slides.md',
        frontmatter,
        [],
      ),
    /frontmatter data signature changed: changed.frontmatter/,
  );
});
