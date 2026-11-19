/*
 * Tells visitors that retrac.space online services are down. Shown every time the page
 * opens, once the loading screen has gone. Esc, the × button, the "Got it" button or a
 * click on the backdrop closes it.
 */
(function () {
  'use strict';

  // Turned off: online services are working again. Set to true (and raise the version)
  // to show the notice again during a future outage.
  const ENABLED = false;
  if (!ENABLED) return;

  const dialog = document.getElementById('serviceOutageDialog');
  if (!dialog) return;

  const close = () => { if (dialog.open) dialog.close(); };
  document.getElementById('serviceOutageClose').addEventListener('click', close);
  document.getElementById('serviceOutageOk').addEventListener('click', close);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });

  function show() {
    if (dialog.open || !dialog.isConnected) return;
    try {
      dialog.showModal();
      document.getElementById('serviceOutageOk').focus();
    } catch (error) {
      dialog.setAttribute('open', '');
    }
  }

  const splash = window.SoundboardSplash;
  (splash ? splash.whenDone : (fn) => fn())(show);
})();
