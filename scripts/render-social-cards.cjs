/*
 * Renders the 1200x630 social card images that link previews show:
 *
 *   assets/social/home.jpg           the home page
 *   assets/social/leaderboard.jpg    /leaderboard
 *   assets/social/sounds/<id>.jpg    /sound/<id>, with that sound's real waveform
 *
 * Uses a locally installed Chrome (or Edge) through playwright-core. Cards whose inputs haven't
 * changed are skipped, using the hashes in assets/social/manifest.json; pass --all to redo every
 * card. Cards for sounds that no longer exist are removed.
 *
 *   npm run build:cards
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets/social');
const MANIFEST = path.join(OUT, 'manifest.json');
const TEMPLATE = path.join(__dirname, 'templates/social-card.html');
const HOST = 'http://cards.local';
const MIME = {
  '.html': 'text/html', '.woff2': 'font/woff2', '.png': 'image/png', '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};

function loadCatalog() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/sounds.js'), 'utf8'), sandbox);
  return sandbox.window.SOUND_CATALOG;
}

function hash(...parts) {
  const h = crypto.createHash('sha1');
  parts.forEach((part) => h.update(part));
  return h.digest('hex');
}

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (error) {
      // Try the next browser.
    }
  }
  return chromium.launch({ headless: true }); // A Playwright-installed Chromium, if any.
}

(async () => {
  const all = process.argv.includes('--all');
  const { categories, sounds } = loadCatalog();
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const template = fs.readFileSync(TEMPLATE);
  const base = hash(template, fs.readFileSync(__filename));

  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch (error) {
    // Render everything.
  }

  const jobs = [
    { file: 'home.jpg', card: { kind: 'home', words: sounds.slice(0, 24).map((sound) => sound.name) } },
    { file: 'leaderboard.jpg', card: { kind: 'leaderboard' } },
    ...sounds.map((sound) => {
      const category = categoryById.get(sound.category);
      return {
        file: 'sounds/' + sound.id + '.jpg',
        audio: path.join(ROOT, sound.src),
        card: {
          kind: 'sound', id: sound.id, name: sound.name, category: category.label,
          color: category.color, side: category.side, src: '/' + sound.src,
        },
      };
    }),
  ];

  jobs.forEach((job) => {
    const audio = job.audio && fs.existsSync(job.audio) ? fs.readFileSync(job.audio) : '';
    job.key = hash(base, JSON.stringify(job.card), audio);
  });

  const todo = jobs.filter((job) => all || manifest[job.file] !== job.key
    || !fs.existsSync(path.join(OUT, job.file)));

  fs.mkdirSync(path.join(OUT, 'sounds'), { recursive: true });
  const next = {};
  jobs.forEach((job) => {
    if (!todo.includes(job)) next[job.file] = job.key;
  });

  if (todo.length) {
    const browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    page.on('pageerror', (error) => console.error('Card error:', error.message));
    await page.route(HOST + '/**', (route) => {
      const url = decodeURIComponent(new URL(route.request().url()).pathname);
      const file = url === '/card.html' ? TEMPLATE : path.join(ROOT, url);
      if (!file.startsWith(ROOT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ body: fs.readFileSync(file), contentType: MIME[path.extname(file)] || 'application/octet-stream' });
    });
    await page.goto(HOST + '/card.html');

    for (const job of todo) {
      await page.evaluate((card) => window.renderCard(card), job.card);
      await page.screenshot({ path: path.join(OUT, job.file), type: 'jpeg', quality: 88 });
      next[job.file] = job.key;
      console.log('Rendered ' + job.file);
    }
    await browser.close();
  }

  // Remove cards for sounds that are gone.
  const wanted = new Set(jobs.map((job) => path.basename(job.file)));
  fs.readdirSync(path.join(OUT, 'sounds')).forEach((file) => {
    if (!wanted.has(file)) fs.unlinkSync(path.join(OUT, 'sounds', file));
  });

  const sorted = {};
  Object.keys(next).sort().forEach((key) => { sorted[key] = next[key]; });
  fs.writeFileSync(MANIFEST, JSON.stringify(sorted, null, 2) + '\n');
  console.log(todo.length ? 'Rendered ' + todo.length + ' card(s).' : 'All cards are up to date.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
