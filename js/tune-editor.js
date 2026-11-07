/*
 * The "Edit speed and pitch" popup. Each change applies as soon as a slider is let go, so there's
 * nothing to save and closing it never loses anything.
 */
(function () {
  'use strict';

  const core = window.TuneCore;

  const LINKED_HINT = 'Speed also changes the pitch, like speeding up a tape.';
  const SEPARATE_HINT = 'Speed won’t change the pitch. Set the pitch with its own slider.';

  const dialog = document.createElement('dialog');
  dialog.className = 'tune-editor';
  dialog.setAttribute('aria-labelledby', 'tune-editor-title');
  dialog.setAttribute('aria-describedby', 'tune-editor-sync');
  dialog.innerHTML = `<section class="signin-panel">
    <h2 id="tune-editor-title">Edit speed and pitch</h2>
    <p class="tune-editor__sound"></p>
    <label class="tune-editor__slider">
      <span class="tune-editor__label">Speed <output class="tune-editor__speed-value"></output></span>
      <input class="tune-editor__speed" type="range" min="0" max="100" step="1">
    </label>
    <label class="tune-editor__check">
      <input class="tune-editor__separate" type="checkbox">
      <span>Change pitch separately</span>
    </label>
    <p class="tune-editor__hint"></p>
    <label class="tune-editor__slider tune-editor__pitch-row">
      <span class="tune-editor__label">Pitch <output class="tune-editor__pitch-value"></output></span>
      <input class="tune-editor__pitch" type="range" min="0" max="100" step="1">
    </label>
    <p class="tune-editor__message" role="status" hidden></p>
    <p class="tune-editor__sync" id="tune-editor-sync">Saved to your account, so it follows you across your devices.</p>
    <div class="signin-actions">
      <button type="button" class="signin-button tune-editor__done">Done</button>
      <button type="button" class="signin-button signin-button--quiet tune-editor__preview">Preview</button>
      <button type="button" class="signin-button signin-button--quiet tune-editor__reset">Reset to normal</button>
    </div>
  </section>`;
  document.body.append(dialog);

  const find = (name) => dialog.querySelector('.tune-editor__' + name);
  const soundEl = find('sound');
  const speedEl = find('speed');
  const speedValueEl = find('speed-value');
  const separateEl = find('separate');
  const hintEl = find('hint');
  const pitchRowEl = find('pitch-row');
  const pitchEl = find('pitch');
  const pitchValueEl = find('pitch-value');
  const messageEl = find('message');
  const resetEl = find('reset');

  let session = null; // { trigger, onChange, onPreview, onClose }

  const speed = () => core.speedFromSlider(Number(speedEl.value));
  const pitch = () => core.pitchFromSlider(Number(pitchEl.value));
  const currentTune = () => core.normalize(speed(), separateEl.checked ? pitch() : undefined);

  function setMessage(text) {
    messageEl.textContent = text || '';
    messageEl.hidden = !text;
  }

  function showValues() {
    speedValueEl.textContent = core.formatSpeed(speed());
    pitchValueEl.textContent = core.formatPitch(pitch());
    hintEl.textContent = separateEl.checked ? SEPARATE_HINT : LINKED_HINT;
    pitchRowEl.hidden = !separateEl.checked;
    resetEl.disabled = currentTune() === null && !separateEl.checked;
  }

  function showTune(tune) {
    speedEl.value = core.speedToSlider(tune ? tune.speed : 1);
    separateEl.checked = Boolean(tune && tune.pitch !== undefined);
    pitchEl.value = core.pitchToSlider(tune && tune.pitch !== undefined ? tune.pitch : 1);
    showValues();
  }

  function commit() {
    showValues();
    setMessage(session.onChange(currentTune()));
  }

  function close() {
    const { trigger, onClose } = session;
    session = null;
    dialog.close();
    onClose();
    if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  speedEl.addEventListener('input', showValues);
  pitchEl.addEventListener('input', showValues);
  speedEl.addEventListener('change', commit);
  pitchEl.addEventListener('change', commit);
  separateEl.addEventListener('change', commit);

  resetEl.addEventListener('click', () => {
    showTune(null);
    commit();
    separateEl.focus({ preventScroll: true });
  });

  find('preview').addEventListener('click', () => {
    setMessage('');
    session.onPreview(currentTune());
  });

  find('done').addEventListener('click', close);

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  // The dialog's keys belong to it, not to the page's shortcuts.
  dialog.addEventListener('keydown', (event) => event.stopPropagation());

  window.TuneEditor = {
    isOpen: () => dialog.open,

    // options: { name, tune, trigger, onChange, onPreview, onClose }
    // onChange(tune) gets null for normal, and returns what went wrong, or nothing if it worked.
    open(options) {
      if (dialog.open) return;
      session = options;
      soundEl.textContent = options.name;
      setMessage('');
      showTune(options.tune);
      dialog.showModal();
      speedEl.focus({ preventScroll: true });
    },

    setMessage,
  };
})();
