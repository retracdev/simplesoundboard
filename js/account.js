/*
 * The visitor's retrac.space account, using the same flow as BasketSmash.
 *
 * The sign-in cookie belongs to accounts.retrac.space and is never readable here. This
 * asks that site who is signed in and for a short-lived token. Tokens are handed straight
 * to the caller and never stored, so nothing here keeps a credential.
 */
(function () {
  'use strict';

  const ACCOUNTS = 'https://accounts.retrac.space';
  const SESSION_TIMEOUT_MS = 5000;
  const TOKEN_TIMEOUT_MS = 8000;

  /*
   * status is one of:
   *   unknown        nothing has been checked yet
   *   authenticated  signed in, with { id, username }
   *   incomplete     signed in, but the account has no username yet
   *   guest          not signed in
   *   error          the check failed, so we can't tell
   */
  let state = { status: 'unknown' };
  let inFlight = null;
  const listeners = new Set();

  function publish(next) {
    state = next;
    listeners.forEach((listener) => listener(state));
    return state;
  }

  function readSession(session) {
    if (session === null) return { status: 'guest' };
    const user = session && session.user;
    if (!user || typeof user.id !== 'string' || !user.id) return null;
    const username = user.username;
    return typeof username === 'string' && username.trim()
      ? { status: 'authenticated', id: user.id, username }
      : { status: 'incomplete', id: user.id };
  }

  async function requestSession() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS);
    try {
      const response = await fetch(ACCOUNTS + '/api/auth/get-session', {
        method: 'GET', credentials: 'include', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) throw new Error('Session unavailable');
      const next = readSession(await response.json());
      if (!next) throw new Error('Unexpected session');
      return publish(next);
    } catch (error) {
      // A failed recheck isn't a sign-out. Anyone signed in stays that way until a real
      // answer says otherwise, and every save still proves who it's writing for.
      return state.status === 'authenticated' ? state : publish({ status: 'error' });
    } finally {
      clearTimeout(timeout);
    }
  }

  // Everyone asking at the same moment shares one request.
  function check() {
    if (!inFlight) {
      inFlight = requestSession().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  // Which account a token belongs to. The API verifies the token itself: this is only so
  // the page can refuse to spend it on a different account's changes.
  function tokenSubject(token) {
    try {
      const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const subject = JSON.parse(atob(payload)).sub;
      return typeof subject === 'string' && subject ? subject : null;
    } catch (error) {
      return null;
    }
  }

  // Resolves to { token, userId }. Rejects with an error carrying the HTTP status,
  // where 0 means the request never completed.
  async function fetchToken() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(ACCOUNTS + '/api/auth/token', {
        method: 'GET', credentials: 'include', cache: 'no-store', signal: controller.signal,
      });
    } catch (error) {
      throw Object.assign(new Error('Token request failed'), { status: 0 });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('Retry-After')) || 0;
      throw Object.assign(new Error('Token refused'), { status: response.status, retryAfter });
    }
    const body = await response.json().catch(() => null);
    const token = body && body.token;
    if (typeof token !== 'string' || !token || token.length > 8192) {
      throw Object.assign(new Error('Bad token response'), { status: 401 });
    }
    return { token, userId: tokenSubject(token) };
  }

  window.RetracAccount = {
    getState: () => state,
    check,
    fetchToken,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();
