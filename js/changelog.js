/*
 * The "what's new" changelog. It slides in on load until the visitor dismisses the
 * current version, which is remembered in a cookie. The pill under the tagline
 * reopens it any time. Bump CHANGELOG_VERSION (and the dialog's content) for the
 * next release and everyone sees it once more.
 */
(function () {
  'use strict';

  const CHANGELOG_VERSION = '1.1';
  const COOKIE = 'ssb_changelog_dismissed';
  const ONE_YEAR = 60 * 60 * 24 * 365;

  const dialog = document.getElementById('changelogDialog');
  const openButton = document.getElementById('changelogOpen');
  const closeButton = document.getElementById('changelogClose');
  const doneButton = document.getElementById('changelogDone');
  if (!dialog || !openButton) return;

  function dismissedVersion() {
    const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function rememberDismissed() {
    document.cookie = `${COOKIE}=${encodeURIComponent(CHANGELOG_VERSION)}; max-age=${ONE_YEAR}; path=/; SameSite=Lax`;
  }

  function open() {
    if (dialog.open) return;
    dialog.querySelector('.changelog__panel').scrollTop = 0;
    dialog.showModal();
    closeButton.focus({ preventScroll: true });
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  // However it closes (button, Escape, or a click outside), this version is seen.
  dialog.addEventListener('close', () => {
    rememberDismissed();
    openButton.focus({ preventScroll: true });
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  closeButton.addEventListener('click', close);
  doneButton.addEventListener('click', close);
  openButton.addEventListener('click', open);

  if (dismissedVersion() !== CHANGELOG_VERSION) {
    // Let the board paint first so the sheet slides in over it.
    setTimeout(() => {
      if (!document.querySelector('dialog[open]')) open();
    }, 600);
  }
})();
