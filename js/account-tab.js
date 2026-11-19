/*
 * The last tab in the top bar. Signed out, it reads "Sign In" and opens the sign-in popup.
 * Signed in to retrac.space, it reads "Manage Account" and links to the accounts site.
 */
(function () {
  'use strict';

  const account = window.RetracAccount;
  const signIn = window.SoundSignIn;
  const tab = document.getElementById('accountTab');
  const label = document.getElementById('accountTabLabel');
  if (!tab || !label) return;
  const iconUse = tab.querySelector('use');

  // Anyone with a session counts, even before they've picked a username or while their
  // account needs action: the accounts site is where they sort that out.
  const SIGNED_IN = new Set(['authenticated', 'incomplete', 'action']);

  function isSignedIn() {
    return SIGNED_IN.has(account.getState().status);
  }

  function render() {
    const signedIn = isSignedIn();
    label.textContent = signedIn ? 'Manage Account' : 'Sign In';
    iconUse.setAttribute('href', signedIn ? '#icon-account' : '#icon-sign-in');
    if (signedIn) tab.removeAttribute('aria-haspopup');
    else tab.setAttribute('aria-haspopup', 'dialog');
  }

  tab.addEventListener('click', (event) => {
    // Signed in, it's an ordinary link.
    if (isSignedIn()) return;
    event.preventDefault();
    if (signIn.isOpen()) return;
    signIn.open({ purpose: 'account', stage: 'confirm', trigger: tab });
  });

  account.subscribe(render);
  render();
})();
