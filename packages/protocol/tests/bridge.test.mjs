import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../dist/deck-bridge.js', import.meta.url), 'utf8');

function createBridge() {
  const messages = [];
  const listeners = new Map();
  const frames = [];
  let now = 0;
  let opacity = '0.000001';
  const slide = {
    dataset: { slidevNo: '1' },
    textContent: 'Slide one',
    getBoundingClientRect: () => ({ width: 980 }),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const location = new URL(
    'https://slides.test/deck/1?nativeProtocol=1&nativeParentOrigin=https://host.test&nativeMount=mount',
  );
  const parent = { postMessage: (message) => messages.push(message) };
  const router = {
    currentRoute: { value: { query: { clicks: '0' } } },
    async replace({ path, query }) {
      location.pathname = `/deck${path}`;
      router.currentRoute.value = { query };
    },
  };
  const document = {
    readyState: 'complete',
    head: { append() {} },
    createElement: () => ({}),
    fonts: { ready: Promise.resolve() },
    querySelectorAll: () => [slide],
  };
  const window = {
    __slidevLabNative: { router, slides: [{ load: async () => ({ default: {} }) }] },
    addEventListener: (name, callback) => {
      const callbacks = listeners.get(name) ?? [];
      callbacks.push(callback);
      listeners.set(name, callbacks);
    },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(source, {
    window,
    parent,
    location,
    document,
    console: { warn() {}, error() {} },
    URL,
    URLSearchParams,
    performance: { now: () => now },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity }),
    requestAnimationFrame: (callback) => frames.push(callback),
  });
  return {
    messages,
    send(sessionRevision) {
      for (const listener of listeners.get('message'))
        listener({
          source: parent,
          origin: 'https://host.test',
          data: { nativeState: { deckId: 'deck', page: 1, clickIndex: 0, sessionRevision } },
        });
    },
    async flush() {
      // Drain promise continuations without advancing the controlled animation frames.
      await new Promise((resolve) => setImmediate(resolve));
    },
    async frame(nextOpacity, elapsed = 16) {
      opacity = nextOpacity;
      now += elapsed;
      const pending = frames.splice(0);
      assert.ok(pending.length, 'bridge is waiting for a rendering frame');
      for (const callback of pending) callback(now);
      await this.flush();
    },
  };
}

test('a re-entering slide may become transparent after the first visibility check', async () => {
  const bridge = createBridge();
  bridge.send(1);
  await bridge.flush();
  await bridge.frame('0');
  await bridge.frame('0');
  assert.equal(
    bridge.messages.some((message) => message.nativeFailure),
    false,
  );
  assert.equal(
    bridge.messages.some((message) => message.nativeRendered),
    false,
  );
  await bridge.frame('0');
  await bridge.frame('0.2');
  await bridge.frame('0.5');
  await bridge.frame('1');
  const reports = bridge.messages.filter((message) => message.nativeRendered);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].nativeRendered.sessionRevision, 1);
  assert.equal(reports[0].nativeRendered.loaded, true);
});

test('a slide that stays transparent still fails within the existing render deadline', async () => {
  const bridge = createBridge();
  bridge.send(1);
  await bridge.flush();
  await bridge.frame('0');
  await bridge.frame('0');
  await bridge.frame('0', 12001);
  const failures = bridge.messages.filter((message) => message.nativeFailure);
  assert.equal(failures.length, 1);
  assert.match(failures[0].nativeFailure.message, /current slide did not become visible/);
  assert.equal(
    bridge.messages.some((message) => message.nativeRendered),
    false,
  );
});

test('a newer state supersedes the state waiting for a re-entering slide', async () => {
  const bridge = createBridge();
  bridge.send(1);
  await bridge.flush();
  await bridge.frame('0');
  await bridge.frame('0');
  bridge.send(2);
  await bridge.flush();
  await bridge.frame('1');
  await bridge.frame('1');
  await bridge.frame('1');
  const reports = bridge.messages.filter((message) => message.nativeRendered);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].nativeRendered.sessionRevision, 2);
  assert.equal(
    bridge.messages.some((message) => message.nativeFailure),
    false,
  );
});
