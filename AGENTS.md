# Repository instructions

When adding a new sound effect, append it to the END of its category in `js/sounds.js`, after all existing effects in that category. Preserve the order of existing effects.

Do NOT edit the README unless the user asks to.

After adding, renaming or removing a sound effect, run `npm run build:social`. It regenerates the shared sound pages (`sound/<id>.html`, `404.html`, `leaderboard.html`) and the social card images in `assets/social/`. Never edit those generated files by hand; change `scripts/templates/` or the scripts in `scripts/` instead. Rendering cards needs Chrome or Edge installed. The "Share pages and social cards" GitHub workflow also regenerates them on `main` if this step is skipped.

The app's markup lives in `index.html`. Open tabs update themselves in place, without reloading, through `js/live-update.js`:

- When you ship a change to the site, raise the version in `version.yml`. The "Sync version" workflow copies it into `<meta name="soundboard-version">` in `index.html` on `main` (locally, `npm run set-version` does the same). Live updates only install a page whose meta matches `version.yml`.
- Keep every file in `js/` wrapped in a function, and share things between files through `window` properties. Don't add top-level `let`, `const` or `class`, because updates run each script again in the same page.
- Anything that must be put away when the app is replaced (audio, unsent work) registers `window.SoundboardLiveUpdate.onDispose(fn)`. Listeners on `window`/`document`, timers, observers, fetches and Web Locks are cleaned up automatically.
- `js/live-update.js` itself is never replaced by a live update. Changes to it reach visitors on their next real page load.
