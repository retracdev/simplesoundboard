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

## Online visitors
The home page lists online visitors by name below the changelog button, using `https://space-api.retrac-space.workers.dev/v1/presence` with the site name `soundboard`. Signed-in visitors send their retrac.space username as a display name; guests get an anonymous animal name from the API. Display names are unverified by the presence API, and no account tokens are sent. Names wrap on narrow screens and are rendered as plain text.

The displayed list and count group matching usernames across computers (ignoring casing and surrounding whitespace). Each refresh rebuilds the list from the API's live sessions, so a username remains online until its last session expires. This grouping affects the home page; the API still counts individual sessions. The API only supplies display names, so entries beginning with `Anonymous ` are treated as guests and counted separately, even when their animal names match. Assigning unused animal names requires a change to the API's animal-name allocator.

A temporary session cookie shares one visitor ID across soundboard tabs, so extra tabs do not inflate the list. The cookie has no expiry date or Max-Age and uses SameSite=Lax and Secure on HTTPS. If cookies are blocked, presence falls back to an in-memory ID per page. Visible tabs send a heartbeat and refresh the list every 30 seconds; a visitor expires within 90 seconds after their last visible tab stops heartbeats. Signing out or switching accounts creates a fresh visitor ID because the API retains the previous display name; that old entry expires within 90 seconds.

If the presence service is unavailable, the indicator shows "Online visitors unavailable" and retries on the next interval or when the connection returns.

## Sound Leaderboard
The **Leaderboard** tab at the top ranks every sound by how many times it has been played, by everyone. The top three get a podium and trophies, and every sound after that is listed below. A sound joins the board on its second play.

Every play counts, including sounds inside a string, Play All, Play Everything, and every repeat of a looping sound. Counts are stored with the retrac.space counters API (`https://space-api.retrac-space.workers.dev/v1/counters`), one counter per sound named `simple-soundboard-plays-<sound id>`. Plays are saved in the browser until they're sent, so none are lost if the tab closes.

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

## retrac.space Accounts
[retrac.space](retrac.space) are required to use some features on the soundboard. This requirement is in place so your data can cloud sync across your devices, free of charge.
You can create an account [here](https://accounts.retrac.space), and you'll be automatically logged in on Simple Soundboard and other retrac.space projects.
