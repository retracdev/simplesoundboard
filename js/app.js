/*
 * Builds the page from the catalog and drives the keys.
 *
 * A key's position comes straight from the audio clock, not from a CSS timer, so it
 * reaches the top exactly as the sound ends, whatever that sound's length turns out to be.
 */
(function () {
  'use strict';

  const { categories, sounds } = window.SOUND_CATALOG;
  const engine = window.SoundEngine;
  const account = window.RetracAccount;
  const favorites = window.SoundFavorites;
  const signIn = window.SoundSignIn;

  const PRESS_MS = 70; // How fast a key sinks when hit.
  const MIN_RISE_SECONDS = 0.22; // Very short sounds still get a visible pop back up.
  const RELEASE_MS = 170; // How fast a key returns when stopped early.
  const MAX_TILT_DEGREES = 7;
  const WAVE_BARS = 20;
  const VOLUME_KEY = 'simple-soundboard:volume';
  const INTENT_KEY = 'simple-soundboard:favorite-after-sign-in';
  const INTENT_MAX_AGE_MS = 30 * 60 * 1000;
  const SESSION_RECHECK_MS = 30000;
  const NOTE_ICONS = ['icon-note-eighth', 'icon-note-beamed', 'icon-note-quarter'];
  const RIBBON_MIN_WORDS = 40; // Enough to fill the ticker on an ultrawide monitor.
  // [face, shadow] pairs for the title and floating notes, independent of the categories.
  const CANDY = [
    ['#35d6c8', '#12877c'], ['#ab8fff', '#6442c9'], ['#ff7eb6', '#c0407b'],
    ['#ffc93c', '#bd8406'], ['#ff8360', '#bf4526'], ['#93e571', '#479c2c'],
  ];

  const $ = (id) => document.getElementById(id);
  const banksEl = $('banks');
  const chipsEl = $('chips');
  const searchEl = $('search');
  const statusEl = $('status');
  const emptyEl = $('empty');
  const emptyTextEl = $('emptyText');
  const emptyTitleEl = $('emptyTitle');
  const emptyIconEl = $('emptyIcon');
  const favoritesNoteEl = $('favoritesNote');
  const stopAllEl = $('stopAll');
  const volumeEl = $('volume');
  const burstEl = $('burst');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const soundById = new Map(sounds.map((sound) => [sound.id, sound]));

  const keys = new Map(); // sound id -> { slotEl, el, heartEl, timeEl, baseEl, litEl, duration, lastLabel }
  const live = new Map(); // sound id -> the run animating that key
  const banks = new Map(); // category id -> { el, countEl, chipCountEl }
  const filter = { category: 'all', query: '' };

  // ---------- DOM helpers ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(id) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }

  function formatSeconds(seconds) {
    if (seconds < 10) return seconds.toFixed(1) + 's';
    if (seconds < 60) return Math.round(seconds) + 's';
    const whole = Math.round(seconds);
    return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
  }

  function plural(count) {
    return count + (count === 1 ? ' sound' : ' sounds');
  }

  // ---------- Title, floating notes, ticker ----------

  function buildTitle() {
    const art = $('titleArt');
    let index = 0;
    [['Simple', true], ['Soundboard', false]].forEach(([word, isPlain]) => {
      const line = el('span', 'title__line' + (isPlain ? ' title__line--small' : ''));
      Array.from(word).forEach((character, i) => {
        const letter = el('span', 'letter', character);
        const [color, side] = isPlain ? ['#f3f0ff', '#8b86a3'] : CANDY[i % CANDY.length];
        letter.style.setProperty('--c', color);
        letter.style.setProperty('--d', side);
        letter.style.setProperty('--i', index);
        letter.style.setProperty('--tw', (index % 2 ? 2.6 : -2.6) + 'deg');
        line.appendChild(letter);
        index++;
      });
      art.appendChild(line);
    });
  }

  function buildHeroNotes() {
    const layout = [
      [4, 12, 40, 8.5], [14, 62, 26, 11], [22, 8, 22, 7.5], [9, 80, 30, 10],
      [80, 10, 36, 9], [90, 58, 28, 12], [74, 66, 22, 8], [94, 16, 24, 10.5],
      [32, 74, 20, 9.5], [66, 4, 24, 11.5],
    ];
    const notes = $('heroNotes');
    layout.forEach(([x, y, size, seconds], i) => {
      const note = icon(NOTE_ICONS[i % NOTE_ICONS.length]);
      note.classList.add('hero-note');
      const { style } = note;
      style.setProperty('--x', x + '%');
      style.setProperty('--y', y + '%');
      style.setProperty('--s', size + 'px');
      style.setProperty('--t', seconds + 's');
      style.setProperty('--w', -i * 1.3 + 's');
      style.setProperty('--c', CANDY[i % CANDY.length][0]);
      notes.appendChild(note);
    });
  }

  function buildRibbon() {
    const track = $('ribbonTrack');
    const set = el('div', 'ribbon__set');
    const words = Math.max(sounds.length, RIBBON_MIN_WORDS);
    for (let i = 0; i < words; i++) {
      set.appendChild(el('span', 'ribbon__word', sounds[i % sounds.length].name.toLowerCase()));
      set.appendChild(icon(NOTE_ICONS[i % NOTE_ICONS.length]));
    }
    track.appendChild(set);
    track.appendChild(set.cloneNode(true)); // The second copy makes the loop seamless.
  }

  // ---------- Keys, banks, chips ----------

  function waveformPath(values) {
    return values.map((value, i) => {
      const x = i * 2 + 1;
      const height = Math.max(0.5, value * 11);
      return 'M' + x + ' ' + (12 - height).toFixed(2) + 'V' + (12 + height).toFixed(2);
    }).join('');
  }

  function buildKey(sound) {
    const button = el('button', 'key');
    button.type = 'button';
    button.dataset.id = sound.id;
    button.setAttribute('aria-label', 'Start ' + sound.name);

    const tilt = el('span', 'key__tilt');
    const face = el('span', 'key__face');
    const foot = el('span', 'key__foot');
    const wave = el('span', 'key__wave');
    const time = el('span', 'key__time', '–');

    const svgNS = 'http://www.w3.org/2000/svg';
    const paths = ['wave-base', 'wave-lit'].map((className) => {
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + WAVE_BARS * 2 + ' 24');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('class', className);
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', waveformPath(new Array(WAVE_BARS).fill(0)));
      svg.appendChild(path);
      wave.appendChild(svg);
      return path;
    });

    foot.append(wave, time);
    face.append(el('span', 'key__name', sound.name), foot);
    tilt.append(el('span', 'key__well'), el('span', 'key__side'), face);
    button.appendChild(tilt);

    // The key is already a button and buttons can't nest, so the heart sits beside it in
    // its own layer. That layer sinks and tilts along with the key's face.
    const heart = el('button', 'key__heart');
    heart.type = 'button';
    heart.dataset.favorite = sound.id;
    heart.setAttribute('aria-label', 'Favorite ' + sound.name);
    heart.setAttribute('aria-pressed', 'false');
    heart.appendChild(icon('icon-heart'));
    const heartLayer = el('span', 'key__heart-layer');
    heartLayer.appendChild(heart);

    const slot = el('div', 'key-slot');
    slot.append(button, heartLayer);

    keys.set(sound.id, {
      slotEl: slot,
      el: button,
      heartEl: heart,
      timeEl: time,
      baseEl: paths[0],
      litEl: paths[1],
      duration: null,
      lastLabel: '',
    });
    return slot;
  }

  function buildChip(id, label, category) {
    const chip = el('button', 'chip');
    chip.type = 'button';
    chip.dataset.category = id;
    chip.setAttribute('aria-pressed', String(id === filter.category));
    if (category) {
      chip.style.setProperty('--key', category.color);
      chip.style.setProperty('--key-side', category.side);
    }
    const count = el('span', 'chip__count');
    chip.append(el('span', 'chip__dot'), el('span', '', label), count);
    chipsEl.appendChild(chip);
    return count;
  }

  function buildBoard() {
    banks.set('all', { chipCountEl: buildChip('all', 'All') });
    banks.set('favorites', { chipCountEl: buildChip('favorites', 'Favorites') });
    const favoritesChip = favoritesChipEl();
    favoritesChip.hidden = true;
    favoritesChip.querySelector('.chip__dot').replaceWith(icon('icon-heart'));
    categories.forEach((category) => {
      const bank = el('section', 'bank');
      bank.style.setProperty('--key', category.color);
      bank.style.setProperty('--key-side', category.side);
      bank.setAttribute('aria-label', category.label);

      const head = el('div', 'bank__head');
      const count = el('span', 'bank__count');
      head.append(el('h2', 'bank__title', category.label), count);

      const grid = el('div', 'bank__keys');
      const members = sounds.filter((sound) => sound.category === category.id);
      members.forEach((sound) => grid.appendChild(buildKey(sound)));
      bank.style.setProperty('--n', members.length);

      bank.append(head, grid);
      banksEl.appendChild(bank);
      banks.set(category.id, {
        el: bank,
        countEl: count,
        chipCountEl: buildChip(category.id, category.label, category),
      });
    });
  }

  function paintKey(sound, buffer) {
    const key = keys.get(sound.id);
    const path = waveformPath(engine.peaks(buffer, WAVE_BARS));
    key.duration = buffer.duration;
    key.baseEl.setAttribute('d', path);
    key.litEl.setAttribute('d', path);
    if (!live.has(sound.id)) key.timeEl.textContent = formatSeconds(buffer.duration);
  }

  // Fetches every sound, one at a time, so each key can show its waveform and length
  // before it's pressed. A press on a sound still waiting jumps the queue.
  async function loadAll() {
    let failed = false;
    for (const sound of sounds) {
      try {
        paintKey(sound, await engine.load(sound));
      } catch (error) {
        failed = true;
        console.warn('Could not load "' + sound.name + '"', error);
      }
    }
    // Browsers block fetch on file:// pages, so point local previews at the fix.
    if (failed && window.location.protocol === 'file:') {
      statusEl.textContent = 'Sounds can’t load from a file:// page. Run “npx serve .” in this folder and open that address.';
    }
  }

  // ---------- Search and categories ----------

  function normalize(text) {
    return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  }

  const searchText = new Map(sounds.map((sound) => [
    sound.id,
    normalize([sound.name, categoryById.get(sound.category).label, sound.tags || ''].join(' ')),
  ]));

  function setEmptyState(icon, title, text) {
    emptyIconEl.setAttribute('href', '#' + icon);
    emptyTitleEl.textContent = title;
    emptyTextEl.textContent = text;
  }

  function showEmptyState() {
    const query = filter.query.trim();
    if (filter.category !== 'favorites') {
      const where = filter.category === 'all' ? '' : ' in ' + categoryById.get(filter.category).label;
      setEmptyState('icon-note-eighth', 'Total silence.',
        query ? 'Nothing' + where + ' matches “' + query + '”.' : 'Nothing' + where + ' yet.');
    } else if (query) {
      setEmptyState('icon-heart', 'No matching favorites.', 'Nothing in your favorites matches “' + query + '”.');
    } else if (!favorites.isLoaded()) {
      // Until the save has been read, "you have none" might simply not be true.
      setEmptyState('icon-heart', 'Your favorites', favorites.getStatus() === 'ok'
        ? 'Getting your favorites…' : 'We can’t show your favorites just now.');
    } else {
      setEmptyState('icon-heart', 'No favorites yet.', 'Tap the heart on any sound to keep it here.');
    }
  }

  function applyFilter() {
    const terms = normalize(filter.query).split(/\s+/).filter(Boolean);
    const inQuery = (sound) => terms.every((term) => searchText.get(sound.id).includes(term));
    const onlyFavorites = filter.category === 'favorites';

    let visible = 0;
    let matches = 0;
    let favoriteMatches = 0;
    const perCategory = new Map(categories.map((category) => [category.id, 0]));
    const shownPerCategory = new Map(categories.map((category) => [category.id, 0]));

    sounds.forEach((sound) => {
      const matchesQuery = inQuery(sound);
      const favorite = favorites.isFavorite(sound.id);
      const show = matchesQuery && (onlyFavorites ? favorite :
        filter.category === 'all' || filter.category === sound.category);
      keys.get(sound.id).slotEl.hidden = !show;
      if (matchesQuery) {
        matches++;
        if (favorite) favoriteMatches++;
        perCategory.set(sound.category, perCategory.get(sound.category) + 1);
      }
      if (show) {
        visible++;
        shownPerCategory.set(sound.category, shownPerCategory.get(sound.category) + 1);
      }
    });

    banks.get('all').chipCountEl.textContent = matches;
    banks.get('favorites').chipCountEl.textContent = favoriteMatches;
    categories.forEach((category) => {
      const bank = banks.get(category.id);
      const count = onlyFavorites ? shownPerCategory.get(category.id) : perCategory.get(category.id);
      const shown = onlyFavorites || filter.category === 'all' || filter.category === category.id;
      bank.chipCountEl.textContent = perCategory.get(category.id);
      bank.countEl.textContent = plural(count);
      bank.el.hidden = !shown || count === 0;
    });

    emptyEl.hidden = visible > 0;
    if (visible === 0) showEmptyState();

    const label = filter.query.trim() ? plural(visible) + ' for “' + filter.query.trim() + '”' : plural(visible);
    statusEl.textContent = label;
  }

  function setCategory(id) {
    filter.category = id;
    chipsEl.querySelectorAll('.chip').forEach((chip) => {
      chip.setAttribute('aria-pressed', String(chip.dataset.category === id));
    });
    applyFilter();
  }

  function resetFilter() {
    searchEl.value = '';
    filter.query = '';
    setCategory('all');
  }

  // ---------- Favorites ----------

  function favoritesChipEl() {
    return chipsEl.querySelector('.chip[data-category="favorites"]');
  }

  function renderFavorites() {
    keys.forEach((key, id) => {
      key.heartEl.setAttribute('aria-pressed', String(favorites.isFavorite(id)));
    });

    const focused = document.activeElement;
    const hadHeartFocus = focused && focused.classList.contains('key__heart');
    applyFilter();
    // Unfavoriting inside the Favorites filter removes the heart that was just clicked.
    if (hadHeartFocus && focused.closest('[hidden]')) {
      const chip = favoritesChipEl();
      if (!chip.hidden) chip.focus({ preventScroll: true });
    }

    const message = {
      retrying: favorites.hasUnsaved()
        ? 'Your favorites haven’t saved yet. We’ll keep trying.'
        : 'We couldn’t get your favorites yet. We’ll keep trying.',
      paused: favorites.hasUnsaved()
        ? 'Your favorites haven’t saved yet. We’ll try again when you come back.'
        : 'We couldn’t get your favorites yet. We’ll try again when you come back.',
      blocked: 'Your favorites can’t be updated right now.',
      signin: 'Sign in again to save your favorites.',
      setup: 'Finish setting up your account to save your favorites.',
    }[favorites.getStatus()];
    favoritesNoteEl.textContent = message || '';
    favoritesNoteEl.hidden = !message;
  }

  let pendingIntent = null;

  // Remembers which sound to favorite after signing in. It's kept for this tab only, so
  // it survives a phone discarding the tab while the visitor is off signing in.
  function rememberIntent(id) {
    try {
      window.sessionStorage.setItem(INTENT_KEY, JSON.stringify({ id, at: Date.now() }));
    } catch (error) {
      // Without storage, this sound just won't be favorited automatically after a discard.
    }
    pendingIntent = id;
  }

  function readIntent() {
    if (pendingIntent) return pendingIntent;
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(INTENT_KEY));
      if (saved && soundById.has(saved.id) && Date.now() - saved.at < INTENT_MAX_AGE_MS) return saved.id;
    } catch (error) {
      // Nothing usable was stored.
    }
    return null;
  }

  function clearIntent() {
    pendingIntent = null;
    try {
      window.sessionStorage.removeItem(INTENT_KEY);
    } catch (error) {
      // Nothing to clear.
    }
  }

  async function onHeartClick(heart) {
    const id = heart.dataset.favorite;
    let state = account.getState();
    if (state.status === 'unknown' || state.status === 'error') state = await account.check();
    if (state.status === 'authenticated') {
      favorites.toggle(id);
      return;
    }
    rememberIntent(id);
    signIn.open({
      stage: state.status === 'guest' ? 'confirm' : state.status,
      trigger: heart,
      onCancel: clearIntent,
    });
  }

  function onAccountChange(state) {
    const signedIn = state.status === 'authenticated';
    if (signedIn || state.status === 'guest' || state.status === 'incomplete') {
      favorites.setAccount(signedIn ? state.username : null);
    }
    // A failed check says nothing about who is signed in, so it changes nothing here.
    if (state.status !== 'error') {
      favoritesChipEl().hidden = !signedIn;
      if (!signedIn && filter.category === 'favorites') setCategory('all');
    }
    if (signedIn) {
      const intended = readIntent();
      clearIntent();
      // Adds rather than flips, so a sound that's already a favorite can't get removed.
      // The add is applied on top of the cloud save, once that has been read.
      if (intended) favorites.add(intended);
      if (signIn.isOpen()) signIn.finish();
    }
  }

  let lastSessionCheck = 0;

  function checkSession() {
    lastSessionCheck = Date.now();
    return account.check();
  }

  // Coming back to the tab or the network is the moment to catch up: another tab may have
  // signed in or out, and any saves that failed can have another go.
  function onReturn() {
    if (document.hidden) return;
    if (!signIn.isOpen() && (readIntent() || Date.now() - lastSessionCheck >= SESSION_RECHECK_MS)) {
      checkSession();
    }
    favorites.resume();
  }

  // ---------- Pressing keys ----------

  let frameRequested = false;

  function requestFrame() {
    if (!frameRequested) {
      frameRequested = true;
      window.requestAnimationFrame(tick);
    }
  }

  function setTimeLabel(key, seconds) {
    const label = formatSeconds(Math.max(0, seconds));
    if (label !== key.lastLabel) {
      key.lastLabel = label;
      key.timeEl.textContent = label;
    }
  }

  function settle(id, run, spring) {
    const key = run.key;
    live.delete(id);
    key.slotEl.style.setProperty('--depth', 0);
    key.slotEl.style.setProperty('--progress', 0);
    key.lastLabel = '';
    key.timeEl.textContent = key.duration === null ? '–' : formatSeconds(key.duration);
    if (spring) {
      key.slotEl.classList.remove('is-pop');
      void key.slotEl.offsetWidth; // Restarts the animation if it's still running.
      key.slotEl.classList.add('is-pop');
    }
    stopAllEl.classList.toggle('is-armed', live.size > 0);
  }

  function tick() {
    frameRequested = false;
    const now = performance.now();

    live.forEach((run, id) => {
      let depth;
      let progress = 0;

      if (run.releasedAt !== null) {
        const t = (now - run.releasedAt) / RELEASE_MS;
        if (t >= 1) return settle(id, run, false);
        run.depth = run.releaseFrom * (1 - t);
        run.key.slotEl.style.setProperty('--depth', run.depth);
        return undefined;
      }

      const sunk = run.fromDepth + (1 - run.fromDepth) * Math.min(1, (now - run.pressedAt) / PRESS_MS);
      depth = sunk;

      if (run.voice) {
        const elapsed = run.voice.elapsed();
        const rise = elapsed / Math.max(run.voice.duration, MIN_RISE_SECONDS);
        if (rise >= 1) return settle(id, run, true);
        depth = Math.min(sunk, 1 - rise);
        progress = Math.min(1, elapsed / run.voice.duration);
        setTimeLabel(run.key, run.voice.duration - elapsed);
      }

      run.depth = depth;
      run.key.slotEl.style.setProperty('--depth', depth);
      run.key.slotEl.style.setProperty('--progress', progress);
      return undefined;
    });

    if (live.size > 0) requestFrame();
  }

  function press(sound) {
    const key = keys.get(sound.id);

    if (!engine.supported) {
      flagProblem(key, 'This browser can’t make sounds, sorry.');
      return;
    }
    engine.unlock();

    const previous = live.get(sound.id);
    const run = {
      key,
      voice: null,
      pressedAt: performance.now(),
      fromDepth: previous ? previous.depth : 0,
      depth: previous ? previous.depth : 0,
      releasedAt: null,
      releaseFrom: 0,
    };
    live.set(sound.id, run);
    key.slotEl.classList.remove('is-pop');
    key.el.classList.remove('is-broken');
    stopAllEl.classList.add('is-armed');
    requestFrame();
    celebrate(key.el, sound);

    engine.start(sound).then((voice) => {
      const current = live.get(sound.id);
      if (current === run && run.releasedAt === null) {
        run.voice = voice;
        if (key.duration === null) key.duration = voice.duration;
      } else if (!current || current.releasedAt !== null) {
        engine.stop(sound.id); // Stop all was hit while this sound was still loading.
      }
    }).catch((error) => {
      console.warn('Could not start "' + sound.name + '"', error);
      if (live.get(sound.id) === run) settle(sound.id, run, false);
      flagProblem(key, 'Couldn’t load “' + sound.name + '”. Press it to try again.');
    });
  }

  function flagProblem(key, message) {
    key.el.classList.remove('is-broken');
    void key.el.offsetWidth; // Restarts the shake if it's still running.
    key.el.classList.add('is-broken');
    statusEl.textContent = message;
  }

  function stopAll() {
    engine.stopAll();
    const now = performance.now();
    live.forEach((run) => {
      if (run.releasedAt === null) {
        run.releasedAt = now;
        run.releaseFrom = run.depth;
      }
    });
    stopAllEl.classList.remove('is-armed');
    requestFrame();
  }

  // A note hops off the key and a title letter jumps along with it.
  let hopIndex = 0;

  function celebrate(keyEl, sound) {
    if (reducedMotion.matches || !Element.prototype.animate) return;

    const box = keyEl.getBoundingClientRect();
    const note = icon(NOTE_ICONS[hopIndex % NOTE_ICONS.length]);
    const drift = (hopIndex % 2 ? 1 : -1) * (16 + (hopIndex * 11) % 26);
    note.style.left = box.left + box.width / 2 + 'px';
    note.style.top = box.top + 10 + 'px';
    note.style.fill = categoryById.get(sound.category).color;
    burstEl.appendChild(note);
    note.animate([
      { transform: 'translate(0, 0) scale(.5) rotate(-10deg)', opacity: 0 },
      { transform: 'translate(' + drift * 0.3 + 'px, -28px) scale(1.1) rotate(8deg)', opacity: 1, offset: 0.2 },
      { transform: 'translate(' + drift + 'px, -96px) scale(.85) rotate(-14deg)', opacity: 0 },
    ], { duration: 900, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => note.remove();

    const letters = document.querySelectorAll('.letter');
    letters[hopIndex % letters.length].animate([
      { translate: '0 0', scale: '1' },
      { translate: '0 -.22em', scale: '1.12', offset: 0.4 },
      { translate: '0 0', scale: '1' },
    ], { duration: 340, easing: 'ease-out' });

    hopIndex++;
  }

  // ---------- Events ----------

  /*
   * A mouse fires on pointerdown so the key responds instantly. Touch waits for the click,
   * or scrolling past a key with a thumb would set it off. Keyboard and assistive
   * technology arrive as clicks with detail === 0, and those always count.
   */
  let lastPointerType = '';

  banksEl.addEventListener('pointerdown', (event) => {
    lastPointerType = event.pointerType;
    const button = event.target.closest('.key');
    if (button && event.pointerType === 'mouse' && event.button === 0) {
      press(soundById.get(button.dataset.id));
    }
  });

  banksEl.addEventListener('click', (event) => {
    const heart = event.target.closest('.key__heart');
    if (heart) {
      onHeartClick(heart);
      return;
    }
    const button = event.target.closest('.key');
    if (!button) return;
    if (event.detail !== 0 && lastPointerType === 'mouse') return;
    press(soundById.get(button.dataset.id));
  });

  // Holding Enter or Space shouldn't machine-gun the sound.
  banksEl.addEventListener('keydown', (event) => {
    if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
  });

  banksEl.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse' || reducedMotion.matches) return;
    const slot = event.target.closest('.key-slot');
    if (!slot) return;
    const box = slot.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    // The key leans toward the pointer, as if weighed down where you're touching it.
    slot.style.setProperty('--rx', (0.5 - y) * 2 * MAX_TILT_DEGREES + 'deg');
    slot.style.setProperty('--ry', (x - 0.5) * 2 * MAX_TILT_DEGREES + 'deg');
  });

  banksEl.addEventListener('pointerout', (event) => {
    const slot = event.target.closest('.key-slot');
    if (!slot || slot.contains(event.relatedTarget)) return;
    slot.style.removeProperty('--rx');
    slot.style.removeProperty('--ry');
  });

  banksEl.addEventListener('animationend', (event) => {
    const slot = event.target.closest('.key-slot');
    if (slot && event.animationName === 'pop') slot.classList.remove('is-pop');
  });

  chipsEl.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (chip) setCategory(chip.dataset.category);
  });

  searchEl.addEventListener('input', () => {
    filter.query = searchEl.value;
    applyFilter();
  });

  $('emptyReset').addEventListener('click', () => {
    resetFilter();
    searchEl.focus();
  });

  stopAllEl.addEventListener('click', stopAll);

  document.addEventListener('keydown', (event) => {
    const typing = event.target === searchEl;
    if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      searchEl.focus();
    } else if (event.key === 'Escape') {
      if (typing && searchEl.value) {
        searchEl.value = '';
        filter.query = '';
        applyFilter();
      } else {
        stopAll();
      }
    }
  });

  // Some browsers only accept an audio unlock from certain gestures, so keep offering.
  ['pointerup', 'keydown'].forEach((type) => {
    document.addEventListener(type, () => {
      if (live.size > 0 && engine.supported) engine.unlock();
    });
  });

  // ---------- Volume ----------

  function readStoredVolume() {
    try {
      const stored = window.localStorage.getItem(VOLUME_KEY);
      const value = stored === null ? NaN : Number(stored);
      return value >= 0 && value <= 100 ? value : null;
    } catch (error) {
      return null; // Storage can be blocked, particularly on managed computers.
    }
  }

  function applyVolume(value) {
    volumeEl.style.setProperty('--fill', value + '%');
    // Squared, because hearing is logarithmic: the slider feels even across its range.
    engine.setVolume(Math.pow(value / 100, 2));
  }

  volumeEl.addEventListener('input', () => {
    const value = Number(volumeEl.value);
    applyVolume(value);
    try {
      window.localStorage.setItem(VOLUME_KEY, String(value));
    } catch (error) {
      // The slider still works for this visit without storage.
    }
  });

  // ---------- Start up ----------

  buildTitle();
  buildHeroNotes();
  buildRibbon();
  buildBoard();
  applyFilter();

  favorites.subscribe(renderFavorites);
  account.subscribe(onAccountChange);
  checkSession();

  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('focus', onReturn);
  window.addEventListener('online', onReturn);

  const storedVolume = readStoredVolume();
  if (storedVolume !== null) volumeEl.value = storedVolume;
  applyVolume(Number(volumeEl.value));

  if (engine.supported) {
    loadAll();
  } else {
    statusEl.textContent = 'This browser can’t make sounds, sorry.';
  }
})();
