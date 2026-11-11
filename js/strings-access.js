/*
 * Strings, looping and speed and pitch editing are available to every signed-in account.
 * Guests are asked to sign in before continuing into the feature they chose.
 */
(function () {
  'use strict';

  const account = window.RetracAccount;
  const signIn = window.SoundSignIn;
  let checking = false;

  // Calls proceed(username) once signed in, or resumes after the visitor signs in.
  async function requireAccess(from, proceed, feature = 'strings') {
    if (checking || signIn.isOpen()) return;
    checking = true;
    try {
      let state = account.getState();
      if (state.status === 'unknown' || state.status === 'error') state = await account.check();
      if (state.status !== 'authenticated') {
        signIn.open({
          purpose: feature,
          stage: state.status === 'guest' ? 'confirm' : state.status,
          trigger: from,
          onSuccess: () => requireAccess(from, proceed, feature),
        });
        return;
      }
      proceed(state.username);
    } finally {
      checking = false;
    }
  }

  window.SoundStringsAccess = {
    require: requireAccess,
    requireLoop: (from, proceed) => requireAccess(from, proceed, 'loop'),
    requireTune: (from, proceed) => requireAccess(from, proceed, 'tune'),
  };
})();
