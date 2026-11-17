/* Presence: one visitor per browser session, kept alive in background tabs too.
 * The API expires visitors 90 seconds after their last heartbeat.
 */
(() => {
  'use strict';

  const indicator = document.getElementById('presence');
  const label = document.getElementById('presenceLabel');
  if (!indicator || !label) return;

  const API = 'https://space-api.retrac-space.workers.dev/v1/presence';
  const SITE = 'soundboard';
  const TAB_PREFIX = 'soundboard-presence-tab:';
  const tabKey = TAB_PREFIX + crypto.randomUUID();
  const TAB_TTL = 90000;
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

  // Each tab owns its own lease, so simultaneous updates cannot erase peers.
  // Expiry handles crashed tabs; pagehide removes a departing tab immediately.
  function publishTab() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (!key.startsWith(TAB_PREFIX)) continue;
        try {
          const tab = JSON.parse(localStorage.getItem(key));
          if (!tab || !(tab.updated > Date.now() - TAB_TTL)) localStorage.removeItem(key);
        } catch (error) { localStorage.removeItem(key); }
      }
      if (suspended) localStorage.removeItem(tabKey);
      else localStorage.setItem(tabKey, JSON.stringify({
        visible: document.visibilityState === 'visible', updated: Date.now(),
      }));
    } catch (error) { /* Storage may be blocked; use this tab's visibility. */ }
  }

  function presenceStatus() {
    if (document.visibilityState === 'visible') return 'online';
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key.startsWith(TAB_PREFIX)) continue;
        const tab = JSON.parse(localStorage.getItem(key));
        if (tab && tab.visible && tab.updated > Date.now() - TAB_TTL) return 'online';
      }
    } catch (error) { /* Fall through to idle if storage is unavailable. */ }
    return 'idle';
  }

  const idleIndicator = document.getElementById('presenceIdle');
  const idleLabel = document.getElementById('presenceIdleLabel');
  let request = null;
  let refreshAgain = false;
  let suspended = false;
  indicator.hidden = false;

  function show(state, text) {
    indicator.dataset.state = state;
    label.textContent = text;
    if (state !== 'online' && idleIndicator) idleIndicator.hidden = true;
  }

  async function refresh() {
    publishTab();
    if (!accountReady || suspended || request) return;
    if (!navigator.onLine) {
      show('unavailable', 'Online visitors unavailable');
      return;
    }

    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    const options = { cache: 'no-store', credentials: 'omit', signal: controller.signal };
    try {
      // Register this browser session before reading, so the first list includes it.
      const sendHeartbeat = async () => {
        // Recheck inside the cross-tab lock: a visibility change while another
        // request was in flight must not allow an older idle write to win.
        if (controller.signal.aborted || suspended) throw new Error('Presence paused');
        syncIdentity();
        publishTab();
        const heartbeat = await fetch(API + '/heartbeat/' + SITE, {
          ...options,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Display names are unverified. Never send account tokens.
          body: JSON.stringify({ visitorId, ...(username ? { username } : {}), status: presenceStatus() }),
        });
        if (!heartbeat.ok) throw new Error('Presence heartbeat failed');
        return heartbeat.json();
      };
      const identity = navigator.locks
        ? await navigator.locks.request('soundboard-presence-heartbeat', { signal: controller.signal }, sendHeartbeat)
        : await sendHeartbeat();
      // The heartbeat identifies this session's anonymous animal as well as
      // named visitors. Match with the same normalization used for grouping.
      const ownName = (username || (identity && identity.displayName) || '').trim().toLowerCase();
      if (request !== controller) return;
      const response = await fetch(API + '/online/' + SITE, options);
      if (!response.ok) throw new Error('Presence read failed');
      const body = await response.json();
      if (!body || !Number.isSafeInteger(body.count) || body.count < 0
        || !Array.isArray(body.users) || body.users.length !== body.count
        || body.users.some((user) => !user || typeof user.displayName !== 'string' || !user.displayName.trim()
          || (user.status !== undefined && user.status !== 'online' && user.status !== 'idle'))) {
        throw new Error('Invalid presence visitors');
      }
      if (request === controller) {
        // Rebuild from all live sessions: a name stays online while any of its
        // computers is online, otherwise it is idle. Never merge guests
        // just because the API assigned them the same anonymous animal name.
        const usernames = new Map();
        const visitors = [];
        body.users.forEach((user) => {
          const name = user.displayName.trim();
          const status = user.status || 'online';
          if (!name.startsWith('Anonymous ')) {
            const key = name.toLowerCase();
            const existing = usernames.get(key);
            if (existing) {
              if (status === 'online') existing.status = 'online';
              return;
            }
            const visitor = { name, status };
            usernames.set(key, visitor);
            visitors.push(visitor);
          } else visitors.push({ name, status });
        });
        let markedSelf = false;
        const names = { online: [], idle: [] };
        visitors.forEach(({ name, status }) => {
          const isSelf = !markedSelf && name.toLowerCase() === ownName;
          if (isSelf) markedSelf = true;
          names[status].push(name + (isSelf ? ' (you)' : ''));
        });
        // Names are user-controlled: render only as text, never as HTML.
        show('online', names.online.length
          ? 'Online now (' + names.online.length.toLocaleString() + '): ' + names.online.join(', ')
          : 'No one online right now');
        if (idleIndicator && idleLabel) {
          idleIndicator.hidden = false;
          idleLabel.textContent = names.idle.length
            ? 'Idle (' + names.idle.length.toLocaleString() + '): ' + names.idle.join(', ')
            : 'No one idle right now';
        }
      }
    } catch (error) {
      if (request === controller) show('unavailable', 'Online visitors unavailable');
    } finally {
      clearTimeout(timeout);
      if (request === controller) {
        request = null;
        if (refreshAgain) {
          refreshAgain = false;
          refresh();
        }
      }
    }
  }

  function pause() {
    refreshAgain = false;
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
    publishTab();
    if (request) refreshAgain = true;
    else refresh();
  });
  window.addEventListener('offline', () => {
    pause();
    show('unavailable', 'Online visitors unavailable');
  });
  window.addEventListener('online', refresh);
  window.addEventListener('pagehide', () => {
    suspended = true;
    publishTab();
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
