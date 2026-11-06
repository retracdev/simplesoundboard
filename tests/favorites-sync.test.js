/*
 * The sync engine (js/favorites.js) against a fake cloud-save API, on a fake clock, so
 * retries and rate limits are exact and instant. No real accounts or saves are involved.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'favorites.js'), 'utf8');
const SAVE_URL = 'https://space-api.retrac-space.workers.dev/v1/games/soundboard/saves/0';
const SESSION_URL = 'https://space-api.retrac-space.workers.dev/v1/session';
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise(setImmediate);
};
const plain = (value) => JSON.parse(JSON.stringify(value));

function createWorld(options = {}) {
  let now = 1000000;
  let nextTimer = 1;
  const timers = new Map();
  const storage = options.storage || new Map();

  // One save per user, like the real API.
  const saves = options.saves || new Map();
  const requests = [];
  const failures = []; // Scripted responses, applied in order to matching requests.
  let inFlight = 0;
  let maxInFlight = 0;
  let hold = null; // When set, requests of this method wait until released.
  const held = [];

  const world = {
    saves,
    requests,
    storage,
    tokens: 0,
    user: options.user === undefined ? 'alice' : options.user,
    tokenError: null,
    tokenSubject: undefined,
    whoAmI: [],
    whoAmIError: null,
    sessionAfterCheck: null,
    get maxInFlight() { return maxInFlight; },
    get pendingTimers() { return timers.size; },
    writes: () => requests.filter((r) => r.method === 'PUT'),
    reads: () => requests.filter((r) => r.method === 'GET'),
    lastWrite() {
      const write = world.writes().at(-1);
      return write && plain(write.body);
    },
    failNext(method, status, code, headers) {
      failures.push({ method, status, code, headers });
    },
    holdRequests(method) {
      hold = method;
    },
    async release() {
      hold = null;
      held.splice(0).forEach((resolve) => resolve());
      await settle();
    },
    async advance(ms) {
      const end = now + ms;
      await settle();
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
    settle,
  };

  async function fakeFetch(url, init = {}) {
    const method = init.method || 'GET';
    const user = init.headers.Authorization.replace('Bearer token-for-', '');
    if (url === SESSION_URL) {
      world.whoAmI.push(user);
      if (world.whoAmIError) return respond(world.whoAmIError.status, { error: { code: world.whoAmIError.code } });
      return respond(200, { data: { authenticated: true, player: { id: 'id-' + user, username: user } } });
    }
    assert.equal(url, SAVE_URL);
    const request = { method, user, init, body: init.body ? JSON.parse(init.body) : null };
    requests.push(request);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (hold === method) await new Promise((resolve) => held.push(resolve));
      const index = failures.findIndex((f) => f.method === method);
      if (index >= 0) {
        const failure = failures.splice(index, 1)[0];
        if (failure.status === 0) throw new TypeError('network');
        return respond(failure.status, { error: { code: failure.code } }, failure.headers);
      }
      if (method === 'GET') {
        if (!saves.has(user)) return respond(404, { error: { code: 'save_not_found' } });
        return respond(200, { data: { slot: 0, data: plain(saves.get(user)), updatedAt: 1 } });
      }
      saves.set(user, request.body.data);
      return respond(200, { data: { slot: 0, data: request.body.data, updatedAt: 2 } });
    } finally {
      inFlight--;
    }
  }

  function respond(status, body, headers = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => (name in headers ? headers[name] : null) },
      json: async () => body,
    };
  }

  const window = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    RetracAccount: {
      async fetchToken() {
        world.tokens++;
        if (world.tokenError) throw Object.assign(new Error('token'), world.tokenError);
        const subject = world.tokenSubject === undefined ? world.user : world.tokenSubject;
        return { token: 'token-for-' + world.user, userId: subject };
      },
      async check() {
        // Mirrors the account listener in app.js.
        const session = world.sessionAfterCheck || { status: 'authenticated', username: world.user };
        if (session.status === 'authenticated') world.favorites.setAccount(session.username);
        else if (session.status !== 'error') world.favorites.setAccount(null);
        return session;
      },
    },
  };

  class FakeDate extends Date {
    static now() { return now; }
  }

  const context = vm.createContext({
    window,
    fetch: fakeFetch,
    AbortController,
    TextEncoder,
    console,
    Date: FakeDate,
    setTimeout(fn, ms) {
      const id = nextTimer++;
      timers.set(id, { at: now + (ms || 0), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  vm.runInContext(SOURCE, context);
  world.favorites = window.SoundFavorites;
  return world;
}

async function signedIn(options) {
  const world = createWorld(options);
  world.favorites.setAccount(world.user);
  await world.advance(0);
  return world;
}

test('a first-time user with no save starts empty, and the first favorite creates the save', async () => {
  const world = await signedIn();
  assert.equal(world.favorites.isLoaded(), true);
  assert.equal(world.favorites.isFavorite('bruh'), false);
  assert.equal(world.writes().length, 0, 'loading never writes');

  world.favorites.toggle('bruh');
  assert.equal(world.favorites.isFavorite('bruh'), true, 'the screen updates before any request');
  await world.advance(700);

  assert.equal(world.writes().length, 1);
  assert.deepEqual(world.lastWrite(), { data: { version: 1, favorites: ['bruh'] } });
  const { init } = world.writes()[0];
  assert.equal(init.headers.Authorization, 'Bearer token-for-alice');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.credentials, 'omit');
  assert.equal(world.favorites.getStatus(), 'ok');
  assert.equal(world.favorites.hasUnsaved(), false);
});

test('existing favorites load automatically, without writing', async () => {
  const saves = new Map([['alice', { version: 1, favorites: ['rizz', 'bruh'] }]]);
  const world = await signedIn({ saves });
  assert.equal(world.favorites.isFavorite('rizz'), true);
  assert.equal(world.favorites.isFavorite('bruh'), true);
  assert.equal(world.favorites.isFavorite('wow'), false);
  assert.equal(world.writes().length, 0);
});

test('unfavoriting removes the sound from the save', async () => {
  const saves = new Map([['alice', { version: 1, favorites: ['rizz', 'bruh'] }]]);
  const world = await signedIn({ saves });
  world.favorites.toggle('rizz');
  assert.equal(world.favorites.isFavorite('rizz'), false);
  await world.advance(700);
  assert.deepEqual(saves.get('alice').favorites, ['bruh']);
});

test('unknown sound ids and unknown fields in a save are preserved', async () => {
  const saves = new Map([['alice', { version: 1, favorites: ['retired-sound', 'bruh'], theme: 'dark' }]]);
  const world = await signedIn({ saves });
  world.favorites.toggle('rizz');
  await world.advance(700);
  assert.deepEqual(saves.get('alice'), { theme: 'dark', version: 1, favorites: ['retired-sound', 'bruh', 'rizz'] });
});

test('writes are debounced: rapid clicks across sounds become one write', async () => {
  const world = await signedIn();
  ['a', 'b', 'c', 'd', 'e'].forEach((id) => world.favorites.toggle(id));
  await world.advance(699);
  assert.equal(world.writes().length, 0, 'nothing before the debounce ends');
  await world.advance(1);
  assert.equal(world.writes().length, 1);
  assert.deepEqual(world.lastWrite().data.favorites, ['a', 'b', 'c', 'd', 'e']);
});

test('each click restarts the debounce, but steady clicking cannot delay a save forever', async () => {
  const world = await signedIn();
  for (let i = 0; i < 12; i++) {
    world.favorites.toggle('sound-' + i);
    await world.advance(400);
  }
  assert.ok(world.writes().length >= 1, 'a save happened during continuous clicking');
});

test('clicking one heart an even number of times writes nothing', async () => {
  const world = await signedIn();
  for (let i = 0; i < 4; i++) world.favorites.toggle('bruh');
  await world.advance(700);
  assert.equal(world.favorites.isFavorite('bruh'), false);
  assert.equal(world.writes().length, 0);
  assert.equal(world.favorites.hasUnsaved(), false);
});

test('only one save runs at a time, and clicks during a save are not lost', async () => {
  const world = await signedIn();
  world.favorites.toggle('first');
  world.holdRequests('PUT');
  await world.advance(700);
  assert.equal(world.writes().length, 1, 'first write is in flight');

  world.favorites.toggle('second');
  await world.advance(5000);
  assert.equal(world.writes().length, 1, 'second write waits for the first');

  await world.release();
  await world.advance(700);
  assert.equal(world.writes().length, 2);
  assert.deepEqual(world.lastWrite().data.favorites, ['first', 'second']);
  assert.equal(world.maxInFlight, 1);
  assert.equal(world.favorites.hasUnsaved(), false);
});

test('a newer change to the same sound survives an earlier save finishing', async () => {
  const world = await signedIn();
  world.favorites.toggle('bruh');
  world.holdRequests('PUT');
  await world.advance(700);

  world.favorites.toggle('bruh'); // Changed their mind while the add is being written.
  assert.equal(world.favorites.isFavorite('bruh'), false);
  await world.release();
  assert.equal(world.favorites.isFavorite('bruh'), false, 'finishing the add must not bring it back');

  await world.advance(700);
  assert.deepEqual(world.saves.get('alice').favorites, []);
  assert.equal(world.favorites.isFavorite('bruh'), false);
});

test('each write reads first, so a change from another device is merged in', async () => {
  const saves = new Map([['alice', { version: 1, favorites: ['bruh'] }]]);
  const world = await signedIn({ saves });
  saves.set('alice', { version: 1, favorites: ['bruh', 'from-phone'] });

  world.favorites.toggle('rizz');
  await world.advance(700);
  assert.deepEqual(saves.get('alice').favorites, ['bruh', 'from-phone', 'rizz']);
  const order = world.requests.slice(-2).map((r) => r.method);
  assert.deepEqual(order, ['GET', 'PUT']);
});

test('add() never removes a favorite that already exists', async () => {
  const saves = new Map([['alice', { version: 1, favorites: ['bruh'] }]]);
  const world = await signedIn({ saves });
  world.favorites.add('bruh');
  await world.advance(700);
  assert.equal(world.favorites.isFavorite('bruh'), true);
  assert.equal(world.writes().length, 0, 'already there, so nothing to write');
  assert.deepEqual(saves.get('alice').favorites, ['bruh']);
});

test('add() before the save has loaded merges with it rather than replacing it', async () => {
  const saves = new Map([['alice', { version: 1, favorites: ['existing'] }]]);
  const world = createWorld({ saves });
  world.holdRequests('GET');
  world.favorites.setAccount('alice');
  await world.settle();
  world.favorites.add('clicked');
  assert.equal(world.favorites.isLoaded(), false);
  await world.release();
  await world.advance(700);
  assert.deepEqual(saves.get('alice').favorites, ['existing', 'clicked']);
});

test('a failed initial read never writes, even with changes waiting', async () => {
  const saves = new Map([['alice', { version: 1, favorites: ['precious'] }]]);
  const world = createWorld({ saves });
  world.failNext('GET', 503, 'service_unavailable');
  world.favorites.setAccount('alice');
  await world.advance(0);
  assert.equal(world.favorites.isLoaded(), false);
  assert.equal(world.favorites.getStatus(), 'retrying');

  world.favorites.toggle('bruh');
  world.failNext('GET', 0);
  await world.advance(700);
  assert.equal(world.writes().length, 0, 'still no successful read');

  await world.advance(60000);
  assert.deepEqual(saves.get('alice').favorites, ['precious', 'bruh']);
  assert.equal(world.favorites.getStatus(), 'ok');
});

test('only 404 save_not_found counts as empty', async () => {
  const saves = new Map([['alice', { version: 1, favorites: ['precious'] }]]);
  const world = createWorld({ saves });
  world.failNext('GET', 404, 'game_not_found');
  world.favorites.setAccount('alice');
  await world.advance(0);
  assert.equal(world.favorites.isLoaded(), false);
  assert.equal(world.favorites.getStatus(), 'blocked');
  world.favorites.toggle('bruh');
  world.failNext('GET', 404);
  await world.advance(700);
  assert.equal(world.writes().length, 0);
  assert.deepEqual(saves.get('alice').favorites, ['precious']);
});

for (const [label, save] of [
  ['a newer version', { version: 2, favorites: ['bruh'] }],
  ['a bare array', ['bruh']],
  ['no favorites list', { version: 1 }],
  ['non-string ids', { version: 1, favorites: [1, 2] }],
]) {
  test(`a save with ${label} is never overwritten or retried`, async () => {
    const saves = new Map([['alice', save]]);
    const world = createWorld({ saves });
    world.favorites.setAccount('alice');
    await world.advance(0);
    assert.equal(world.favorites.getStatus(), 'blocked');

    world.favorites.toggle('rizz');
    await world.advance(700);
    const reads = world.reads().length;
    await world.advance(600000);
    assert.equal(world.reads().length, reads, 'no automatic retries');
    assert.equal(world.writes().length, 0);
    assert.deepEqual(saves.get('alice'), save);
    assert.equal(world.favorites.hasUnsaved(), true, 'the change is kept, not dropped');
  });
}

test('network errors retry with growing waits, then stop until the visitor returns', async () => {
  const world = await signedIn();
  world.favorites.toggle('bruh');
  for (let i = 0; i < 5; i++) world.failNext('PUT', 0);
  await world.advance(700);
  assert.equal(world.writes().length, 1);
  assert.equal(world.favorites.getStatus(), 'retrying');
  assert.equal(world.favorites.hasUnsaved(), true);

  await world.advance(2999);
  assert.equal(world.writes().length, 1, 'waits out the first delay');
  await world.advance(1 + 12000 + 30000 + 60000);
  assert.equal(world.writes().length, 5);
  assert.equal(world.favorites.getStatus(), 'paused');

  await world.advance(600000);
  assert.equal(world.writes().length, 5, 'stopped retrying');

  world.favorites.resume();
  await world.advance(0);
  assert.equal(world.writes().length, 6);
  assert.equal(world.favorites.getStatus(), 'ok');
  assert.deepEqual(world.saves.get('alice').favorites, ['bruh']);
});

test('a failing write keeps failing toward the cap, even though its reads succeed', async () => {
  const world = await signedIn();
  world.favorites.toggle('bruh');
  for (let i = 0; i < 20; i++) world.failNext('PUT', 503, 'service_unavailable');
  await world.advance(3600000);
  assert.equal(world.writes().length, 5, 'one attempt plus four retries, then it stops');
  assert.equal(world.favorites.getStatus(), 'paused');
});

test('unrecoverable errors are not retried', async () => {
  const world = await signedIn();
  world.favorites.toggle('bruh');
  world.failNext('PUT', 400, 'invalid_body');
  await world.advance(700);
  assert.equal(world.favorites.getStatus(), 'blocked');
  assert.equal(world.favorites.hasUnsaved(), true);
  const writes = world.writes().length;
  await world.advance(3600000);
  assert.equal(world.writes().length, writes);
  assert.equal(world.pendingTimers, 0);
});

test('returning to the tab rechecks a blocked save only occasionally', async () => {
  const world = await signedIn();
  world.favorites.toggle('bruh');
  world.failNext('PUT', 400, 'invalid_body');
  await world.advance(700);
  const reads = world.reads().length;
  for (let i = 0; i < 10; i++) {
    world.favorites.resume();
    await world.advance(1000);
  }
  assert.equal(world.reads().length, reads, 'ten quick returns cause no requests');
  await world.advance(60000);
  world.favorites.resume();
  await world.advance(0);
  assert.equal(world.reads().length, reads + 1);
});

test('a 429 waits the default 60 seconds, since browsers cannot read Retry-After here', async () => {
  const world = await signedIn();
  world.favorites.toggle('bruh');
  world.failNext('PUT', 429, 'rate_limited');
  await world.advance(700);
  assert.equal(world.favorites.getStatus(), 'retrying');
  const requests = world.requests.length;

  world.favorites.resume(); // Returning to the tab must not jump the queue.
  world.favorites.toggle('rizz'); // Neither must another click.
  await world.advance(59000);
  assert.equal(world.requests.length, requests, 'no requests during the wait');

  await world.advance(1000);
  assert.deepEqual(world.saves.get('alice').favorites, ['bruh', 'rizz']);
});

test('a 429 uses Retry-After when it is readable', async () => {
  const world = await signedIn();
  world.favorites.toggle('bruh');
  world.failNext('PUT', 429, 'rate_limited', { 'Retry-After': '10' });
  await world.advance(700);
  const writes = world.writes().length;
  await world.advance(9999);
  assert.equal(world.writes().length, writes);
  await world.advance(1);
  assert.equal(world.writes().length, writes + 1);
});

test('rate-limited tokens wait too', async () => {
  const world = await signedIn();
  world.tokenError = { status: 429, retryAfter: 0 };
  world.favorites.toggle('bruh');
  await world.advance(700);
  const tokens = world.tokens;
  await world.advance(59000);
  assert.equal(world.tokens, tokens);
  world.tokenError = null;
  await world.advance(1000);
  assert.deepEqual(world.saves.get('alice').favorites, ['bruh']);
});

test('sustained clicking stays well under the shared 30-writes-a-minute limit', async () => {
  const world = await signedIn();
  const startedAt = world.requests.length;
  for (let i = 0; i < 300; i++) {
    world.favorites.toggle('sound-' + i);
    await world.advance(1000);
  }
  const writes = world.requests.slice(startedAt).filter((r) => r.method === 'PUT');
  assert.ok(writes.length <= 100, 'five minutes is at most 100 writes, saw ' + writes.length);
  await world.advance(60000);
  assert.equal(world.saves.get('alice').favorites.length, 300, 'and nothing was lost');
});

test('unsaved changes survive a refresh and then save', async () => {
  const storage = new Map();
  const saves = new Map([['alice', { version: 1, favorites: ['existing'] }]]);
  const before = await signedIn({ storage, saves });
  before.favorites.toggle('bruh');
  before.favorites.toggle('existing');
  assert.equal(storage.size, 1, 'stored as soon as clicked');
  const [[key, value]] = storage;
  assert.ok(key.endsWith(':alice'), 'stored under the account');
  assert.equal(value.includes('token'), false);

  // The page is refreshed before the debounce ends.
  const after = createWorld({ storage, saves });
  after.favorites.setAccount('alice');
  assert.equal(after.favorites.isFavorite('bruh'), true);
  await after.advance(0);
  assert.deepEqual(saves.get('alice').favorites, ['bruh']);
  assert.equal(storage.size, 0, 'cleared once saved');
});

test('tokens are never written to local storage', async () => {
  const storage = new Map();
  const world = await signedIn({ storage });
  world.favorites.toggle('bruh');
  world.failNext('PUT', 0);
  await world.advance(700);
  assert.equal(JSON.stringify([...storage]).includes('token-for'), false);
});

test('corrupt local storage is ignored rather than breaking the board', async () => {
  const storage = new Map([['simple-soundboard:favorites-pending:alice', '{not json']]);
  const world = await signedIn({ storage });
  assert.equal(world.favorites.isLoaded(), true);
  assert.equal(world.favorites.hasUnsaved(), false);
});

test('an expired session stops saving, keeps the change, and finishes after signing in again', async () => {
  const storage = new Map();
  const saves = new Map([['alice', { version: 1, favorites: ['existing'] }]]);
  const world = await signedIn({ storage, saves });
  world.tokenError = { status: 401 };
  world.sessionAfterCheck = { status: 'guest' };
  world.favorites.toggle('bruh');
  await world.advance(700);

  assert.equal(world.favorites.getStatus(), 'signin');
  assert.equal(world.favorites.isFavorite('bruh'), false, 'nobody is signed in to show favorites for');
  assert.equal(world.writes().length, 0);
  assert.equal(storage.size, 1, 'the change is kept for that account');

  world.tokenError = null;
  world.sessionAfterCheck = null;
  world.favorites.setAccount('alice');
  await world.advance(0);
  assert.deepEqual(saves.get('alice').favorites, ['existing', 'bruh']);
  assert.equal(world.favorites.getStatus(), 'ok');
});

test('an expired token gets one retry, and repeated 401s do not loop', async () => {
  const world = await signedIn();
  world.favorites.toggle('bruh');
  world.failNext('PUT', 401, 'invalid_session');
  await world.advance(700);
  assert.deepEqual(world.saves.get('alice').favorites, ['bruh'], 'recovered on the retry');

  world.favorites.toggle('rizz');
  for (let i = 0; i < 20; i++) world.failNext('PUT', 401, 'invalid_session');
  const writes = world.writes().length;
  await world.advance(3600000);
  assert.equal(world.writes().length, writes + 2, 'one attempt plus one retry');
  assert.equal(world.favorites.getStatus(), 'signin');
});

test('switching accounts keeps favorites and unsaved changes separate', async () => {
  const storage = new Map();
  const saves = new Map([
    ['alice', { version: 1, favorites: ['alice-sound'] }],
    ['bob', { version: 1, favorites: ['bob-sound'] }],
  ]);
  const world = await signedIn({ storage, saves });
  world.favorites.toggle('alice-new'); // Not saved yet.

  world.user = 'bob';
  world.favorites.setAccount('bob');
  assert.equal(world.favorites.isFavorite('alice-new'), false);
  assert.equal(world.favorites.isFavorite('alice-sound'), false);
  await world.advance(5000);
  assert.equal(world.favorites.isFavorite('bob-sound'), true);
  assert.deepEqual(saves.get('bob').favorites, ['bob-sound'], "Alice's change never reached Bob");
  assert.ok(world.writes().every((w) => w.user !== 'bob'));

  world.user = 'alice';
  world.favorites.setAccount('alice');
  await world.advance(0);
  assert.deepEqual(saves.get('alice').favorites, ['alice-sound', 'alice-new'], "Alice's change waited for Alice");
});

test('a save in flight during an account switch is abandoned before it can write', async () => {
  const saves = new Map([['alice', { version: 1, favorites: [] }], ['bob', { version: 1, favorites: ['bob-sound'] }]]);
  const world = await signedIn({ saves });
  world.favorites.toggle('alice-new');
  world.holdRequests('GET');
  await world.advance(700);

  world.user = 'bob';
  world.favorites.setAccount('bob');
  await world.release();
  await world.advance(1000);
  assert.equal(world.writes().length, 0, 'the read returned too late to count');
  assert.equal(world.favorites.isFavorite('bob-sound'), true);
  assert.deepEqual(saves.get('bob').favorites, ['bob-sound']);
});

test('a token for a different account is never used to write', async () => {
  const saves = new Map([['bob', { version: 1, favorites: ['bob-sound'] }]]);
  const world = await signedIn({ saves });
  // Bob signed in from another tab, but this tab still thinks it's Alice.
  world.user = 'bob';
  world.tokenSubject = 'bob';
  world.sessionAfterCheck = { status: 'authenticated', username: 'bob' };
  const reads = world.reads().length;
  world.favorites.toggle('alice-new');
  // setAccount('bob') runs inside the check, which abandons Alice's change for Bob's load.
  await world.advance(700);
  assert.deepEqual(saves.get('bob').favorites, ['bob-sound']);
  assert.equal(world.writes().length, 0);
  assert.ok(world.reads().length > reads, "Bob's own favorites load");
  assert.equal(world.favorites.isFavorite('bob-sound'), true);
});

test('the API confirms who a token belongs to once per account, not on every save', async () => {
  const world = await signedIn();
  assert.deepEqual(plain(world.whoAmI), ['alice']);
  world.favorites.toggle('bruh');
  await world.advance(700);
  world.favorites.toggle('rizz');
  await world.advance(700);
  assert.equal(world.writes().length, 2);
  assert.deepEqual(plain(world.whoAmI), ['alice'], 'no repeat confirmation for the same token subject');
});

test('a first token belonging to someone else is caught before any save is read or written', async () => {
  const saves = new Map([['bob', { version: 1, favorites: ['bob-sound'] }]]);
  const storage = new Map([['simple-soundboard:favorites-pending:alice', JSON.stringify({ ops: [['alice-new', 'add']] })]]);
  const world = createWorld({ saves, storage });
  // The page was told Alice was signed in, but by now the cookie is Bob's.
  world.user = 'bob';
  world.sessionAfterCheck = { status: 'authenticated', username: 'bob' };
  world.favorites.setAccount('alice');
  await world.advance(0);
  assert.deepEqual(saves.get('bob').favorites, ['bob-sound'], "Alice's change never reached Bob");
  assert.equal(world.writes().length, 0);
  assert.ok(storage.has('simple-soundboard:favorites-pending:alice'), "Alice's change is kept for Alice");
  assert.equal(world.favorites.isFavorite('bob-sound'), true, "Bob's own favorites load");
});

test('a token with an unreadable subject is confirmed with the API every time, and still works', async () => {
  const world = createWorld();
  world.tokenSubject = null;
  world.favorites.setAccount('alice');
  await world.advance(0);
  world.favorites.toggle('bruh');
  await world.advance(700);
  assert.deepEqual(world.saves.get('alice').favorites, ['bruh']);
  assert.equal(world.whoAmI.length, 2, 'once for the load and once for the save');
});

test('a failed confirmation neither reads nor writes the save', async () => {
  const saves = new Map([['alice', { version: 1, favorites: ['precious'] }]]);
  const world = createWorld({ saves });
  world.whoAmIError = { status: 503, code: 'accounts_unavailable' };
  world.favorites.setAccount('alice');
  await world.advance(0);
  assert.equal(world.requests.length, 0);
  assert.equal(world.favorites.getStatus(), 'retrying');

  world.whoAmIError = null;
  await world.advance(3000);
  assert.equal(world.favorites.isFavorite('precious'), true, 'recovers on the retry');
});

test('an account that needs a username stops at the confirmation too', async () => {
  const world = createWorld();
  world.whoAmIError = { status: 403, code: 'username_required' };
  world.favorites.setAccount('alice');
  await world.advance(0);
  assert.equal(world.favorites.getStatus(), 'setup');
  assert.equal(world.pendingTimers, 0);
});

test('an account that needs a username stops and says so, without retrying', async () => {
  const world = await signedIn();
  world.favorites.toggle('bruh');
  world.failNext('GET', 403, 'username_required');
  await world.advance(700);
  assert.equal(world.favorites.getStatus(), 'setup');
  assert.equal(world.pendingTimers, 0);
  assert.equal(world.favorites.hasUnsaved(), true);
});

test('a site not yet allowed by the API stops quietly rather than hammering it', async () => {
  const world = createWorld();
  world.tokenError = { status: 403 };
  world.favorites.setAccount('alice');
  await world.advance(3600000);
  assert.equal(world.tokens, 1);
  assert.equal(world.favorites.getStatus(), 'blocked');
});

test('a save too large for the API is not sent', async () => {
  const huge = Array.from({ length: 4000 }, (_, i) => 'long-sound-id-number-' + i);
  const saves = new Map([['alice', { version: 1, favorites: huge }]]);
  const world = await signedIn({ saves });
  world.favorites.toggle('one-more');
  await world.advance(700);
  assert.equal(world.writes().length, 0);
  assert.equal(world.favorites.getStatus(), 'blocked');
  assert.equal(world.favorites.hasUnsaved(), true);
});

test('signing out shows no favorites, and clicks without an account store nothing', async () => {
  const storage = new Map();
  const saves = new Map([['alice', { version: 1, favorites: ['bruh'] }]]);
  const world = await signedIn({ storage, saves });
  world.favorites.setAccount(null);
  assert.equal(world.favorites.isFavorite('bruh'), false);
  world.favorites.toggle('rizz');
  world.favorites.add('wow');
  assert.equal(world.favorites.isFavorite('rizz'), false);
  assert.equal(storage.size, 0, 'no local-only favorites');
  await world.advance(5000);
  assert.deepEqual(saves.get('alice').favorites, ['bruh']);
});

test('returning to the tab refreshes favorites only once they are a minute old', async () => {
  const saves = new Map([['alice', { version: 1, favorites: [] }]]);
  const world = await signedIn({ saves });
  const reads = world.reads().length;
  world.favorites.resume();
  await world.advance(1000);
  assert.equal(world.reads().length, reads);

  saves.set('alice', { version: 1, favorites: ['from-phone'] });
  await world.advance(60000);
  world.favorites.resume();
  await world.advance(0);
  assert.equal(world.reads().length, reads + 1);
  assert.equal(world.favorites.isFavorite('from-phone'), true);
});
