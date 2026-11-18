/*
 * A little terminal. Press ` (backtick) to open or close it, type a command, press Enter.
 *
 *   startupdate  plays a full app update (loading screen, restart, "updated" toast), even
 *                when there's no new version
 *   help         lists the commands
 *   clear        empties the screen
 *   exit         closes the terminal (so does Escape, or ` with an empty line)
 */
(function () {
  'use strict';

  const COMMANDS = {
    help: () => ['startupdate  play a full app update', 'clear        empty the screen', 'exit         close the terminal'],
    clear: () => {
      output.textContent = '';
      return [];
    },
    exit: () => {
      close();
      return [];
    },
    startupdate: () => {
      const updater = window.SoundboardLiveUpdate;
      if (!updater || typeof updater.simulateUpdate !== 'function') return ['Live updates aren’t available here.'];
      updater.simulateUpdate().catch(() => {
        print('Couldn’t start the update. Check your connection and try again.');
      });
      return ['Starting update…'];
    },
  };

  const panel = document.createElement('div');
  panel.className = 'terminal';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Terminal');
  const output = document.createElement('div');
  output.className = 'terminal__output';
  output.setAttribute('role', 'log');
  output.setAttribute('aria-live', 'polite');
  const form = document.createElement('form');
  form.className = 'terminal__line';
  const prompt = document.createElement('span');
  prompt.className = 'terminal__prompt';
  prompt.setAttribute('aria-hidden', 'true');
  prompt.textContent = '>';
  const input = document.createElement('input');
  input.className = 'terminal__input';
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Command');
  form.append(prompt, input);
  panel.append(output, form);
  document.body.append(panel);

  let returnFocus = null;

  function print(text, kind) {
    const line = document.createElement('div');
    line.className = 'terminal__text' + (kind ? ' terminal__text--' + kind : '');
    line.textContent = text;
    output.append(line);
    output.scrollTop = output.scrollHeight;
  }

  function open() {
    returnFocus = document.activeElement;
    panel.hidden = false;
    if (!output.childElementCount) print('Type "help" for commands.', 'muted');
    input.focus();
  }

  function close() {
    panel.hidden = true;
    input.value = '';
    if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const command = input.value.trim();
    input.value = '';
    if (!command) return;
    print('> ' + command, 'muted');
    const run = COMMANDS[command.toLowerCase()];
    if (!run) {
      print('Unknown command: ' + command + '. Type "help" for commands.');
      return;
    }
    run().forEach((text) => print(text));
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' || (event.key === '`' && !input.value)) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== '`' || event.ctrlKey || event.metaKey || event.altKey || !panel.hidden) return;
    const target = event.target;
    // Typing a backtick into a field, or with a dialog open, is just typing.
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (document.querySelector('dialog[open]')) return;
    event.preventDefault();
    open();
  });
})();
