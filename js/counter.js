/*
 * Play counts for the Sound Leaderboard, stored with Abacus (https://abacus.jasoncameron.dev).
 *
 * Abacus allows 30 requests per 10 seconds per IP and has no bulk read, so every request
 * goes through one paced queue. Plays go first and reads use what's left over, which lets
 * someone hit Play Everything without losing a single count to the leaderboard loading.
 *
 * Plays that haven't been sent yet are saved, so closing the tab right after Play Everything
 * doesn't throw them away: the next visit sends them. Each tab keeps its own save with a
 * heartbeat, and only a save whose tab has gone quiet gets picked up, so nothing is sent twice.
 *
 * Counts that have been read are cached, so the leaderboard draws instantly on a return
 * visit and only refreshes what's gone stale.
 *
 * Counting is a bonus: nothing here can delay or block a sound. If Abacus can't be reached,
 * the leaderboard says so and the board keeps working.
 */
(function () {
  'use strict';

  const API = 'https://abacus.jasoncameron.dev';
  // A fresh namespace, so the leaderboard starts from zero rather than the old key counters.
  const NAMESPACE = 'soundboard.retrac.space';
  const KEY_PREFIX = 'plays.'; // Counter key = this + the sound's id.

  const WINDOW_MS = 10000;
  const MAX_REQUESTS = 25; // Stays under the limit of 30, leaving room for a second tab.
  const PUMP_MS = 250;
  const RATE_LIMITED_PAUSE_MS = 4000;
  const FAILURE_PAUSE_MS = 15000;
  const STALE_MS = 2 * 60 * 1000; // A cached count older than this is read again.

  const CACHE_KEY = 'simple-soundboard:play-counts';
  const PENDING_PREFIX = 'simple-soundboard:unsent-plays:';
  const HEARTBEAT_MS = 4000;
  const ORPHAN_AFTER_MS = 15000; // A save this quiet belongs to a closed tab.

  const tabId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const pendingKey = PENDING_PREFIX + tabId;

  const known = new Map(); // sound id -> { value, at } from Abacus or the cache
  const unsent = new Map(); // sound id -> plays from this tab not yet confirmed by Abacus
  const hitQueue = []; // one sound id per play still to send
  const readQueue = [];
  const reading = new Set(); // ids queued or in flight for a read
  const sentAt = [];
  const listeners = new Set();

  let pausedUntil = 0;
  let timer = null;
  let failures = 0; // reads in a row that couldn't reach Abacus
  let lastError = false;

  // ---------- Storage ----------

  function storage() {
    try {
      return window.localStorage;
    } catch (error) {
      return null;
    }
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
          saved.hits.filter((id) => typeof id === 'string').forEach(queueHit);
        }
      } catch (error) {
        // Skip anything unreadable.
      }
    });
    savePending();
  }

  // ---------- Requests ----------

  function url(action, id) {
    return API + '/' + action + '/' + NAMESPACE + '/' + KEY_PREFIX + id;
  }

  // Every request needs a real answer, because /hit is a GET that a cache would swallow.
  function send(action, id) {
    return fetch(url(action, id), { cache: 'no-store', credentials: 'omit', keepalive: action === 'hit' });
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
        const { value } = await response.json();
        if (Number.isFinite(value)) record(id, value);
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
        const { value } = await response.json();
        if (Number.isFinite(value)) record(id, value);
      }
    } catch (error) {
      // Leave it as it was.
    }
    emit([id]);
  }

  function pump() {
    timer = null;
    const now = performance.now();
    while (sentAt.length && now - sentAt[0] >= WINDOW_MS) sentAt.shift();

    if (now >= pausedUntil) {
      while (hitQueue.length && sentAt.length < MAX_REQUESTS) {
        sentAt.push(now);
        sendHit(hitQueue.shift());
      }
      while (readQueue.length && !hitQueue.length && sentAt.length < MAX_REQUESTS) {
        sentAt.push(now);
        sendRead(readQueue.shift());
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

  // The heartbeat that tells other tabs this one is still sending its own plays.
  setInterval(() => {
    if (hitQueue.length) savePending();
  }, HEARTBEAT_MS);
  window.addEventListener('pagehide', savePending);

  // Another tab read some counts, so this one can use them too.
  window.addEventListener('storage', (event) => {
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

    // Counts one play of each sound. Duplicates in one call count once, since one play of
    // a string uses each of its sounds once however many times it repeats them.
    hit(ids) {
      const unique = Array.from(new Set(Array.isArray(ids) ? ids : [ids]));
      unique.forEach(queueHit);
      savePending();
      emit(unique);
      start();
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

    // How many reads are still waiting, and whether Abacus seems to be down.
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
