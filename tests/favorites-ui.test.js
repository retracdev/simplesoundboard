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
const SCRIPTS = ['js/sounds.js', 'js/tune-core.js', 'js/account.js', 'js/strings-core.js', 'js/favorites.js', 'js/sign-in.js', 'js/rearrange.js', 'js/beta.js', 'js/strings-access.js', 'js/string-editor.js', 'js/tune-editor.js', 'js/app.js', 'js/account-welcome.js'];
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

function openPage({ session = null, save, saveStatus, beta = 'strings: []\n' } = {}) {
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
    if (url === 'beta.yml') {
      if (world.betaFails) return { ok: false, status: 500 };
      return { ok: true, status: 200, text: async () => beta };
    }
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
    prepare() {},
    start: async (sound, options) => {
      world.started.push(sound.id);
      world.startOptions = options;
      return { duration: 1, elapsed: () => 0 };
    },
    startClips: async (id, clips) => {
      world.started.push(id);
      world.startedClips = clips;
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

  // The sound's own button in its category, as opposed to its copy in the Favorites row.
  const inCategory = '#banks .bank:not(.bank--favorites):not(.bank--strings)';
  world.heart = (id) => document.querySelector(`${inCategory} .key__heart[data-favorite="${id}"]`);
  world.key = (id) => document.querySelector(`${inCategory} .key[data-id="${id}"]`);
  world.row = () => document.querySelector('.bank--favorites');
  world.rowCards = () => [...world.row().querySelectorAll('.bank__keys > .key-slot')];
  world.rowIds = () => world.rowCards().map((slot) => {
    const key = slot.querySelector('.key');
    return key.dataset.id || 'see-all';
  });
  world.rowKey = (id) => world.row().querySelector(`.key[data-id="${id}"]`);
  world.rowHeart = (id) => world.row().querySelector(`.key__heart[data-favorite="${id}"]`);
  world.seeAll = () => world.row().querySelector('.key--see-all');
  world.pressed = (id) => world.heart(id).getAttribute('aria-pressed') === 'true';
  world.chip = (id) => document.querySelector(`.chip[data-category="${id}"]`);
  world.visible = () => [...document.querySelectorAll(`${inCategory} .key-slot`)]
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

test('the Favorites and Strings filters show 0 to guests and stay visible when signed in', async () => {
  const guest = openPage();
  await wait(30);
  ['favorites', 'strings'].forEach((id) => {
    assert.equal(guest.chip(id).hidden, false);
    assert.equal(guest.chip(id).querySelector('.chip__count').textContent, '0');
  });
  assert.equal(guest.chip('favorites').querySelector('.chip__spinner').hasAttribute('hidden'), true, 'no spinner for guests');
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

test('guests get no Favorites row', async () => {
  const page = openPage();
  await wait(30);
  assert.equal(page.row().hidden, true);
  page.close();
});

test('the Favorites row sits above the first category, with a hint when empty', async () => {
  const page = openPage({ session: alice });
  await wait(40);
  const { firstElementChild } = page.document.getElementById('banks');
  assert.equal(firstElementChild, page.row());
  assert.equal(page.row().hidden, false);
  assert.equal(page.row().querySelector('h2').textContent, 'Favorites');
  assert.equal(page.row().querySelector('.bank__note').textContent, 'Tap the heart on any sound to keep it here.');
  assert.deepEqual(page.rowIds(), []);
  page.close();
});

test('the row shows the loading state until favorites arrive, not the empty hint', async () => {
  const page = openPage();
  await wait(30);
  page.session = alice;
  page.save = { version: 1, favorites: ['bruh'] };
  const release = holdSaves(page);
  page.window.RetracAccount.check();
  await wait(30);
  const note = page.row().querySelector('.bank__note');
  assert.equal(note.textContent, 'Getting your favorites…');
  assert.equal(note.classList.contains('is-loading'), true);
  release();
  await wait(30);
  assert.equal(note.hidden, true);
  assert.deepEqual(page.rowIds(), ['bruh']);
  page.close();
});

test('under five favorites: all of them, newest first, with no See all card', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh', 'rizz', 'wow'] } });
  await wait(40);
  assert.deepEqual(page.rowIds(), ['wow', 'rizz', 'bruh']);
  assert.equal(page.seeAll(), null);
  page.close();
});

test('each row card keeps its category color, and See all is the pink sixth card', async () => {
  const { window } = openPage();
  const { sounds, categories } = window.SOUND_CATALOG;
  window.close();
  const ids = ['bruh', 'get-out', 'punch', 'fart-1', 'apple-pay'];
  const page = openPage({ session: alice, save: { version: 1, favorites: ids } });
  await wait(40);

  assert.deepEqual(page.rowIds(), [...ids].reverse().concat('see-all'));
  page.rowCards().slice(0, 5).forEach((slot) => {
    const id = slot.querySelector('.key').dataset.id;
    const category = categories.find((c) => c.id === sounds.find((s) => s.id === id).category);
    assert.equal(slot.style.getPropertyValue('--key'), category.color, id);
    assert.equal(slot.style.getPropertyValue('--key-side'), category.side, id);
  });
  const css = read('css/style.css').replace(/\s+/g, ' ');
  assert.match(css, /\.bank--favorites \{ --key: #ff7eb6; --key-side: #c0407b;/, 'pink comes from the row');
  assert.equal(page.rowCards()[5].style.getPropertyValue('--key'), '', 'See all inherits that pink');
  assert.ok(page.seeAll().textContent.includes('See all favorites'));
  assert.equal(page.seeAll().tagName, 'BUTTON');
  assert.equal(page.seeAll().closest('.bank').querySelector('.key__heart[data-favorite="see-all"]'), null);
  page.close();
});

test('over five favorites: the five newest, See all, and a full count', async () => {
  const ids = ['enrique', 'bruh', 'fahh', 'vine-boom', 'wow', 'rizz', 'taco-bell'];
  const page = openPage({ session: alice, save: { version: 1, favorites: ids } });
  await wait(40);
  assert.deepEqual(page.rowIds(), ['taco-bell', 'rizz', 'wow', 'vine-boom', 'fahh', 'see-all']);
  assert.equal(page.row().querySelector('.bank__count').textContent, '7 sounds');
  assert.equal(page.seeAll().querySelector('.key__see-all-count').textContent, '7 sounds');
  page.close();
});

test('sounds no longer on the board do not take up spots or count', async () => {
  const ids = ['retired-1', 'retired-2', 'retired-3', 'retired-4', 'retired-5', 'bruh'];
  const page = openPage({ session: alice, save: { version: 1, favorites: ids } });
  await wait(40);
  assert.deepEqual(page.rowIds(), ['bruh']);
  assert.equal(page.seeAll(), null);
  assert.equal(page.row().querySelector('.bank__count').textContent, '1 sound');
  page.close();
});

test('See all opens the Favorites filter, and starts no sound', async () => {
  const ids = ['enrique', 'bruh', 'fahh', 'vine-boom', 'wow', 'rizz'];
  const page = openPage({ session: alice, save: { version: 1, favorites: ids } });
  await wait(40);
  const { MouseEvent } = page.window;
  page.seeAll().dispatchEvent(Object.assign(new MouseEvent('pointerdown', { bubbles: true, button: 0 }), { pointerType: 'mouse' }));
  page.seeAll().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  await wait(10);
  assert.deepEqual(page.started, []);
  assert.equal(page.chip('favorites').getAttribute('aria-pressed'), 'true');
  assert.equal(page.document.activeElement, page.chip('favorites'));
  assert.equal(page.row().hidden, true);
  assert.deepEqual(page.visible().sort(), [...ids].sort());
  page.close();
});

test('the row updates at once, and See all comes and goes at exactly five', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['enrique', 'bruh', 'fahh', 'vine-boom'] } });
  await wait(40);
  assert.equal(page.seeAll(), null);

  page.click(page.heart('wow'));
  await wait(5);
  assert.deepEqual(page.rowIds(), ['wow', 'vine-boom', 'fahh', 'bruh', 'enrique', 'see-all']);

  page.click(page.rowHeart('fahh'));
  await wait(5);
  assert.deepEqual(page.rowIds(), ['wow', 'vine-boom', 'bruh', 'enrique']);
  assert.equal(page.pressed('fahh'), false, 'the category copy clears too');
  await wait(DEBOUNCE);
  assert.deepEqual(page.save.favorites, ['enrique', 'bruh', 'vine-boom', 'wow']);
  page.close();
});

test('both copies of a favorite stay in step', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh'] } });
  await wait(40);
  assert.equal(page.rowHeart('bruh').getAttribute('aria-pressed'), 'true');
  assert.equal(page.rowKey('bruh').getAttribute('aria-label'), 'Start Bruh');
  assert.equal(page.rowHeart('bruh').getAttribute('aria-label'), 'Favorite Bruh');

  page.click(page.rowKey('bruh'));
  await wait(120);
  assert.deepEqual(page.started, ['bruh'], 'one press, one sound');
  const depth = (element) => Number(element.closest('.key-slot').style.getPropertyValue('--depth'));
  assert.ok(depth(page.rowKey('bruh')) > 0.5, 'the pressed copy sinks');
  assert.equal(depth(page.key('bruh')), depth(page.rowKey('bruh')), 'and the other copy with it');
  page.close();
});

