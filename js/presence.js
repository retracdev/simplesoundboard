/* Anonymous presence: one visitor per tab, refreshed only while visible.
 * The API expires visitors 90 seconds after their last heartbeat.
 */
(() => {
  'use strict';

  const indicator = document.getElementById('presence');
  const label = document.getElementById('presenceLabel');
  if (!indicator || !label) return;

  const API = 'https://space-api.retrac-space.workers.dev/v1/presence';
  const SITE = 'soundboard';
  const VISITOR_KEY = 'simple-soundboard-presence-visitor';
  let visitorId;
  try {
    visitorId = sessionStorage.getItem(VISITOR_KEY);
  } catch (error) {
    // Storage can be disabled. An in-memory ID still lasts for this page.
  }
  if (!visitorId) {
    visitorId = crypto.randomUUID();
    try {
      sessionStorage.setItem(VISITOR_KEY, visitorId);
    } catch (error) {
      // Presence doesn't require persistent storage.
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
    if (suspended || document.visibilityState !== 'visible' || request) return;
    if (!navigator.onLine) {
      show('unavailable', 'Online count unavailable');
      return;
    }

    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    const options = { cache: 'no-store', credentials: 'omit', signal: controller.signal };
    try {
      // Register this tab before reading, so the first count includes it.
      const heartbeat = await fetch(API + '/heartbeat/' + SITE, {
        ...options,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId }),
      });
      if (!heartbeat.ok) throw new Error('Presence heartbeat failed');
      if (request !== controller) return;
      const response = await fetch(API + '/online/' + SITE, options);
      if (!response.ok) throw new Error('Presence read failed');
      const body = await response.json();
      if (!body || !Number.isSafeInteger(body.count) || body.count < 0) {
        throw new Error('Invalid presence count');
      }
      if (request === controller) show('online', body.count.toLocaleString() + ' online');
    } catch (error) {
      if (request === controller) show('unavailable', 'Online count unavailable');
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
    show('unavailable', 'Online count unavailable');
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
  refresh();
})();
