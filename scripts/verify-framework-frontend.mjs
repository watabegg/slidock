import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-chromium';
import { buildHub } from '@slidock/slidock';
import { createServer } from '@slidock/slidock/serve';

const workRoot = await mkdtemp(join(tmpdir(), 'slidock-framework-frontend-'));
const slidesRoot = join(workRoot, 'slides');
const homeOutput = join(workRoot, 'home-site');
const consumerOutput = join(workRoot, 'consumer-site');
await symlink(join(process.cwd(), 'node_modules'), join(workRoot, 'node_modules'), 'dir');
const fixtureSlides = [
  {
    path: 'science/physics.md',
    title: 'Wave Motion',
    author: 'Mina Sato',
    description: 'An introduction to sound and light.',
    tags: "['intro', 'science']",
    date: '2025-01-01',
    body: 'Sound travels through a medium.',
  },
  {
    path: 'science/chemistry.md',
    title: 'Atoms',
    author: 'Riku Ito',
    description: 'Matter at the smallest scale.',
    tags: "['chemistry']",
    date: '2026-03-10',
    body: 'Atoms contain protons and electrons.',
  },
  {
    path: 'history/astronomy.md',
    title: 'Night Sky',
    author: 'A. Reader',
    description: 'Stories about the stars.',
    tags: "['intro']",
    date: '2024-06-12',
    body: 'Look up at the stars.',
  },
];
for (const slide of fixtureSlides) {
  const file = join(slidesRoot, slide.path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(
    file,
    `---\ntitle: ${slide.title}\nauthor: ${slide.author}\ndescription: ${slide.description}\ntags: ${slide.tags}\ndate: ${slide.date}\nfonts:\n  webfonts: []\n  sans: Arial\n  mono: monospace\n---\n# ${slide.title}\n\n${slide.body}\n`,
  );
}

let browser;
const servers = [];
async function serve(output) {
  const server = createServer(output);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

try {
  const home = await buildHub({
    sourceRoot: slidesRoot,
    outDir: homeOutput,
    offline: false,
    thumbnails: 'none',
    home: {
      title: '<img id="config-injection" src=x onerror="window.configPwned=true">',
      hero: true,
      description: 'Fixture description',
      logo: false,
      links: [{ label: 'Docs', href: 'https://example.test/docs' }],
      footer: 'Fixture footer',
      categoryLabels: { science: 'Science & Nature' },
    },
  });
  const consumerEntry = join(workRoot, 'consumer-entry.ts');
  const catalogLiteral = JSON.stringify(JSON.stringify(home.catalog));
  await writeFile(
    consumerEntry,
    `import '@slidock/slidock/frontend/style.css';
import { createApp, h, ref, shallowRef } from 'vue';
import { SlidockHome } from '@slidock/slidock/frontend';
const initialCatalog = JSON.parse(${catalogLiteral});
const emptyCatalog = { schemaVersion: 1, categories: [], decks: [] };
const card = ({ deck, href }) => h('a', { class: 'fixture-card', 'data-deck': deck.id, href }, [h('h3', deck.title)]);
const app = createApp({
  setup() {
    const catalog = shallowRef(initialCatalog);
    const query = ref('');
    const tag = ref('');
    const sort = ref('catalog');
    const offQuery = ref('');
    const offTag = ref('');
    const offSort = ref('catalog');
    Object.assign(globalThis, {
      frameworkFrontendFixture: {
        replaceCatalog(value) { catalog.value = value; },
        state() { return { query: query.value, tag: tag.value, sort: sort.value }; },
        offState() { return { query: offQuery.value, tag: offTag.value, sort: offSort.value }; },
      },
    });
    const primary = () => h(SlidockHome, {
      catalog: catalog.value,
      query: query.value,
      'onUpdate:query': value => query.value = value,
      tag: tag.value,
      'onUpdate:tag': value => tag.value = value,
      sort: sort.value,
      'onUpdate:sort': value => sort.value = value,
    }, { card });
    const noControls = () => h(SlidockHome, {
      catalog: catalog.value,
      controls: false,
      query: offQuery.value,
      'onUpdate:query': value => offQuery.value = value,
      tag: offTag.value,
      'onUpdate:tag': value => offTag.value = value,
      sort: offSort.value,
      'onUpdate:sort': value => offSort.value = value,
    }, {
      card,
      toolbar: ({ setQuery, setTag, setSort }) => h('div', { class: 'custom-toolbar' }, [
        h('button', { id: 'set-custom-query', onClick: () => setQuery('wave') }, 'Query Wave'),
        h('button', { id: 'set-custom-tag', onClick: () => setTag('intro') }, 'Tag Intro'),
        h('button', { id: 'set-custom-sort', onClick: () => setSort('title') }, 'Sort Title'),
      ]),
    });
    return () => h('div', { id: 'frontend-test-root' }, [
      h('a', { id: 'host-link', class: 'navbar brand skip-link', href: '#host' }, 'Host link'),
      h('button', { id: 'host-button', class: 'filter-control navbar-links' }, 'Host button'),
      h('div', { id: 'host-preview', class: 'deck-preview' }),
      h('section', { id: 'primary-ui' }, [primary()]),
      h('section', { id: 'controls-off-ui' }, [noControls()]),
      h('section', { id: 'empty-state-ui' }, [h(SlidockHome, { catalog: emptyCatalog, controls: false })]),
    ]);
  },
});
app.mount(document.querySelector('#app'));
`,
  );
  const consumer = await buildHub({
    sourceRoot: slidesRoot,
    outDir: consumerOutput,
    frontendEntry: consumerEntry,
    offline: false,
    thumbnails: 'none',
  });
  assert.deepEqual(
    consumer.catalog.decks.map(({ id }) => id),
    home.catalog.decks.map(({ id }) => id),
    'The default and custom entry build the same fixture catalog',
  );

  const generatedHtml = await readFile(join(home.output, 'index.html'), 'utf8');
  const configScript = generatedHtml.match(
    /<script id="slidock-home-config" type="application\/json">([\s\S]*?)<\/script>/u,
  );
  assert.ok(configScript, 'Configured home emits an inert JSON script');
  assert.ok(!configScript[1].includes('<'), 'Home JSON escapes less-than characters');

  const homeUrl = await serve(home.output);
  const consumerUrl = await serve(consumer.output);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
  });

  const homePage = await browser.newPage();
  const homeErrors = [];
  homePage.on('pageerror', (error) => homeErrors.push(error.message));
  await homePage.goto(homeUrl);
  await homePage.locator('.deck-card').first().waitFor();
  assert.equal(
    await homePage.locator('.brand span').textContent(),
    '<img id="config-injection" src=x onerror="window.configPwned=true">',
  );
  assert.equal(await homePage.locator('#config-injection').count(), 0);
  assert.equal(await homePage.evaluate(() => globalThis.configPwned), undefined);
  assert.equal(
    await homePage.locator('.home-hero h1').textContent(),
    '<img id="config-injection" src=x onerror="window.configPwned=true">',
  );
  assert.equal(await homePage.locator('.home-hero p').textContent(), 'Fixture description');
  assert.equal(
    await homePage.locator('.navbar-links a').getAttribute('href'),
    'https://example.test/docs',
  );
  assert.equal(await homePage.locator('.library-footer').textContent(), 'Fixture footer');
  assert.equal(await homePage.locator('.brand img').count(), 0);
  assert.equal(
    await homePage.getByRole('button', { name: 'Science & Nature', exact: true }).count(),
    1,
  );
  assert.equal(await homePage.getByRole('searchbox', { name: '資料を検索' }).count(), 1);
  assert.equal(await homeErrors.length, 0);

  await homePage.route(`${homeUrl}/`, async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    const malformed = html.replace(
      /(<script id="slidock-home-config" type="application\/json">)[\s\S]*?(<\/script>)/u,
      '$1{invalid JSON}$2',
    );
    await route.fulfill({ response, body: malformed });
  });
  await homePage.goto(homeUrl);
  await homePage
    .getByRole('alert')
    .getByText(/安全な既定設定/u)
    .waitFor();
  await homePage.locator('.deck-card').first().waitFor();
  assert.equal(await homePage.locator('.brand span').textContent(), 'Slidock');
  await homePage.unroute(`${homeUrl}/`);

  const page = await browser.newPage();
  await page.addInitScript(() => {
    const host = document.createElement('style');
    host.id = 'host-sentinel-style';
    host.textContent = `body { margin: 23px; background: rgb(13, 27, 39); font-family: cursive; }
a { color: rgb(180, 20, 100); text-decoration: overline; }
button { font: 900 19px monospace; }`;
    const observer = new MutationObserver(() => {
      if (!document.head) return;
      document.head.prepend(host);
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
    if (document.head) {
      document.head.prepend(host);
      observer.disconnect();
    }
  });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(consumerUrl);
  await page.locator('#primary-ui .fixture-card').first().waitFor();

  const hostStyles = await page.evaluate(() => ({
    margin: getComputedStyle(document.body).marginTop,
    background: getComputedStyle(document.body).backgroundColor,
    linkColor: getComputedStyle(document.querySelector('#host-link')).color,
    linkDecoration: getComputedStyle(document.querySelector('#host-link')).textDecorationLine,
    linkDisplay: getComputedStyle(document.querySelector('#host-link')).display,
    linkPosition: getComputedStyle(document.querySelector('#host-link')).position,
    buttonDisplay: getComputedStyle(document.querySelector('#host-button')).display,
    buttonFont: getComputedStyle(document.querySelector('#host-button')).fontFamily,
    buttonWeight: getComputedStyle(document.querySelector('#host-button')).fontWeight,
    previewRatio: getComputedStyle(document.querySelector('#host-preview')).aspectRatio,
  }));
  assert.deepEqual(hostStyles, {
    margin: '23px',
    background: 'rgb(13, 27, 39)',
    linkColor: 'rgb(180, 20, 100)',
    linkDecoration: 'overline',
    linkDisplay: 'inline',
    linkPosition: 'static',
    buttonDisplay: 'inline-block',
    buttonFont: 'monospace',
    buttonWeight: '900',
    previewRatio: 'auto',
  });

  const primary = page.locator('#primary-ui');
  await primary.getByRole('button', { name: 'science', exact: true }).click();
  await primary.getByRole('combobox', { name: 'タグで絞り込み' }).selectOption('intro');
  await primary.getByRole('searchbox', { name: '資料を検索' }).fill('  WAVE ');
  assert.deepEqual(
    await primary
      .locator('.fixture-card')
      .evaluateAll((cards) => cards.map((card) => card.dataset.deck)),
    ['science/physics'],
  );
  await primary.getByRole('searchbox', { name: '資料を検索' }).fill('matter');
  assert.equal(await primary.locator('.fixture-card').count(), 0);
  assert.equal(
    await primary.locator('.empty-library').textContent(),
    '条件に一致するスライドがありません。',
  );
  await primary.getByRole('searchbox', { name: '資料を検索' }).fill('');
  await primary.getByRole('combobox', { name: 'タグで絞り込み' }).selectOption('');
  await primary.getByRole('button', { name: 'すべて', exact: true }).click();
  await primary.getByRole('combobox', { name: '並び替え' }).selectOption('title');
  const titleOrder = [...home.catalog.decks]
    .sort((left, right) =>
      left.title < right.title
        ? -1
        : left.title > right.title
          ? 1
          : left.id < right.id
            ? -1
            : left.id > right.id
              ? 1
              : 0,
    )
    .map(({ id }) => id);
  assert.deepEqual(
    await primary
      .locator('.fixture-card')
      .evaluateAll((cards) => cards.map((card) => card.dataset.deck)),
    titleOrder,
  );
  await primary.getByRole('combobox', { name: '並び替え' }).selectOption('date');
  const dateOrder = [...home.catalog.decks]
    .map((deck, index) => ({
      deck,
      index,
      date: Date.parse(typeof deck.frontmatter.date === 'string' ? deck.frontmatter.date : ''),
    }))
    .sort((left, right) => {
      const leftValid = Number.isFinite(left.date);
      const rightValid = Number.isFinite(right.date);
      if (leftValid !== rightValid) return leftValid ? -1 : 1;
      if (leftValid && rightValid && left.date !== right.date) return right.date - left.date;
      return left.index - right.index;
    })
    .map(({ deck }) => deck.id);
  assert.deepEqual(
    await primary
      .locator('.fixture-card')
      .evaluateAll((cards) => cards.map((card) => card.dataset.deck)),
    dateOrder,
  );
  await primary.getByRole('searchbox', { name: '資料を検索' }).fill('53.0.0');
  assert.equal(await primary.locator('.fixture-card').count(), 0);
  assert.equal(
    await primary.locator('.empty-library').textContent(),
    '条件に一致するスライドがありません。',
  );
  assert.doesNotMatch(
    await primary.locator('.library').innerText(),
    /(?:53\.0\.0|slidev53|revision-)/u,
  );
  await primary.getByRole('searchbox', { name: '資料を検索' }).fill('wave');

  const controlsOff = page.locator('#controls-off-ui');
  assert.equal(await controlsOff.getByRole('searchbox', { name: '資料を検索' }).count(), 0);
  assert.equal(await controlsOff.getByRole('combobox', { name: 'タグで絞り込み' }).count(), 0);
  assert.equal(await controlsOff.getByRole('combobox', { name: '並び替え' }).count(), 0);
  await controlsOff.locator('#set-custom-query').click();
  await controlsOff.locator('#set-custom-tag').click();
  await controlsOff.locator('#set-custom-sort').click();
  assert.deepEqual(await page.evaluate(() => globalThis.frameworkFrontendFixture.offState()), {
    query: 'wave',
    tag: 'intro',
    sort: 'title',
  });
  assert.deepEqual(
    await controlsOff
      .locator('.fixture-card')
      .evaluateAll((cards) => cards.map((card) => card.dataset.deck)),
    ['science/physics'],
  );

  const beforeRefresh = await page.evaluate(() => globalThis.frameworkFrontendFixture.state());
  const refreshedCatalog = structuredClone(home.catalog);
  refreshedCatalog.decks[0].revision = 'refresh-revision';
  await page.evaluate(
    (value) => globalThis.frameworkFrontendFixture.replaceCatalog(value),
    refreshedCatalog,
  );
  assert.deepEqual(
    await page.evaluate(() => globalThis.frameworkFrontendFixture.state()),
    beforeRefresh,
  );
  assert.deepEqual(
    await primary
      .locator('.fixture-card')
      .evaluateAll((cards) => cards.map((card) => card.dataset.deck)),
    ['science/physics'],
  );
  assert.equal(
    await page.locator('#empty-state-ui .empty-library').textContent(),
    'スライドがありません。',
  );
  assert.equal(pageErrors.length, 0);

  console.log(
    'Framework frontend verification passed: home config, filters, sorting, slots, CSS isolation, refresh state, empty states, and metadata rendering.',
  );
} finally {
  if (browser) await browser.close();
  await Promise.all(servers.map(closeServer));
  await rm(workRoot, { recursive: true, force: true });
}
