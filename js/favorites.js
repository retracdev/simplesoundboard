/*
 * Favorites, kept in the signed-in account's retrac.space cloud save (app "soundboard",
 * slot 0) as { version: 1, favorites: ["sound-id", ...] }.
 *
 * The API replaces the whole save on every write and has no way to say "only if nothing
 * changed", so saving works like this:
 *
 *   - A click updates the screen at once and records one add or remove for that sound.
 *     Those changes are stored locally per account, so they survive a refresh.
 *   - One save runs at a time. It reads the latest save, applies the recorded changes,
 *     writes the result, and then forgets only the changes it actually wrote. Anything
 *     clicked during a save waits for the next one.
 *   - It never writes without reading first in that same save. A failed read or a save
 *     it doesn't understand therefore can't overwrite anything.
 *
 * Two devices saving at the same instant can still race, with the last write winning.
 * Reading right before every write makes that window very small, not impossible.
 */
(function () {
  'use strict';

  const account = window.RetracAccount;

  const API = 'https://space-api.retrac-space.workers.dev/v1';
  const SAVE_URL = API + '/games/soundboard/saves/0';
  const WHO_AM_I_URL = API + '/session';
  const REQUEST_TIMEOUT_MS = 8000;
  const DEBOUNCE_MS = 700;
  const MAX_DEBOUNCE_MS = 3000; // Steady clicking can't put off a save forever.
  const WRITE_WINDOW_MS = 60000;
  // The API allows 30 writes a minute per account, shared with every retrac.space game.
  const MAX_WRITES_PER_WINDOW = 20;
  const RETRY_DELAYS_MS = [3000, 12000, 30000, 60000]; // Then wait for a click or a return.
  // The API sends Retry-After but doesn't expose it to other sites, so browsers can't read
  // it. Its value is always 60, which makes this the honest default.
  const RATE_LIMIT_DEFAULT_MS = 60000;
  const RATE_LIMIT_MAX_MS = 300000;
  const REFRESH_AFTER_MS = 60000;
  const MAX_SAVE_BYTES = 65536;
  const STORAGE_PREFIX = 'simple-soundboard:favorites-pending:';

  class SaveError extends Error {
    constructor(status, code, retryAfter) {
      super(code || 'save_failed');
      this.status = status;
      this.code = code || '';
      this.retryAfter = retryAfter || 0;
    }
  }

  /*
   * status says what the visitor needs to know:
   *   ok       nothing to report
   *   retrying the last attempt failed, and another is scheduled
   *   paused   retries ran out, and the next click or return tries again
   *   blocked  trying again won't help without something changing
   *   signin   the session ended with changes still unsaved
   *   setup    the account has to finish setup first
   */
  let accountId = null; // The signed-in username, which is how accounts identifies people here.
  let confirmedToken = null; // The token subject the API has confirmed is this account.
  let cloud = null; // The last save read for this account, or null if none has been read.
  let extras = {}; // Save fields this version doesn't use, kept so a write can't drop them.
  const pending = new Map(); // sound id -> 'add' | 'remove'
  let status = 'ok';
  let lastReadAt = 0;
  let lastAttemptAt = 0;

  let epoch = 0; // Bumped on every account change. Work from an older epoch is discarded.
  let running = false;
  let rerun = false;
  let timer = null;
  let firstQueuedAt = 0;
  let attempts = 0;
  let authRetried = false;
  let notBefore = 0;
  const writeTimes = [];

  const listeners = new Set();

  function emit() {
    listeners.forEach((listener) => listener());
  }

  // ---------- Local storage of unsaved changes ----------

  function storageKey(id) {
    return STORAGE_PREFIX + id;
  }

  function persist() {
    if (!accountId) return;
    try {
      if (pending.size) {
        window.localStorage.setItem(storageKey(accountId), JSON.stringify({ ops: Array.from(pending) }));
      } else {
        window.localStorage.removeItem(storageKey(accountId));
      }
    } catch (error) {
      // Storage can be blocked. Changes still save, but wouldn't survive a refresh.
    }
  }

  function restore(id) {
    pending.clear();
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey(id)));
      if (saved && Array.isArray(saved.ops)) {
        saved.ops.forEach((entry) => {
          if (Array.isArray(entry) && typeof entry[0] === 'string' && (entry[1] === 'add' || entry[1] === 'remove')) {
            pending.set(entry[0], entry[1]);
          }
        });
      }
    } catch (error) {
      // Blocked or unreadable storage just means nothing to restore.
    }
  }

  // ---------- Talking to the API ----------

  async function request(token, options, url = SAVE_URL) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
        ...options,
        headers: { Authorization: 'Bearer ' + token, ...(options && options.headers) },
      });
    } catch (error) {
      throw new SaveError(0);
    } finally {
      clearTimeout(timeout);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const code = body && body.error && body.error.code;
      throw new SaveError(response.status, code, Number(response.headers.get('Retry-After')) || 0);
    }
    return body;
  }

  // The session check says who is signed in, but a token could belong to someone newer if
  // another tab just switched accounts. The API can say exactly whose this token is, so ask
  // it once per account, then just watch for the token's subject changing.
  async function confirmToken(token, subject) {
    if (subject && subject === confirmedToken) return;
    const body = await request(token, { method: 'GET' }, WHO_AM_I_URL);
    const player = body && body.data && body.data.player;
    const username = player && player.username;
    if (typeof username !== 'string' || username.toLowerCase() !== accountId.toLowerCase()) {
      throw new SaveError(-2, 'account_changed');
    }
    confirmedToken = subject;
  }

  // Throws for anything other than a save this version fully understands.
  function parseSave(save) {
    const valid = save && typeof save === 'object' && !Array.isArray(save) && save.version === 1 &&
      Array.isArray(save.favorites) && save.favorites.every((id) => typeof id === 'string' && id);
    if (!valid) throw new SaveError(-1, 'unsupported_save');
    const { version, favorites, ...rest } = save;
    return { favorites: Array.from(new Set(favorites)), extras: rest };
  }

  async function readSave(token) {
    try {
      const body = await request(token, { method: 'GET' });
      return parseSave(body && body.data && body.data.data);
    } catch (error) {
      // Only this exact answer means "no save yet". Any other failure means we don't know.
      if (error.status === 404 && error.code === 'save_not_found') return { favorites: [], extras: {} };
      throw error;
    }
  }

  function applyChanges(favorites, changes) {
    const next = favorites.filter((id) => changes.get(id) !== 'remove');
    changes.forEach((op, id) => {
      if (op === 'add' && !next.includes(id)) next.push(id);
    });
    return next;
  }

  const sameList = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

  // ---------- The save cycle ----------

  function delayUntilAllowed(now) {
    while (writeTimes.length && now - writeTimes[0] >= WRITE_WINDOW_MS) writeTimes.shift();
    const paced = writeTimes.length >= MAX_WRITES_PER_WINDOW ? writeTimes[0] + WRITE_WINDOW_MS - now : 0;
    return Math.max(paced, notBefore - now, 0);
  }

  function setTimer(delay) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delay);
  }

  function queueSave() {
    const now = Date.now();
    if (!firstQueuedAt) firstQueuedAt = now;
    const debounce = Math.min(DEBOUNCE_MS, Math.max(0, firstQueuedAt + MAX_DEBOUNCE_MS - now));
    setTimer(Math.max(debounce, delayUntilAllowed(now)));
  }

  async function saveCycle(cycleEpoch) {
    const { token, userId } = await account.fetchToken();
    if (cycleEpoch !== epoch) return;
    // A token for anyone else means the account changed in another tab. Stop right here.
    await confirmToken(token, userId);
    if (cycleEpoch !== epoch) return;

    const save = await readSave(token);
    if (cycleEpoch !== epoch) return;
    cloud = save.favorites;
    extras = save.extras;
    lastReadAt = Date.now();
    emit();

    if (!pending.size) {
      succeed();
      return;
    }

    const writing = new Map(pending);
    const next = applyChanges(cloud, writing);
    if (!sameList(next, cloud)) {
      const payload = JSON.stringify({ data: { ...extras, version: 1, favorites: next } });
      if (new TextEncoder().encode(payload).length > MAX_SAVE_BYTES) {
        throw new SaveError(413, 'save_too_large');
      }
      writeTimes.push(Date.now());
      await request(token, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload });
      if (cycleEpoch !== epoch) return;
      cloud = next;
    }

    // Forget only what was written. A newer click on the same sound stays pending.
    writing.forEach((op, id) => {
      if (pending.get(id) === op) pending.delete(id);
    });
    persist();
    succeed();
    if (pending.size) queueSave();
  }

  // Failure counters reset only here. A read that works followed by a write that doesn't
  // still has to count, or a failing write would retry forever.
  function succeed() {
    attempts = 0;
    authRetried = false;
    status = 'ok';
    emit();
  }

  async function handleFailure(error, cycleEpoch) {
    if (error.status === 401 || error.status === -2) {
      if (error.status === 401 && !authRetried) {
        // The token or session may simply have expired, so try once with a fresh look.
        authRetried = true;
        const hadChanges = pending.size > 0;
        const session = await account.check();
        if (cycleEpoch !== epoch) {
          if (hadChanges && !accountId) markSignedOut();
          return;
        }
        if (session.status === 'authenticated' && session.username === accountId) {
          setTimer(0);
          return;
        }
        if (session.status === 'error') scheduleRetry();
        return;
      }
      if (error.status === -2) {
        // Ask who is really signed in. The account listener switches over from there, so
        // still being here means the account didn't change and something else is wrong.
        await account.check();
        if (cycleEpoch !== epoch) return;
        status = 'blocked';
      } else {
        status = 'signin'; // Refused twice, even with a fresh token.
      }
      emit();
      return;
    }
    if (error.status === 429) {
      const wait = error.retryAfter > 0
        ? Math.min(error.retryAfter * 1000, RATE_LIMIT_MAX_MS)
        : RATE_LIMIT_DEFAULT_MS;
      notBefore = Date.now() + wait;
      status = 'retrying';
      setTimer(wait);
      emit();
      return;
    }
    if (error.status === 0 || error.status >= 500) {
      scheduleRetry();
      return;
    }
    // Everything else needs something to change first: an account finishing setup, a save
    // from a newer version of this site, or a configuration fix. Retrying can't help.
    status = error.status === 403 && error.code === 'username_required' ? 'setup' : 'blocked';
    emit();
  }

  function scheduleRetry() {
    attempts++;
    if (attempts > RETRY_DELAYS_MS.length) {
      status = 'paused';
    } else {
      status = 'retrying';
      setTimer(RETRY_DELAYS_MS[attempts - 1]);
    }
    emit();
  }

  function markSignedOut() {
    status = 'signin';
    emit();
  }

  async function run() {
    if (!accountId) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    firstQueuedAt = 0;
    lastAttemptAt = Date.now();
    const cycleEpoch = epoch;
    try {
      await saveCycle(cycleEpoch);
    } catch (error) {
      if (cycleEpoch === epoch) await handleFailure(error, cycleEpoch);
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        if (accountId) {
          // A brand-new account loads right away. More clicks on this one wait their turn.
          if (cycleEpoch !== epoch) run();
          else if (pending.size && !timer) queueSave();
        }
      }
    }
  }

  // ---------- What the page uses ----------

  // Pass null when nobody is signed in. Unsaved changes stay stored under their account,
  // and only ever go to that account when it signs back in.
  function setAccount(id) {
    if (id === accountId) return;
    epoch++;
    clearTimeout(timer);
    timer = null;
    accountId = id;
    confirmedToken = null;
    cloud = null;
    extras = {};
    status = 'ok';
    attempts = 0;
    authRetried = false;
    notBefore = 0;
    firstQueuedAt = 0;
    lastReadAt = 0;
    lastAttemptAt = 0;
    pending.clear();
    if (id) {
      restore(id);
      if (running) rerun = true;
      else run();
    }
    emit();
  }

  function setChange(id, op) {
    pending.set(id, op);
    persist();
    if (status === 'blocked' || status === 'paused') attempts = 0;
    emit();
    queueSave();
  }

  function isFavorite(id) {
    if (pending.has(id)) return pending.get(id) === 'add';
    return cloud ? cloud.includes(id) : false;
  }

  window.SoundFavorites = {
    setAccount,
    isFavorite,

    // Every favorite in the order they were added, including sounds this version of the
    // site doesn't know about.
    list: () => applyChanges(cloud || [], pending),

    // Flips one sound. The screen can show the new state immediately.
    toggle(id) {
      if (!accountId) return;
      setChange(id, isFavorite(id) ? 'remove' : 'add');
    },

    // Makes one sound a favorite, leaving it alone if it already is one.
    add(id) {
      if (accountId) setChange(id, 'add');
    },

    // True once this account's save has been read at least once.
    isLoaded: () => cloud !== null,
    getStatus: () => status,
    hasUnsaved: () => pending.size > 0,

    // Called when the visitor returns, or the network does. Honors any rate-limit wait.
    resume() {
      if (!accountId) return;
      // These won't fix themselves, so returning to the tab only rechecks them now and then.
      const stuck = status === 'blocked' || status === 'setup' || status === 'signin';
      if (stuck && Date.now() - lastAttemptAt < REFRESH_AFTER_MS) return;
      const waiting = pending.size > 0 || cloud === null;
      const stale = Date.now() - lastReadAt >= REFRESH_AFTER_MS;
      if (!waiting && !stale) return;
      if (waiting) attempts = 0;
      const wait = delayUntilAllowed(Date.now());
      if (!running && !timer) {
        if (wait) setTimer(wait);
        else run();
      } else if (timer && !wait && (status === 'retrying' || status === 'paused')) {
        setTimer(0);
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();
