const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/presence.js'), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));
const response = (count, users = Array.from({ length: Number.isSafeInteger(count) && count >= 0 ? count : 0 }, (_, i) => ({ displayName: ['retrac', 'Anonymous Bear', 'Anonymous Fox'][i] || 'Guest' }))) => ({ ok: true, json: async () => ({ count, users }) });

async function open(t, { storedId, blockedCookies = false, fetch, account, previousUsername } = {}) {
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
  if (storedId) window.document.cookie = 'soundboard-presence=' + encodeURIComponent(JSON.stringify({ visitorId: storedId, username: previousUsername || null })) + '; Path=/; Secure; SameSite=Lax';
  if (blockedCookies) Object.defineProperty(window.document, 'cookie', { get() { return ''; }, set() {} });
  window.setInterval = (fn, ms) => { assert.equal(ms, 30000); tick = fn; };
  window.setTimeout = (fn, ms) => { assert.equal(ms, 10000); const id = {}; timers.set(id, fn); return id; };
  window.clearTimeout = (id) => timers.delete(id);
  window.fetch = async (url, options) => {
    calls.push({ url, options });
    return fetch ? fetch(url, options) : response(3);
  };
  let accountListener;
  if (account) window.RetracAccount = { getState: () => account, subscribe: (fn) => { accountListener = fn; } };
  window.eval(source);
  await settle();
  return {
    window, calls, timers, accountChanged: (state) => accountListener(state), tick: () => tick(),
    label: () => window.document.getElementById('presenceLabel').textContent,
    state: () => window.document.getElementById('presence').dataset.state,
    visibility(value) { visible = value; window.document.dispatchEvent(new window.Event('visibilitychange')); },
    network(value) { online = value; window.dispatchEvent(new window.Event(value ? 'online' : 'offline')); },
  };
}

test('registers an anonymous visitor before reading and reuses the shared cookie identity', async (t) => {
  const page = await open(t, { storedId: 'existing-tab' });
  assert.equal(page.window.document.getElementById('presence').hidden, false);
  assert.equal(page.label(), 'Online now: retrac, Anonymous Bear, Anonymous Fox');
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
  assert.equal(JSON.parse(decodeURIComponent(page.window.document.cookie.split('=')[1])).visitorId, id);
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

test('works without cookies and replaces stale names on offline, recovering on reconnect', async (t) => {
  const page = await open(t, { blockedCookies: true });
  assert.ok(JSON.parse(page.calls[0].options.body).visitorId);
  page.network(false);
  assert.equal(page.label(), 'Online visitors unavailable');
  assert.equal(page.state(), 'unavailable');
  page.tick();
  assert.equal(page.calls.length, 2);
  page.network(true);
  await settle();
  assert.equal(page.label(), 'Online now: retrac, Anonymous Bear, Anonymous Fox');
});

test('failed or malformed responses show unavailable and the next interval retries', async (t) => {
  for (const failure of [() => ({ ok: false }), () => { throw new Error('Network'); },
    () => ({ ok: true, json: async () => { throw new Error('Invalid JSON'); } }),
    ...[-1, 1.5, '3', null].map((count) => () => response(count))]) {
    let failing = true;
    const page = await open(t, { fetch: () => failing ? failure() : response(0) });
    assert.equal(page.label(), 'Online visitors unavailable');
    failing = false;
    page.tick();
    await settle();
    assert.equal(page.label(), 'No one online right now');
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
  assert.equal(page.label(), 'Online visitors unavailable');
  stalled = false;
  page.tick();
  await settle();
  assert.equal(page.label(), 'Online now: retrac');
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

test('shows every display name as text, including anonymous guests and HTML-like usernames', async (t) => {
  const name = '<img src=x onerror=alert(1)>';
  const page = await open(t, { fetch: () => response(2, [{ displayName: name }, { displayName: 'Anonymous Bear' }]) });
  assert.equal(page.label(), 'Online now: ' + name + ', Anonymous Bear');
  assert.equal(page.window.document.querySelector('#presenceLabel img'), null);
});

test('signed-in usernames follow account changes; sign-out gets a fresh anonymous identity', async (t) => {
  const page = await open(t, { account: { status: 'unknown' }, storedId: 'tab-id' });
  assert.equal(page.calls.length, 0);
  page.accountChanged({ status: 'authenticated', username: 'retrac' });
  await settle();
  assert.deepEqual(JSON.parse(page.calls[0].options.body), { visitorId: 'tab-id', username: 'retrac' });
  page.accountChanged({ status: 'authenticated', username: 'another-user' });
  await settle();
  const switched = JSON.parse(page.calls[2].options.body);
  assert.equal(switched.username, 'another-user');
  assert.notEqual(switched.visitorId, 'tab-id');
  page.accountChanged({ status: 'guest' });
  await settle();
  const guest = JSON.parse(page.calls[4].options.body);
  assert.equal(guest.username, undefined);
  assert.notEqual(guest.visitorId, switched.visitorId);
  assert.equal(JSON.parse(decodeURIComponent(page.window.document.cookie.split('=')[1])).username, null);
});

test('a reload after signing out does not reuse an identity with a retained server username', async (t) => {
  const page = await open(t, { account: { status: 'guest' }, storedId: 'named-tab', previousUsername: 'retrac' });
  const guest = JSON.parse(page.calls[0].options.body);
  assert.notEqual(guest.visitorId, 'named-tab');
  assert.equal(guest.username, undefined);
});

test('malformed user lists show unavailable rather than a misleading name list', async (t) => {
  for (const users of [null, [], [null], [{ displayName: '' }], [{ displayName: 123 }]]) {
    const page = await open(t, { fetch: () => response(1, users) });
    assert.equal(page.label(), 'Online visitors unavailable');
  }
});
