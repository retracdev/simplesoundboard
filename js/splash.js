/*
 * The loading screen. The favicon pops up on black with a bar under it. The bar fills to
 * 25% as the sounds load, then runs on to 100% over a random 0.5 to 2.75 seconds. At 100%
 * the screen fades away, the board rises in, and anything waiting on whenDone() (the
 * welcome pill, the changelog and so on) gets its turn.
 */
(function () {
  'use strict';

  const SOUNDS_SHARE = 25; // Percent of the bar that stands for loading the sounds.
  const MIN_FINISH_MS = 500;
  const MAX_FINISH_MS = 2750;
  const HOLD_AT_FULL_MS = 180; // A beat at 100% before it leaves, so the full bar registers.
  const LEAVE_MS = 650; // Matches the longest .splash.is-leaving transition in style.css.
  const REVEAL_MS = 900; // Matches the site-in animation in style.css.
  const GIVE_UP_MS = 20000; // A slow connection still gets in eventually.

  const root = document.documentElement;
  const splash = document.getElementById('splash');
  const fill = splash && splash.querySelector('.splash__fill');
  const waiting = [];
  let done = false;
  let finishing = false;
  let shown = 0;

  function flush() {
    done = true;
    waiting.splice(0).forEach((fn) => {
      try { fn(); } catch (error) { console.error(error); }
    });
  }

  if (!splash || !fill) {
    root.classList.remove('is-splashing');
    flush();
  }

  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Nothing behind the screen can be focused or read out until it's gone.
  const hidden = splash ? [...document.body.children].filter((el) => el !== splash && !el.inert) : [];
  hidden.forEach((el) => { el.inert = true; });
  function blockKeys(event) { event.stopPropagation(); }
  if (splash) window.addEventListener('keydown', blockKeys, true);

  function show(percent) {
    shown = Math.max(shown, Math.min(100, percent));
    fill.style.transform = `scaleX(${shown / 100})`;
    splash.setAttribute('aria-valuenow', String(Math.round(shown)));
  }

  function leave() {
    splash.classList.add('is-leaving');
    root.classList.add('is-revealing');
    root.classList.remove('is-splashing');
    hidden.forEach((el) => { el.inert = false; });
    window.removeEventListener('keydown', blockKeys, true);
    setTimeout(() => {
      splash.remove();
      flush();
    }, reducedMotion ? 200 : LEAVE_MS);
    setTimeout(() => root.classList.remove('is-revealing'), REVEAL_MS + 100);
  }

  // Slow at the very start and end, quick through the middle.
  function ease(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function finish() {
    if (finishing || done) return;
    finishing = true;
    clearTimeout(giveUp);
    const from = Math.max(shown, SOUNDS_SHARE);
    const duration = MIN_FINISH_MS + Math.random() * (MAX_FINISH_MS - MIN_FINISH_MS);
    fill.classList.add('is-running'); // Frames drive it from here, not the CSS transition.
    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      show(from + (100 - from) * ease(t));
      if (t < 1) requestAnimationFrame(frame);
      else setTimeout(leave, HOLD_AT_FULL_MS);
    }
    requestAnimationFrame(frame);
  }

  const giveUp = splash ? setTimeout(finish, GIVE_UP_MS) : null;

  window.SoundboardSplash = {
    // How many sounds have loaded (or failed) out of how many there are.
    progress(loaded, total) {
      if (finishing || done || !total) return;
      show(SOUNDS_SHARE * Math.min(1, loaded / total));
    },

    // Every sound has had its try, so the bar can finish.
    soundsLoaded() {
      if (done) return;
      show(SOUNDS_SHARE);
      finish();
    },

    isDone: () => done,

    // Runs fn once the screen is gone, or right away if it already is.
    whenDone(fn) {
      if (done) fn();
      else waiting.push(fn);
    },
  };
})();
