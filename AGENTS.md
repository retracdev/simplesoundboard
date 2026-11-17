# Repository instructions

When adding a new sound effect, append it to the END of its category in `js/sounds.js`, after all existing effects in that category. Preserve the order of existing effects.

After adding, renaming or removing a sound effect, run `npm run build:social`. It regenerates the shared sound pages (`sound/<id>.html`, `404.html`, `leaderboard.html`) and the social card images in `assets/social/`. Never edit those generated files by hand; change `scripts/templates/` or the scripts in `scripts/` instead. Rendering cards needs Chrome or Edge installed. The "Share pages and social cards" GitHub workflow also regenerates them on `main` if this step is skipped.

The app's markup lives in `index-data.html`. `index.html` is a small kernel that runs it in a frame so the footer's "Check for Updates" button can restart the app with fresh files without reloading the tab. Edit `index-data.html` for page changes, and keep `index.html` minimal: it only updates on a real reload.
