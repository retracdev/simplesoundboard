/*
 * A little terminal. Press ` (backtick) to open or close it, type a command, press Enter.
 *
 *   startupdate  plays a full app update (loading screen, restart, "updated" toast), even
 *                when there's no new version
 *   version      shows the running version
 *   logs [n]     shows the last n console messages (default 50), including failed updates
 *   copylogs     copies every console message to the clipboard
 *   help         lists the commands
 *   clear        empties the screen
 *   exit         closes the terminal (so does Escape, or ` with an empty line)
 */
(function () {
  'use strict';

  const COMMANDS = {
    help: () => [
      'version      show the running version',
      'startupdate  play a full app update',
      'logs [n]     show the last n console messages (default 50)',
      'copylogs     copy every console message to the clipboard',
      'clear        empty the screen',
      'exit         close the terminal',
    ],
    version: () => {
      const updater = window.SoundboardLiveUpdate;
      const meta = document.querySelector('meta[name="soundboard-version"]');
      const version = (updater && updater.version) || (meta && meta.content);
      return [version ? 'Simple Soundboard version ' + version : 'The version isn’t known here.'];
    },
    logs: (count) => {
      const all = readLogs();
      if (!all) return ['Logs aren’t available here.'];
      if (!all.length) return ['Nothing has been logged.'];
      const shown = all.slice(-Math.max(1, Number.parseInt(count, 10) || 50));
      if (shown.length < all.length) print('Showing the last ' + shown.length + ' of ' + all.length + '. Use "logs ' + all.length + '" for all.', 'muted');
      shown.forEach((entry) => print(formatLog(entry), entry.level));
      return [];
    },
    copylogs: () => {
      const all = readLogs();
      if (!all || !all.length) return ['Nothing to copy.'];
      const text = all.map(formatLog).join('\n');
      if (!navigator.clipboard) return ['Copying isn’t available here. Use "logs" instead.'];
      navigator.clipboard.writeText(text).then(
        () => print('Copied ' + all.length + ' messages.'),
        () => print('Couldn’t copy. Use "logs" instead.'),
      );
      return [];
    },
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
      updater.simulateUpdate().catch((error) => {
        console.warn('Simple Soundboard: startupdate failed.', error);
        print('Couldn’t start the update: ' + (error && error.message ? error.message : error));
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

  function readLogs() {
    const updater = window.SoundboardLiveUpdate;
    return updater && typeof updater.logs === 'function' ? updater.logs() : null;
  }

  function formatLog(entry) {
    const time = new Date(entry.time).toTimeString().slice(0, 8);
    return time + ' ' + entry.level.toUpperCase().padEnd(5) + ' ' + entry.text;
  }

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
    const [name, ...args] = command.split(/\s+/);
    const run = Object.prototype.hasOwnProperty.call(COMMANDS, name.toLowerCase()) && COMMANDS[name.toLowerCase()];
    if (!run) {
      print('Unknown command: ' + name + '. Type "help" for commands.');
      return;
    }
    run(...args).forEach((text) => print(text));
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
