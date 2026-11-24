import { dirname, join, resolve } from 'node:path';

export type SlideForSanitizing = {
  note?: string;
  frontmatterRaw?: string;
  content: string;
  source: {
    note?: string;
    frontmatterRaw?: string;
    content: string;
  };
};

export function stripPrivateSlideData(slide: SlideForSanitizing): void {
  slide.note = '';
  slide.source.note = '';
  slide.frontmatterRaw = '';
  slide.source.frontmatterRaw = '';
  slide.content = slide.content.replace(/<!--[\s\S]*?-->/g, '');
  slide.source.content = slide.source.content.replace(/<!--[\s\S]*?-->/g, '');
}

export function rewriteSlidevImports(code: string, deckPrefix: string): string {
  return code.replace(/(["'])\/@slidev\//g, `$1${deckPrefix}/`);
}

export function patchSlidevImageFrontmatter(
  code: string,
  images: unknown[],
  urls: string[],
  id: string,
): string {
  const signature = `"images":${JSON.stringify(images)}`;
  if (!code.includes(signature))
    throw new Error(`Slidev image frontmatter signature changed: ${id}`);
  return code.replace(signature, () => `"images":[${urls.join(',')}]`);
}

export function patchSlidevImageImports(
  code: string,
  id: string,
  filepath: string,
  frontmatter: Record<string, unknown>,
  images: string[],
): string {
  const relativeImage = (value: unknown): value is string =>
    typeof value === 'string' && (value.startsWith('./') || value.startsWith('../'));
  const properties = Object.entries(frontmatter).filter(
    (entry): entry is [string, string] =>
      /^(?:background(?:Image)?|image(?:[A-Z].*)?)$/u.test(entry[0]) && relativeImage(entry[1]),
  );
  const paths = [
    ...new Set([...images.filter(relativeImage), ...properties.map(([, value]) => value)]),
  ];
  if (!paths.length) return code;
  const urls = new Map(
    paths.map((path, index) => [path, `new URL(__labImage${index}, import.meta.url).href`]),
  );
  const imports = paths.map(
    (path, index) =>
      `import __labImage${index} from ${JSON.stringify(resolve(dirname(filepath), path) + '?url&no-inline')};`,
  );
  // Slidev 52 omits preload metadata. Layout-specific keys such as imageLeft
  // can still need imports even when Slidev found no preloadable images.
  if (code.includes(`"images":${JSON.stringify(images)}`))
    code = patchSlidevImageFrontmatter(
      code,
      images,
      images.map((path) => urls.get(path) ?? JSON.stringify(path)),
      id,
    );
  if (properties.length) {
    const signature = `export const frontmatterData = ${JSON.stringify(frontmatter)}`;
    if (!code.includes(signature))
      throw new Error(`Slidev frontmatter data signature changed: ${id}`);
    const keys = new Set(properties.map(([key]) => key));
    const fields = Object.entries(frontmatter).map(
      ([key, value]) =>
        `${JSON.stringify(key)}:${keys.has(key) ? urls.get(value as string) : JSON.stringify(value)}`,
    );
    // Theme helpers prefix root-relative URLs with BASE_URL. Absolute URLs also
    // let the stock development preloader use an imported asset without re-prefixing it.
    code = code.replace(signature, () => `export const frontmatterData = {${fields.join(',')}}`);
  }
  return imports.join('\n') + '\n' + code;
}

export function patchStaticRuntimeModule({
  code,
  id,
  clientRoot,
}: {
  code: string;
  id: string;
  clientRoot: string;
}): string | undefined {
  const mainFile = join(clientRoot, 'setup/main.ts');
  const envFile = join(clientRoot, 'env.ts');
  const rootFile = join(clientRoot, 'setup/root.ts');
  const preloadImagesFile = join(clientRoot, 'composables/usePreloadImages.ts');

  if (id === preloadImagesFile) {
    let transformed = code.replaceAll('import.meta.env.BASE_URL', '__labDeckBase');
    const baseSignature = "const base = (__labDeckBase || '/').replace(RE_TRAILING_SLASH, '')";
    if (!code.includes("import.meta.env.BASE_URL || '/'") || !transformed.includes(baseSignature))
      throw new Error(`Slidev image-base signature changed: ${id}`);
    transformed = transformed.replace(
      baseSignature,
      `if (url.startsWith(__labSiteBase)) return url\n  ${baseSignature}`,
    );
    return (
      `import { deckBase as __labDeckBase, siteBase as __labSiteBase } from '/@lab/selection';\n` +
      transformed
    );
  }

  if (id === mainFile || id === envFile) {
    if (!code.includes('import.meta.env.BASE_URL'))
      throw new Error(`Slidev router-base signature changed: ${id}`);
    let transformed =
      `import { deckBase as __labDeckBase } from '/@lab/selection';\n` +
      code.replaceAll('import.meta.env.BASE_URL', '__labDeckBase');
    if (id === mainFile) {
      if (!code.includes('app.use(router)'))
        throw new Error(`Slidev native-router signature changed: ${id}`);
      transformed =
        `import { slides as __labNativeSlides } from '#slidev/slides';\nimport { unref as __labUnref } from 'vue';\n` +
        transformed.replace(
          'app.use(router)',
          'app.use(router)\n  if (window.__nativeSlidevBridge) window.__slidevLabNative = { router, slides: __labUnref(__labNativeSlides) }',
        );
    }
    return transformed;
  }

  if (id === rootFile) {
    if (
      !code.includes('`${slidesTitle} - shared`') ||
      !code.includes('`${slidesTitle} - drawings`')
    )
      throw new Error(`Slidev sync-channel signature changed: ${id}`);
    return (
      `import { deckId as __labDeckId } from '/@lab/selection';\n` +
      code
        .replace('`${slidesTitle} - shared`', '`${__labDeckId} - shared`')
        .replace('`${slidesTitle} - drawings`', '`${__labDeckId} - drawings`')
    );
  }
}

export function stripSlidevImagePreloads(html: string): string {
  // The HTML hints still contain source paths; the runtime preloader receives resolved imports.
  return html.replace(/<link\b[^>]*\bas=["']image["'][^>]*>/g, '');
}

export function patchSlidevHtmlEntry(html: string): string {
  const entryPattern = /<script type="module" src="[^"]+"><\/script>/;
  if (!entryPattern.test(html)) throw new Error('Slidev HTML entry signature changed');
  const transformed = stripSlidevImagePreloads(
    html.replace(entryPattern, '<script type="module" src="/@lab/entry"></script>'),
  );
  if (!transformed.includes('/@lab/entry')) throw new Error('Slidev HTML entry signature changed');
  return transformed;
}

// Presentation labels can vary without changing the compiler's module graph.
const runtimeOnlyFields = new Set([
  'title',
  'slidesTitle',
  'titleTemplate',
  'author',
  'keywords',
  'info',
  'seoMeta',
]);
export function compileContract(options: {
  data: { config: Record<string, unknown>; features: unknown };
  roots: string[];
  clientRoot: string;
}) {
  return {
    features: options.data.features,
    config: Object.fromEntries(
      Object.entries(options.data.config).filter(([key]) => !runtimeOnlyFields.has(key)),
    ),
    roots: options.roots,
    clientRoot: options.clientRoot,
  };
}
export function stableJson(value: unknown): string | undefined {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => JSON.stringify(key) + ':' + stableJson(record[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}
