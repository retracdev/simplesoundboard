/*
 * Tells visitors that retrac.space online services are down. Shown every time the page
 * opens, once the loading screen has gone. Esc, the × button, the "Got it" button or a
 * click on the backdrop closes it. Remove this file (and its dialog) once the backend is back.
 */
(function () {
  'use strict';

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
