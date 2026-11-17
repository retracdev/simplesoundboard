/*
 * The footer's "Check for Updates" button.
 *
 * This page runs inside the kernel (index.html). The kernel fetches the newest copy of this
 * page and every file it loads, then restarts the app in place, so the tab itself never
 * reloads. Opened outside the kernel, there's nothing to ask, and the button stays hidden.
 */
(function () {
  'use strict';

  const button = document.getElementById('checkUpdates');
  const label = document.getElementById('checkUpdatesLabel');
  if (!button || !label) return;

  let kernel = null;
  try {
    if (window.parent !== window) kernel = window.parent.SoundboardKernel || null;
  } catch (error) {
    kernel = null; // Framed by another site.
  }
  if (!kernel || typeof kernel.checkForUpdates !== 'function') return;

  function busy(on) {
    button.disabled = on;
    button.classList.toggle('is-checking', on);
    button.setAttribute('aria-busy', String(on));
    label.textContent = on ? 'Checking for updates…' : 'Check for Updates';
  }

  button.hidden = false;
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    busy(true);
    try {
      // On success the kernel restarts the app, and this page goes away with it.
      await kernel.checkForUpdates();
    } catch (error) {
      busy(false);
      if (window.SoundboardToasts) {
        window.SoundboardToasts.show({
          text: "Couldn't check for updates. Try again in a moment.",
          icon: 'warning',
          key: 'check-updates',
        });
      }
    }
  });
})();
