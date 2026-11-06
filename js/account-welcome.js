/*
 * Greets someone signed in to their retrac.space account, using the same pill as
 * BasketSmash. Guests, and any failed check, just see nothing.
 */
(function () {
  'use strict';

  const greetings = [
    (username) => `Hey, hey, ${username}!`,
    (username) => `How's it going, ${username}?`,
    (username) => `Ready to make some noise, ${username}?`,
  ];

  function showWelcomePill(username) {
    const pill = document.createElement('div');
    pill.className = 'welcome-pill';
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');
    pill.setAttribute('aria-atomic', 'true');
    pill.innerHTML = `
      <img class="brand-icon" src="assets/alt-favicon.png" alt="" aria-hidden="true">
      <div class="pill-content">
        <div class="brand-name">retrac.space</div>
        <div class="message"></div>
        <div class="login-confirmation">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9"></circle>
            <path d="m8 12 2.5 2.5L16 9"></path>
          </svg>
          <span>Logged in with your retrac.space account.</span>
        </div>
      </div>
      <span class="check" aria-hidden="true">✓</span>`;
    document.body.append(pill);
    setTimeout(() => {
      const greeting = greetings[Math.floor(Math.random() * greetings.length)];
      // Usernames come from the account, so they must never be treated as HTML.
      pill.querySelector('.message').textContent = greeting(username);
      pill.classList.add('visible');
    }, 250);
    setTimeout(() => {
      pill.classList.remove('visible');
      pill.classList.add('leaving');
    }, 3400);
    setTimeout(() => pill.remove(), 3800);
  }

  // Covers both arriving signed in and signing in later, but only ever greets once.
  let greeted = false;
  function greet(state) {
    if (greeted || state.status !== 'authenticated') return;
    greeted = true;
    showWelcomePill(state.username);
  }

  window.RetracAccount.subscribe(greet);
  greet(window.RetracAccount.getState());
})();
