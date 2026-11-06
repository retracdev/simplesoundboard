// Usage: node render.cjs preview t1,t2,... | node render.cjs video out.mp4
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const ffmpeg = require('ffmpeg-static');

const REPO = 'C:/Users/Belcaro Welch/Desktop/Code/simplesoundboard';
const FPS = 60;
const LOOP = 10;
const MIME = { '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.html': 'text/html' };

(async () => {
  const [mode, arg] = process.argv.slice(2);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.route('http://scene.local/**', (route) => {
    const url = new URL(route.request().url()).pathname;
    const file = url === '/scene.html' ? path.join(__dirname, 'scene.html') : path.join(REPO, url);
    route.fulfill({ body: fs.readFileSync(file), contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://scene.local/scene.html');
  const keys = await page.evaluate(() => window.prepare());
  console.log(keys.map((k) => `${k.name} ${k.duration.toFixed(2)}s, up by ${k.lastEnd.toFixed(2)}`).join('\n'));

  const shot = async (t) => {
    await page.evaluate((time) => window.renderFrame(time), t);
    return page.screenshot({ type: 'png' });
  };

  if (mode === 'preview') {
    fs.mkdirSync(path.join(__dirname, 'frames'), { recursive: true });
    for (const t of arg.split(',').map(Number)) {
      fs.writeFileSync(path.join(__dirname, 'frames', `t${t.toFixed(3)}.png`), await shot(t));
    }
  } else {
    const encoder = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
      '-c:v', 'libx264rgb', '-preset', 'ultrafast', '-crf', '0', '-an', arg], { stdio: ['pipe', 'inherit', 'inherit'] });
    const closed = new Promise((res) => encoder.on('close', res));
    const frames = FPS * LOOP;
    const started = Date.now();
    for (let f = 0; f < frames; f++) {
      const png = await shot(f / FPS);
      if (!encoder.stdin.write(png)) await new Promise((res) => encoder.stdin.once('drain', res));
      if (f % 120 === 0) console.log(`frame ${f}/${frames} ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
    encoder.stdin.end();
    console.log('encoder exit', await closed);
  }
  if (errors.length) console.log('PAGE ERRORS:', errors);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
