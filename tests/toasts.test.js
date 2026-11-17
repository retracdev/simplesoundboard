const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'js/toasts.js'), 'utf8');

function open(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  Object.assign(window, { setTimeout, clearTimeout, setInterval, clearInterval, Date });
  window.matchMedia = () => ({ matches: true }); // Reduced motion: remove immediately.
  window.eval(source);
  const pills = () => [...window.document.querySelectorAll('.toast')].map((node) => node.textContent);
  return { window, toasts: window.SoundboardToasts, pills };
}

test('a keyed countdown updates one toast in place and closes when it ends', (t) => {
  const { window, toasts, pills } = open(t);
  toasts.show({ key: 'cooldown', icon: 'warning', text: 'Leaderboard cooldown', until: Date.now() + 2000 });
  assert.deepEqual(pills(), ['Leaderboard cooldown2s']);
  assert.ok(window.document.querySelector('.toast__icon--warning svg'));
  t.mock.timers.tick(1000);
  assert.deepEqual(pills(), ['Leaderboard cooldown1s']);
  toasts.show({ key: 'cooldown', icon: 'warning', text: 'Leaderboard cooldown', until: Date.now() + 5000 });
  assert.deepEqual(pills(), ['Leaderboard cooldown5s']);
  t.mock.timers.tick(5000);
  assert.deepEqual(pills(), []);
});

test('plain toasts stack, render names as text and expire after 4.5 seconds', (t) => {
  const { window, toasts, pills } = open(t);
  toasts.show({ name: '<b>Ada</b>', icon: 'online', text: ' is now online!' });
  t.mock.timers.tick(1000);
  toasts.show({ name: 'Bo', icon: 'offline', text: ' is now offline.' });
  assert.deepEqual(pills(), ['<b>Ada</b> is now online!', 'Bo is now offline.']);
  assert.equal(window.document.querySelector('.toast b'), null);
  t.mock.timers.tick(3500);
  assert.deepEqual(pills(), ['Bo is now offline.']);
  t.mock.timers.tick(1000);
  assert.deepEqual(pills(), []);
});
