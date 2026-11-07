/*
 * The one gate in front of everything Strings, looping and speed and pitch do. Anyone can see the
 * buttons. Using them takes an account, then a place on the strings list in beta.yml, which covers
 * all three.
 */
(function () {
  'use strict';

  const account = window.RetracAccount;
  const signIn = window.SoundSignIn;
  const beta = window.SoundBeta;

  const dialog = document.createElement('dialog');
  dialog.className = 'strings-access';
  dialog.setAttribute('aria-labelledby', 'strings-access-title');
  dialog.setAttribute('aria-describedby', 'strings-access-description');
  dialog.innerHTML = `<section class="signin-panel">
    <h2 id="strings-access-title">You don’t have access yet.</h2>
    <p id="strings-access-description">We’re rolling out strings to everyone soon. You may not have access yet.</p>
    <div class="signin-actions"><button type="button" class="signin-button">Got it</button></div>
  </section>`;
  document.body.append(dialog);

  let trigger = null;
  let checking = false;

  // What the "no access yet" dialog calls each feature.
  const FEATURE_NAMES = { strings: 'strings', loop: 'looping', tune: 'speed and pitch editing' };

  function closeDialog() {
    dialog.close();
    if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
    trigger = null;
  }

  dialog.querySelector('button').addEventListener('click', closeDialog);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog();
  });
  // The dialog's keys belong to it, not to the page's shortcuts.
  dialog.addEventListener('keydown', (event) => event.stopPropagation());

  // Calls proceed(username) once this visitor may use the feature. Otherwise it asks them to sign
  // in and carries on by itself if they do, or tells them they aren't in the beta yet and
  // calls onDenied, if given.
  async function requireAccess(from, proceed, onDenied, feature = 'strings') {
    if (checking || dialog.open || signIn.isOpen()) return;
    checking = true;
    try {
      let state = account.getState();
      if (state.status === 'unknown' || state.status === 'error') state = await account.check();
      if (state.status !== 'authenticated') {
        signIn.open({
          purpose: feature,
          stage: state.status === 'guest' ? 'confirm' : state.status,
          trigger: from,
          onSuccess: () => requireAccess(from, proceed, onDenied, feature),
        });
        return;
      }
      if (await beta.hasAccess('strings', state.username)) {
        proceed(state.username);
        return;
      }
      if (onDenied) onDenied();
      trigger = from;
      dialog.querySelector('p').textContent = 'We’re rolling out ' + FEATURE_NAMES[feature] + ' to everyone soon. You may not have access yet.';
      dialog.showModal();
      dialog.querySelector('button').focus({ preventScroll: true });
    } finally {
      checking = false;
    }
  }

  window.SoundStringsAccess = {
    require: requireAccess,
    requireLoop: (from, proceed) => requireAccess(from, proceed, undefined, 'loop'),
    requireTune: (from, proceed) => requireAccess(from, proceed, undefined, 'tune'),
    // Whether this account is on the list, without asking them anything.
    hasAccess: (username) => beta.hasAccess('strings', username),
  };
})();
