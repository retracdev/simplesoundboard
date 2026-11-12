const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/presence.js'), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));
const response = (count) => ({ ok: true, json: async () => ({ count }) });

async function open(t, { storedId, blockedStorage = false, fetch } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
    url: 'https://soundboard.retrac.space/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  await settle(); // Let the initial pageshow fire before installing the script.
  const { window } = dom;
  const calls = [];
  const timers = new Map();
  let visible = true;
  let online = true;
  let tick;
  Object.defineProperty(window.document, 'visibilityState', { get: () => visible ? 'visible' : 'hidden' });
  Object.defineProperty(window.navigator, 'onLine', { get: () => online });
  if (storedId) window.sessionStorage.setItem('simple-soundboard-presence-visitor', storedId);
  if (blockedStorage) Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('Blocked'); } });
  window.setInterval = (fn, ms) => { assert.equal(ms, 30000); tick = fn; };
  window.setTimeout = (fn, ms) => { assert.equal(ms, 10000); const id = {}; timers.set(id, fn); return id; };
  window.clearTimeout = (id) => timers.delete(id);
  window.fetch = async (url, options) => {
    calls.push({ url, options });
    return fetch ? fetch(url, options) : response(3);
  };
  window.eval(source);
  await settle();
  return {
    window, calls, timers, tick: () => tick(),
    label: () => window.document.getElementById('presenceLabel').textContent,
    state: () => window.document.getElementById('presence').dataset.state,
    visibility(value) { visible = value; window.document.dispatchEvent(new window.Event('visibilitychange')); },
    network(value) { online = value; window.dispatchEvent(new window.Event(value ? 'online' : 'offline')); },
  };
}

test('registers an anonymous tab before reading and reuses its stored identity', async (t) => {
  const page = await open(t, { storedId: 'existing-tab' });
  assert.equal(page.window.document.getElementById('presence').hidden, false);
  assert.equal(page.label(), '3 online');
  assert.equal(page.state(), 'online');
  assert.deepEqual(page.calls.map((call) => call.url), [
    'https://space-api.retrac-space.workers.dev/v1/presence/heartbeat/soundboard',
    'https://space-api.retrac-space.workers.dev/v1/presence/online/soundboard',
  ]);
  const { options } = page.calls[0];
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), { visitorId: 'existing-tab' });
  page.tick();
  await settle();
  assert.equal(page.calls.length, 4);
  assert.equal(page.calls[2].options.body, options.body);
});

test('hidden tabs and pages in the back/forward cache stop heartbeats, then resume immediately', async (t) => {
  const page = await open(t);
  const id = JSON.parse(page.calls[0].options.body).visitorId;
  assert.equal(page.window.sessionStorage.getItem('simple-soundboard-presence-visitor'), id);
  page.visibility(false);
  page.tick();
  assert.equal(page.calls.length, 2);
  page.visibility(true);
  await settle();
  assert.equal(page.calls.length, 4);
  page.window.dispatchEvent(new page.window.Event('pagehide'));
  page.tick();
  assert.equal(page.calls.length, 4);
  page.window.dispatchEvent(new page.window.Event('pageshow'));
  await settle();
  assert.equal(page.calls.length, 6);
});

test('works without storage and replaces stale counts on offline, recovering on reconnect', async (t) => {
  const page = await open(t, { blockedStorage: true });
  assert.ok(JSON.parse(page.calls[0].options.body).visitorId);
  page.network(false);
  assert.equal(page.label(), 'Online count unavailable');
  assert.equal(page.state(), 'unavailable');
  page.tick();
  assert.equal(page.calls.length, 2);
  page.network(true);
  await settle();
  assert.equal(page.label(), '3 online');
});

test('failed or malformed responses show unavailable and the next interval retries', async (t) => {
  for (const failure of [() => ({ ok: false }), () => { throw new Error('Network'); },
    () => ({ ok: true, json: async () => { throw new Error('Invalid JSON'); } }),
    ...[-1, 1.5, '3', null].map((count) => () => response(count))]) {
    let failing = true;
    const page = await open(t, { fetch: () => failing ? failure() : response(0) });
    assert.equal(page.label(), 'Online count unavailable');
    failing = false;
    page.tick();
    await settle();
    assert.equal(page.label(), '0 online');
  }
});

test('times out stalled requests without overlapping polls and retries', async (t) => {
  let stalled = true;
  const page = await open(t, { fetch: (url, options) => stalled ? new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Aborted')));
  }) : response(1) });
  page.tick();
  assert.equal(page.calls.length, 1);
  for (const timeout of page.timers.values()) timeout();
  await settle();
  assert.equal(page.label(), 'Online count unavailable');
  stalled = false;
  page.tick();
  await settle();
  assert.equal(page.label(), '1 online');
});

test('ignores late responses from a tab that became hidden', async (t) => {
  let finish;
  const page = await open(t, { fetch: () => new Promise((resolve) => { finish = resolve; }) });
  page.visibility(false);
  finish(response(99));
  await settle();
  assert.equal(page.calls.length, 1);
  assert.notEqual(page.state(), 'online');
});