test('a copy built while its sound is already running joins in', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: [] } });
  await wait(40);
  page.click(page.key('bruh'));
  await wait(120);
  page.click(page.heart('bruh'));
  await wait(5);
  const depth = (element) => Number(element.closest('.key-slot').style.getPropertyValue('--depth'));
  assert.ok(depth(page.rowKey('bruh')) > 0.5);
  page.close();
});

test('the row leaves search and filters alone, and sounds are not counted twice', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh', 'rizz'] } });
  await wait(40);
  const { sounds } = page.window.SOUND_CATALOG;
  const status = page.document.getElementById('status');
  assert.equal(status.textContent, sounds.length + ' sounds', 'favorites are not counted twice');
  assert.equal(page.chip('all').querySelector('.chip__count').textContent, String(sounds.length));

  page.search('bruh');
  assert.equal(page.row().hidden, true, 'a search shows each sound once');
  assert.deepEqual(page.visible(), ['bruh']);
  page.search('');
  assert.equal(page.row().hidden, false);

  page.click(page.chip('silly'));
  assert.equal(page.row().hidden, true);
  page.click(page.chip('favorites'));
  assert.equal(page.row().hidden, true, 'the filter already shows them all');
  assert.deepEqual(page.visible().sort(), ['bruh', 'rizz']);
  page.click(page.chip('all'));
  assert.equal(page.row().hidden, false);
  page.close();
});

test('removing a favorite from the row moves focus somewhere sensible', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh', 'rizz'] } });
  await wait(40);
  page.rowHeart('bruh').focus();
  page.click(page.rowHeart('bruh'));
  await wait(5);
  assert.equal(page.document.activeElement, page.chip('favorites'));
  page.close();
});

test('signing out removes the row, and switching accounts replaces it', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh'] } });
  await wait(40);
  assert.deepEqual(page.rowIds(), ['bruh']);

  page.session = bob;
  page.save = { version: 1, favorites: ['wow'] };
  await page.window.RetracAccount.check();
  await wait(40);
  assert.deepEqual(page.rowIds(), ['wow']);

  page.session = null;
  await page.window.RetracAccount.check();
  await wait(5);
  assert.equal(page.row().hidden, true);
  page.close();
});

test('every sound in the catalog points at a real file, with a unique id', () => {
  const page = openPage();
  const { sounds, categories } = page.window.SOUND_CATALOG;
  assert.equal(new Set(sounds.map((s) => s.id)).size, sounds.length);
  sounds.forEach((sound) => {
    assert.ok(fs.existsSync(path.join(ROOT, sound.src)), sound.src);
    assert.ok(categories.some((c) => c.id === sound.category), sound.id);
  });
  const files = fs.readdirSync(path.join(ROOT, 'sounds')).filter((f) => f.endsWith('.mp3'));
  assert.equal(files.length, sounds.length, 'and no file is left unused');
  page.close();
});

