# Simple Soundboard

Fun sound effects without the bloat. 🔊 Part of the [Retrac.Space](https://retrac.space) collection.

Press a key and it sinks, then slowly rises back up over the exact length of the sound.

The site is plain HTML, CSS and JavaScript, with no build step and no dependencies. Fonts are stored in the repo. The only third-party requests are the press counts, which use the free [Abacus](https://abacus.jasoncameron.dev) counting API.

## Running it locally

Sounds are loaded with `fetch`, which browsers block on `file://` pages. Double-clicking `index.html` shows the page but no sounds will load, so serve the folder instead:

```sh
npx serve .
```

## Deploying to GitHub Pages

In the repo, go to **Settings → Pages → Build and deployment**, set **Source** to *Deploy from a branch*, then choose `main` and `/ (root)`.

All paths are relative, so the site works at `retracdev.github.io/simplesoundboard/` or on a custom domain. For a custom domain, add it on the same settings page.

## Adding sounds

Put the file in `sounds/` and add an entry to [`js/sounds.js`](js/sounds.js):

```js
{ id: 'bruh', name: 'Bruh', category: 'internet', tags: 'meme reaction seriously',
  src: 'sounds/bruh.mp3' },
```

Nothing else needs changing: the waveform, the duration label and the pop-up timing all come from the audio itself.

- Keep each `id` stable, because future features such as favorites will key off it.
- To add a category, add a row to `categories` in the same file. Its panel and filter chip appear automatically.

## Press counts

Each sound has its own public counter at `/hit/retrac.space/simple-soundboard.<id>`, which goes up on every press. Counters are created on the first press, so a new sound needs no setup.

- Changing a sound's `id` starts its count again from zero.
- Abacus deletes a counter after 6 months without any reads or presses.
- Counters created this way have no admin key, so they can't be reset or edited. Anyone can also increase them by calling the URL directly.

If Abacus is down, sounds still work and the counts just don't appear.

## Project layout

| Path | What it does |
| --- | --- |
| `index.html` | Page structure |
| `css/style.css` | All styling, including the 3D keys |
| `js/sounds.js` | The sound catalog and categories |
| `js/engine.js` | Web Audio: decoding, starting and stopping sounds |
| `js/counter.js` | Press counts, paced to stay within the Abacus rate limit |
| `js/app.js` | Builds the board, animates the keys, handles search and categories |
| `sounds/` | The audio files |
| `assets/` | Logo, favicon and fonts (licensed under the SIL OFL, see `assets/fonts/OFL.txt`) |
