/* Loads Tally only when requested, with the visitor's retrac.space username. */
(function () {
  'use strict';

  const account = window.RetracAccount;
  const signIn = window.SoundSignIn;
  const trigger = document.getElementById('requestSound');
  const dialog = document.getElementById('soundRequestDialog');
  const body = document.getElementById('soundRequestBody');
  const closeButton = document.getElementById('soundRequestClose');
  const FORM_ID = 'yXN0Xx';
  let frame = null;
  let username = null;
  let submitted = false;
  let checking = false;
  let opening = false;
  let pendingSignIn = null;
  let flow = 0;

  function promptSignIn(state) {
    signIn.open({
      purpose: 'request',
      stage: state.status === 'guest' ? 'confirm' : state.status,
      trigger,
      onSuccess: openRequest,
    });
  }

  async function openRequest() {
    if (dialog.open || signIn.isOpen() || opening) return;
    opening = true;
    try {
      let state = account.getState();
      if (state.status === 'unknown' || state.status === 'error') state = await account.check();
      if (state.status !== 'authenticated') {
        promptSignIn(state);
        return;
      }
      submitted = false;
      dialog.showModal();
      showSession(state);
      closeButton.focus({ preventScroll: true });
      checkSession();
    } finally {
      opening = false;
    }
  }

  function clearForm() {
    frame = null;
    username = null;
    body.replaceChildren();
  }

  function showSession(state) {
    if (!dialog.open || submitted) return;
    if (state.status === 'authenticated') {
      if (frame && username === state.username) return;
      clearForm();
      username = state.username;
      const url = new URL('https://tally.so/embed/' + FORM_ID);
      url.searchParams.set('retracspaceusername', username);
      url.searchParams.set('hideTitle', '1');
      // A fresh iframe also clears Tally's previous submission when submitting again.
      frame = document.createElement('iframe');
      frame.className = 'sound-request__frame';
      frame.title = 'Request a Sound Effect form';
      frame.src = url.href;
      body.append(frame);
      return;
    }

    // Switch to the shared compact sign-in dialog if this account signed out.
    pendingSignIn = state;
    dialog.close();
  }

  async function checkSession() {
    if (!dialog.open || submitted || checking) return;
    checking = true;
    const current = flow;
    try {
      const state = await account.check();
      if (current === flow) showSession(state);
    } finally {
      if (current === flow) checking = false;
    }
  }

  trigger.addEventListener('click', openRequest);
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    flow++;
    checking = false;
    clearForm();
    trigger.focus({ preventScroll: true });
    if (pendingSignIn) {
      const state = pendingSignIn;
      pendingSignIn = null;
      promptSignIn(state);
    }
  });
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  body.addEventListener('click', (event) => {
    const button = event.target.closest('[data-request-action]');
    if (!button) return;
    if (button.dataset.requestAction === 'dismiss') dialog.close();
    else if (button.dataset.requestAction === 'again') {
      submitted = false;
      showSession(account.getState());
      closeButton.focus({ preventScroll: true });
      checkSession();
    } else checkSession();
  });
  account.subscribe(showSession);
  window.addEventListener('focus', checkSession);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkSession();
  });

  window.addEventListener('message', (event) => {
    // Only the current embedded form can report a successful submission.
    if (!dialog.open || !frame || event.origin !== 'https://tally.so' || event.source !== frame.contentWindow) return;
    let message = event.data;
    if (typeof message === 'string') {
      try { message = JSON.parse(message); } catch (error) { return; }
    }
    if (!message || message.event !== 'Tally.FormSubmitted' || message.payload?.formId !== FORM_ID) return;
    submitted = true;
    clearForm();
    body.innerHTML = `<section class="sound-request__success">
      <svg class="sound-request__check" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29"/><path d="m19 32 9 9 18-18"/></svg>
      <h3 tabindex="-1">Submitted!</h3>
      <p>Thanks for the suggestion. Your sound request is in!</p>
      <div class="signin-actions">
        <button class="signin-button" type="button" data-request-action="dismiss">Dismiss</button>
        <button class="signin-button signin-button--quiet" type="button" data-request-action="again">Submit again</button>
      </div>
    </section>`;
    body.querySelector('h3').focus({ preventScroll: true });
  });
})();