const startAllButton = (page, group) => page.document.querySelector(`.bank__all[data-group="${group}"]`);
const everything = (page) => page.document.getElementById('everything');
const warning = (page) => page.document.querySelector('dialog.warning-dialog');
const warningButton = (page, label) => [...warning(page).querySelectorAll('button')].find((b) => b.textContent === label);

test('Shocked is gone from the board', async () => {
  const page = openPage();
  const { sounds } = page.window.SOUND_CATALOG;
  assert.equal(sounds.some((s) => s.id === 'shocked'), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'sounds/shocked.mp3')), false);
  page.close();
});

test('a saved favorite for a removed sound does no harm, and is kept', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['shocked', 'bruh'] } });
  await wait(40);
  assert.deepEqual(page.rowIds(), ['bruh']);
  page.click(page.heart('rizz'));
  await wait(DEBOUNCE);
  assert.deepEqual(page.save.favorites, ['shocked', 'bruh', 'rizz']);
  page.close();
});

test('every category has a Play All button, named with "Start" for screen readers', async () => {
  const page = openPage();
  await wait(20);
  page.window.SOUND_CATALOG.categories.forEach((category) => {
    const button = startAllButton(page, category.id);
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.textContent, 'Play All');
    assert.equal(button.getAttribute('aria-label'), `Start all ${category.label} sounds`);
  });
  page.close();
});

test('Play All starts every sound in that category at once, and only that category', async () => {
  const page = openPage();
  await wait(20);
  const { sounds } = page.window.SOUND_CATALOG;
  page.click(startAllButton(page, 'silly'));
  await wait(30);
  assert.deepEqual([...page.started].sort(), sounds.filter((s) => s.category === 'silly').map((s) => s.id).sort());
  assert.equal(page.dialog().open, false);
  assert.equal(warning(page).open, false, 'no confirmation for one category');
  page.close();
});

test('no sound starts until the whole group has loaded', async () => {
  const page = openPage();
  await wait(20);
  let finishLoading;
  const loading = new Promise((resolve) => { finishLoading = resolve; });
  const { sounds } = page.window.SOUND_CATALOG;
  const slow = sounds.find((s) => s.category === 'silly').id;
  const { load } = page.window.SoundEngine;
  page.window.SoundEngine.load = (sound) => (sound.id === slow ? loading.then(() => load(sound)) : load(sound));
  page.click(startAllButton(page, 'silly'));
  await wait(30);
  assert.deepEqual(page.started, [], 'still waiting on one file');
  finishLoading();
  await wait(30);
  assert.equal(page.started.length, sounds.filter((s) => s.category === 'silly').length);
  page.close();
});

test('a sound that fails to load does not stop the rest of the group', async () => {
  const page = openPage();
  await wait(20);
  const { sounds } = page.window.SOUND_CATALOG;
  const bad = sounds.find((s) => s.category === 'silly').id;
  const { load } = page.window.SoundEngine;
  page.window.SoundEngine.load = (sound) => (sound.id === bad ? Promise.reject(new Error('nope')) : load(sound));
  page.click(startAllButton(page, 'silly'));
  await wait(30);
  assert.ok(page.started.length >= sounds.filter((s) => s.category === 'silly').length - 1);
  page.close();
});

test('Stop all during loading cancels a group before it starts', async () => {
  const page = openPage();
  await wait(20);
  let finishLoading;
  const loading = new Promise((resolve) => { finishLoading = resolve; });
  const { load } = page.window.SoundEngine;
  page.window.SoundEngine.load = (sound) => loading.then(() => load(sound));
  page.click(startAllButton(page, 'silly'));
  await wait(5);
  page.click(page.document.getElementById('stopAll'));
  finishLoading();
  await wait(30);
  assert.deepEqual(page.started, []);
  page.close();
});

test('a search narrows Play All to the sounds showing', async () => {
  const page = openPage();
  await wait(20);
  page.search('bruh');
  page.click(startAllButton(page, 'internet'));
  await wait(30);
  assert.deepEqual(page.started, ['bruh']);
  page.close();
});

test('the Favorites filter narrows a category to its favorites', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh', 'rizz', 'punch'] } });
  await wait(40);
  page.click(page.chip('favorites'));
  page.click(startAllButton(page, 'internet'));
  await wait(30);
  assert.deepEqual([...page.started].sort(), ['bruh', 'rizz']);
  page.close();
});

test('Play All in the Favorites section covers every favorite, not just the top five', async () => {
  const ids = ['enrique', 'bruh', 'fahh', 'vine-boom', 'wow', 'rizz', 'taco-bell'];
  const page = openPage({ session: alice, save: { version: 1, favorites: ids } });
  await wait(40);
  const button = startAllButton(page, 'favorites');
  assert.equal(button.hidden, false);
  assert.equal(button.getAttribute('aria-label'), 'Start all favorite sounds');
  page.click(button);
  await wait(30);
  assert.deepEqual([...page.started].sort(), [...ids].sort());
  page.close();
});

test('the Favorites section hides Play All when there is nothing to start', async () => {
  const page = openPage({ session: alice });
  await wait(40);
  assert.equal(startAllButton(page, 'favorites').hidden, true);
  page.close();
});

test('Play Everything sits at the bottom and warns before starting anything', async () => {
  const page = openPage();
  await wait(20);
  const button = everything(page);
  assert.equal(button.textContent.trim(), 'Play Everything');
  assert.equal(button.getAttribute('aria-label'), 'Start every sound');
  const banks = page.document.getElementById('banks');
  assert.ok(banks.compareDocumentPosition(button) & page.window.Node.DOCUMENT_POSITION_FOLLOWING, 'after the categories');

  page.click(button);
  await wait(10);
  assert.equal(warning(page).open, true);
  assert.deepEqual(page.started, [], 'nothing starts yet');
  const { sounds } = page.window.SOUND_CATALOG;
  assert.equal(warning(page).querySelector('h2').textContent, 'Take off your headphones!');
  assert.ok(warning(page).querySelector('p').textContent.includes(`all ${sounds.length} sounds`));
  assert.equal(warning(page).querySelector('use').getAttribute('href'), '#icon-headphones');
  assert.equal(page.document.activeElement, warningButton(page, 'Cancel'), 'the safe choice has focus');
  page.close();
});

