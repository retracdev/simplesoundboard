/*
 * The real page and scripts in a simulated browser, with fake accounts and save services,
 * so this covers the buttons, the sign-in flow and the filter working together.
 * No real accounts or saves are involved.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SCRIPTS = ['js/sounds.js', 'js/account.js', 'js/favorites.js', 'js/sign-in.js', 'js/app.js', 'js/account-welcome.js'];
const SAVE_URL = 'https://space-api.retrac-space.workers.dev/v1/games/soundboard/saves/0';
const DEBOUNCE = 800;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Real tokens carry an opaque user id, which websites otherwise never get to see.
const jwtFor = (username) => 'h.' + Buffer.from(JSON.stringify({ sub: 'opaque-id-of-' + username, sid: 's' })).toString('base64url') + '.s';
const respond = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
});

function openPage({ session = null, save, saveStatus } = {}) {
  const html = read('index.html').replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '');
  const dom = new JSDOM(html, { url: 'https://soundboard.retrac.space/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;

  const world = {
    window,
    document,
    session,
    save,
    saveStatus,
    calls: [],
    sessionCalls: 0,
    started: [],
    opened: [],
  };
  world.writes = () => world.calls.filter((call) => call.method === 'PUT');

  window.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (url === 'https://accounts.retrac.space/api/auth/get-session') {
      world.sessionCalls++;
      assert.equal(init.credentials, 'include');
      return respond(200, world.session);
    }
    if (url === 'https://accounts.retrac.space/api/auth/token') {
      assert.equal(init.credentials, 'include');
      if (!world.session) return respond(401, {});
      return respond(200, { token: jwtFor(world.session.user.username) });
    }
    if (url === 'https://space-api.retrac-space.workers.dev/v1/session') {
      assert.equal(init.credentials, 'omit');
      const { username } = world.session.user;
      return respond(200, { data: { authenticated: true, player: { id: 'opaque-id-of-' + username, username } } });
    }
    assert.equal(url, SAVE_URL);
    assert.equal(init.credentials, 'omit');
    assert.ok(init.headers.Authorization.startsWith('Bearer '));
    world.calls.push({ method, body: init.body && JSON.parse(init.body) });
    if (world.saveGate) await world.saveGate;
    if (world.saveStatus) return respond(world.saveStatus, { error: { code: 'service_unavailable' } });
    if (method === 'PUT') {
      world.save = JSON.parse(init.body).data;
      return respond(200, { data: { slot: 0, data: world.save, updatedAt: 1 } });
    }
    if (world.save === undefined) return respond(404, { error: { code: 'save_not_found' } });
    return respond(200, { data: { slot: 0, data: world.save, updatedAt: 1 } });
  };

  window.TextEncoder = TextEncoder; // Every browser has this, but jsdom doesn't.
  window.matchMedia = () => ({ matches: true }); // Skips decorative animations.
  window.open = (...args) => {
    world.opened.push(args);
    return null;
  };
  document.hasFocus = () => true;

  // Sound playback isn't under test here, only whether a sound was asked to start.
  window.SoundEngine = {
    supported: true,
    unlock() {},
    load: async () => ({ duration: 1, getChannelData: () => new Float32Array(10) }),
    start: async (sound) => {
      world.started.push(sound.id);
      return { duration: 1, elapsed: () => 0 };
    },
    stop() {},
    stopAll() {},
    setVolume() {},
    peaks: () => new Array(20).fill(0.5),
  };

  // jsdom doesn't implement modal dialogs.
  const dialogProto = window.HTMLDialogElement.prototype;
  dialogProto.showModal = function showModal() { this.setAttribute('open', ''); };
  dialogProto.close = function close() { this.removeAttribute('open'); };
  Object.defineProperty(dialogProto, 'open', { get() { return this.hasAttribute('open'); } });

  SCRIPTS.forEach((file) => window.eval(read(file)));

  world.heart = (id) => document.querySelector(`.key__heart[data-favorite="${id}"]`);
  world.key = (id) => document.querySelector(`.key[data-id="${id}"]`);
  world.pressed = (id) => world.heart(id).getAttribute('aria-pressed') === 'true';
  world.chip = (id) => document.querySelector(`.chip[data-category="${id}"]`);
  world.visible = () => [...document.querySelectorAll('.key-slot')]
    .filter((slot) => !slot.hidden)
    .map((slot) => slot.querySelector('.key').dataset.id);
  world.dialog = () => document.querySelector('dialog.signin-dialog');
  world.dialogTitle = () => world.dialog().querySelector('h2').textContent;
  world.action = (name) => world.dialog().querySelector(`[data-action="${name}"]`);
  world.click = (element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 }));
  world.search = (text) => {
    const input = document.getElementById('search');
    input.value = text;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  world.returnToTab = () => {
    window.dispatchEvent(new window.Event('blur'));
    window.dispatchEvent(new window.Event('focus'));
  };
  world.close = () => window.close();
  return world;
}

// Exactly what accounts sends to approved websites: the username and nothing else.
// See "Expose only the username" in the worker in space-accounts.
const alice = { user: { username: 'alice' } };
const bob = { user: { username: 'bob' } };

test('a real signed-in session, with only a username, signs in and shows the pill', async () => {
  const page = openPage({ session: alice });
  await wait(30);
  assert.deepEqual({ ...page.window.RetracAccount.getState() }, { status: 'authenticated', username: 'alice' });
  await wait(300);
  assert.match(page.document.querySelector('.welcome-pill .message').textContent, /alice/);
  page.close();
});

test('a real signed-out session is a guest and gets no pill', async () => {
  const page = openPage({ session: null });
  await wait(330);
  assert.equal(page.window.RetracAccount.getState().status, 'guest');
  assert.equal(page.document.querySelector('.welcome-pill'), null);
  page.close();
});

test('every sound card gets its own accessible heart, outside the key button', async () => {
  const page = openPage();
  await wait(20);
  const cards = page.document.querySelectorAll('.key');
  assert.ok(cards.length > 0);
  assert.equal(page.document.querySelectorAll('.key__heart').length, cards.length);
  page.window.SOUND_CATALOG.sounds.forEach((sound) => {
    const heart = page.heart(sound.id);
    assert.equal(heart.tagName, 'BUTTON');
    assert.equal(heart.getAttribute('type'), 'button');
    assert.equal(heart.getAttribute('aria-label'), 'Favorite ' + sound.name);
    assert.equal(heart.getAttribute('aria-pressed'), 'false');
    assert.equal(heart.closest('.key'), null, 'not nested inside the key button');
    assert.equal(heart.querySelector('use').getAttribute('href'), '#icon-heart');
    assert.equal(page.key(sound.id).getAttribute('aria-label'), 'Start ' + sound.name);
  });
  assert.ok(page.document.querySelector('symbol#icon-heart path'), 'uses the Lucide symbol');
  page.close();
});

test('clicking a heart starts no sound, and clicking a card still does', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: [] } });
  await wait(30);
  const { MouseEvent } = page.window;
  const pointer = (type) => Object.assign(new MouseEvent(type, { bubbles: true, button: 0 }), { pointerType: 'mouse' });

  page.heart('bruh').dispatchEvent(pointer('pointerdown'));
  page.heart('bruh').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  await wait(20);
  assert.deepEqual(page.started, [], 'no sound from the heart');
  assert.equal(page.pressed('bruh'), true);

  page.key('rizz').dispatchEvent(pointer('pointerdown'));
  page.key('rizz').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  await wait(20);
  assert.deepEqual(page.started, ['rizz'], 'one sound from the card');
  assert.equal(page.pressed('rizz'), false, 'and the card does not favorite');
  page.close();
});

test('favoriting and unfavoriting update at once and save automatically', async () => {
  const page = openPage({ session: alice });
  await wait(30);
  page.click(page.heart('bruh'));
  await wait(5);
  assert.equal(page.pressed('bruh'), true, 'immediately');
  assert.equal(page.writes().length, 0, 'not saved yet');
  await wait(DEBOUNCE);
  assert.deepEqual(page.save, { version: 1, favorites: ['bruh'] });

  page.click(page.heart('bruh'));
  await wait(5);
  assert.equal(page.pressed('bruh'), false);
  await wait(DEBOUNCE);
  assert.deepEqual(page.save, { version: 1, favorites: [] });
  page.close();
});

test('existing favorites light up automatically for a signed-in visitor', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['rizz', 'retired-sound'] } });
  await wait(30);
  assert.equal(page.pressed('rizz'), true);
  assert.equal(page.pressed('bruh'), false);
  assert.equal(page.writes().length, 0);
  page.close();
});

test('the welcome pill and favorites share one session check', async () => {
  const page = openPage({ session: alice });
  await wait(30);
  assert.equal(page.sessionCalls, 1);
  await wait(300);
  assert.ok(page.document.querySelector('.welcome-pill .message').textContent.includes('alice'));
  page.close();
});

test('browsing and starting sounds never needs an account', async () => {
  const page = openPage();
  await wait(30);
  assert.equal(page.dialog().open, false);
  assert.equal(page.calls.length, 0, 'no save requests for a guest');
  page.click(page.key('bruh'));
  await wait(10);
  assert.deepEqual(page.started, ['bruh']);
  assert.equal(page.dialog().open, false);
  page.close();
});

test('a signed-out click opens the dialog, without favoriting anything locally', async () => {
  const page = openPage();
  await wait(30);
  page.click(page.heart('bruh'));
  await wait(10);
  assert.equal(page.dialog().open, true);
  assert.equal(page.dialogTitle(), 'Save your favorite sounds');
  assert.equal(page.pressed('bruh'), false);
  assert.equal(page.window.localStorage.length, 0, 'no local-only favorites');
  assert.equal(page.opened.length, 0, 'no new tab until asked for');

  page.click(page.action('open'));
  assert.deepEqual(page.opened[0], ['https://accounts.retrac.space', '_blank', 'noopener']);
  assert.equal(page.dialogTitle(), 'Finish signing in');
  page.close();
});

test('after signing in, the clicked sound is favorited on top of existing cloud favorites', async () => {
  const page = openPage();
  await wait(30);
  page.click(page.heart('bruh'));
  await wait(10);
  page.click(page.action('open'));

  page.session = alice;
  page.save = { version: 1, favorites: ['rizz', 'retired-sound'] };
  page.returnToTab();
  await wait(260);

  assert.equal(page.dialog().open, false, 'the dialog closes itself');
  assert.equal(page.pressed('bruh'), true);
  assert.equal(page.pressed('rizz'), true, 'existing favorites loaded');
  await wait(DEBOUNCE);
  assert.deepEqual(page.save, { version: 1, favorites: ['rizz', 'retired-sound', 'bruh'] });
  await wait(300);
  assert.ok(page.document.querySelector('.welcome-pill'), 'and they get the greeting');
  page.close();
});

test('signing in does not toggle off a sound that was already a favorite', async () => {
  const page = openPage();
  await wait(30);
  page.click(page.heart('bruh'));
  await wait(10);
  page.click(page.action('open'));

  page.session = alice;
  page.save = { version: 1, favorites: ['bruh'] };
  page.returnToTab();
  await wait(260 + DEBOUNCE);

  assert.equal(page.pressed('bruh'), true);
  assert.deepEqual(page.save.favorites, ['bruh']);
  assert.equal(page.writes().length, 0, 'it was already there');
  page.close();
});

test('returning without signing in offers a retry, and retrying works', async () => {
  const page = openPage();
  await wait(30);
  page.click(page.heart('bruh'));
  await wait(10);
  page.click(page.action('open'));
  page.returnToTab();
  await wait(260);
  assert.equal(page.dialog().open, true);
  assert.equal(page.dialogTitle(), 'Not signed in yet');

  page.session = alice;
  page.click(page.action('verify'));
  await wait(40);
  assert.equal(page.dialog().open, false);
  assert.equal(page.pressed('bruh'), true);
  page.close();
});

test('dismissing the dialog forgets the sound', async () => {
  const page = openPage();
  await wait(30);
  page.click(page.heart('bruh'));
  await wait(10);
  page.click(page.action('cancel'));
  assert.equal(page.dialog().open, false);

  page.session = alice;
  page.window.dispatchEvent(new page.window.Event('online'));
  page.window.RetracAccount.check();
  await wait(40 + DEBOUNCE);
  assert.equal(page.pressed('bruh'), false, 'they changed their mind');
  assert.equal(page.writes().length, 0);
  page.close();
});

test('the intended sound survives the tab being reloaded mid sign-in', async () => {
  const page = openPage();
  await wait(30);
  page.click(page.heart('bruh'));
  await wait(10);
  const stored = page.window.sessionStorage.getItem('simple-soundboard:favorite-after-sign-in');
  assert.ok(stored.includes('bruh'));
  assert.equal(stored.includes('token'), false);
  page.close();
});

test('an account without a username is guided to finish setup', async () => {
  const page = openPage({ session: { user: { username: null } } });
  await wait(30);
  page.click(page.heart('bruh'));
  await wait(10);
  assert.equal(page.dialog().open, true);
  assert.equal(page.dialogTitle(), 'Finish setting up your account');
  assert.equal(page.calls.length, 0);
  page.close();
});

test('the Favorites filter is hidden from guests and stays visible when signed in', async () => {
  const guest = openPage();
  await wait(30);
  assert.equal(guest.chip('favorites').hidden, true);
  assert.ok(guest.visible().length > 0);
  guest.close();

  const page = openPage({ session: alice });
  await wait(30);
  assert.equal(page.chip('favorites').hidden, false, 'even with no favorites');
  page.close();
});

test('the Favorites filter shows only favorites, with a clean empty state', async () => {
  const page = openPage({ session: alice });
  await wait(30);
  page.click(page.chip('favorites'));
  assert.deepEqual(page.visible(), []);
  const empty = page.document.getElementById('empty');
  assert.equal(empty.hidden, false);
  assert.equal(page.document.getElementById('emptyTitle').textContent, 'No favorites yet.');
  page.click(page.document.getElementById('emptyReset'));
  assert.equal(page.chip('all').getAttribute('aria-pressed'), 'true');

  page.click(page.heart('bruh'));
  page.click(page.heart('rizz'));
  await wait(5);
  page.click(page.chip('favorites'));
  assert.deepEqual(page.visible().sort(), ['bruh', 'rizz']);
  assert.equal(page.chip('favorites').querySelector('.chip__count').textContent, '2');
  page.close();
});

test('unfavoriting inside the filter removes the sound immediately', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh', 'rizz'] } });
  await wait(30);
  page.click(page.chip('favorites'));
  page.heart('bruh').focus();
  page.click(page.heart('bruh'));
  await wait(5);
  assert.deepEqual(page.visible(), ['rizz']);
  assert.equal(page.document.activeElement, page.chip('favorites'), 'focus lands somewhere sensible');
  page.close();
});

test('search still works, alone and inside the Favorites filter', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh', 'rizz'] } });
  await wait(30);
  page.search('bruh');
  assert.deepEqual(page.visible(), ['bruh']);
  page.search('');

  page.click(page.chip('favorites'));
  page.search('rizz');
  assert.deepEqual(page.visible(), ['rizz']);
  page.search('fart');
  assert.deepEqual(page.visible(), [], 'fart is a sound, but not a favorite');
  assert.equal(page.document.getElementById('emptyTitle').textContent, 'No matching favorites.');
  page.close();
});

test('category filters keep working next to Favorites', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh'] } });
  await wait(30);
  const { sounds } = page.window.SOUND_CATALOG;
  page.click(page.chip('silly'));
  assert.equal(page.visible().length, sounds.filter((s) => s.category === 'silly').length);
  page.click(page.chip('all'));
  assert.equal(page.visible().length, sounds.length);
  page.close();
});

function chipState(page) {
  const chip = page.chip('favorites');
  return {
    count: chip.querySelector('.chip__count').textContent,
    spinner: !chip.querySelector('.chip__spinner').hasAttribute('hidden'),
    busy: chip.getAttribute('aria-busy'),
  };
}

function holdSaves(page) {
  let release;
  page.saveGate = new Promise((resolve) => {
    release = () => {
      page.saveGate = null;
      resolve();
    };
  });
  return release;
}

test('the Favorites chip shows a spinner instead of 0 until favorites arrive', async () => {
  const page = openPage({ session: null });
  await wait(30);
  page.session = alice;
  page.save = { version: 1, favorites: ['bruh', 'rizz'] };
  const release = holdSaves(page);
  page.window.RetracAccount.check();
  await wait(30);

  assert.equal(page.chip('favorites').hidden, false);
  assert.deepEqual(chipState(page), { count: '', spinner: true, busy: 'true' }, 'no count while loading');
  const spinner = page.chip('favorites').querySelector('.chip__spinner');
  assert.equal(spinner.getAttribute('aria-label'), 'Loading');
  assert.equal(spinner.querySelector('use').getAttribute('href'), '#icon-loader');

  release();
  await wait(30);
  assert.deepEqual(chipState(page), { count: '2', spinner: false, busy: 'false' });
  page.close();
});

test('a real 0 still shows once a first-time user has finished loading', async () => {
  const page = openPage({ session: alice });
  await wait(40);
  assert.deepEqual(chipState(page), { count: '0', spinner: false, busy: 'false' });
  page.close();
});

test('a click during loading keeps the spinner, rather than showing a partial count', async () => {
  const page = openPage({ session: null });
  await wait(30);
  page.session = alice;
  page.save = { version: 1, favorites: ['rizz'] };
  const release = holdSaves(page);
  page.window.RetracAccount.check();
  await wait(30);

  page.click(page.heart('bruh'));
  await wait(10);
  assert.equal(page.pressed('bruh'), true);
  assert.deepEqual(chipState(page), { count: '', spinner: true, busy: 'true' });

  release();
  await wait(30);
  assert.deepEqual(chipState(page), { count: '2', spinner: false, busy: 'false' });
  page.close();
});

test('opening Favorites while loading shows no misleading "0 sounds"', async () => {
  const page = openPage({ session: null });
  await wait(30);
  page.session = alice;
  page.save = { version: 1, favorites: ['bruh'] };
  const release = holdSaves(page);
  page.window.RetracAccount.check();
  await wait(30);

  page.click(page.chip('favorites'));
  const status = page.document.getElementById('status');
  assert.equal(status.textContent, '');
  assert.equal(page.document.getElementById('emptyText').textContent, 'Getting your favorites…');
  assert.equal(page.document.getElementById('emptyTitle').textContent.includes('No favorites'), false);

  release();
  await wait(30);
  assert.equal(status.textContent, '1 sound');
  assert.deepEqual(page.visible(), ['bruh']);
  page.close();
});

test('the spinner keeps going during retries, but stops when trying stops', async () => {
  const retrying = openPage({ session: alice, saveStatus: 503 });
  await wait(40);
  assert.deepEqual(chipState(retrying), { count: '', spinner: true, busy: 'true' }, 'another attempt is scheduled');
  retrying.close();

  const stopped = openPage({ session: alice, saveStatus: 400 });
  await wait(40);
  assert.deepEqual(chipState(stopped), { count: '', spinner: false, busy: 'false' }, 'no endless spinner, and no false 0');
  stopped.close();
});

test('an account switch shows the spinner again until the new favorites arrive', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh'] } });
  await wait(40);
  assert.equal(chipState(page).count, '1');

  page.session = bob;
  page.save = { version: 1, favorites: ['rizz', 'wow'] };
  const release = holdSaves(page);
  await page.window.RetracAccount.check();
  await wait(20);
  assert.deepEqual(chipState(page), { count: '', spinner: true, busy: 'true' });
  release();
  await wait(30);
  assert.equal(chipState(page).count, '2');
  page.close();
});

test('favorites that fail to load are not shown as an empty collection', async () => {
  const page = openPage({ session: alice, saveStatus: 503 });
  await wait(40);
  page.click(page.chip('favorites'));
  const text = page.document.getElementById('emptyText').textContent;
  assert.equal(page.document.getElementById('emptyTitle').textContent, 'Your favorites');
  assert.equal(text.includes('No favorites'), false);
  page.close();
});

test('unsaved changes get a quiet note, and no technical language', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: [] } });
  await wait(30);
  const note = page.document.getElementById('favoritesNote');
  assert.equal(note.hidden, true);

  page.saveStatus = 503;
  page.click(page.heart('bruh'));
  await wait(DEBOUNCE + 30);
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, 'Your favorites haven’t saved yet. We’ll keep trying.');
  assert.equal(page.pressed('bruh'), true, 'the heart stays filled');
  assert.ok(page.window.localStorage.getItem('simple-soundboard:favorites-pending:alice').includes('bruh'));
  assert.equal(page.document.querySelector('dialog').open, false, 'no dialog for this');
  page.close();
});

test('signing out clears hearts and the filter', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh'] } });
  await wait(30);
  page.click(page.chip('favorites'));
  page.session = null;
  await page.window.RetracAccount.check();
  await wait(5);
  assert.equal(page.pressed('bruh'), false);
  assert.equal(page.chip('favorites').hidden, true);
  assert.equal(page.chip('all').getAttribute('aria-pressed'), 'true');
  assert.ok(page.visible().length > 1);
  page.close();
});

test('switching to another account never shows or writes the first account\'s favorites', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh'] } });
  await wait(30);
  page.click(page.heart('rizz')); // Unsaved when the switch happens.
  page.session = bob;
  page.save = { version: 1, favorites: ['wow'] };
  await page.window.RetracAccount.check();
  await wait(DEBOUNCE + 30);

  assert.equal(page.pressed('bruh'), false);
  assert.equal(page.pressed('rizz'), false);
  assert.equal(page.pressed('wow'), true);
  assert.deepEqual(page.save, { version: 1, favorites: ['wow'] });
  assert.ok(page.window.localStorage.getItem('simple-soundboard:favorites-pending:alice').includes('rizz'),
    'still waiting for Alice');
  page.close();
});

test('nothing sensitive reaches browser storage', async () => {
  const page = openPage({ session: alice });
  await wait(30);
  page.click(page.heart('bruh'));
  await wait(DEBOUNCE);
  const { localStorage, sessionStorage } = page.window;
  [localStorage, sessionStorage].forEach((storage) => {
    for (let i = 0; i < storage.length; i++) {
      const value = storage.getItem(storage.key(i));
      assert.equal(value.includes(jwtFor('alice')), false);
    }
  });
  page.close();
});
