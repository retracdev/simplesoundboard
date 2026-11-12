/* Presence: one visitor per browser session, refreshed only while visible.
 * The API expires visitors 90 seconds after their last heartbeat.
 */
(() => {
  'use strict';

  const indicator = document.getElementById('presence');
  const label = document.getElementById('presenceLabel');
  if (!indicator || !label) return;

  const API = 'https://space-api.retrac-space.workers.dev/v1/presence';
  const SITE = 'soundboard';
  const COOKIE_KEY = 'soundboard-presence';
  let visitorId = crypto.randomUUID();
  let username = null;
  let accountReady = !window.RetracAccount;

  function readIdentity() {
    try {
      const cookie = document.cookie.split('; ').find((entry) => entry.startsWith(COOKIE_KEY + '='));
      const identity = cookie && JSON.parse(decodeURIComponent(cookie.slice(COOKIE_KEY.length + 1)));
      return identity && typeof identity.visitorId === 'string' && identity.visitorId
        && (identity.username === null || typeof identity.username === 'string') ? identity : null;
    } catch (error) {
      return null;
    }
  }

  // Read again before every heartbeat so newly opened tabs and account changes
  // share one identity. No Expires or Max-Age: this is a session cookie.
  function syncIdentity() {
    const shared = readIdentity();
    if (shared) {
      visitorId = shared.username && shared.username !== username ? crypto.randomUUID() : shared.visitorId;
    }
    try {
      const value = encodeURIComponent(JSON.stringify({ visitorId, username }));
      document.cookie = COOKIE_KEY + '=' + value + '; Path=/; SameSite=Lax'
        + (location.protocol === 'https:' ? '; Secure' : '');
    } catch (error) {
      // Blocked cookies fall back to this page's in-memory visitor ID.
    }
  }

  let request = null;
  let suspended = false;
  indicator.hidden = false;

  function show(state, text) {
    indicator.dataset.state = state;
    label.textContent = text;
  }

  async function refresh() {
    if (!accountReady || suspended || document.visibilityState !== 'visible' || request) return;
    if (!navigator.onLine) {
      show('unavailable', 'Online visitors unavailable');
      return;
    }

    syncIdentity();
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    const options = { cache: 'no-store', credentials: 'omit', signal: controller.signal };
    try {
      // Register this browser session before reading, so the first list includes it.
      const heartbeat = await fetch(API + '/heartbeat/' + SITE, {
        ...options,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Display names are unverified by the presence API. Never send account tokens.
        body: JSON.stringify(username ? { visitorId, username } : { visitorId }),
      });
      if (!heartbeat.ok) throw new Error('Presence heartbeat failed');
      const identity = await heartbeat.json();
      // The heartbeat identifies this session's anonymous animal as well as
      // named visitors. Match with the same normalization used for grouping.
      const ownName = (username || (identity && identity.displayName) || '').trim().toLowerCase();
      if (request !== controller) return;
      const response = await fetch(API + '/online/' + SITE, options);
      if (!response.ok) throw new Error('Presence read failed');
      const body = await response.json();
      if (!body || !Number.isSafeInteger(body.count) || body.count < 0
        || !Array.isArray(body.users) || body.users.length !== body.count
        || body.users.some((user) => !user || typeof user.displayName !== 'string' || !user.displayName.trim())) {
        throw new Error('Invalid presence visitors');
      }
      if (request === controller) {
        // Rebuild from all live sessions each time: a name stays online while
        // any of its computers is still sending heartbeats. Never merge guests
        // just because the API assigned them the same anonymous animal name.
        const usernames = new Set();
        const names = [];
        let markedSelf = false;
        body.users.forEach((user) => {
          const name = user.displayName.trim();
          if (!name.startsWith('Anonymous ')) {
            const key = name.toLowerCase();
            if (usernames.has(key)) return;
            usernames.add(key);
          }
          // Decorate only after grouping so several computers using our account
          // still produce one name, one marker, and one entry in the count.
          const isSelf = !markedSelf && name.toLowerCase() === ownName;
          if (isSelf) markedSelf = true;
          names.push(name + (isSelf ? ' (you)' : ''));
        });
        // Names are user-controlled: render them only as text, never as HTML.
        show('online', names.length
          ? 'Online now (' + names.length.toLocaleString() + '): ' + names.join(', ')
          : 'No one online right now');
      }
    } catch (error) {
      if (request === controller) show('unavailable', 'Online visitors unavailable');
    } finally {
      clearTimeout(timeout);
      if (request === controller) request = null;
    }
  }

  function pause() {
    const previous = request;
    request = null;
    if (previous) previous.abort();
  }

  function resume() {
    show('checking', "Checking who's online…");
    refresh();
  }

  setInterval(refresh, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
    else pause();
  });
  window.addEventListener('offline', () => {
    pause();
    show('unavailable', 'Online visitors unavailable');
  });
  window.addEventListener('online', refresh);
  window.addEventListener('pagehide', () => {
    suspended = true;
    pause();
  });
  window.addEventListener('pageshow', () => {
    suspended = false;
    resume();
  });
  function accountChanged(state) {
    if (state.status === 'unknown') return;
    const next = state.status === 'authenticated' ? state.username : null;
    // Omitting username doesn't clear it on the server. Give a signed-out tab a
    // fresh anonymous identity; the old name expires after the API's 90 seconds.
    if (username && username !== next && !readIdentity()) visitorId = crypto.randomUUID();
    username = next;
    accountReady = true;
    pause();
    resume();
  }

  if (window.RetracAccount) {
    window.RetracAccount.subscribe(accountChanged);
    accountChanged(window.RetracAccount.getState());
  } else {
    refresh();
  }
})();
