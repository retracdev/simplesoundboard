/*
 * A promotion for another retrac.space site, shown in the changelog's sliding sheet. It
 * opens once the loading screen has gone and no other dialog is up, until the visitor
 * dismisses it (Dismiss, the × button, Escape or a click on the backdrop), which is
 * remembered in a cookie. "Check out Reaction Arena" opens the site in a new tab and leaves the
 * sheet open, so it does not count as dismissing. The "Check out Reaction Arena" pill under the
 * changelog pill (and a #motdPromotion link in the MOTD, when there is one) reopens it any time. For the next promotion, change
 * PROMOTION_ID (and the dialog's content) and everyone sees it once more. To retire it,
 * remove this file and #promotionDialog.
 */
(function () {
  'use strict';

  const PROMOTION_ID = '2';
  const COOKIE = 'ssb_promotion_dismissed';
  const ONE_YEAR = 60 * 60 * 24 * 365;

  const dialog = document.getElementById('promotionDialog');
  if (!dialog) return;
  const video = document.getElementById('promotionVideo');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function dismissed() {
    const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) === PROMOTION_ID : false;
  }

  function rememberDismissed() {
    document.cookie = `${COOKIE}=${encodeURIComponent(PROMOTION_ID)}; max-age=${ONE_YEAR}; path=/; SameSite=Lax`;
  }

  function playVideo() {
    if (!video) return;
    if (reduceMotion) {
      // Don't move on its own; let the visitor start it.
      video.controls = true;
      video.preload = 'metadata';
      return;
    }
    const playing = video.play();
    if (playing && playing.catch) playing.catch(() => { video.controls = true; });
  }

  function open() {
    if (dialog.open || !dialog.isConnected) return;
    dialog.querySelector('.changelog__panel').scrollTop = 0;
    try {
      dialog.showModal();
    } catch (error) {
      dialog.setAttribute('open', '');
    }
    document.getElementById('promotionClose').focus({ preventScroll: true });
    playVideo();
  }

  const close = () => { if (dialog.open) dialog.close(); };

  // However it closes, this promotion is seen and won't open by itself again.
  dialog.addEventListener('close', () => {
    rememberDismissed();
    if (video) video.pause();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  document.getElementById('promotionClose').addEventListener('click', close);
  document.getElementById('promotionDismiss').addEventListener('click', close);

  // Reopen on demand, even after it was dismissed.
  ['motdPromotion', 'promotionOpen'].forEach((id) => {
    const trigger = document.getElementById(id);
    if (trigger) trigger.addEventListener('click', open);
  });

  if (window.SoundboardLiveUpdate) {
    window.SoundboardLiveUpdate.onDispose(() => { if (video) video.pause(); });
  }

  if (dismissed()) return;

  // Don't stack on top of another sheet (the changelog, the outage notice, sign-in...).
  // Wait for it to close, then slide in. `close` doesn't bubble, so listen while capturing.
  function openWhenClear() {
    if (dialog.open || dismissed()) return;
    if (document.querySelector('dialog[open]')) {
      document.addEventListener('close', onAnyClose, true);
      return;
    }
    open();
  }
  function onAnyClose() {
    document.removeEventListener('close', onAnyClose, true);
    setTimeout(openWhenClear, 400);
  }

  // Start after the changelog's own 600ms delay, so it gets the first turn.
  const splash = window.SoundboardSplash;
  (splash ? splash.whenDone : (fn) => fn())(() => setTimeout(openWhenClear, 900));
})();
