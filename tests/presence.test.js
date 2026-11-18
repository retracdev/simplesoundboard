const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/presence.js'), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));
const response = (count, users = Array.from({ length: Number.isSafeInteger(count) && count >= 0 ? count : 0 }, (_, i) => ({ displayName: ['retrac', 'Anonymous Bear', 'Anonymous Fox'][i] || 'Guest' }))) => ({ ok: true, json: async () => ({ count, users }) });

async function open(t, { storedId, blockedCookies = false, fetch, account, previousUsername, storage, locks, toasts, initiallyVisible = true } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
    url: 'https://soundboard.retrac.space/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  await settle(); // Let the initial pageshow fire before installing the script.
  const { window } = dom;
  const calls = [];
  const timers = new Map();
  let visible = initiallyVisible;
  if (storage) Object.defineProperty(window, 'localStorage', { value: {
    get length() { return storage.size; },
    key: (i) => [...storage.keys()][i],
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  } });
  if (locks) Object.defineProperty(window.navigator, 'locks', { value: locks });
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
  if (toasts) window.SoundboardToasts = { show: (toast) => toasts.push(toast) };
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
  assert.equal(page.label(), 'Online now (3): retrac, Anonymous Bear, Anonymous Fox');
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
  assert.deepEqual(JSON.parse(options.body), { visitorId: 'existing-tab', status: 'online' });
  page.tick();
  await settle();
  assert.equal(page.calls.length, 4);
  assert.equal(page.calls[2].options.body, options.body);
});

test('background tabs send idle heartbeats; visibility and bfcache restore online immediately', async (t) => {
  const page = await open(t);
  const id = JSON.parse(page.calls[0].options.body).visitorId;
  page.visibility(false);
  await settle();
  assert.equal(JSON.parse(page.calls[2].options.body).status, 'idle');
  page.tick();
  await settle();
  assert.equal(JSON.parse(page.calls[4].options.body).status, 'idle');
  assert.equal(JSON.parse(page.calls[4].options.body).visitorId, id);
  page.visibility(true);
  await settle();
  assert.equal(JSON.parse(page.calls[6].options.body).status, 'online');
  page.window.dispatchEvent(new page.window.Event('pagehide'));
  page.tick();
  assert.equal(page.calls.length, 8);
  page.window.dispatchEvent(new page.window.Event('pageshow'));
  await settle();
  assert.equal(page.calls.length, 10);
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
  assert.equal(page.label(), 'Online now (3): retrac, Anonymous Bear, Anonymous Fox');
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
  assert.equal(page.label(), 'Online now (1): retrac');
});

test('ignores late responses from a suspended page', async (t) => {
  let finish;
  const page = await open(t, { fetch: () => new Promise((resolve) => { finish = resolve; }) });
  page.window.dispatchEvent(new page.window.Event('pagehide'));
  finish(response(99));
  await settle();
  assert.equal(page.calls.length, 1);
  assert.notEqual(page.state(), 'online');
});

test('shows every display name as text, including anonymous guests and HTML-like usernames', async (t) => {
  const name = '<img src=x onerror=alert(1)>';
  const page = await open(t, { fetch: () => response(2, [{ displayName: name }, { displayName: 'Anonymous Bear' }]) });
  assert.equal(page.label(), 'Online now (2): ' + name + ', Anonymous Bear');
  assert.equal(page.window.document.querySelector('#presenceLabel img'), null);
});

