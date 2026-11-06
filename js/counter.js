/*
 * Press counts for each sound, stored with Abacus (https://abacus.jasoncameron.dev).
 *
 * Abacus allows 30 requests per 10 seconds per IP, and it has no bulk read, so requests
 * go through a small queue. Presses go first and reads only use what's left over, which
 * lets someone mash a key without losing counts to reads.
 *
 * Counting is a bonus: nothing here can delay or block a sound. If Abacus can't be
 * reached, the counts just don't appear.
 */
(function () {
  'use strict';

  const API = 'https://abacus.jasoncameron.dev';
  const NAMESPACE = 'retrac.space';
  const KEY_PREFIX = 'simple-soundboard.'; // Counter key = this + the sound's id.

  const WINDOW_MS = 10000;
  const MAX_REQUESTS = 25; // Stays under the limit of 30, in case of a second open tab.
  const MAX_WITH_READS = 20; // Reads stop here, which keeps some room free for presses.
  const PUMP_MS = 400;
  const RATE_LIMITED_PAUSE_MS = 5000;

  const counters = new Map(); // sound id -> { server, pending, requested }
  const hitQueue = [];
  const readQueue = [];
  const sentAt = []; // When each request in the current window went out, oldest first.

  let listener = () => {};
  let pausedUntil = 0;
  let timer = null;

  function counter(id) {
    if (!counters.has(id)) counters.set(id, { server: null, pending: 0, requested: false });
    return counters.get(id);
  }

  function url(action, id) {
    return API + '/' + action + '/' + NAMESPACE + '/' + KEY_PREFIX + id;
  }

  // Every request needs a real answer, because /hit is a GET that a cache would swallow.
  function send(action, id) {
    return fetch(url(action, id), { cache: 'no-store', keepalive: action === 'hit' });
  }

  function record(id, value) {
    const entry = counter(id);
    // Answers can arrive out of order, and the count only ever goes up.
    entry.server = entry.server === null ? value : Math.max(entry.server, value);
  }

  async function sendHit(id) {
    const entry = counter(id);
    try {
      const response = await send('hit', id);
      if (response.status === 429) {
        pausedUntil = performance.now() + RATE_LIMITED_PAUSE_MS;
        hitQueue.unshift(id); // Still pending, so it goes back to the front of the line.
        schedule();
        return;
      }
      entry.pending--;
      if (response.ok) record(id, (await response.json()).value);
    } catch (error) {
      entry.pending--;
    }
    listener(id);
  }

  async function sendRead(id) {
    try {
      const response = await send('get', id);
      if (response.status === 429) {
        pausedUntil = performance.now() + RATE_LIMITED_PAUSE_MS;
        readQueue.unshift(id);
        schedule();
        return;
      }
      if (response.status === 404) record(id, 0); // Nobody has pressed this one yet.
      else if (response.ok) record(id, (await response.json()).value);
      listener(id);
    } catch (error) {
      // Leave the count blank. A later press can still fill it in.
    }
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
      while (readQueue.length && !hitQueue.length && sentAt.length < MAX_WITH_READS) {
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
    if (timer !== null) {
      clearTimeout(timer);
    }
    pump();
  }

  window.SoundCounter = {
    onChange(fn) {
      listener = fn;
    },

    // Fetches the current count, once per page load.
    load(id) {
      const entry = counter(id);
      if (entry.requested) return;
      entry.requested = true;
      readQueue.push(id);
      start();
    },

    // Counts one press. The number on screen goes up right away.
    hit(id) {
      counter(id).pending++;
      hitQueue.push(id);
      listener(id);
      start();
    },

    // The count to show, or null if it isn't known yet.
    value(id) {
      const entry = counter(id);
      return entry.server === null ? null : entry.server + entry.pending;
    },
  };
})();
