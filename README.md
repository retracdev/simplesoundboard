# Simple Soundboard

Fun sound effects without the bloat. 🔊 Part of the [retrac.space](https://retrac.space) collection.

Press a key and it sinks, then slowly rises back up over the exact length of the sound.

The site is plain HTML, CSS and JavaScript, with no build step and no dependencies. Fonts are stored in the repo. The only outside requests go to retrac.space accounts and its cloud-save API, to greet signed-in visitors and keep their favorites. Sounds work without an account.

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

## Favorites

Signed-in visitors can favorite sounds. Favorites are stored in their retrac.space cloud save (app `soundboard`, slot `0`) as `{"version":1,"favorites":["sound-id"]}`, using stable sound ids.

- Authentication is the same as BasketSmash: a short-lived token from `accounts.retrac.space`, kept in memory and sent as a Bearer token. The site holds no secrets or API keys.
- The site's origin must be in `ALLOWED_ORIGINS` for `space-api` and in the `GAME_AUTH_ORIGINS` environment variable for `space-accounts`.
- Each save reads the latest cloud save, applies the visitor's changes and writes the result. The API has no conditional writes, so two devices saving at the same instant can still conflict.

## Tests

```sh
npm install
npm test
```

## Project layout

| Path | What it does |
| --- | --- |
| `index.html` | Page structure |
| `css/style.css` | All styling, including the 3D keys |
| `js/sounds.js` | The sound catalog and categories |
| `js/engine.js` | Web Audio: decoding, starting and stopping sounds |
| `js/account.js` | The shared retrac.space session check and token request |
| `js/favorites.js` | Syncs favorites with the cloud save |
| `js/sign-in.js` | The sign-in dialog |
| `js/account-welcome.js` | Greets signed-in retrac.space accounts |
| `tests/` | Automated tests, which aren't part of the running site |
| `js/app.js` | Builds the board, animates the keys, handles search and categories |
| `sounds/` | The audio files |
| `assets/` | Logo, favicon and fonts (licensed under the SIL OFL, see `assets/fonts/OFL.txt`) |
