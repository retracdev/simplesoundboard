/*
 * Tells an account it has Early Access, once. Anyone named on a list in beta.yml sees this the
 * first time they're signed in. Dismissing it is remembered in their cloud save, so it doesn't
 * come back on this device or any other.
 */
(function () {
  'use strict';

  const account = window.RetracAccount;
  const favorites = window.SoundFavorites;
  const beta = window.SoundBeta;

  const dialog = document.createElement('dialog');
  dialog.className = 'early-access';
  dialog.setAttribute('aria-labelledby', 'early-access-title');
  dialog.setAttribute('aria-describedby', 'early-access-description');
  dialog.innerHTML = `<section class="signin-panel">
    <div class="signin-brand"><img src="assets/alt-favicon.png" alt=""><span>retrac.space</span></div>
    <h2 id="early-access-title">You have Early Access to new features on Simple Soundboard.</h2>
    <p id="early-access-description">You’ll get to try what we’re working on before everyone else. Early features are still being polished, so they may change along the way.</p>
    <div class="signin-actions"><button type="button" class="signin-button">Got it</button></div>
  </section>`;
  document.body.append(dialog);

  let shownFor = null; // The username the open popup is for.
  let checking = false;

  function signedInAs() {
    const state = account.getState();
    return state.status === 'authenticated' ? state.username : null;
  }

  function dismiss() {
    // Only the account that saw it gets it marked as seen.
    if (shownFor && signedInAs() === shownFor) favorites.markEarlyAccessSeen();
    shownFor = null;
    if (dialog.open) dialog.close();
  }

  dialog.querySelector('button').addEventListener('click', dismiss);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dismiss();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismiss();
  });
  // The dialog's keys belong to it, not to the page's shortcuts.
  dialog.addEventListener('keydown', (event) => event.stopPropagation());

  async function update() {
    const username = signedInAs();
    if (dialog.open) {
      // Signed out or switched accounts underneath it, so it's no longer theirs to dismiss.
      if (username !== shownFor) {
        shownFor = null;
        dialog.close();
      }
      return;
    }
    // Waits for the save, which is what knows whether they've seen this already.
    if (checking || !username || !favorites.isLoaded() || favorites.hasSeenEarlyAccess()) return;
    checking = true;
    let allowed = false;
    try {
      allowed = await beta.hasEarlyAccess(username);
    } finally {
      checking = false;
    }
    if (!allowed || signedInAs() !== username || !favorites.isLoaded() || favorites.hasSeenEarlyAccess()) return;
    // Never interrupts another popup. Its closing brings this back around.
    if (document.querySelector('dialog[open]')) return;
    shownFor = username;
    dialog.showModal();
    dialog.querySelector('button').focus({ preventScroll: true });
  }

  account.subscribe(update);
  favorites.subscribe(update);
  // "close" doesn't bubble, so this listens on the way down instead.
  document.addEventListener('close', (event) => {
    if (event.target !== dialog) update();
  }, true);
  update();
})();
