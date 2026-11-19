// Renders a changelog card to PNG with a local Chrome.
// Usage: node marketing/source/render-changelog.cjs changelog-1.2.html assets/changelog-1.2.png
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const REPO = path.resolve(__dirname, '../..');
const MIME = { '.woff2': 'font/woff2', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml' };

(async () => {
  const [source = 'changelog-1.2.html', out = 'assets/changelog-1.2.png'] = process.argv.slice(2);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfailed', (r) => errors.push('failed: ' + r.url()));

  await page.route('http://card.local/**', (route) => {
    const url = new URL(route.request().url()).pathname;
    const file = url === '/card.html' ? path.join(__dirname, source) : path.join(REPO, url);
    route.fulfill({ body: fs.readFileSync(file), contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://card.local/card.html');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(REPO, out), type: 'png' });
  if (errors.length) console.log('PAGE ERRORS:', errors);
  console.log('wrote', out);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