test('Cancel starts nothing, and confirming starts every sound at once', async () => {
  const page = openPage();
  await wait(20);
  page.click(everything(page));
  page.click(warningButton(page, 'Cancel'));
  await wait(20);
  assert.equal(warning(page).open, false);
  assert.deepEqual(page.started, []);
  assert.equal(page.document.activeElement, everything(page));

  page.click(everything(page));
  page.click(warningButton(page, 'Play Everything'));
  await wait(40);
  const { sounds } = page.window.SOUND_CATALOG;
  assert.equal(warning(page).open, false);
  assert.deepEqual([...page.started].sort(), sounds.map((s) => s.id).sort());
  page.close();
});

test('Play Everything ignores a search or filter, since it means everything', async () => {
  const page = openPage();
  await wait(20);
  page.search('bruh');
  page.click(everything(page));
  page.click(warningButton(page, 'Play Everything'));
  await wait(40);
  assert.equal(page.started.length, page.window.SOUND_CATALOG.sounds.length);
  page.close();
});

test('while sounds run the red button stops them, without asking', async () => {
  const page = openPage();
  await wait(20);
  page.click(page.key('bruh'));
  await wait(20);
  const button = everything(page);
  assert.equal(button.textContent.trim(), 'Stop all');
  assert.equal(button.getAttribute('aria-label'), 'Stop all sounds');
  assert.equal(button.classList.contains('is-stop'), true);

  page.click(button);
  await wait(10);
  assert.equal(warning(page).open, false, 'no warning for stopping');
  assert.equal(button.textContent.trim(), 'Play Everything');
  assert.equal(button.getAttribute('aria-label'), 'Start every sound');
  page.close();
});

test('a click on the warning backdrop cancels', async () => {
  const page = openPage();
  await wait(20);
  page.click(everything(page));
  page.click(warning(page));
  await wait(20);
  assert.equal(warning(page).open, false);
  assert.deepEqual(page.started, []);
  page.close();
});

function rightClick(page, element) {
  const event = new page.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 });
  element.dispatchEvent(event);
  return event;
}

const menu = (page) => page.document.querySelector('.card-menu');
const rearrangeDialog = (page) => page.document.querySelector('dialog.rearrange');
const slotIds = (page) => [...rearrangeDialog(page).querySelectorAll('.rearrange__slots .rearrange__tile')].map((t) => t.dataset.id);
const poolIds = (page) => [...rearrangeDialog(page).querySelectorAll('.rearrange__pool .rearrange__tile')].map((t) => t.dataset.id);
const tile = (page, id) => rearrangeDialog(page).querySelector(`.rearrange__tile[data-id="${id}"]`);
const footerButton = (page, label) => [...rearrangeDialog(page).querySelectorAll('button')].find((b) => b.textContent === label);
const pressKey = (page, element, key) => element.dispatchEvent(new page.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

async function openRearrangeFromRow(page, id) {
  rightClick(page, page.rowKey(id));
  page.click(menu(page).querySelector('button'));
  await wait(5);
}

const SEVEN = ['enrique', 'bruh', 'fahh', 'vine-boom', 'wow', 'rizz', 'taco-bell'];

test('right-clicking a card in the Favorites row offers Rearrange top favorites', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh', 'rizz'] } });
  await wait(40);
  const event = rightClick(page, page.rowKey('bruh'));
  assert.equal(event.defaultPrevented, true, 'instead of the browser menu');
  assert.equal(menu(page).getAttribute('role'), 'menu');
  const item = menu(page).querySelector('[role="menuitem"]');
  assert.equal(item.textContent, 'Rearrange top favorites');
  assert.deepEqual(page.started, [], 'and no sound');
  page.close();
});

test('right-clicking inside the Favorites filter offers it too, including See all', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: SEVEN } });
  await wait(40);
  rightClick(page, page.seeAll());
  assert.ok(menu(page), 'the See all card');
  page.click(menu(page).querySelector('button'));
  await wait(5);
  assert.equal(rearrangeDialog(page).open, true);
  page.click(footerButton(page, 'Cancel'));

  page.click(page.seeAll());
  rightClick(page, page.key('bruh'));
  assert.ok(menu(page), 'a card in the filter');
  page.close();
});

const menuLabels = (page) => [...menu(page).querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);

test('other cards offer to create a string and to loop, for guests too', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh'] } });
  await wait(40);
  assert.equal(rightClick(page, page.key('bruh')).defaultPrevented, true);
  assert.deepEqual(menuLabels(page), ['Create string with this sound', 'Loop sound', 'Edit speed and pitch'], 'a favorite in its own category');
  rightClick(page, page.key('rizz'));
  assert.deepEqual(menuLabels(page), ['Create string with this sound', 'Loop sound', 'Edit speed and pitch'], 'a card that is not a favorite');
  rightClick(page, page.rowKey('bruh'));
  assert.deepEqual(menuLabels(page), ['Rearrange top favorites', 'Create string with this sound', 'Loop sound', 'Edit speed and pitch'], 'the Favorites row');
  page.close();

  const guest = openPage();
  await wait(40);
  rightClick(guest, guest.key('bruh'));
  assert.deepEqual(menuLabels(guest), ['Create string with this sound', 'Loop sound', 'Edit speed and pitch'], 'guests');
  guest.close();
});

test('the menu closes with Escape and on an outside press', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh'] } });
  await wait(40);
  rightClick(page, page.rowKey('bruh'));
  pressKey(page, menu(page).querySelector('button'), 'Escape');
  assert.equal(menu(page), null);
  assert.equal(page.document.activeElement, page.rowKey('bruh'), 'focus returns to the card');

  rightClick(page, page.rowKey('bruh'));
  page.document.body.dispatchEvent(new page.window.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(menu(page), null);
  page.close();
});

