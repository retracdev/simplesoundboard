/* Toasts: small glass pills that rise into the bottom-right corner and stack.
 *
 *   SoundboardToasts.show({ text, name, icon, duration, until, key })
 *
 * - text: the message. name: optional bold prefix that truncates first (user names).
 * - icon: optional leading icon: status dots 'online' | 'idle' | 'offline',
 *   or 'warning' for a yellow warning sign.
 * - until: a timestamp; shows a live "12s" countdown and closes when it ends.
 * - duration: milliseconds before closing when there is no countdown (default 4500).
 * - key: showing a key that is already on screen updates that toast in place
 *   instead of stacking a new one.
 *
 * Returns { dismiss() }. All text is set with textContent, never as HTML.
 */
(() => {
  'use strict';

  const DEFAULT_DURATION = 4500;
  const MAX_VISIBLE = 4;
  const LEAVE_MS = 320;
  const ICONS = ['online', 'idle', 'offline', 'warning'];
  const WARNING_SVG = '<svg viewBox="0 0 16 16" focusable="false"><path d="M8 1.6c.5 0 .95.27 1.2.7l5.9 10.3c.5.9-.15 2-1.2 2H2.1c-1.05 0-1.7-1.1-1.2-2L6.8 2.3c.25-.43.7-.7 1.2-.7Z" fill="currentColor"/><path d="M8 5.6v4" stroke="#1a1408" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="12.1" r="1" fill="#1a1408"/></svg>';
  const keyed = new Map();
  const visible = [];
  let region = null;

  function container() {
    if (region && region.isConnected) return region;
    region = document.createElement('div');
    region.className = 'toasts';
    region.setAttribute('aria-live', 'polite');
    // Announce new toasts only, not every countdown tick.
    region.setAttribute('aria-relevant', 'additions');
    document.body.append(region);
    return region;
  }

  function reducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function dismiss(toast) {
    if (toast.gone) return;
    toast.gone = true;
    clearTimeout(toast.timer);
    clearInterval(toast.ticker);
    if (toast.key && keyed.get(toast.key) === toast) keyed.delete(toast.key);
    const index = visible.indexOf(toast);
    if (index !== -1) visible.splice(index, 1);
    if (reducedMotion()) {
      toast.node.remove();
      return;
    }
    toast.node.classList.add('is-leaving');
    setTimeout(() => toast.node.remove(), LEAVE_MS);
  }

  function render(toast, options) {
    const { node } = toast;
    const icon = node.querySelector('.toast__icon');
    const kind = ICONS.includes(options.icon) ? options.icon : null;
    icon.className = 'toast__icon' + (kind ? ' toast__icon--' + kind : '');
    // Static, trusted markup only; never caller-supplied HTML.
    icon.innerHTML = kind === 'warning' ? WARNING_SVG : '';
    icon.hidden = !kind;
    const name = node.querySelector('.toast__name');
    name.textContent = options.name || '';
    name.hidden = !options.name;
    node.querySelector('.toast__message').textContent = options.text || '';

    clearTimeout(toast.timer);
    clearInterval(toast.ticker);
    const time = node.querySelector('.toast__time');
    if (Number.isFinite(options.until)) {
      time.hidden = false;
      let shown = null;
      const tick = () => {
        const seconds = Math.ceil((options.until - Date.now()) / 1000);
        if (seconds <= 0) {
          dismiss(toast);
          return;
        }
        if (seconds !== shown) {
          shown = seconds;
          time.textContent = seconds + 's';
        }
      };
      toast.ticker = setInterval(tick, 250);
      tick();
    } else {
      time.hidden = true;
      toast.timer = setTimeout(() => dismiss(toast), options.duration || DEFAULT_DURATION);
    }
  }

  function show(options = {}) {
    const existing = options.key && keyed.get(options.key);
    if (existing) {
      render(existing, options);
      return { dismiss: () => dismiss(existing) };
    }

    const node = document.createElement('div');
    node.className = 'toast';
    const pill = document.createElement('div');
    pill.className = 'toast__pill';
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'toast__text';
    const name = document.createElement('strong');
    name.className = 'toast__name';
    const message = document.createElement('span');
    message.className = 'toast__message';
    text.append(name, message);
    const time = document.createElement('span');
    time.className = 'toast__time';
    time.setAttribute('aria-hidden', 'true');
    pill.append(icon, text, time);
    node.append(pill);
    icon.className = 'toast__icon';

    const toast = { node, key: options.key || null, gone: false, timer: null, ticker: null };
    if (toast.key) keyed.set(toast.key, toast);
    visible.push(toast);
    render(toast, options);
    if (toast.gone) return { dismiss() {} };
    container().append(node);
    while (visible.length > MAX_VISIBLE) dismiss(visible[0]);
    return { dismiss: () => dismiss(toast) };
  }

  window.SoundboardToasts = { show };
})();
