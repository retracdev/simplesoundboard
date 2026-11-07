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
  const rearrange = window.FavoritesRearrange;
  const stringsCore = window.StringsCore;
  const stringsAccess = window.SoundStringsAccess;
  const stringEditor = window.StringEditor;

  const PRESS_MS = 70; // How fast a key sinks when hit.
  const MIN_RISE_SECONDS = 0.22; // Very short sounds still get a visible pop back up.
  const RELEASE_MS = 170; // How fast a key returns when stopped early.
  const MAX_TILT_DEGREES = 7;
  const WAVE_BARS = 20;
  const VOLUME_KEY = 'simple-soundboard:volume';
  const INTENT_KEY = 'simple-soundboard:favorite-after-sign-in';
  const INTENT_MAX_AGE_MS = 30 * 60 * 1000;
  const SESSION_RECHECK_MS = 30000;
  const LONG_PRESS_MS = 500; // Touch screens' stand-in for a right-click.
  const LONG_PRESS_SLOP_PX = 10;
  const MAX_GROUP_NOTES = 12; // Decoration only, so a huge group doesn't need one per sound.
  const FAVORITES_ROW_SIZE = 5; // A sixth spot goes to the "See all favorites" card.
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
  const emptySignInEl = $('emptySignIn');
  const emptyResetEl = $('emptyReset');
  const favoritesNoteEl = $('favoritesNote');
  const stopAllEl = $('stopAll');
  const everythingEl = $('everything');
  const volumeEl = $('volume');
  const burstEl = $('burst');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const soundById = new Map(sounds.map((sound) => [sound.id, sound]));

  // One sound can have several buttons on the page, such as its own category and the
  // Favorites row. Each is a "view", and they all sink, rise and light up together.
  // sound id -> { view, views, duration, lastLabel, path }
  // A view is { slotEl, el, heartEl, timeEl, baseEl, litEl }, and `view` is the category one.
  const keys = new Map();
  const favoritesRowViews = new Map(); // sound id -> that sound's view in the Favorites row
  let favoritesRow = null; // { el, countEl, gridEl, noteEl, noteTextEl, seeAllEl, seeAllCountEl }
  const live = new Map(); // sound id -> the run animating that key
  const banks = new Map(); // category id -> { el, countEl, chipCountEl }
  // key id -> { string, signature, sound, view } for each string's key. A string's key id is
  // "string:" plus its own id, and it's a regular entry in `keys` and `soundById` as well.
  const stringKeys = new Map();
  let stringsGridEl = null;
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

  function buildKeyView(sound) {
    const isString = Boolean(sound.clips);
    const button = el('button', 'key');
    button.type = 'button';
    button.dataset.id = sound.id;
    button.setAttribute('aria-label', 'Start ' + sound.name + (sound.summary ? ', with ' + sound.summary : ''));

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
    face.append(el('span', 'key__name', sound.name));
    if (sound.summary) face.append(el('span', 'key__summary', sound.summary));
    face.append(foot);
    tilt.append(el('span', 'key__well'), el('span', 'key__side'), face);
    button.appendChild(tilt);

    const slot = el('div', 'key-slot');
    if (isString) {
      slot.classList.add('key-slot--string');
      slot.style.setProperty('--key', sound.color);
      slot.style.setProperty('--key-side', sound.side);
      slot.style.setProperty('--string-fill', sound.fill);
      slot.style.setProperty('--string-side', sound.sideFill);
      slot.appendChild(button);
      return { slotEl: slot, el: button, heartEl: null, timeEl: time, baseEl: paths[0], litEl: paths[1] };
    }

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

    const category = categoryById.get(sound.category);
    slot.style.setProperty('--key', category.color);
    slot.style.setProperty('--key-side', category.side);
    slot.append(button, heartLayer);

    return { slotEl: slot, el: button, heartEl: heart, timeEl: time, baseEl: paths[0], litEl: paths[1] };
  }

  function buildKey(sound) {
    const view = buildKeyView(sound);
    keys.set(sound.id, { view, views: [view], duration: null, lastLabel: '', path: null });
    return view.slotEl;
  }

  // Built the first time a sound joins the row, then kept, so it stays in step with any
  // sound already running and with a press of its other copy.
  function favoritesRowView(sound) {
    if (favoritesRowViews.has(sound.id)) return favoritesRowViews.get(sound.id);
    const key = keys.get(sound.id);
    const view = buildKeyView(sound);
    const original = key.view;
    if (key.path) {
      view.baseEl.setAttribute('d', key.path);
      view.litEl.setAttribute('d', key.path);
    }
    view.timeEl.textContent = original.timeEl.textContent;
    ['--depth', '--progress'].forEach((name) => {
      const value = original.slotEl.style.getPropertyValue(name);
      if (value) view.slotEl.style.setProperty(name, value);
    });
    key.views.push(view);
    favoritesRowViews.set(sound.id, view);
    return view;
  }

  function setKeyMotion(key, depth, progress) {
    key.views.forEach((view) => {
      view.slotEl.style.setProperty('--depth', depth);
      if (progress !== undefined) view.slotEl.style.setProperty('--progress', progress);
    });
  }

  function setKeyTime(key, text) {
    key.views.forEach((view) => {
      view.timeEl.textContent = text;
    });
  }

  // The pink card that takes the sixth spot once the row is full. It looks like a key but
  // isn't one: it has no sound, so the key handlers ignore it.
  function buildSeeAllCard() {
    const button = el('button', 'key key--see-all');
    button.type = 'button';
    const tilt = el('span', 'key__tilt');
    const face = el('span', 'key__face');
    const foot = el('span', 'key__foot');
    const count = el('span', 'key__see-all-count');
    const arrow = icon('icon-arrow');
    arrow.setAttribute('class', 'key__see-all-arrow');
    arrow.setAttribute('aria-hidden', 'true');
    foot.append(count, arrow);
    face.append(el('span', 'key__name', 'See all favorites'), foot);
    tilt.append(el('span', 'key__well'), el('span', 'key__side'), face);
    button.appendChild(tilt);
    const slot = el('div', 'key-slot');
    slot.appendChild(button);
    return { slotEl: slot, countEl: count };
  }

  // The visible words are "Play All". The accessible name says "start", like every key.
  function buildBankStartAll(group, label) {
    const button = el('button', 'bank__all');
    button.type = 'button';
    button.dataset.group = group;
    button.setAttribute('aria-label', label);
    const svg = icon('icon-play-all');
    svg.setAttribute('aria-hidden', 'true');
    button.append(svg, el('span', '', 'Play All'));
    return button;
  }

  function buildFavoritesRow() {
    const bank = el('section', 'bank bank--favorites');
    bank.setAttribute('aria-label', 'Favorites');
    bank.hidden = true;
    const head = el('div', 'bank__head');
    const count = el('span', 'bank__count');
    const startAll = buildBankStartAll('favorites', 'Start all favorite sounds');
    head.append(el('h2', 'bank__title', 'Favorites'), count, startAll);
    const grid = el('div', 'bank__keys');
    const note = el('p', 'bank__note');
    const noteText = el('span');
    const spinner = icon('icon-loader');
    spinner.setAttribute('class', 'bank__spinner');
    spinner.setAttribute('aria-hidden', 'true');
    note.append(spinner, noteText);
    bank.append(head, grid, note);
    banksEl.appendChild(bank);
    const seeAll = buildSeeAllCard();
    favoritesRow = {
      el: bank,
      countEl: count,
      startAllEl: startAll,
      gridEl: grid,
      noteEl: note,
      noteTextEl: noteText,
      seeAllEl: seeAll.slotEl,
      seeAllCountEl: seeAll.countEl,
    };
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

  // Only ever shows under its own Strings chip, never on the All board.
  function buildStringsBank() {
    const bank = el('section', 'bank bank--strings');
    bank.setAttribute('aria-label', 'Strings');
    bank.hidden = true;
    const head = el('div', 'bank__head');
    const count = el('span', 'bank__count');
    head.append(el('h2', 'bank__title', 'Strings'), count);
    stringsGridEl = el('div', 'bank__keys');
    bank.append(head, stringsGridEl);
    banksEl.appendChild(bank);
    Object.assign(banks.get('strings'), { el: bank, countEl: count });
  }

  function addChipSpinner(chip) {
    const spinner = icon('icon-loader');
    spinner.classList.add('chip__spinner');
    spinner.setAttribute('role', 'img');
    spinner.setAttribute('aria-label', 'Loading');
    chip.appendChild(spinner);
  }

  function buildBoard() {
    buildFavoritesRow();
    banks.set('all', { chipCountEl: buildChip('all', 'All') });
    banks.set('favorites', { chipCountEl: buildChip('favorites', 'Favorites') });
    banks.set('strings', { chipCountEl: buildChip('strings', 'Strings') });
    stringsChipEl().querySelector('.chip__dot').replaceWith(icon('icon-string'));
    addChipSpinner(stringsChipEl());
    buildStringsBank();
    const favoritesChip = favoritesChipEl();
    favoritesChip.querySelector('.chip__dot').replaceWith(icon('icon-heart'));
    addChipSpinner(favoritesChip);
    categories.forEach((category) => {
      const bank = el('section', 'bank');
      bank.style.setProperty('--key', category.color);
      bank.style.setProperty('--key-side', category.side);
      bank.setAttribute('aria-label', category.label);

      const head = el('div', 'bank__head');
      const count = el('span', 'bank__count');
      head.append(el('h2', 'bank__title', category.label), count,
        buildBankStartAll(category.id, 'Start all ' + category.label + ' sounds'));

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
    key.path = path;
    key.views.forEach((view) => {
      view.baseEl.setAttribute('d', path);
      view.litEl.setAttribute('d', path);
    });
    if (!live.has(sound.id)) setKeyTime(key, formatSeconds(buffer.duration));
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

  function setEmptyState(icon, title, text, asksToSignIn) {
    emptyIconEl.setAttribute('href', '#' + icon);
    emptyTitleEl.textContent = title;
    emptyTextEl.textContent = text;
    emptyEl.classList.toggle('empty--string', icon === 'icon-string');
    emptySignInEl.hidden = !asksToSignIn;
    emptyResetEl.hidden = Boolean(asksToSignIn);
  }

  // Someone we know isn't signed in, as opposed to someone we haven't heard back about yet.
  function needsAccount() {
    const { status } = account.getState();
    return status !== 'authenticated' && status !== 'unknown';
  }

  function showEmptyState() {
    const query = filter.query.trim();
    if (needsAccount() && filter.category === 'favorites') {
      setEmptyState('icon-heart', 'You need an account.', 'Log in or sign up to keep your favorite sounds.', true);
    } else if (needsAccount() && filter.category === 'strings') {
      setEmptyState('icon-string', 'You need an account.', 'Log in or sign up to combine sounds into strings and keep them.', true);
    } else if (filter.category === 'strings') {
      if (query) setEmptyState('icon-string', 'No matching strings.', 'Nothing in your strings matches “' + query + '”.');
      else if (!favorites.isLoaded()) {
        setEmptyState('icon-string', 'Your strings', favorites.getStatus() === 'ok'
          ? 'Getting your strings…' : 'We can’t show your strings just now.');
      } else setEmptyState('icon-string', 'No strings yet.', 'Right-click or long-press any sound and choose “Create string with this sound”.');
    } else if (filter.category !== 'favorites') {
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
    const onlyStrings = filter.category === 'strings';

    renderStringKeys();
    let stringMatches = 0;
    stringKeys.forEach(({ string, view }) => {
      const name = normalize(string.name);
      const matchesQuery = terms.every((term) => name.includes(term));
      view.slotEl.hidden = !matchesQuery;
      if (matchesQuery) stringMatches++;
    });
    const stringsBank = banks.get('strings');
    stringsBank.chipCountEl.textContent = favorites.isLoaded() || needsAccount() ? stringMatches : '';
    showChipLoading(stringsChipEl());
    stringsBank.countEl.textContent = stringMatches + (stringMatches === 1 ? ' string' : ' strings');
    stringsBank.el.hidden = !onlyStrings || stringMatches === 0;

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
      keys.get(sound.id).view.slotEl.hidden = !show;
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
    renderFavoritesCount(favoriteMatches);
    renderFavoritesRow();
    categories.forEach((category) => {
      const bank = banks.get(category.id);
      const count = onlyFavorites ? shownPerCategory.get(category.id) : perCategory.get(category.id);
      const shown = onlyFavorites || filter.category === 'all' || filter.category === category.id;
      bank.chipCountEl.textContent = perCategory.get(category.id);
      bank.countEl.textContent = plural(count);
      bank.el.hidden = !shown || count === 0;
    });

    const shown = onlyStrings ? stringMatches : visible;
    emptyEl.hidden = shown > 0;
    if (shown === 0) showEmptyState();

    const count = onlyStrings ? stringsBank.countEl.textContent : plural(visible);
    const label = filter.query.trim() ? count + ' for “' + filter.query.trim() + '”' : count;
    // "0 sounds" would be just as misleading as a 0 on the chip until the save has been read.
    statusEl.textContent = (onlyFavorites || onlyStrings) && !favorites.isLoaded() ? '' : label;
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

  // A count before the save has been read would be a guess, usually a wrong 0. So the Favorites
  // and Strings chips show a spinner while we're still trying, and nothing once we've stopped.
  // Both come from the same save, so they finish loading together.
  function favoritesLoading() {
    if (needsAccount()) return false;
    const status = favorites.getStatus();
    return !favorites.isLoaded() && (status === 'ok' || status === 'retrying');
  }

  function showChipLoading(chip) {
    const loading = favoritesLoading();
    chip.setAttribute('aria-busy', String(loading));
    chip.querySelector('.chip__spinner').toggleAttribute('hidden', !loading);
  }

  function renderFavoritesCount(count) {
    const loaded = favorites.isLoaded();
    banks.get('favorites').chipCountEl.textContent = loaded || needsAccount() ? count : '';
    showChipLoading(favoritesChipEl());
  }

  const newestFavorites = () => favorites.list().filter((id) => soundById.has(id)).reverse();

  // The chosen arrangement first, then everything else newest first. So with nothing chosen
  // it's simply newest first, and a slot freed up by a removal fills itself.
  function arrangedFavorites() {
    const top = favorites.top().filter((id) => soundById.has(id));
    return [...top, ...newestFavorites().filter((id) => !top.includes(id))];
  }

  // The row at the top of the board: the arranged favorites, then a link to the rest. It only
  // appears on the full board, since a search or filter should show each sound just once.
  function renderFavoritesRow() {
    const row = favoritesRow;
    const signedIn = account.getState().status === 'authenticated';
    row.el.hidden = !(signedIn && filter.category === 'all' && !filter.query.trim());
    if (row.el.hidden) return;

    const loaded = favorites.isLoaded();
    const all = loaded ? arrangedFavorites() : [];
    const shown = all.slice(0, FAVORITES_ROW_SIZE);
    const full = shown.length === FAVORITES_ROW_SIZE;

    row.countEl.textContent = all.length ? plural(all.length) : '';
    row.startAllEl.hidden = !all.length;
    row.seeAllCountEl.textContent = plural(all.length);

    const cards = shown.map((id) => favoritesRowView(soundById.get(id)).slotEl);
    if (full) cards.push(row.seeAllEl);
    const current = Array.from(row.gridEl.children);
    if (cards.length !== current.length || cards.some((card, i) => card !== current[i])) {
      // Moving a focused element drops its focus, so it needs putting back afterward.
      const focused = row.gridEl.contains(document.activeElement) ? document.activeElement : null;
      row.gridEl.replaceChildren(...cards);
      if (focused && focused.isConnected) focused.focus({ preventScroll: true });
    }

    const loading = favoritesLoading();
    row.gridEl.hidden = !shown.length;
    row.noteEl.hidden = shown.length > 0;
    row.noteEl.classList.toggle('is-loading', loading);
    if (!shown.length) {
      row.noteTextEl.textContent = loading ? 'Getting your favorites…'
        : loaded ? 'Tap the heart on any sound to keep it here.'
          : 'We can’t show your favorites just now.';
    }
  }

  // ---------- The right-click menu ----------

  // Only cards in the Favorites row, or in the Favorites filter, can rearrange.
  function canRearrange(card) {
    if (!favorites.isLoaded() || account.getState().status !== 'authenticated') return false;
    return Boolean(card.closest('.bank--favorites')) || filter.category === 'favorites';
  }

  function menuItemsFor(card) {
    const id = card.dataset.id;
    if (stringKeys.has(id)) {
      return [{ icon: 'icon-pencil', label: 'Edit string', onSelect: () => editString(id, card) }];
    }
    const items = [];
    if (canRearrange(card)) {
      items.push({ icon: 'icon-rearrange', label: 'Rearrange top favorites', onSelect: () => openRearrange(card) });
    }
    if (id) {
      items.push({ icon: 'icon-string', label: 'Create string with this sound', onSelect: () => createString(id, card) });
    }
    return items;
  }

  // Cards with nothing to offer keep the browser's normal menu.
  function menuTargetFrom(target) {
    const slot = target.closest && target.closest('.key-slot');
    const card = slot && slot.querySelector('.key');
    return card && menuItemsFor(card).length ? card : null;
  }

  function openRearrange(trigger) {
    rearrange.open({
      order: arrangedFavorites(),
      newest: newestFavorites(),
      trigger,
      describe(id) {
        const sound = soundById.get(id);
        const category = categoryById.get(sound.category);
        return { name: sound.name, color: category.color, side: category.side };
      },
      onSave: (top) => favorites.setTop(top),
    });
  }

  function showCardMenu(trigger, x, y) {
    rearrange.openMenu({ x, y, trigger, label: 'Sound options', items: menuItemsFor(trigger) });
  }

  banksEl.addEventListener('contextmenu', (event) => {
    const card = menuTargetFrom(event.target);
    if (!card) return;
    event.preventDefault();
    // The keyboard's menu key has no pointer position, so it opens at the card instead.
    const box = card.getBoundingClientRect();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    showCardMenu(card, fromKeyboard ? box.left + 16 : event.clientX, fromKeyboard ? box.top + 16 : event.clientY);
  });

  // iPhones have no right-click and send no contextmenu event, so a long press does the job.
  let longPress = null;
  let suppressClickUntil = 0;

  function cancelLongPress() {
    if (longPress) clearTimeout(longPress.timer);
    longPress = null;
  }

  banksEl.addEventListener('pointerdown', (event) => {
    cancelLongPress();
    if (event.pointerType === 'mouse') return;
    const card = menuTargetFrom(event.target);
    if (!card) return;
    const { clientX: x, clientY: y } = event;
    longPress = {
      x,
      y,
      timer: setTimeout(() => {
        longPress = null;
        suppressClickUntil = Date.now() + 800; // Letting go mustn't also start the sound.
        showCardMenu(card, x, y);
      }, LONG_PRESS_MS),
    };
  });

  banksEl.addEventListener('pointermove', (event) => {
    if (longPress && Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > LONG_PRESS_SLOP_PX) {
      cancelLongPress();
    }
  });
  ['pointerup', 'pointercancel'].forEach((type) => banksEl.addEventListener(type, cancelLongPress));

  function showAllFavorites() {
    setCategory('favorites');
    favoritesChipEl().focus({ preventScroll: true });
    const consoleEl = document.querySelector('.console');
    if (consoleEl.scrollIntoView) {
      consoleEl.scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    }
  }

  // ---------- Strings ----------

  function stringsChipEl() {
    return chipsEl.querySelector('.chip[data-category="strings"]');
  }

  const clipCategory = (soundId) => {
    const sound = soundById.get(soundId);
    return sound && categoryById.get(sound.category);
  };

  // What a string's key needs to work like a sound's key.
  function stringSound(string) {
    const clips = string.clips.filter((clip) => clipCategory(clip.sound));
    const colors = stringsCore.colors(clips, clipCategory);
    // Each sound once, in the order you'd hear them.
    const names = [...clips].sort((a, b) => a.at - b.at || a.lane - b.lane)
      .map((clip) => soundById.get(clip.sound).name);
    return {
      id: 'string:' + string.id,
      name: string.name,
      summary: stringsCore.summarize(Array.from(new Set(names))),
      clips,
      color: colors[0].color,
      side: colors[0].side,
      fill: stringsCore.gradient(colors.map((color) => color.color)),
      sideFill: stringsCore.gradient(colors.map((color) => color.side)),
    };
  }

  function removeStringKey(id) {
    const entry = stringKeys.get(id);
    const run = live.get(id);
    if (run) {
      engine.stop(id);
      settle(id, run, false);
    }
    entry.view.slotEl.remove();
    stringKeys.delete(id);
    keys.delete(id);
    soundById.delete(id);
  }

  // Draws the waveform of the whole string once its sounds have loaded.
  async function paintStringKey(entry) {
    const { sound } = entry;
    const total = stringsCore.duration(sound.clips);
    const key = keys.get(sound.id);
    key.duration = total;
    setKeyTime(key, formatSeconds(total));
    if (!engine.supported) return;
    const ids = Array.from(new Set(sound.clips.map((clip) => clip.sound)));
    const peaks = new Map();
    try {
      await Promise.all(ids.map(async (id) => {
        const buffer = await engine.load(soundById.get(id));
        peaks.set(id, { values: engine.peaks(buffer, 200), duration: buffer.duration });
      }));
    } catch (error) {
      return; // Its waveform stays flat, and pressing it reports the problem.
    }
    if (stringKeys.get(sound.id) !== entry) return;
    const path = waveformPath(stringsCore.mixPeaks(sound.clips, (id) => peaks.get(id), WAVE_BARS));
    key.path = path;
    entry.view.baseEl.setAttribute('d', path);
    entry.view.litEl.setAttribute('d', path);
  }

  // Newest first. A key is only rebuilt when its string actually changed, so one that's
  // playing isn't interrupted by a save of something else.
  function renderStringKeys() {
    const strings = favorites.strings().slice().reverse();
    const wanted = new Set(strings.map((string) => 'string:' + string.id));
    Array.from(stringKeys.keys()).forEach((id) => {
      if (!wanted.has(id)) removeStringKey(id);
    });
    const slots = strings.map((string) => {
      const id = 'string:' + string.id;
      const signature = JSON.stringify(string);
      let entry = stringKeys.get(id);
      if (entry && entry.signature !== signature) {
        removeStringKey(id);
        entry = null;
      }
      if (!entry) {
        const sound = stringSound(string);
        const view = buildKeyView(sound);
        entry = { string, signature, sound, view };
        stringKeys.set(id, entry);
        soundById.set(id, sound);
        keys.set(id, { view, views: [view], duration: null, lastLabel: '', path: null });
        paintStringKey(entry);
      }
      return entry.view.slotEl;
    });
    const current = Array.from(stringsGridEl.children);
    if (slots.length !== current.length || slots.some((slot, i) => slot !== current[i])) {
      stringsGridEl.replaceChildren(...slots);
    }
  }

  function openStringEditor(trigger, username, source) {
    stringEditor.open({
      ...source,
      trigger,
      // Says what went wrong, or nothing if it saved.
      onSave(string) {
        const state = account.getState();
        if (state.status !== 'authenticated' || state.username !== username) {
          return 'Sign in again as ' + username + ' to save this string.';
        }
        if (!favorites.canSaveString(string)) {
          return 'You’re out of room for strings. Delete one or make this one shorter.';
        }
        favorites.saveString(string);
        return '';
      },
      onSaved(id) {
        searchEl.value = '';
        filter.query = '';
        setCategory('strings');
        const entry = stringKeys.get('string:' + id);
        if (entry) entry.view.el.focus({ preventScroll: true });
      },
      onDelete(id) {
        favorites.deleteString(id);
      },
    });
  }

  function createString(soundId, trigger) {
    stringsAccess.require(trigger, (username) => openStringEditor(trigger, username, { soundId }));
  }

  function editString(id, trigger) {
    const entry = stringKeys.get(id);
    if (!entry) return; // Deleted on another device while the menu was open.
    stringsAccess.require(trigger, (username) => openStringEditor(trigger, username, { string: entry.string }));
  }

  // Guests get the tab itself, which explains the account. Signed-in visitors outside the beta
  // are told so instead.
  async function openStringsTab(chip) {
    let state = account.getState();
    if (state.status === 'unknown' || state.status === 'error') state = await account.check();
    if (state.status === 'authenticated') stringsAccess.require(chip, () => setCategory('strings'));
    else setCategory('strings');
  }

  // The button on the Favorites and Strings tabs for anyone without an account.
  async function signInFromTab() {
    if (filter.category === 'strings') {
      stringsAccess.require(emptySignInEl, () => setCategory('strings'), () => setCategory('all'));
      return;
    }
    let state = account.getState();
    if (state.status === 'unknown' || state.status === 'error') state = await account.check();
    if (state.status === 'authenticated') return;
    signIn.open({ stage: state.status === 'guest' ? 'confirm' : state.status, trigger: emptySignInEl });
  }

  emptySignInEl.addEventListener('click', signInFromTab);

  function renderFavorites() {
    keys.forEach((key, id) => {
      const favorite = String(favorites.isFavorite(id));
      key.views.forEach((view) => {
        if (view.heartEl) view.heartEl.setAttribute('aria-pressed', favorite);
      });
    });

    const focused = document.activeElement;
    const hadHeartFocus = focused && focused.classList.contains('key__heart');
    applyFilter();
    // Unfavoriting inside the Favorites filter removes the heart that was just clicked.
    if (hadHeartFocus && (!focused.isConnected || focused.closest('[hidden]'))) {
      favoritesChipEl().focus({ preventScroll: true });
    }

    const saved = favorites.hasUnsavedStrings() ? 'strings' : 'favorites';
    const message = {
      retrying: favorites.hasUnsaved()
        ? 'Your ' + saved + ' haven’t saved yet. We’ll keep trying.'
        : 'We couldn’t get your favorites yet. We’ll keep trying.',
      paused: favorites.hasUnsaved()
        ? 'Your ' + saved + ' haven’t saved yet. We’ll try again when you come back.'
        : 'We couldn’t get your favorites yet. We’ll try again when you come back.',
      blocked: 'Your ' + saved + ' can’t be updated right now.',
      signin: 'Sign in again to save your ' + saved + '.',
      setup: 'Finish setting up your account to save your ' + saved + '.',
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
    // The Favorites and Strings tabs stay put and explain the account when nobody's signed in.
    applyFilter();
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

  // While anything is sounding, the big red button becomes a way to stop it. Stop all can be
  // far off-screen from there on a phone, and that's a bad moment to go looking for it.
  function setArmed(armed) {
    stopAllEl.classList.toggle('is-armed', armed);
    everythingEl.classList.toggle('is-stop', armed);
    everythingEl.setAttribute('aria-label', armed ? 'Stop all sounds' : 'Start every sound');
    $('everythingLabel').textContent = armed ? 'Stop all' : 'Play Everything';
    $('everythingIcon').setAttribute('href', armed ? '#icon-stop' : '#icon-play-all');
  }

  function setTimeLabel(key, seconds) {
    const label = formatSeconds(Math.max(0, seconds));
    if (label !== key.lastLabel) {
      key.lastLabel = label;
      setKeyTime(key, label);
    }
  }

  function settle(id, run, spring) {
    const key = run.key;
    live.delete(id);
    setKeyMotion(key, 0, 0);
    key.lastLabel = '';
    setKeyTime(key, key.duration === null ? '–' : formatSeconds(key.duration));
    if (spring) {
      key.views.forEach((view) => {
        view.slotEl.classList.remove('is-pop');
        void view.slotEl.offsetWidth; // Restarts the animation if it's still running.
        view.slotEl.classList.add('is-pop');
      });
    }
    setArmed(live.size > 0);
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
        setKeyMotion(run.key, run.depth);
        return undefined;
      }

      const sunk = run.fromDepth + (1 - run.fromDepth) * Math.min(1, (now - run.pressedAt) / PRESS_MS);
      depth = sunk;

      if (run.voice) {
        const elapsed = run.voice.elapsed();
        const rise = elapsed / Math.max(run.voice.duration, MIN_RISE_SECONDS);
        if (rise >= 1) return settle(id, run, true);
        depth = Math.min(sunk, 1 - rise);
        progress = run.voice.duration ? Math.min(1, elapsed / run.voice.duration) : 1;
        setTimeLabel(run.key, run.voice.duration - elapsed);
      }

      run.depth = depth;
      setKeyMotion(run.key, depth, progress);
      return undefined;
    });

    if (live.size > 0) requestFrame();
  }

  // pressedEl is the button actually pressed, which is where the note hops from.
  function press(sound, pressedEl, quiet) {
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
    key.views.forEach((view) => {
      view.slotEl.classList.remove('is-pop');
      view.el.classList.remove('is-broken');
    });
    setArmed(true);
    requestFrame();
    if (!quiet) celebrate(pressedEl || key.view.el, sound);

    const starting = sound.clips
      ? engine.startClips(sound.id, sound.clips, (id) => soundById.get(id))
      : engine.start(sound);
    starting.then((voice) => {
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
    key.views.forEach((view) => {
      view.el.classList.remove('is-broken');
      void view.el.offsetWidth; // Restarts the shake if it's still running.
      view.el.classList.add('is-broken');
    });
    statusEl.textContent = message;
  }

  // Sounds load at their own pace, so this waits for the whole group and then starts it in
  // one go. Otherwise the slowest files would come in late and it wouldn't really be at once.
  let groupStart = 0;

  async function startTogether(group) {
    if (engine.supported) engine.unlock();
    const thisStart = ++groupStart;
    await Promise.allSettled(group.map((sound) => engine.supported && engine.load(sound)));
    if (thisStart !== groupStart) return; // Stopped, or started again, while loading.
    group.forEach((sound, i) => press(sound, keys.get(sound.id).view.el, i >= MAX_GROUP_NOTES));
  }

  // What a Play All button covers. A category means the sounds showing in it, so a search or
  // the Favorites filter narrows it, and Favorites means every favorite, not just the top five.
  function groupFor(id) {
    if (id === 'favorites') return arrangedFavorites().map((soundId) => soundById.get(soundId));
    return sounds.filter((sound) => sound.category === id && !keys.get(sound.id).view.slotEl.hidden);
  }

  function buildEverythingDialog() {
    const dialog = el('dialog', 'warning-dialog');
    dialog.setAttribute('aria-labelledby', 'warning-title');
    dialog.setAttribute('aria-describedby', 'warning-description');
    const panel = el('section', 'signin-panel warning-panel');
    const headphones = icon('icon-headphones');
    headphones.setAttribute('class', 'warning-panel__icon');
    headphones.setAttribute('aria-hidden', 'true');
    const title = el('h2', '', 'Take off your headphones!');
    title.id = 'warning-title';
    const description = el('p', '', 'This starts all ' + sounds.length + ' sounds at the same time, and it gets very loud. '
      + 'Take off your headphones or turn your volume down first.');
    description.id = 'warning-description';
    const actions = el('div', 'signin-actions');
    const go = el('button', 'signin-button signin-button--danger', 'Play Everything');
    go.type = 'button';
    go.setAttribute('aria-label', 'Start every sound');
    const cancel = el('button', 'signin-button signin-button--quiet', 'Cancel');
    cancel.type = 'button';
    actions.append(go, cancel);
    panel.append(headphones, title, description, actions);
    dialog.appendChild(panel);
    document.body.appendChild(dialog);

    const close = () => {
      dialog.close();
      everythingEl.focus({ preventScroll: true });
    };
    go.addEventListener('click', () => {
      close();
      startTogether(sounds);
    });
    cancel.addEventListener('click', close);
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close();
    });
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });
    // The dialog's keys belong to it, not to the page's shortcuts.
    dialog.addEventListener('keydown', (event) => event.stopPropagation());

    return () => {
      dialog.showModal();
      cancel.focus({ preventScroll: true }); // The safe choice is the one a stray Enter hits.
    };
  }

  function stopAll() {
    groupStart++;
    engine.stopAll();
    const now = performance.now();
    live.forEach((run) => {
      if (run.releasedAt === null) {
        run.releasedAt = now;
        run.releaseFrom = run.depth;
      }
    });
    setArmed(false);
    requestFrame();
  }

  // A note hops off the key and a title letter jumps along with it.
  let hopIndex = 0;

  function celebrate(keyEl, sound) {
    if (reducedMotion.matches || !Element.prototype.animate) return;

    const box = keyEl.getBoundingClientRect();
    if (!box.width) return; // Its key is hidden by a search or filter, so nothing can hop off it.
    const note = icon(NOTE_ICONS[hopIndex % NOTE_ICONS.length]);
    const drift = (hopIndex % 2 ? 1 : -1) * (16 + (hopIndex * 11) % 26);
    note.style.left = box.left + box.width / 2 + 'px';
    note.style.top = box.top + 10 + 'px';
    note.style.fill = sound.color || categoryById.get(sound.category).color;
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
    const button = event.target.closest('.key[data-id]');
    if (button && event.pointerType === 'mouse' && event.button === 0) {
      press(soundById.get(button.dataset.id), button);
    }
  });

  banksEl.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil) {
      suppressClickUntil = 0;
      return;
    }
    const heart = event.target.closest('.key__heart');
    if (heart) {
      onHeartClick(heart);
      return;
    }
    const startAll = event.target.closest('.bank__all');
    if (startAll) {
      startTogether(groupFor(startAll.dataset.group));
      return;
    }
    if (event.target.closest('.key--see-all')) {
      showAllFavorites();
      return;
    }
    const button = event.target.closest('.key[data-id]');
    if (!button) return;
    if (event.detail !== 0 && lastPointerType === 'mouse') return;
    press(soundById.get(button.dataset.id), button);
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
    if (!chip) return;
    if (chip.dataset.category === 'strings') openStringsTab(chip);
    else setCategory(chip.dataset.category);
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

  const confirmEverything = buildEverythingDialog();
  everythingEl.addEventListener('click', () => {
    if (live.size > 0) stopAll();
    else confirmEverything();
  });

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
