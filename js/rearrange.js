/*
 * The "Rearrange top favorites" menu and dialog.
 *
 * The arrangement is one ordered list: the first five sit in the numbered slots and the rest
 * wait below. Moving a card just changes its place in that list, so cards cross between the
 * slots and the others naturally, and the top five are never left with a gap.
 *
 * Dragging uses pointer events rather than the browser's own drag and drop, which doesn't
 * work on touch screens and can't animate the other cards out of the way.
 */
(function () {
  'use strict';

  const TOP_SIZE = 5;
  const LIFT_DISTANCE_PX = 4; // A mouse has to actually move before a press becomes a drag.
  const TOUCH_HOLD_MS = 180; // A finger has to pause first, or it couldn't scroll the list.
  const TOUCH_SLOP_PX = 8;
  const MAX_FLOAT_TILT_DEGREES = 7;
  const SCROLL_EDGE_PX = 44;
  const SCROLL_SPEED_PX = 9;
  const FLIP_MS = 240;
  const LAND_MS = 180;
  const EASE = 'cubic-bezier(.2, .8, .2, 1)';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canAnimate = () => !reducedMotion.matches && Boolean(Element.prototype.animate);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(id, className) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + id);
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    svg.appendChild(use);
    return svg;
  }

  // ---------- The right-click menu ----------

  let closeMenu = null;

  // options: { x, y, trigger, label, items: [{ icon, label, onSelect }] }
  function openMenu(options) {
    if (closeMenu) closeMenu(false);

    const menu = el('div', 'card-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', options.label);
    const buttons = options.items.map((entry) => {
      const item = el('button', 'card-menu__item');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.append(icon(entry.icon, 'card-menu__icon'), el('span', '', entry.label));
      item.addEventListener('click', () => {
        close(false);
        entry.onSelect();
      });
      menu.appendChild(item);
      return item;
    });
    document.body.appendChild(menu);

    // Stays on screen, opening up or to the left when there isn't room.
    const box = menu.getBoundingClientRect();
    const margin = 8;
    const left = options.x + box.width + margin > window.innerWidth ? options.x - box.width : options.x;
    const top = options.y + box.height + margin > window.innerHeight ? options.y - box.height : options.y;
    menu.style.left = Math.max(margin, left) + 'px';
    menu.style.top = Math.max(margin, top) + 'px';

    const onOutside = (event) => {
      if (!menu.contains(event.target)) close(false);
    };
    const onDismiss = () => close(false);

    function close(returnFocus) {
      closeMenu = null;
      menu.remove();
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('blur', onDismiss);
      if (returnFocus && options.trigger && options.trigger.isConnected) {
        options.trigger.focus({ preventScroll: true });
      }
    }
    closeMenu = close;

    menu.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + step + buttons.length) % buttons.length].focus({ preventScroll: true });
      }
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        close(true);
      }
    });
    menu.addEventListener('contextmenu', (event) => event.preventDefault());

    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('scroll', onDismiss, true);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('blur', onDismiss);
    buttons[0].focus({ preventScroll: true });
  }

  // ---------- The dialog ----------

  const dialog = el('dialog', 'rearrange');
  dialog.setAttribute('aria-labelledby', 'rearrange-title');
  dialog.setAttribute('aria-describedby', 'rearrange-help');
  const panel = el('div', 'rearrange__panel');
  const header = el('header', 'rearrange__header');
  const title = el('h2', 'rearrange__title', 'Rearrange top favorites');
  title.id = 'rearrange-title';
  const help = el('p', 'rearrange__help', 'Drag your favorites to choose which five sit at the top of your board, and in what order.');
  help.id = 'rearrange-help';
  header.append(title, help);

  const scroller = el('div', 'rearrange__scroll');
  const slotsEl = el('div', 'rearrange__slots');
  const slots = Array.from({ length: TOP_SIZE }, (_, i) => {
    const slot = el('div', 'rearrange__slot');
    slot.append(el('span', 'rearrange__rank', String(i + 1)), el('div', 'rearrange__socket'));
    slotsEl.appendChild(slot);
    return slot.lastChild;
  });
  const othersEl = el('section', 'rearrange__others');
  const poolEl = el('div', 'rearrange__pool');
  othersEl.append(el('h3', 'rearrange__subtitle', 'Other favorites'), poolEl);
  scroller.append(slotsEl, othersEl);

  const footer = el('footer', 'rearrange__footer');
  const resetButton = el('button', 'rearrange__reset', 'Back to newest first');
  resetButton.type = 'button';
  const actions = el('div', 'rearrange__actions');
  const cancelButton = el('button', 'signin-button signin-button--quiet', 'Cancel');
  cancelButton.type = 'button';
  const saveButton = el('button', 'signin-button', 'Save order');
  saveButton.type = 'button';
  actions.append(cancelButton, saveButton);
  footer.append(resetButton, actions);

  const announcer = el('p', 'sr-only');
  announcer.setAttribute('role', 'status');
  panel.append(header, scroller, footer, announcer);
  dialog.appendChild(panel);
  document.body.appendChild(dialog);

  let session = null; // { order, initial, newest, useNewest, tiles, describe, onSave, trigger }
  let drag = null;

  function buildTile(id) {
    const info = session.describe(id);
    const tile = el('button', 'key-slot rearrange__tile');
    tile.type = 'button';
    tile.dataset.id = id;
    tile.style.setProperty('--key', info.color);
    tile.style.setProperty('--key-side', info.side);
    const face = el('span', 'key__face');
    face.append(el('span', 'key__name', info.name), icon('icon-grip', 'rearrange__grip'));
    tile.append(el('span', 'key__well'), el('span', 'key__side'), face);
    return tile;
  }

  // Puts every card where the order says it belongs, moving only those that have to move
  // so that the card being dragged or focused isn't disturbed.
  function layout() {
    const { order, tiles } = session;
    order.forEach((id, i) => {
      const tile = tiles.get(id);
      const parent = i < TOP_SIZE ? slots[i] : poolEl;
      if (i < TOP_SIZE) {
        if (tile.parentNode !== parent) parent.replaceChildren(tile);
      } else if (poolEl.children[i - TOP_SIZE] !== tile) {
        poolEl.insertBefore(tile, poolEl.children[i - TOP_SIZE] || null);
      }
      tile.setAttribute('aria-label', `${session.describe(id).name}, position ${i + 1} of ${order.length}. Use the arrow keys to move it.`);
      tile.classList.toggle('is-top', i < TOP_SIZE);
    });
    slots.forEach((socket, i) => {
      if (i >= order.length) socket.replaceChildren();
    });
    othersEl.hidden = order.length <= TOP_SIZE;
    const changed = order.some((id, i) => id !== session.initial[i]);
    saveButton.disabled = !changed && !session.useNewest;
    resetButton.hidden = order.length < 2;
  }

  // Cards glide from their old spot to their new one. This measures each card, applies the
  // change, then animates from the difference, which also handles a card already moving.
  function withGlide(change) {
    if (!canAnimate()) {
      change();
      return;
    }
    const before = new Map();
    session.tiles.forEach((tile, id) => before.set(id, tile.getBoundingClientRect()));
    change();
    session.tiles.forEach((tile, id) => {
      if (drag && drag.lifted && drag.id === id) return;
      const was = before.get(id);
      tile.getAnimations().forEach((animation) => animation.cancel());
      const settled = tile.getBoundingClientRect();
      const dx = was.left - settled.left;
      const dy = was.top - settled.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      tile.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: FLIP_MS, easing: EASE },
      );
    });
  }

  function moveTo(id, index) {
    const { order } = session;
    const from = order.indexOf(id);
    const to = Math.max(0, Math.min(order.length - 1, index));
    if (from === to) return false;
    const focused = document.activeElement;
    withGlide(() => {
      order.splice(from, 1);
      order.splice(to, 0, id);
      session.useNewest = false;
      layout();
    });
    // Moving an element in the page drops its focus, so put it back.
    if (focused && focused !== document.activeElement && focused.isConnected) {
      focused.focus({ preventScroll: true });
    }
    return true;
  }

  function placeName(index) {
    return index < TOP_SIZE ? `top spot ${index + 1}` : 'other favorites';
  }

  // ---------- Dragging ----------

  // Cards are compared by where they sit in the layout, ignoring any glide in progress, so
  // a moving card can't make the target flicker back and forth.
  function indexAtPoint(x, y) {
    const { order } = session;
    const poolBox = poolEl.getBoundingClientRect();
    let best = 0;
    let bestDistance = Infinity;
    order.forEach((id, i) => {
      let cx;
      let cy;
      if (i < TOP_SIZE) {
        const box = slots[i].getBoundingClientRect();
        cx = box.left + box.width / 2;
        cy = box.top + box.height / 2;
      } else {
        const tile = session.tiles.get(id);
        cx = poolBox.left + tile.offsetLeft + tile.offsetWidth / 2;
        cy = poolBox.top + tile.offsetTop + tile.offsetHeight / 2;
      }
      const distance = Math.hypot(x - cx, y - cy);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    return best;
  }

  function positionFloat() {
    const tilt = canAnimate() ? drag.tilt : 0;
    drag.float.style.transform =
      `translate(${drag.x - drag.grabX}px, ${drag.y - drag.grabY}px) rotate(${tilt}deg) scale(1.06)`;
  }

  function lift() {
    const tile = session.tiles.get(drag.id);
    const box = tile.getBoundingClientRect();
    drag.lifted = true;
    drag.snapshot = [...session.order];
    drag.snapshotUseNewest = session.useNewest;
    drag.grabX = drag.startX - box.left;
    drag.grabY = drag.startY - box.top;
    drag.tilt = 0;

    const float = tile.cloneNode(true);
    float.classList.add('rearrange__float');
    float.removeAttribute('aria-label');
    float.setAttribute('aria-hidden', 'true');
    float.tabIndex = -1;
    float.style.width = box.width + 'px';
    float.style.height = box.height + 'px';
    drag.float = float;
    dialog.appendChild(float);
    positionFloat();

    tile.classList.add('is-lifted');
    dialog.classList.add('is-dragging');
    try {
      // Held on the dialog because the card itself moves around the page mid-drag.
      dialog.setPointerCapture(drag.pointerId);
    } catch (error) {
      // The pointer has already gone. The next event ends the drag.
    }
    drag.frame = window.requestAnimationFrame(autoScroll);
  }

  function dragToPointer() {
    moveTo(drag.id, indexAtPoint(drag.x, drag.y));
  }

  function autoScroll() {
    if (!drag || !drag.lifted) return;
    const box = scroller.getBoundingClientRect();
    let step = 0;
    if (drag.y < box.top + SCROLL_EDGE_PX) step = -SCROLL_SPEED_PX;
    else if (drag.y > box.bottom - SCROLL_EDGE_PX) step = SCROLL_SPEED_PX;
    if (step) {
      const before = scroller.scrollTop;
      scroller.scrollTop += step;
      if (scroller.scrollTop !== before) dragToPointer();
    }
    drag.frame = window.requestAnimationFrame(autoScroll);
  }

  function finishDrag(restore) {
    const finished = drag;
    drag = null;
    clearTimeout(finished.holdTimer);
    if (!finished.lifted) return;
    window.cancelAnimationFrame(finished.frame);
    dialog.classList.remove('is-dragging');
    try {
      dialog.releasePointerCapture(finished.pointerId);
    } catch (error) {
      // It had already been released.
    }

    if (restore) {
      withGlide(() => {
        session.order = finished.snapshot;
        session.useNewest = finished.snapshotUseNewest;
        layout();
      });
    }

    const tile = session.tiles.get(finished.id);
    const settle = () => {
      finished.float.remove();
      tile.classList.remove('is-lifted');
    };
    if (!canAnimate()) {
      settle();
    } else {
      // Drops back into its socket, wherever that ended up.
      const target = tile.getBoundingClientRect();
      finished.float.animate(
        [
          { transform: finished.float.style.transform },
          { transform: `translate(${target.left}px, ${target.top}px) rotate(0deg) scale(1)` },
        ],
        { duration: LAND_MS, easing: EASE, fill: 'forwards' },
      ).onfinish = settle;
    }

    const index = session.order.indexOf(finished.id);
    announcer.textContent = restore
      ? 'Move canceled.'
      : `${session.describe(finished.id).name} moved to ${placeName(index)}.`;
  }

  dialog.addEventListener('pointerdown', (event) => {
    if (drag) return;
    const tile = event.target.closest('.rearrange__tile');
    if (!tile || event.button !== 0 || tile.classList.contains('rearrange__float')) return;
    drag = {
      id: tile.dataset.id,
      pointerId: event.pointerId,
      touch: event.pointerType !== 'mouse',
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      lifted: false,
      holdTimer: null,
    };
    if (drag.touch) {
      drag.holdTimer = setTimeout(() => {
        if (drag) lift();
      }, TOUCH_HOLD_MS);
    }
  });

  dialog.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = event.clientX - drag.x;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.lifted) {
      const travel = Math.hypot(drag.x - drag.startX, drag.y - drag.startY);
      if (drag.touch) {
        // Moved before the pause was up, so this is a scroll and not a drag.
        if (travel > TOUCH_SLOP_PX) finishDrag(false);
        return;
      }
      if (travel < LIFT_DISTANCE_PX) return;
      lift();
    }
    // Leans into the direction of travel, and settles when the pointer slows down.
    const lean = Math.max(-MAX_FLOAT_TILT_DEGREES, Math.min(MAX_FLOAT_TILT_DEGREES, moved * 0.6));
    drag.tilt = drag.tilt * 0.7 + lean * 0.3;
    positionFloat();
    dragToPointer();
  });

  dialog.addEventListener('pointerup', (event) => {
    if (drag && event.pointerId === drag.pointerId) finishDrag(false);
  });
  dialog.addEventListener('pointercancel', (event) => {
    if (drag && event.pointerId === drag.pointerId) finishDrag(Boolean(drag.lifted));
  });

  // Once a finger has lifted a card, its movement is the drag and not a page scroll.
  dialog.addEventListener('touchmove', (event) => {
    if (drag && drag.lifted && event.cancelable) event.preventDefault();
  }, { passive: false });

  // ---------- Keyboard ----------

  dialog.addEventListener('keydown', (event) => {
    event.stopPropagation(); // The dialog's keys belong to it, not to the page's shortcuts.
    if (event.key === 'Escape' && drag && drag.lifted) {
      event.preventDefault();
      finishDrag(true);
      return;
    }
    const tile = event.target.closest && event.target.closest('.rearrange__tile');
    if (!tile) return;
    const index = session.order.indexOf(tile.dataset.id);
    const targets = {
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      Home: 0,
      End: session.order.length - 1,
    };
    if (!(event.key in targets)) return;
    event.preventDefault();
    if (moveTo(tile.dataset.id, targets[event.key])) {
      const now = session.order.indexOf(tile.dataset.id);
      announcer.textContent = `${session.describe(tile.dataset.id).name} moved to position ${now + 1} of ${session.order.length}, ${placeName(now)}.`;
      if (tile.scrollIntoView) tile.scrollIntoView({ block: 'nearest' });
    }
  });

  // ---------- Opening and closing ----------

  function closeDialog() {
    if (drag) finishDrag(false);
    const { trigger } = session;
    session = null;
    if (dialog.open) dialog.close();
    slots.forEach((socket) => socket.replaceChildren());
    poolEl.replaceChildren();
    dialog.querySelectorAll('.rearrange__float').forEach((float) => float.remove());
    announcer.textContent = '';
    if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  const isUnchanged = () => session.order.every((id, i) => id === session.initial[i]) && !session.useNewest;

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (drag && drag.lifted) finishDrag(true);
    else closeDialog();
  });

  // A stray click outside shouldn't throw away an arrangement someone just made.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && session && isUnchanged()) closeDialog();
  });

  cancelButton.addEventListener('click', closeDialog);

  saveButton.addEventListener('click', () => {
    const { order, useNewest, onSave } = session;
    const top = useNewest ? [] : order.slice(0, TOP_SIZE);
    closeDialog();
    onSave(top);
  });

  resetButton.addEventListener('click', () => {
    withGlide(() => {
      session.order = [...session.newest];
      session.useNewest = true;
      layout();
    });
    announcer.textContent = 'Back to newest first. Save to keep this.';
  });

  window.FavoritesRearrange = {
    openMenu,
    isOpen: () => dialog.open,

    // options: { order, newest, describe, onSave, trigger }. order is the current arrangement,
    // newest is the automatic one, and describe(id) gives { name, color, side }.
    open(options) {
      if (dialog.open) return;
      session = {
        order: [...options.order],
        initial: [...options.order],
        newest: [...options.newest],
        useNewest: false,
        tiles: new Map(),
        describe: options.describe,
        onSave: options.onSave,
        trigger: options.trigger,
      };
      session.order.forEach((id) => session.tiles.set(id, buildTile(id)));
      layout();
      dialog.showModal();
      scroller.scrollTop = 0;
      const first = session.tiles.get(session.order[0]);
      if (first) first.focus({ preventScroll: true });
    },
  };
})();
