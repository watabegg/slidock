import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright-chromium';
import { createServer } from './serve.mjs';

const site = 'packages/slidock/artifacts/module-graph-offline/site';
const output = 'artifacts/slive-sharpness';
await mkdir(output, { recursive: true });
const bridge = await readFile('apps/slive/dist/deck-bridge.js', 'utf8');
const manifest = JSON.parse(await readFile(site + '/native-player.json', 'utf8'));
const deck = manifest.decks[0];
const server = createServer(site);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const results = [];
try {
  for (const [name, engine] of [
    ['webkit', webkit],
    ['chromium', chromium],
  ]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      await page.route(origin + '/__rendering', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style>
          <iframe></iframe><script>
          let state=${JSON.stringify({ deckId: deck.id, revision: deck.revision, page: 1, clickIndex: 0, sessionRevision: 1, blackout: false })};
          const send=()=>document.querySelector('iframe').contentWindow.postMessage({nativeState:state},location.origin);
          window.addEventListener('message',e=>{
            if(e.data.nativeEscape)window.escapeCount=(window.escapeCount||0)+1;
            if(e.data.nativeBridgeReady)send();
            if(e.data.nativeRendered)window.rendered=e.data.nativeRendered;
          });
          window.advance=()=>{state={...state,page:2,sessionRevision:2};send();};
          document.querySelector('iframe').src=${JSON.stringify(origin + deck.entry + '?nativeProtocol=1&nativeMount=qa&nativeParentOrigin=' + encodeURIComponent(origin))};
          </script>`,
        }),
      );
      // Exercise the current local bridge against the real built Slidev fixture.
      await page.route(origin + deck.entry + '?nativeProtocol=*', async (route) => {
        const response = await route.fetch();
        const html = await response.text();
        await route.fulfill({
          response,
          body: html.replace('<head>', '<head><script>' + bridge + '</script>'),
        });
      });
      await page.goto(origin + '/__rendering');
      await page.waitForFunction(() => window.rendered?.page === 1);
      const frame = page.frames()[1];
      const token = await page.evaluate(() => window.rendered.documentToken);
      await frame.locator('#slide-content').click();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => window.escapeCount === 1);
      assert.equal(await page.evaluate(() => window.rendered.page), 1);
      assert.equal(await page.evaluate(() => window.rendered.documentToken), token);
      for (const viewport of [
        { width: 1920, height: 1080 },
        { width: 800, height: 550 },
        { width: 288, height: 162 },
        { width: 1080, height: 1080 },
      ]) {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(100);
        const geometry = await frame.locator('#slide-content').evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            designWidth: parseFloat(style.width),
            designHeight: parseFloat(style.height),
            transform: style.transform,
            zoom: parseFloat(style.zoom),
          };
        });
        const scale = Math.min(
          viewport.width / geometry.designWidth,
          viewport.height / geometry.designHeight,
        );
        assert.equal(geometry.transform, 'none');
        assert.ok(Math.abs(geometry.zoom - scale) < 0.001);
        assert.ok(Math.abs(geometry.width - geometry.designWidth * scale) < 1);
        assert.ok(Math.abs(geometry.height - geometry.designHeight * scale) < 1);
        assert.ok(Math.abs(geometry.x - (viewport.width - geometry.width) / 2) < 1);
        assert.ok(Math.abs(geometry.y - (viewport.height - geometry.height) / 2) < 1);
        results.push({ browser: name, viewport, geometry });
      }
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.waitForTimeout(100);
      await page.evaluate(() => window.advance());
      await page.waitForFunction(() => window.rendered?.sessionRevision === 2);
      assert.equal(await page.evaluate(() => window.rendered.documentToken), token);
      const transition = await frame
        .locator('.slidev-page[data-slidev-no="2"]')
        .evaluate((element) => {
          element.classList.add('fade-enter-active');
          const style = getComputedStyle(element);
          const result = { property: style.transitionProperty, duration: style.transitionDuration };
          element.classList.remove('fade-enter-active');
          return result;
        });
      assert.ok(transition.property.includes('opacity'));
      assert.ok(parseFloat(transition.duration) > 0, 'authored fade remains configured');
      await page.screenshot({ path: output + '/' + name + '-transition.png' });
      await page.waitForTimeout(600);
      await page.screenshot({ path: output + '/' + name + '-settled.png' });
      await page.goto(origin + deck.entry + '?embedded=true');
      await page.waitForSelector('#slide-content');
      assert.notEqual(
        await page
          .locator('#slide-content')
          .evaluate((element) => getComputedStyle(element).transform),
        'none',
      );
      assert.equal(await page.evaluate(() => Boolean(window.__nativeSlidevBridge)), false);
    } finally {
      await browser.close();
    }
  }
  await writeFile(
    output + '/rendering.json',
    JSON.stringify({ passed: true, results }, null, 2) + '\n',
  );
  console.log(
    'PASS: WebKit/Chromium, four viewport sizes, centered bounds, fade styling, persistent document, ordinary Web unchanged',
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