test('signed-in usernames follow account changes; sign-out gets a fresh anonymous identity', async (t) => {
  const page = await open(t, { account: { status: 'unknown' }, storedId: 'tab-id' });
  assert.equal(page.calls.length, 0);
  page.accountChanged({ status: 'authenticated', username: 'retrac' });
  await settle();
  assert.deepEqual(JSON.parse(page.calls[0].options.body), { visitorId: 'tab-id', username: 'retrac', status: 'online' });
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


test('foreground tabs overrule background tabs sharing a session, until hidden or closed', async (t) => {
  const storage = new Map();
  const front = await open(t, { storage, storedId: 'shared' });
  const back = await open(t, { storage, storedId: 'shared', initiallyVisible: false });
  const lastStatus = (page) => JSON.parse(page.calls.filter((c) => c.options.method === 'POST').at(-1).options.body).status;
  assert.equal(lastStatus(back), 'online');
  front.visibility(false);
  await settle();
  assert.equal(lastStatus(front), 'idle');
  back.tick();
  await settle();
  assert.equal(lastStatus(back), 'idle');
  front.visibility(true);
  await settle();
  back.tick();
  await settle();
  assert.equal(lastStatus(back), 'online');
  front.window.dispatchEvent(new front.window.Event('pagehide'));
  back.tick();
  await settle();
  assert.equal(lastStatus(back), 'idle');
});

test('expired foreground leases cannot keep background visitors online', async (t) => {
  const storage = new Map([['soundboard-presence-tab:crashed', JSON.stringify({ visible: true, updated: Date.now() - 90000 })]]);
  const page = await open(t, { storage, initiallyVisible: false });
  assert.equal(JSON.parse(page.calls[0].options.body).status, 'idle');
  assert.equal(storage.has('soundboard-presence-tab:crashed'), false);
});

test('splits idle and online cards and groups accounts with online taking precedence', async (t) => {
  const users = [
    { displayName: 'retrac', status: 'idle' },
    { displayName: 'RETRAC', status: 'online' },
    { displayName: '<b>guest</b>', status: 'idle' },
    { displayName: 'Anonymous Fox', status: 'idle' },
    { displayName: 'Anonymous Fox', status: 'online' },
  ];
  const page = await open(t, { account: { status: 'authenticated', username: 'retrac' }, fetch: () => response(users.length, users) });
  assert.equal(page.label(), 'Online now (2): retrac (you), Anonymous Fox');
  const idle = page.window.document.getElementById('presenceIdle');
  assert.equal(idle.hidden, false);
  assert.equal(idle.textContent.trim(), 'Idle (2): <b>guest</b>, Anonymous Fox');
  assert.equal(idle.querySelector('b'), null);
  page.network(false);
  assert.equal(idle.hidden, true);
});

test('a visibility change during a heartbeat queues the new status after it finishes', async (t) => {
  let finish;
  let first = true;
  const page = await open(t, { fetch: () => {
    if (first) { first = false; return new Promise((resolve) => { finish = resolve; }); }
    return response(0);
  } });
  page.visibility(false);
  assert.equal(page.calls.length, 1);
  finish(response(0));
  await settle();
  assert.equal(JSON.parse(page.calls[2].options.body).status, 'idle');
});


test('queued cross-tab heartbeats compute status after acquiring the lock', async (t) => {
  const queued = [];
  const locks = { request: (name, options, send) => {
    assert.equal(name, 'soundboard-presence-heartbeat');
    return new Promise((resolve, reject) => queued.push(async () => {
      try { resolve(await send()); } catch (error) { reject(error); }
    }));
  } };
  const storage = new Map();
  const back = await open(t, { storage, locks, storedId: 'shared', initiallyVisible: false });
  const front = await open(t, { storage, locks, storedId: 'shared' });
  assert.equal(back.calls.length, 0);
  await queued.shift()();
  await settle();
  assert.equal(JSON.parse(back.calls[0].options.body).status, 'online');
  await queued.shift()();
  await settle();
  assert.equal(JSON.parse(front.calls[0].options.body).status, 'online');
});

test('announces visitors coming online, going idle and leaving, but not the first list or yourself', async (t) => {
  const toasts = [];
  const lists = [
    [{ displayName: 'me', status: 'online' }, { displayName: 'Ada', status: 'online' }, { displayName: 'Bo', status: 'idle' }],
    [{ displayName: 'me', status: 'idle' }, { displayName: 'Ada', status: 'idle' }, { displayName: 'Bo', status: 'online' }, { displayName: '<i>Cy</i>', status: 'online' }],
    [{ displayName: 'me', status: 'online' }, { displayName: 'Bo', status: 'online' }],
  ];
  let list = lists[0];
  const page = await open(t, { toasts, account: { status: 'authenticated', username: 'me' },
    fetch: (url) => url.endsWith('/heartbeat/soundboard') ? { ok: true, json: async () => ({}) } : response(list.length, list) });
  assert.deepEqual(toasts, []);
  list = lists[1];
  page.tick();
  await settle();
  assert.deepEqual(toasts.map(({ name, icon, text }) => [name, icon, text]), [
    ['Ada', 'idle', ' has gone idle.'],
    ['Bo', 'online', ' is now online!'],
    ['<i>Cy</i>', 'online', ' is now online!'],
  ]);
  toasts.length = 0;
  list = lists[2];
  page.tick();
  await settle();
  assert.deepEqual(toasts.map(({ name, icon, text }) => [name, icon, text]), [
    ['Ada', 'offline', ' is now offline.'],
    ['<i>Cy</i>', 'offline', ' is now offline.'],
  ]);
});
