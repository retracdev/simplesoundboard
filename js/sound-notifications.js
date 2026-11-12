/* Sound request outcomes. Dismissals share the account's existing cloud save. */
(function () {
  'use strict';

  const account = window.RetracAccount;
  const saves = window.SoundFavorites;
  const API = 'https://space-api.retrac-space.workers.dev/v1';
  const dialog = document.getElementById('soundUpdatesDialog');
  const trigger = document.getElementById('soundUpdatesOpen');
  const closeButton = document.getElementById('soundUpdatesClose');
  const list = document.getElementById('soundUpdatesList');
  const status = document.getElementById('soundUpdatesStatus');
  const retry = document.getElementById('soundUpdatesRetry');
  const notifications = new Map();
  let username = null;
  let epoch = 0;
  let loading = false;
  let lastAttempt = 0;
  let autoOpen = false;
  let ready = false;
  let sizeError = false;
  let rendered = '';
  let displayedIds = [];

  function open() {
    if (!username || !saves.isLoaded() || dialog.open || document.querySelector('dialog[open]')) return;
    autoOpen = false;
    dialog.querySelector('.changelog__panel').scrollTop = 0;
    dialog.showModal();
    closeButton.focus({ preventScroll: true });
  }

  function showPending() {
    if (ready && autoOpen && !trigger.hidden) open();
  }

  function dismissAndClose() {
    if (!dialog.open) return;
    autoOpen = false;
    sizeError = !saves.dismissNotifications(displayedIds);
    render();
    if (!sizeError) dialog.close();
  }

  function render() {
    if (!username || !saves.isLoaded()) {
      displayedIds = [];
      trigger.hidden = true;
      if (dialog.open) dialog.close();
      return;
    }
    const rows = [...notifications.values()].filter((row) => !saves.isNotificationDismissed(row.id));
    displayedIds = rows.map((row) => row.id);
    if (!rows.length) autoOpen = false;
    const unsaved = saves.hasUnsavedNotifications();
    const saveStatus = saves.getStatus();
    trigger.hidden = !rows.length && !unsaved;
    trigger.textContent = rows.length ? `Sound request updates (${rows.length})` : 'Sound request updates';
    const message = sizeError ? 'Your cloud save is full. These updates are still available. Free up space and try closing again.'
      : unsaved ? (saveStatus === 'ok' ? 'Saving your dismissals to your account…'
        : 'Your dismissals have not synced yet. They are kept on this device while saving retries. Retry saving, or sign in again if your session ended.')
        : rows.length ? 'Closing this window dismisses all of these updates.'
          : 'You’re all caught up!';
    const signature = JSON.stringify([rows, message, unsaved, saveStatus]);
    if (signature !== rendered) {
      rendered = signature;
      list.replaceChildren();
      rows.forEach((row) => {
        const card = document.createElement('li');
        card.className = 'sound-updates__card' + (row.status === 'denied' ? ' sound-updates__card--denied' : '');
        // Only static markup goes through innerHTML. All API text is assigned below.
        card.innerHTML = `<svg class="sound-updates__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${row.status === 'added' ? 'm5 12 4 4L19 6' : 'm6 6 12 12M18 6 6 18'}"/></svg><div class="sound-updates__details"><h3></h3><p class="sound-updates__label"></p></div>`;
        const details = card.querySelector('.sound-updates__details');
        details.querySelector('h3').textContent = row.sound_name;
        details.querySelector('.sound-updates__label').textContent = row.status === 'added' ? 'Added to the soundboard' : 'Request denied';
        if (row.reason) {
          const reason = document.createElement('p');
          reason.className = 'sound-updates__reason';
          reason.textContent = row.reason;
          details.append(reason);
        }
        list.append(card);
      });
      status.textContent = message;
      retry.hidden = !unsaved || saveStatus === 'ok';
    }
    showPending();
  }

  async function request(path, token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(API + path, {
        method: 'GET', credentials: 'omit', cache: 'no-store',
        headers: { Authorization: 'Bearer ' + token }, signal: controller.signal,
      });
      if (!response.ok) throw Object.assign(new Error('Notifications unavailable'), { status: response.status });
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function load() {
    if (!username || loading || Date.now() - lastAttempt < 60000) return;
    loading = true;
    lastAttempt = Date.now();
    const current = epoch;
    const expected = username;
    try {
      let body;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { token } = await account.fetchToken();
          if (current !== epoch) return;
          // As with cloud saves, detect an account switch before using a fresh token.
          const session = await request('/session', token);
          if (current !== epoch) return;
          if (session?.data?.player?.username?.toLowerCase() !== expected.toLowerCase()) {
            await account.check();
            return;
          }
          body = await request('/soundboard/notifications', token);
          break;
        } catch (error) {
          if (error.status !== 401 || attempt === 1) throw error;
          await account.check();
          if (current !== epoch) return;
        }
      }
      if (current !== epoch) return;
      const rows = body?.data?.notifications;
      if (!Array.isArray(rows) || !rows.every((row) => row && Number.isSafeInteger(row.id) && row.id > 0
        && typeof row.sound_name === 'string' && ['added', 'denied'].includes(row.status)
        && (row.reason == null || typeof row.reason === 'string'))) throw new Error('Unexpected notifications');
      rows.forEach((row) => {
        if (!notifications.has(row.id) && !saves.isNotificationDismissed(row.id)) autoOpen = true;
        notifications.set(row.id, row);
      });
      render();
    } catch (error) {
      // A failed fetch leaves existing updates intact. Returning to the tab retries.
    } finally {
      if (current === epoch) loading = false;
    }
  }

  function onAccount(state) {
    const next = state.status === 'authenticated' ? state.username : null;
    if (next !== username) {
      epoch++;
      username = next;
      loading = false;
      lastAttempt = 0;
      autoOpen = false;
      sizeError = false;
      rendered = '';
      notifications.clear();
      list.replaceChildren();
      if (dialog.open) dialog.close();
      render();
    }
    load();
  }

  trigger.addEventListener('click', open);
  closeButton.addEventListener('click', dismissAndClose);
  document.getElementById('soundUpdatesDone').addEventListener('click', dismissAndClose);
  retry.addEventListener('click', () => { saves.resume(); render(); });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dismissAndClose(); });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismissAndClose();
  });
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  dialog.addEventListener('close', () => {
    autoOpen = false;
    (trigger.hidden ? document.getElementById('requestSound') : trigger).focus({ preventScroll: true });
  });
  // Wait behind any existing modal, including the page-load changelog.
  document.addEventListener('close', () => setTimeout(showPending, 0), true);
  setTimeout(() => { ready = true; showPending(); }, 800);
  saves.subscribe(render);
  account.subscribe(onAccount);
  onAccount(account.getState());
  window.addEventListener('focus', () => { if (!document.hidden) load(); });
  window.addEventListener('online', load);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
