/*
 * The small sign-in dialog, following BasketSmash's flow: sign in at retrac.space in a new
 * tab, and this page notices when the visitor comes back and checks their session again.
 */
(function () {
  'use strict';

  const account = window.RetracAccount;
  const ACCOUNTS_URL = 'https://accounts.retrac.space';

  const screens = {
    confirm: {
      title: 'Save your favorite sounds',
      description: 'Sign in with your retrac.space account to keep your favorites. We’ll open it in a new tab, then pick up right here when you’re back.',
      actions: [['open', 'Continue to retrac.space'], ['cancel', 'Not now']],
    },
    waiting: {
      title: 'Finish signing in',
      description: 'Sign in or create your account in the new tab. When you’re finished, come back here.',
      actions: [['verify', 'I’ve signed in'], ['open', 'Open accounts again'], ['cancel', 'Cancel']],
    },
    checking: {
      title: 'Checking your account',
      description: 'Just a moment.',
      actions: [['cancel', 'Cancel']],
    },
    guest: {
      title: 'Not signed in yet',
      description: 'We couldn’t find your account. Finish signing in, then come back and try again.',
      actions: [['verify', 'Try again'], ['open', 'Open accounts'], ['cancel', 'Cancel']],
    },
    error: {
      title: 'Couldn’t check your account',
      description: 'We couldn’t reach retrac.space just now. Please try again in a moment. Your sounds still work without signing in.',
      actions: [['verify', 'Try again'], ['open', 'Open accounts'], ['cancel', 'Cancel']],
    },
    incomplete: {
      title: 'Finish setting up your account',
      description: 'Choose a username at retrac.space to start saving favorites, then come back here.',
      actions: [['open', 'Open accounts'], ['verify', 'I’ve finished'], ['cancel', 'Cancel']],
    },
  };

  const dialog = document.createElement('dialog');
  dialog.className = 'signin-dialog';
  dialog.setAttribute('aria-labelledby', 'signin-title');
  dialog.setAttribute('aria-describedby', 'signin-description');
  document.body.append(dialog);

  let stage = 'confirm';
  let started = false;
  let away = false;
  let trigger = null;
  let onCancel = null;
  let onSuccess = null;
  let purpose = 'favorites';
  let flow = 0;
  let returnTimer = null;

  function render(next) {
    stage = next;
    const screen = { ...screens[next] };
    if (purpose === 'request') {
      if (next === 'confirm') {
        screen.title = 'Request a sound effect';
        screen.description = 'Sign in with your retrac.space account to send a sound request. We’ll open it in a new tab, then pick up right here when you’re back.';
      } else if (next === 'incomplete') {
        screen.description = 'Choose a username at retrac.space to send your sound request, then come back here.';
      }
    }
    if (purpose === 'strings') {
      if (next === 'confirm') {
        screen.title = 'Make your own strings';
        screen.description = 'Sign in with your retrac.space account to combine sounds into strings and keep them. We’ll open it in a new tab, then pick up right here when you’re back.';
      } else if (next === 'incomplete') {
        screen.description = 'Choose a username at retrac.space to start making strings, then come back here.';
      }
    }
    if (purpose === 'loop') {
      if (next === 'confirm') {
        screen.title = 'Loop your sound effects';
        screen.description = 'Sign in with your retrac.space account to loop your sound effects over and over. We’ll open it in a new tab, then pick up right here when you’re back.';
      } else if (next === 'incomplete') {
        screen.description = 'Choose a username at retrac.space to start looping your sound effects, then come back here.';
      }
    }
    const waiting = next === 'waiting' || next === 'checking';
    dialog.innerHTML = `<section class="signin-panel">
      <div class="signin-brand"><img src="assets/alt-favicon.png" alt=""><span>retrac.space</span></div>
      <h2 id="signin-title">${screen.title}</h2>
      <p id="signin-description">${screen.description}</p>
      ${waiting ? '<p class="signin-waiting" role="status"><span aria-hidden="true"></span>Waiting for your account</p>' : ''}
      <div class="signin-actions">${screen.actions.map(([action, label], i) =>
        `<button type="button" class="${i ? 'signin-button signin-button--quiet' : 'signin-button'}" data-action="${action}">${label}</button>`).join('')}
      </div>
    </section>`;
    if (dialog.open) dialog.querySelector('button').focus({ preventScroll: true });
  }

  function restoreFocus() {
    if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
    trigger = null;
  }

  function close() {
    flow++;
    started = false;
    away = false;
    clearTimeout(returnTimer);
    if (dialog.open) dialog.close();
    restoreFocus();
  }

  function cancel() {
    const notify = onCancel;
    onCancel = null;
    onSuccess = null;
    close();
    if (notify) notify();
  }

  function openAccounts() {
    // Runs directly in a button click, so browsers allow the new tab.
    started = true;
    away = false;
    window.open(ACCOUNTS_URL, '_blank', 'noopener');
    render('waiting');
  }

  async function verify() {
    clearTimeout(returnTimer);
    if (!dialog.open || stage === 'checking') return;
    away = false;
    const current = flow;
    render('checking');
    const session = await account.check();
    if (!dialog.open || flow !== current) return;
    // A successful sign-in closes this dialog through the account listener in app.js.
    if (session.status === 'authenticated') return;
    render(screens[session.status] ? session.status : 'error');
  }

  function markAway() {
    if (dialog.open && started) away = true;
  }

  function onReturn() {
    if (!dialog.open || !started || !away || document.hidden || !document.hasFocus()) return;
    away = false;
    clearTimeout(returnTimer);
    // visibilitychange and focus usually arrive together, so act on just one of them.
    returnTimer = setTimeout(() => {
      if (document.hidden || !document.hasFocus()) markAway();
      else verify();
    }, 200);
  }

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      cancel();
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    if (button.dataset.action === 'open') openAccounts();
    else if (button.dataset.action === 'verify') verify();
    else cancel();
  });

  // The dialog's keys belong to it, not to the page's shortcuts.
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    cancel();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) markAway();
    else onReturn();
  });
  window.addEventListener('blur', markAway);
  window.addEventListener('focus', onReturn);

  window.SoundSignIn = {
    isOpen: () => dialog.open,

    // options: { stage, trigger, onCancel, onSuccess, purpose }
    open(options) {
      if (dialog.open) return;
      flow++;
      started = false;
      away = false;
      trigger = options.trigger || null;
      onCancel = options.onCancel || null;
      onSuccess = options.onSuccess || null;
      purpose = options.purpose || 'favorites';
      render(screens[options.stage] ? options.stage : 'confirm');
      dialog.showModal();
      dialog.querySelector('button').focus({ preventScroll: true });
    },

    // Called once the visitor is signed in. The dialog's job is done.
    finish() {
      const notify = onSuccess;
      onSuccess = null;
      onCancel = null;
      close();
      if (notify) notify();
    },
  };
})();
