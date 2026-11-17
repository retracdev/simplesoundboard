/*
 * The human check for leaderboard counting. Playing sounds without moving the mouse or
 * touching the screen for a minute opens a Tally form with a reCAPTCHA. It has no close
 * button and comes back after a reload until the form is submitted.
 */
(function () {
  'use strict';

  const verification = window.SoundCounter && window.SoundCounter.verification;
  if (!verification) return;

  const FORM_ID = '8NLKPA';
  const SUCCESS_DELAY_MS = 450;

  const dialog = document.createElement('dialog');
  dialog.className = 'sound-request human-check';
  dialog.setAttribute('aria-labelledby', 'humanCheckTitle');
  dialog.setAttribute('aria-describedby', 'humanCheckDescription');
  dialog.innerHTML = `<header class="sound-request__header">
      <div>
        <h2 id="humanCheckTitle">Still There?</h2>
        <p id="humanCheckDescription">You haven't moved or touched the screen in a while, so leaderboard counting is paused. Verify you're a human to keep counting your plays.</p>
      </div>
    </header>
    <div class="sound-request__body"></div>`;
  const body = dialog.querySelector('.sound-request__body');
  let frame = null;
  let finishing = false;

  function showForm() {
    const url = new URL('https://tally.so/embed/' + FORM_ID);
    url.searchParams.set('hideTitle', '1');
    frame = document.createElement('iframe');
    frame.className = 'sound-request__frame';
    frame.title = 'Human verification form';
    frame.src = url.href;
    body.replaceChildren(frame);
  }

  function open() {
    if (finishing || !verification.required()) return;
    if (!dialog.isConnected) document.body.append(dialog);
    if (!frame) showForm();
    if (!dialog.open) dialog.showModal();
  }

  function finish() {
    finishing = true;
    frame = null;
    verification.complete();
    body.innerHTML = `<section class="sound-request__success">
      <svg class="sound-request__check" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29"/><path d="m19 32 9 9 18-18"/></svg>
      <h3 tabindex="-1">Thanks for verifying you're a human!</h3>
    </section>`;
    body.querySelector('h3').focus({ preventScroll: true });
    setTimeout(() => {
      finishing = false;
      body.replaceChildren();
      dialog.close();
    }, SUCCESS_DELAY_MS);
  }

  // There's no way out but the form: Escape does nothing, and a forced close reopens it.
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  dialog.addEventListener('close', () => {
    if (!finishing && verification.required()) open();
  });
  dialog.addEventListener('keydown', (event) => event.stopPropagation());

  window.addEventListener('message', (event) => {
    // Only the current embedded form can report a successful submission.
    if (!dialog.open || !frame || event.origin !== 'https://tally.so' || event.source !== frame.contentWindow) return;
    let message = event.data;
    if (typeof message === 'string') {
      try { message = JSON.parse(message); } catch (error) { return; }
    }
    if (!message || message.event !== 'Tally.FormSubmitted' || message.payload?.formId !== FORM_ID) return;
    finish();
  });

  // Another tab may have asked for the check, or finished it.
  function sync() {
    if (verification.required()) open();
    else if (dialog.open && !finishing) {
      frame = null;
      body.replaceChildren();
      dialog.close();
    }
  }
  window.addEventListener('focus', sync);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync();
  });

  verification.onRequired(open);
  if (verification.required()) open();
})();
