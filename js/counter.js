/*
 * Play counts for the Sound Leaderboard, stored with the retrac.space counters API.
 *
 * There's no bulk read, so each sound is its own counter. Requests go through one queue
 * that keeps a handful in flight at once. Plays go first and reads use what's left over, so
 * Play Everything never waits behind the leaderboard loading.
 *
 * Plays that haven't been sent yet are saved, so closing the tab right after Play Everything
 * doesn't throw them away: the next visit sends them. Each tab keeps its own save with a
 * heartbeat, and only a save whose tab has gone quiet gets picked up, so nothing is sent twice.
 *
 * Counts that have been read are cached, so the leaderboard draws instantly on a return
 * visit and only refreshes what's gone stale.
 *
 * Counting is a bonus: nothing here can delay or block a sound. If the API can't be reached,
 * the leaderboard says so and the board keeps working.
 */
(function () {
  'use strict';

  const API = 'https://space-api.retrac-space.workers.dev/v1/counters';
  // Counter names are shared across every retrac.space site, so these carry the site's prefix.
  // Names allow letters, numbers, hyphens and underscores, which sound ids already stick to.
  // Start fresh rankings; tabs running older code keep writing to the previous counters.
  const NAME_PREFIX = 'simple-soundboard-plays-v2-';

  const MAX_IN_FLIGHT = 12; // Enough to fill the whole board in a moment without a flood.
  const PUMP_MS = 250;
  const RATE_LIMITED_PAUSE_MS = 4000;
  const FAILURE_PAUSE_MS = 15000;
  const STALE_MS = 30 * 1000; // A cached count older than this is read again.

  // Keep cached counts and pending plays from previous rankings out of the fresh counters.
  const CACHE_KEY = 'simple-soundboard:play-counts-v3';
  const PENDING_PREFIX = 'simple-soundboard:unsent-plays-v3:';
  const LIMIT_KEY = 'simple-soundboard:counting-limit-v1';
  const MAX_COUNTED_PLAYS = 30;
  const COUNT_WINDOW_MS = 60000;
  const COOLDOWN_MS = 60000;
  const SOUND_COOLDOWN_MS = 3000;
  const HEARTBEAT_MS = 4000;
  const ORPHAN_AFTER_MS = 15000; // A save this quiet belongs to a closed tab.
  const MOUSE_ACTIVE_MS = 60000;

  // Activity belongs to this tab only. Returning to it requires fresh mouse movement.
  let lastMouseMove = -Infinity;
  let activeSince = Infinity;
  function canCount(completedAt = performance.now()) {
    const now = performance.now();
    return document.visibilityState === 'visible' && document.hasFocus()
      && now - lastMouseMove < MOUSE_ACTIVE_MS && completedAt >= activeSince
      && completedAt <= lastMouseMove + MOUSE_ACTIVE_MS;
  }
  window.addEventListener('mousemove', (event) => {
    if (!event.isTrusted || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const now = performance.now();
    if (!canCount(now)) activeSince = now;
    lastMouseMove = now;
  }, { passive: true });
  function resetActivity() {
    lastMouseMove = -Infinity;
    activeSince = Infinity;
  }
  window.addEventListener('blur', resetActivity);
  document.addEventListener('visibilitychange', resetActivity);

  const tabId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const pendingKey = PENDING_PREFIX + tabId;

  const known = new Map(); // sound id -> { value, at } from the API or the cache
  const unsent = new Map(); // sound id -> plays from this tab not yet confirmed by the API
  const hitQueue = []; // one sound id per play still to send
  const readQueue = [];
  const reading = new Set(); // ids queued or in flight for a read
  const listeners = new Set();

  let pausedUntil = 0;
  let timer = null;
  let inFlight = 0;
  let failures = 0; // reads in a row that couldn't reach the API
  let lastError = false;

  // ---------- Storage ----------

  function storage() {
    try {
      return window.localStorage;
    } catch (error) {
      return null;
    }
  }

  // Shared across reloads and tabs; memory also covers unavailable browser storage.
  let countingLimit = { plays: [], until: 0 };
  let noticeUntil = 0;
  let noticeTimer = null;

  function readLimit() {
    try {
      const saved = JSON.parse(storage()?.getItem(LIMIT_KEY));
      if (saved && Array.isArray(saved.plays) && Number.isFinite(saved.until)) {
        countingLimit = {
          plays: saved.plays.filter((play) => play && typeof play.id === 'string'
            && Number.isFinite(play.at)),
          until: saved.until,
        };
      }
    } catch (error) {
      // Keep the in-memory limit if storage is unavailable or unreadable.
    }
    return countingLimit;
  }

  function showCooldown(until, fullLimit) {
    const notice = document.getElementById('countingCooldown');
    if (!notice) return;
    noticeUntil = Math.max(noticeUntil, until);
    document.getElementById('countingCooldownMessage').textContent = fullLimit
      ? 'You reached 30 counted plays in a minute. Sounds still play; leaderboard counting is paused.'
      : 'This sound counts once every 3 seconds. Keep playing; extra repeats do not count.';
    notice.hidden = false;
    if (noticeTimer !== null) clearInterval(noticeTimer);
    function update() {
      const seconds = Math.ceil((noticeUntil - Date.now()) / 1000);
      if (seconds <= 0) {
        notice.hidden = true;
        clearInterval(noticeTimer);
        noticeTimer = null;
        noticeUntil = 0;
        return;
      }
      document.getElementById('countingCooldownTime').textContent = 'Counting resumes in ' + seconds + 's';
    }
    noticeTimer = setInterval(update, 250);
    update();
  }

  function countPlays(ids, completedAt) {
    if (!canCount(completedAt)) return;
    const now = Date.now();
    const limit = readLimit();
    limit.plays = limit.plays.filter((play) => play.at > now - COUNT_WINDOW_MS);
    if (limit.until > now) {
      showCooldown(limit.until, true);
      return;
    }
    const accepted = [];
    let soundUntil = 0;
    for (const id of ids) {
      if (limit.plays.length >= MAX_COUNTED_PLAYS) break;
      const previous = limit.plays.find((play) => play.id === id && play.at > now - SOUND_COOLDOWN_MS);
      if (previous) {
        soundUntil = Math.max(soundUntil, previous.at + SOUND_COOLDOWN_MS);
        continue;
      }
      limit.plays.push({ id, at: now });
      accepted.push(id);
    }
    if (limit.plays.length >= MAX_COUNTED_PLAYS) limit.until = now + COOLDOWN_MS;
    try {
      storage()?.setItem(LIMIT_KEY, JSON.stringify(limit));
    } catch (error) {
      // The in-memory limit still applies for this visit.
    }
    if (limit.until > now) showCooldown(limit.until, true);
    else if (soundUntil) showCooldown(soundUntil, false);
    // Rejected plays never enter the retry queue or the optimistic counts.
    if (!accepted.length) return;
    accepted.forEach(queueHit);
    savePending();
    emit(accepted);
    start();
  }

  function loadCache() {
    const store = storage();
    if (!store) return;
    try {
      const saved = JSON.parse(store.getItem(CACHE_KEY));
      if (saved && typeof saved === 'object') {
        Object.keys(saved).forEach((id) => {
          const entry = saved[id];
          if (entry && Number.isFinite(entry.v) && Number.isFinite(entry.t)) {
            known.set(id, { value: entry.v, at: entry.t });
          }
        });
      }
    } catch (error) {
      // A broken cache just means reading everything again.
    }
  }

  let cacheTimer = null;
  function saveCacheSoon() {
    if (cacheTimer !== null) return;
    cacheTimer = setTimeout(() => {
      cacheTimer = null;
      const store = storage();
      if (!store) return;
      const out = {};
      known.forEach((entry, id) => {
        out[id] = { v: entry.value, t: entry.at };
      });
      try {
        store.setItem(CACHE_KEY, JSON.stringify(out));
      } catch (error) {
        // Still works for this visit.
      }
    }, 500);
  }

  function savePending() {
    const store = storage();
    if (!store) return;
    try {
      if (!hitQueue.length) {
        store.removeItem(pendingKey);
        return;
      }
      store.setItem(pendingKey, JSON.stringify({ at: Date.now(), hits: hitQueue }));
    } catch (error) {
      // Unsent plays just won't survive this tab closing.
    }
  }

  // Takes over plays left behind by tabs that closed before sending them.
  function adoptOrphans() {
    const store = storage();
    if (!store) return;
    const now = Date.now();
    const orphaned = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key && key.startsWith(PENDING_PREFIX) && key !== pendingKey) orphaned.push(key);
      }
    } catch (error) {
      return;
    }
    orphaned.forEach((key) => {
      try {
        const saved = JSON.parse(store.getItem(key));
        const quiet = !saved || !Number.isFinite(saved.at) || now - saved.at > ORPHAN_AFTER_MS;
        if (!quiet) return; // That tab is still open and sending its own.
        store.removeItem(key);
        if (saved && Array.isArray(saved.hits)) {
          saved.hits.filter((id) => typeof id === 'string')
            .slice(0, Math.max(0, MAX_COUNTED_PLAYS - hitQueue.length)).forEach(queueHit);
        }
      } catch (error) {
        // Skip anything unreadable.
      }
    });
    savePending();
  }

  // ---------- Requests ----------

  function counterName(id) {
    return NAME_PREFIX + id;
  }

  // GET /get/<name> reads a counter, creating it at 0 if it's new. POST /increment/<name> adds
  // one. Both answer { name, count }. Every request needs a real answer, never a cached one.
  function send(action, id) {
    const isHit = action === 'hit';
    return fetch(API + '/' + (isHit ? 'increment' : 'get') + '/' + encodeURIComponent(counterName(id)), {
      method: isHit ? 'POST' : 'GET',
      cache: 'no-store',
      credentials: 'omit',
      keepalive: isHit, // A play sent as the tab closes still gets there.
    });
  }

  async function countFrom(response) {
    const body = await response.json();
    return body && Number.isFinite(body.count) ? body.count : null;
  }

  function emit(ids) {
    listeners.forEach((fn) => {
      try {
        fn(ids);
      } catch (error) {
        console.warn(error);
      }
    });
  }

  function record(id, value) {
    const previous = known.get(id);
    // Answers can arrive out of order, and a count only ever goes up.
    const best = previous && previous.at > Date.now() - STALE_MS ? Math.max(previous.value, value) : value;
    known.set(id, { value: best, at: Date.now() });
    saveCacheSoon();
  }

  function rateLimited() {
    pausedUntil = performance.now() + RATE_LIMITED_PAUSE_MS;
  }

  async function sendHit(id) {
    let response;
    try {
      response = await send('hit', id);
    } catch (error) {
      response = null;
    }
    if (!response || response.status === 429 || response.status >= 500) {
      // Still unsent, so it goes back to the front of the line.
      if (response && response.status === 429) rateLimited();
      else pausedUntil = performance.now() + FAILURE_PAUSE_MS;
      hitQueue.unshift(id);
      savePending();
      schedule();
      return;
    }
    unsent.set(id, Math.max(0, (unsent.get(id) || 1) - 1));
    if (!unsent.get(id)) unsent.delete(id);
    if (response.ok) {
      try {
        // The answer includes this play. Plays of ours still on the way get added on top.
        const value = await countFrom(response);
        if (value !== null) record(id, value);
      } catch (error) {
        // The play counted, the number just didn't come back.
      }
    }
    savePending();
    emit([id]);
  }

  async function sendRead(id) {
    let response;
    try {
      response = await send('get', id);
    } catch (error) {
      response = null;
    }
    if (!response || response.status === 429 || response.status >= 500) {
      if (response && response.status === 429) {
        rateLimited();
      } else {
        failures++;
        pausedUntil = performance.now() + Math.min(FAILURE_PAUSE_MS, 1000 * failures);
      }
      readQueue.unshift(id);
      lastError = failures >= 3;
      schedule();
      emit([]);
      return;
    }
    failures = 0;
    lastError = false;
    reading.delete(id);
    try {
      if (response.status === 404) record(id, 0); // Nobody has played this one yet.
      else if (response.ok) {
        const value = await countFrom(response);
        if (value !== null) record(id, value);
      }
    } catch (error) {
      // Leave it as it was.
    }
    emit([id]);
  }

  // Keeps up to MAX_IN_FLIGHT requests going, and starts the next as soon as one finishes.
  function launch(request, id) {
    inFlight++;
    request(id).finally(() => {
      inFlight--;
      start();
    });
  }

  function pump() {
    timer = null;
    if (performance.now() >= pausedUntil) {
      while (hitQueue.length && inFlight < MAX_IN_FLIGHT) launch(sendHit, hitQueue.shift());
      while (readQueue.length && !hitQueue.length && inFlight < MAX_IN_FLIGHT) {
        launch(sendRead, readQueue.shift());
      }
    }
    schedule();
  }

  function schedule() {
    if (timer === null && (hitQueue.length || readQueue.length)) {
      timer = setTimeout(pump, PUMP_MS);
    }
  }

  function start() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pump();
  }

  function queueHit(id) {
    hitQueue.push(id);
    unsent.set(id, (unsent.get(id) || 0) + 1);
  }

  // ---------- Start up ----------

  loadCache();
  adoptOrphans();
  if (hitQueue.length) start();
  const initialLimit = readLimit();
  if (initialLimit.until > Date.now()) showCooldown(initialLimit.until, true);

  // The heartbeat that tells other tabs this one is still sending its own plays.
  setInterval(() => {
    if (hitQueue.length) savePending();
  }, HEARTBEAT_MS);
  window.addEventListener('pagehide', savePending);

  // Another tab read some counts, so this one can use them too.
  window.addEventListener('storage', (event) => {
    if (event.key === LIMIT_KEY) {
      const limit = readLimit();
      if (limit.until > Date.now()) showCooldown(limit.until, true);
      return;
    }
    if (event.key !== CACHE_KEY || !event.newValue) return;
    try {
      const saved = JSON.parse(event.newValue);
      const changed = [];
      Object.keys(saved).forEach((id) => {
        const entry = saved[id];
        const mine = known.get(id);
        if (entry && Number.isFinite(entry.v) && (!mine || entry.t > mine.at)) {
          known.set(id, { value: mine ? Math.max(mine.value, entry.v) : entry.v, at: entry.t });
          changed.push(id);
        }
      });
      if (changed.length) emit(changed);
    } catch (error) {
      // Ignore it.
    }
  });

  window.SoundCounter = {
    // fn(ids) runs whenever counts change. ids lists the sounds that changed.
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // Counts completed plays. Duplicates in a single call count once.
    hit(ids, completedAt = performance.now()) {
      // Reject silently before queueing; skipped plays are never saved or replayed.
      if (!canCount(completedAt)) return;
      const unique = Array.from(new Set(Array.isArray(ids) ? ids : [ids]))
        .filter((id) => typeof id === 'string' && id.length > 0);
      if (!unique.length) return;
      // Serialize admission across tabs where Web Locks are available.
      if (navigator.locks && navigator.locks.request) {
        navigator.locks.request(LIMIT_KEY, () => countPlays(unique, completedAt)).catch(() => {
          // Counting is optional; a lock failure must never interrupt playback.
        });
      } else {
        countPlays(unique, completedAt);
      }
    },

    // Reads the counts of these sounds, skipping any read recently. Unknown ones go first,
    // then the highest cached counts, so the top of the leaderboard settles soonest.
    refresh(ids) {
      const now = Date.now();
      const due = ids.filter((id) => !reading.has(id)
        && (!known.has(id) || now - known.get(id).at > STALE_MS));
      due.sort((a, b) => {
        const ka = known.get(a);
        const kb = known.get(b);
        if (!ka !== !kb) return ka ? 1 : -1;
        return (kb ? kb.value : 0) - (ka ? ka.value : 0);
      });
      due.forEach((id) => {
        reading.add(id);
        readQueue.push(id);
      });
      if (due.length) start();
      return due.length;
    },

    // The count to show, or null if it isn't known yet. Includes this tab's unsent plays.
    value(id) {
      const entry = known.get(id);
      const extra = unsent.get(id) || 0;
      return entry ? entry.value + extra : null;
    },

    // Whether the count is still being read.
    isLoading(id) {
      return reading.has(id);
    },

    // How many reads are still waiting, and whether the API seems to be down.
    status() {
      return { reading: reading.size, unsent: hitQueue.length, offline: lastError };
    },

    // When the oldest of these counts was read, or null if any are missing.
    updatedAt(ids) {
      let oldest = Infinity;
      for (const id of ids) {
        const entry = known.get(id);
        if (!entry) return null;
        oldest = Math.min(oldest, entry.at);
      }
      return oldest === Infinity ? null : oldest;
    },
  };
})();
