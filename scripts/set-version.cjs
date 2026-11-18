#!/usr/bin/env node
/*
 * Sets the published version of Simple Soundboard in both places it lives:
 *   version.yml                                 what open tabs check every 30 seconds
 *   <meta name="soundboard-version"> in index.html  what the downloaded page says it is
 * Live updates only install a page whose meta matches version.yml, so change them together.
 *
 * Usage: npm run set-version -- 1.2.0
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const version = String(process.argv[2] || '').trim().replace(/^v/, '');
if (!/^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: npm run set-version -- <version>   (for example 1.2.0)');
  process.exit(1);
}

function update(file, pattern, replacement) {
  const full = path.join(ROOT, file);
  const source = fs.readFileSync(full, 'utf8');
  if (!pattern.test(source)) {
    console.error(`Couldn't find the version in ${file}.`);
    process.exit(1);
  }
  fs.writeFileSync(full, source.replace(pattern, replacement));
}

update('version.yml', /^version:.*$/m, `version: "${version}"`);
update('index.html', /(<meta name="soundboard-version" content=")[^"]*(")/, `$1${version}$2`);
console.log(`Simple Soundboard is now version ${version}. Deploy it, and open tabs update within about 30 seconds.`);
