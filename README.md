<div align="center">
  <img
    width="150"
    height="150"
    alt="simple-soundboard-logo"
    src="https://github.com/user-attachments/assets/c0148050-f61c-4aa1-bf35-df09eeded5d1"
  />
</div>

# Simple Soundboard

Fun sound effects without the bloat. 🔊 Part of the [retrac.space](https://retrac.space) collection.

If you are looking to get to the Simple Soundboard, press [here](https://soundboard.retrac.space) or go to [https://soundboard.retrac.space](https://soundboard.retrac.space).

Press a key and it sinks, then slowly rises back up over the exact length of the sound.

## "What's the catch? Is there a subscription or ads?"
Nope! None of that. I build Simple Soundboard as an easy and fun way to play sound effects.
The site is completely free with no advertisements or intrusive popups.
Some features like **Favorites** and **Strings** do require a **retrac.space account**, but the account is free, and is used to Cloud Save your data across devices.

## Open Source
This project is open source and licensed under the MIT license. You're welcome to use, modify, and distribute the code for your own projects, provided you retain the original copyright and license notices.

If you want to add a feature or change something on the site, go ahead! You can create a branch and make a PR when you are ready. However, there is no guarantee we approve the PR.

## Want a Sound That's Missing?
There are 2 ways to get a sound effect you want on Simple Soundboard:
### 1. Submit it directly on the website. (Easiest, requires a retrac.space account)
There is "Request a Sound Effect" button at the top of the page. You can press that to open a form where you can put in the details to your sound effect. If your sound effect is approved, it will usually be added to the site within a few days.
### 2. Submit it in a PR.
If you understand the codebase (or know how to use an AI Development Tool like [Claude Code](https://claude.com/claude-code), you can create a branch, add the sound effect, and then create a PR.

## Publishing Updates
Simple Soundboard updates itself in open tabs without a page refresh.

1. Change the site.
2. Raise the version in `version.yml` (for example to `1.2.0`). You can do this right on github.com. The "Sync version" workflow copies it into `index.html` for you.
3. Deploy to GitHub Pages (merge to `main`).

Every open tab reads `version.yml` every 30 seconds. When it finds a newer version, it downloads the new `index.html` and every script and stylesheet the page loads, and checks that they're all there and that the page really is that version. Then it plays the loading screen again, shuts the old app down, swaps in the new HTML, CSS and JavaScript, and starts the app as if it were a fresh visit. A green toast confirms the update. The address, your sign-in and your saved settings stay as they were.

The **Check for Updates** button at the bottom of the page does the same restart on demand, even when the version hasn't changed. It never installs an older version than the one you're running.

If an update can't be downloaded completely, which can happen while GitHub Pages is still deploying, the running app carries on and tabs try again later, waiting longer each time (up to 10 minutes). If a new version fails to start, the previous one is started again.

Limitations:
- Automatic updates wait while the tab is hidden, the app is loading, or a dialog is open, so nobody loses a half-filled form.
- An update restarts the app, so sounds that are playing fade out, and unsaved typing (like a search) is cleared, just like a reload.
- `js/live-update.js` is never replaced by a live update. Changes to it reach visitors on their next real page load.
- Images, fonts and sounds that change while keeping the same file name may stay cached until a real reload. Give changed files a new name.
- Scripts are run again in the same page, so every file in `js/` must stay wrapped in a function with no top-level `let`, `const` or `class`.

## retrac.space Accounts
[retrac.space](retrac.space) are required to use some features on the soundboard. This requirement is in place so your data can cloud sync across your devices, free of charge.
You can create an account [here](https://accounts.retrac.space), and you'll be automatically logged in on Simple Soundboard and other retrac.space projects.