test('the dialog shows the top five in slots and the rest below', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: SEVEN } });
  await wait(40);
  await openRearrangeFromRow(page, 'rizz');
  assert.equal(rearrangeDialog(page).open, true);
  assert.equal(rearrangeDialog(page).querySelector('h2').textContent, 'Rearrange top favorites');
  assert.deepEqual(slotIds(page), page.rowIds().slice(0, 5), 'same order as the row');
  assert.deepEqual(poolIds(page), ['bruh', 'enrique']);
  assert.equal(rearrangeDialog(page).querySelectorAll('.rearrange__rank').length, 5);
  assert.equal(page.document.activeElement, tile(page, 'taco-bell'));
  assert.match(tile(page, 'taco-bell').getAttribute('aria-label'), /^Taco Bell, position 1 of 7/);
  page.close();
});

test('with fewer than five favorites, the extra slots stay empty and Others is hidden', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh', 'rizz'] } });
  await wait(40);
  await openRearrangeFromRow(page, 'rizz');
  assert.deepEqual(slotIds(page), ['rizz', 'bruh']);
  assert.equal(rearrangeDialog(page).querySelectorAll('.rearrange__socket:empty').length, 3);
  assert.equal(rearrangeDialog(page).querySelector('.rearrange__others').hidden, true);
  page.close();
});

test('moving a card and saving updates the row at once and saves the order', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: SEVEN } });
  await wait(40);
  await openRearrangeFromRow(page, 'rizz');
  assert.equal(footerButton(page, 'Save order').disabled, true, 'nothing to save yet');

  pressKey(page, tile(page, 'fahh'), 'Home');
  assert.deepEqual(slotIds(page), ['fahh', 'taco-bell', 'rizz', 'wow', 'vine-boom']);
  assert.equal(footerButton(page, 'Save order').disabled, false);
  assert.deepEqual(page.rowIds().slice(0, 5), ['taco-bell', 'rizz', 'wow', 'vine-boom', 'fahh'], 'the board waits for Save');

  page.click(footerButton(page, 'Save order'));
  await wait(5);
  assert.equal(rearrangeDialog(page).open, false);
  assert.deepEqual(page.rowIds(), ['fahh', 'taco-bell', 'rizz', 'wow', 'vine-boom', 'see-all']);
  await wait(DEBOUNCE);
  assert.deepEqual(page.save.top, ['fahh', 'taco-bell', 'rizz', 'wow', 'vine-boom']);
  assert.deepEqual(page.save.favorites, SEVEN, 'the favorites themselves are untouched');
  page.close();
});

test('a card from below can be promoted, pushing the fifth down, with arrow keys', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: SEVEN } });
  await wait(40);
  await openRearrangeFromRow(page, 'rizz');
  assert.deepEqual(poolIds(page), ['bruh', 'enrique']);
  pressKey(page, tile(page, 'bruh'), 'ArrowLeft');
  assert.deepEqual(slotIds(page).at(-1), 'bruh');
  assert.deepEqual(poolIds(page), ['fahh', 'enrique']);
  assert.equal(page.document.querySelector('dialog.rearrange [role="status"]').textContent, 'Bruh moved to position 5 of 7, top spot 5.');
  page.close();
});

test('a chosen top five loads back in order, and new favorites do not displace it', async () => {
  const top = ['bruh', 'enrique', 'fahh', 'wow', 'rizz'];
  const page = openPage({ session: alice, save: { version: 1, favorites: SEVEN, top } });
  await wait(40);
  assert.deepEqual(page.rowIds(), [...top, 'see-all']);

  page.click(page.heart('punch'));
  await wait(5);
  assert.deepEqual(page.rowIds(), [...top, 'see-all'], 'still your five');
  await wait(DEBOUNCE);
  assert.deepEqual(page.save.top, top);
  assert.ok(page.save.favorites.includes('punch'));
  page.close();
});

test('removing a chosen favorite lets the newest other favorite take the last spot', async () => {
  const top = ['bruh', 'enrique', 'fahh', 'wow', 'rizz'];
  const page = openPage({ session: alice, save: { version: 1, favorites: SEVEN, top } });
  await wait(40);
  page.click(page.rowHeart('enrique'));
  await wait(5);
  assert.deepEqual(page.rowIds(), ['bruh', 'fahh', 'wow', 'rizz', 'taco-bell', 'see-all']);
  page.close();
});

test('Back to newest first undoes a chosen order once saved', async () => {
  const top = ['bruh', 'enrique', 'fahh', 'wow', 'rizz'];
  const page = openPage({ session: alice, save: { version: 1, favorites: SEVEN, top } });
  await wait(40);
  await openRearrangeFromRow(page, 'rizz');
  page.click(footerButton(page, 'Back to newest first'));
  assert.deepEqual(slotIds(page), ['taco-bell', 'rizz', 'wow', 'vine-boom', 'fahh']);
  page.click(footerButton(page, 'Save order'));
  await wait(DEBOUNCE + 5);
  assert.deepEqual(page.rowIds(), ['taco-bell', 'rizz', 'wow', 'vine-boom', 'fahh', 'see-all']);
  assert.equal(page.save.top, undefined);
  page.close();
});

test('Cancel discards the arrangement and writes nothing', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: SEVEN } });
  await wait(40);
  const before = page.rowIds();
  await openRearrangeFromRow(page, 'rizz');
  pressKey(page, tile(page, 'fahh'), 'Home');
  page.click(footerButton(page, 'Cancel'));
  assert.equal(rearrangeDialog(page).open, false);
  await wait(DEBOUNCE);
  assert.deepEqual(page.rowIds(), before);
  assert.equal(page.writes().length, 0);
  assert.equal(page.document.activeElement, page.rowKey('rizz'), 'focus returns to the card');
  page.close();
});

test('a stray click outside only closes the dialog when nothing would be lost', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: SEVEN } });
  await wait(40);
  await openRearrangeFromRow(page, 'rizz');
  pressKey(page, tile(page, 'fahh'), 'Home');
  page.click(rearrangeDialog(page));
  assert.equal(rearrangeDialog(page).open, true, 'kept open with changes');

  page.click(footerButton(page, 'Cancel'));
  await openRearrangeFromRow(page, 'rizz');
  page.click(rearrangeDialog(page));
  assert.equal(rearrangeDialog(page).open, false, 'closed with none');
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

