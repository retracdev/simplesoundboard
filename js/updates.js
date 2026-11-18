/*
 * The footer's "Check for Updates" button.
 *
 * It asks the live updater (js/live-update.js) to fetch the newest copy of the app and restart
 * it in this same page, even when the version hasn't changed, so the tab never reloads. The
 * updater shows the toast that follows. Without the updater there's nothing to ask, and the
 * button stays hidden.
 */
(function () {
  'use strict';

  const button = document.getElementById('checkUpdates');
  const label = document.getElementById('checkUpdatesLabel');
  const updater = window.SoundboardLiveUpdate;
  if (!button || !label || !updater || typeof updater.refresh !== 'function') return;

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
      // When the app restarts, this button goes away with the rest of the old page.
      await updater.refresh();
    } catch (error) {
      console.warn('Simple Soundboard: Check for Updates failed.', error);
      if (window.SoundboardToasts) {
        window.SoundboardToasts.show({
          text: "Couldn't check for updates. Try again in a moment.",
          icon: 'warning',
          key: 'check-updates',
        });
      }
    } finally {
      if (button.isConnected) busy(false);
    }
  });
})();