test('signing out clears hearts and explains the account on the Favorites tab', async () => {
  const page = openPage({ session: alice, save: { version: 1, favorites: ['bruh'] } });
  await wait(30);
  page.click(page.chip('favorites'));
  page.session = null;
  await page.window.RetracAccount.check();
  await wait(5);
  assert.equal(page.pressed('bruh'), false);
  assert.equal(page.chip('favorites').querySelector('.chip__count').textContent, '0');
  assert.equal(page.chip('favorites').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(page.visible(), []);
  assert.equal(page.document.getElementById('emptySignIn').hidden, false);
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

// ---------- Strings ----------

const BETA_ALICE = 'strings: [Alice, someone_else]\n';
const STRING = {
  id: 'one',
  name: 'My string',
  clips: [
    { sound: 'bruh', at: 0, from: 0, length: 0.5, lane: 0 },
    { sound: 'windows-xp-error', at: 0.25, from: 0, length: 0.5, lane: 1 },
  ],
};
const noAccess = (page) => page.document.querySelector('dialog.strings-access');
const editor = (page) => page.document.querySelector('dialog.string-editor');
const editorButton = (page, label) => [...editor(page).querySelectorAll('button')].find((b) => b.textContent === label);
const stringKeys = (page) => [...page.document.querySelectorAll('.bank--strings .key')];

async function createFromMenu(page, id) {
  rightClick(page, page.key(id));
  page.click([...menu(page).querySelectorAll('button')].find((b) => b.textContent === 'Create string with this sound'));
  await wait(20);
}

test('the Strings tab asks guests for an account, and its button opens the strings sign-in', async () => {
  const page = openPage();
  await wait(30);
  page.click(page.chip('strings'));
  await wait(10);
  assert.equal(page.chip('strings').getAttribute('aria-pressed'), 'true');
  assert.equal(page.dialog().open, false, 'the tab explains it first');
  assert.equal(page.document.getElementById('emptyTitle').textContent, 'You need an account.');
  const button = page.document.getElementById('emptySignIn');
  assert.equal(button.hidden, false);
  assert.equal(page.document.getElementById('emptyReset').hidden, true);
  page.click(button);
  await wait(10);
  assert.equal(page.dialog().open, true);
  assert.equal(page.dialogTitle(), 'Make your own strings');
  page.close();
});

test('the Favorites tab asks guests for an account, and its button opens the favorites sign-in', async () => {
  const page = openPage();
  await wait(30);
  page.click(page.chip('favorites'));
  await wait(10);
  assert.equal(page.chip('favorites').getAttribute('aria-pressed'), 'true');
  assert.equal(page.document.getElementById('emptyTitle').textContent, 'You need an account.');
  page.click(page.document.getElementById('emptySignIn'));
  await wait(10);
  assert.equal(page.dialogTitle(), 'Save your favorite sounds');

  page.session = alice;
  await page.window.RetracAccount.check();
  await wait(30);
  assert.equal(page.dialog().open, false);
  assert.equal(page.document.getElementById('emptySignIn').hidden, true);
  assert.equal(page.document.getElementById('emptyTitle').textContent, 'No favorites yet.');
  page.close();
});

test('creating a string asks guests to sign in, then carries on into the editor', async () => {
  const page = openPage({ beta: BETA_ALICE });
  await wait(30);
  await createFromMenu(page, 'bruh');
  assert.equal(page.dialogTitle(), 'Make your own strings');
  assert.equal(editor(page).open, false);
  page.session = alice;
  await page.window.RetracAccount.check();
  await wait(30);
  assert.equal(editor(page).open, true);
  page.close();
});

test('signed-in visitors outside the beta are told they have no access', async () => {
  const page = openPage({ session: bob, beta: BETA_ALICE });
  await wait(30);
  page.click(page.chip('strings'));
  await wait(20);
  assert.equal(noAccess(page).open, true);
  assert.equal(noAccess(page).querySelector('h2').textContent, 'You don’t have access yet.');
  assert.equal(noAccess(page).querySelector('p').textContent, 'We’re rolling out strings to everyone soon. You may not have access yet.');
  assert.equal(page.chip('strings').getAttribute('aria-pressed'), 'false');
  page.click(noAccess(page).querySelector('button'));
  assert.equal(noAccess(page).open, false);

  await createFromMenu(page, 'bruh');
  assert.equal(noAccess(page).open, true, 'creating one too');
  assert.equal(editor(page).open, false);
  page.close();
});

test('an unreadable beta list gives nobody access', async () => {
  const page = openPage({ session: alice, beta: BETA_ALICE });
  page.betaFails = true;
  await wait(30);
  page.click(page.chip('strings'));
  await wait(20);
  assert.equal(noAccess(page).open, true);
  page.close();
});

test('a beta account can name and save a string, which lands in its tab and the cloud save', async () => {
  const page = openPage({ session: alice, beta: BETA_ALICE, save: { version: 1, favorites: ['bruh'], other: 'kept' } });
  await wait(30);
  await createFromMenu(page, 'bruh');
  assert.equal(editor(page).open, true);
  assert.equal(editor(page).querySelectorAll('.string-clip').length, 1, 'starts with the chosen sound');

  page.click(editorButton(page, 'Save string'));
  assert.equal(editor(page).open, true, 'it needs a name');
  assert.match(editor(page).querySelector('.string-editor__message').textContent, /name/);

  editor(page).querySelector('.string-editor__name').value = 'Bruh mix';
  page.click(editorButton(page, 'Save string'));
  assert.equal(editor(page).open, false);
  assert.equal(page.chip('strings').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(stringKeys(page).map((key) => key.querySelector('.key__name').textContent), ['Bruh mix']);
  assert.equal(page.chip('strings').querySelector('.chip__count').textContent, '1');

  await wait(DEBOUNCE + 40);
  assert.equal(page.save.other, 'kept');
  assert.deepEqual([...page.save.favorites], ['bruh']);
  assert.equal(page.save.strings.length, 1);
  assert.equal(page.save.strings[0].name, 'Bruh mix');
  assert.equal(page.save.strings[0].clips[0].sound, 'bruh');
  page.close();
});

test('saved strings only show under their tab, painted with the colors of their sounds', async () => {
  const page = openPage({ session: alice, beta: BETA_ALICE, save: { version: 1, favorites: [], strings: [STRING] } });
  await wait(40);
  assert.equal(page.document.querySelector('.bank--strings').hidden, true, 'not on All');
  assert.equal(page.chip('strings').querySelector('.chip__count').textContent, '1');

  page.click(page.chip('strings'));
  await wait(20);
  assert.equal(page.document.querySelector('.bank--strings').hidden, false);
  assert.deepEqual(page.visible(), [], 'and no sounds with them');
  const [key] = stringKeys(page);
  const slot = key.closest('.key-slot');
  const { categories, sounds } = page.window.SOUND_CATALOG;
  const color = (id) => categories.find((c) => c.id === sounds.find((s) => s.id === id).category).color;
  const fill = slot.style.getPropertyValue('--string-fill');
  assert.ok(fill.includes(color('bruh')), fill);
  assert.ok(fill.includes(color('windows-xp-error')), fill);
  assert.equal(slot.querySelector('.key__heart'), null);

  page.click(key);
  await wait(10);
  assert.deepEqual(page.started, ['string:one']);
  assert.equal(page.startedClips.length, 2);
  page.close();
});

test('right-clicking a string edits it, and deleting it takes two clicks', async () => {
  const page = openPage({ session: alice, beta: BETA_ALICE, save: { version: 1, favorites: [], strings: [STRING] } });
  await wait(40);
  page.click(page.chip('strings'));
  await wait(20);
  rightClick(page, stringKeys(page)[0]);
  assert.deepEqual(menuLabels(page), ['Edit string']);
  page.click(menu(page).querySelector('button'));
  await wait(20);
  assert.equal(editor(page).open, true);
  assert.equal(editor(page).querySelector('.string-editor__name').value, 'My string');
  assert.equal(editor(page).querySelectorAll('.string-clip').length, 2);

  page.click(editorButton(page, 'Delete string'));
  assert.equal(editor(page).open, true);
  page.click(editorButton(page, 'Really delete?'));
  assert.equal(editor(page).open, false);
  assert.equal(stringKeys(page).length, 0);
  await wait(DEBOUNCE + 40);
  assert.equal(page.save.strings, undefined);
  page.close();
});

test('closing the editor with changes asks first, and without them just closes', async () => {
  const page = openPage({ session: alice, beta: BETA_ALICE });
  await wait(30);
  await createFromMenu(page, 'bruh');
  page.click(editorButton(page, 'Cancel'));
  assert.equal(editor(page).open, false, 'nothing changed yet');

  await createFromMenu(page, 'bruh');
  editor(page).querySelector('.string-editor__name').value = 'Something';
  page.click(editorButton(page, 'Cancel'));
  assert.equal(editor(page).open, true);
  page.click(editorButton(page, 'Keep editing'));
  assert.equal(editor(page).open, true);
  page.click(editorButton(page, 'Cancel'));
  page.click(editorButton(page, 'Discard'));
  assert.equal(editor(page).open, false);
  page.close();
});

test('editor tools split, duplicate, remove and undo clips', async () => {
  const page = openPage({ session: alice, beta: BETA_ALICE });
  await wait(30);
  await createFromMenu(page, 'bruh');
  const clips = () => editor(page).querySelectorAll('.string-clip').length;
  page.click(editorButton(page, 'Duplicate'));
  assert.equal(clips(), 2);
  page.click(editorButton(page, 'Remove'));
  assert.equal(clips(), 1);
  page.click(editorButton(page, 'Undo'));
  assert.equal(clips(), 2);
  page.click(editorButton(page, 'Redo'));
  assert.equal(clips(), 1);
  page.close();
});

// ---------- Speed and pitch ----------

const tuneDialog = (page) => page.document.querySelector('dialog.tune-editor');
const tunePart = (page, name) => tuneDialog(page).querySelector('.tune-editor__' + name);
const slotOf = (page, id) => page.key(id).closest('.key-slot');

async function openTuneMenu(page, id) {
  rightClick(page, page.key(id));
  page.click([...menu(page).querySelectorAll('button')].find((b) => b.textContent === 'Edit speed and pitch'));
  await wait(20);
}

function setSlider(page, input, value) {
  input.value = value;
  input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new page.window.Event('change', { bubbles: true }));
}

function setSeparate(page, on) {
  const box = tunePart(page, 'separate');
  box.checked = on;
  box.dispatchEvent(new page.window.Event('change', { bubbles: true }));
}

// 1.25x and 150%, with the sliders running 0 to 100 evenly in ratios.
const SPEED_125 = 58;
const PITCH_150 = 79;

test('editing speed and pitch asks guests to sign in with its own wording, then opens', async () => {
  const page = openPage({ beta: BETA_ALICE });
  await wait(30);
  await openTuneMenu(page, 'bruh');
  assert.equal(page.dialogTitle(), 'Edit speed and pitch');
  assert.match(page.dialog().querySelector('p').textContent, /sync it across your devices/);
  assert.equal(tuneDialog(page).open, false);
  page.session = alice;
  await page.window.RetracAccount.check();
  await wait(30);
  assert.equal(tuneDialog(page).open, true);
  page.close();
});

test('editing speed and pitch is beta only, using the same list as Strings', async () => {
  const page = openPage({ session: bob, beta: BETA_ALICE });
  await wait(30);
  await openTuneMenu(page, 'bruh');
  assert.equal(tuneDialog(page).open, false);
  assert.equal(noAccess(page).open, true);
  assert.match(noAccess(page).querySelector('p').textContent, /speed and pitch editing/);
  page.close();
});

test('by default the speed slider saves and shows one card, with no separate pitch', async () => {
  const page = openPage({ session: alice, beta: BETA_ALICE, save: { version: 1, favorites: [] } });
  await wait(30);
  await openTuneMenu(page, 'bruh');
  assert.equal(tunePart(page, 'separate').checked, false);
  assert.equal(tunePart(page, 'pitch-row').hidden, true);
  assert.equal(tunePart(page, 'reset').disabled, true, 'already normal');

  setSlider(page, tunePart(page, 'speed'), SPEED_125);
  assert.equal(tunePart(page, 'speed-value').textContent, '1.25x');
  assert.equal(tunePart(page, 'reset').disabled, false);
  const slot = slotOf(page, 'bruh');
  assert.equal(slot.classList.contains('has-speed'), true);
  assert.equal(slot.classList.contains('has-pitch'), false);
  assert.equal(slot.dataset.badges, '1');
  assert.equal(slot.querySelector('.key__speed').textContent, 'Speed: 1.25x');
  assert.match(page.key('bruh').getAttribute('aria-label'), /speed 1\.25x/);

  await wait(DEBOUNCE);
  assert.deepEqual(page.save, { version: 1, favorites: [], tunes: { bruh: { speed: 1.25 } } });
  page.close();
});

test('a separate pitch gets its own slider and card, and three cards can share a key', async () => {
  const page = openPage({ session: alice, beta: BETA_ALICE, save: { version: 1, favorites: [] } });
  await wait(30);
  await openTuneMenu(page, 'bruh');
  setSlider(page, tunePart(page, 'speed'), SPEED_125);
  setSeparate(page, true);
  assert.equal(tunePart(page, 'pitch-row').hidden, false);
  assert.equal(slotOf(page, 'bruh').querySelector('.key__pitch').textContent, 'Pitch: 100%', 'speed no longer moves the pitch');
  assert.equal(slotOf(page, 'bruh').classList.contains('has-pitch'), true);

  setSlider(page, tunePart(page, 'pitch'), PITCH_150);
  assert.equal(tunePart(page, 'pitch-value').textContent, '150%');
  assert.equal(slotOf(page, 'bruh').querySelector('.key__pitch').textContent, 'Pitch: 150%');
  page.click(tuneDialog(page).querySelector('.tune-editor__done'));
  assert.equal(tuneDialog(page).open, false);

  rightClick(page, page.key('bruh'));
  page.click([...menu(page).querySelectorAll('button')].find((b) => b.textContent === 'Loop sound'));
  await wait(20);
  assert.equal(slotOf(page, 'bruh').dataset.badges, '3');
  assert.deepEqual({ ...page.startOptions.tune }, { speed: 1.25, pitch: 1.5 }, 'the loop plays with them too');
  page.close();
});

test('pressing a changed sound plays it that way, and its time follows the speed', async () => {
  const page = openPage({ session: alice, beta: BETA_ALICE, save: { version: 1, favorites: [], tunes: { bruh: { speed: 2 } } } });
  await wait(60);
  assert.equal(slotOf(page, 'bruh').querySelector('.key__speed').textContent, 'Speed: 2x', 'from another device');
  assert.equal(slotOf(page, 'bruh').querySelector('.key__time').textContent, '0.5s');
  page.click(page.key('bruh'));
  await wait(10);
  assert.deepEqual({ ...page.startOptions.tune }, { speed: 2 });
  page.close();
});

test('a sound with no changes plays normally and keeps its waveform', async () => {
  const page = openPage({ session: alice, beta: BETA_ALICE, save: { version: 1, favorites: [] } });
  await wait(60);
  assert.equal(slotOf(page, 'bruh').dataset.badges || '0', '0');
  page.click(page.key('bruh'));
  await wait(10);
  assert.equal(page.startOptions.tune, null);
  page.close();
});

test('Reset to normal removes the cards and the saved settings', async () => {
  const page = openPage({ session: alice, beta: BETA_ALICE, save: { version: 1, favorites: [], tunes: { bruh: { speed: 2, pitch: 0.5 } } } });
  await wait(60);
  await openTuneMenu(page, 'bruh');
  assert.equal(tunePart(page, 'speed-value').textContent, '2x');
  assert.equal(tunePart(page, 'separate').checked, true);
  assert.equal(tunePart(page, 'pitch-value').textContent, '50%');

  page.click(tunePart(page, 'reset'));
  assert.equal(tunePart(page, 'speed-value').textContent, '1x');
  assert.equal(tunePart(page, 'separate').checked, false);
  assert.equal(tunePart(page, 'pitch-row').hidden, true);
  assert.equal(slotOf(page, 'bruh').dataset.badges, '0');
  assert.equal(slotOf(page, 'bruh').querySelector('.key__time').textContent, '1.0s');
  await wait(DEBOUNCE);
  assert.deepEqual(page.save, { version: 1, favorites: [] });
  page.close();
});

test('Preview plays what the sliders say, on its own voice, without saving', async () => {
  const page = openPage({ session: alice, beta: BETA_ALICE, save: { version: 1, favorites: [] } });
  await wait(30);
  await openTuneMenu(page, 'bruh');
  const speed = tunePart(page, 'speed');
  speed.value = SPEED_125;
  speed.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  page.click(tunePart(page, 'preview'));
  await wait(10);
  assert.deepEqual({ ...page.startOptions.tune }, { speed: 1.25 });
  assert.equal(page.startOptions.id, 'tune-preview');
  assert.equal(slotOf(page, 'bruh').dataset.badges || '0', '0', 'nothing changed yet');
  page.close();
});

test('settings stop applying for someone who has left the beta', async () => {
  const page = openPage({ session: bob, beta: BETA_ALICE, save: { version: 1, favorites: [], tunes: { bruh: { speed: 2 } } } });
  await wait(60);
  assert.equal(slotOf(page, 'bruh').dataset.badges || '0', '0');
  page.click(page.key('bruh'));
  await wait(10);
  assert.equal(page.startOptions.tune, null);
  page.close();
});

test('strings do not get a speed and pitch option', async () => {
  const string = { id: 's1', name: 'Mix', clips: [{ sound: 'bruh', at: 0, from: 0, length: 1, lane: 0 }] };
  const page = openPage({ session: alice, beta: BETA_ALICE, save: { version: 1, favorites: [], strings: [string] } });
  await wait(30);
  page.click(page.chip('strings'));
  await wait(20);
  rightClick(page, stringKeys(page)[0]);
  assert.deepEqual(menuLabels(page), ['Edit string']);
  page.close();
});
