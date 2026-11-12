/*
 * The Sound Leaderboard, and the Home / Leaderboard tabs in the top bar.
 *
 * Every sound's play count comes from SoundCounter. A sound only makes the board once it has
 * been played more than once. The top three stand on a podium with trophies, and everything
 * after is a list, with a bar showing how close each one is to first place.
 *
 * The view lives at #leaderboard, so it can be linked to and the back button works.
 */
(function () {
  'use strict';

  const { categories, sounds } = window.SOUND_CATALOG;
  const counter = window.SoundCounter;
  const board = window.SoundBoard;

  const MIN_PLAYS = 2; // A sound needs more than one play to be ranked.
  const LIVE_REFRESH_MS = 30000; // While open, stale counts are read again this often.
  const VIEW_HASH = '#leaderboard';
  const HOME_TITLE = document.title;
  const BOARD_TITLE = 'Sound Leaderboard · Simple Soundboard';
  const MEDALS = ['gold', 'silver', 'bronze'];

  const $ = (id) => document.getElementById(id);
  const viewEl = $('leaderboardView');
  const homeEls = Array.from(document.querySelectorAll('[data-home-view]'));
  const tabs = Array.from(document.querySelectorAll('.viewtab'));
  const podiumEl = $('podium');
  const listEl = $('ranksList');
  const emptyEl = $('ranksEmpty');
  const noMatchEl = $('ranksNoMatch');
  const footEl = $('ranksFoot');
  const totalEl = $('ranksTotal');
  const rankedEl = $('ranksRanked');
  const leaderEl = $('ranksLeader');
  const progressEl = $('ranksProgress');
  const progressBarEl = $('ranksBar');
  const progressTextEl = $('ranksProgressText');
  const searchEl = $('ranksSearch');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const soundById = new Map(sounds.map((sound) => [sound.id, sound]));
  const ids = sounds.map((sound) => sound.id);
  const numberFormat = new Intl.NumberFormat();

  const rows = new Map(); // sound id -> { el, placeEl, countEl, barEl, playEl }
  const shown = new Map(); // sound id -> the count last drawn, to spot ones that went up
  let spots = []; // the podium's three places
  let liveTimer = null;
  let refreshTotal = 0; // how many reads this round of loading started with
  let renderQueued = false;
  let query = '';

  // ---------- Small helpers ----------

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
    svg.appendChild(use);
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    return svg;
  }

  function ordinal(n) {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return n + 'th';
    return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  }

  function plays(n) {
    return numberFormat.format(n) + (n === 1 ? ' play' : ' plays');
  }

  function normalize(text) {
    return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  }

  const searchText = new Map(sounds.map((sound) => [
    sound.id,
    normalize([sound.name, categoryById.get(sound.category).label, sound.tags || ''].join(' ')),
  ]));

  // Highest first. Ties share a place (1, 2, 2, 4) and are listed by name.
  function ranking() {
    const entries = [];
    sounds.forEach((sound) => {
      const value = counter.value(sound.id);
      if (value !== null && value >= MIN_PLAYS) entries.push({ sound, value });
    });
    entries.sort((a, b) => b.value - a.value || a.sound.name.localeCompare(b.sound.name));
    entries.forEach((entry, i) => {
      entry.place = i > 0 && entries[i - 1].value === entry.value ? entries[i - 1].place : i + 1;
    });
    return entries;
  }

  // ---------- Play buttons ----------

  function buildPlayButton(className, sound, withLabel) {
    const button = el('button', className);
    button.type = 'button';
    button.dataset.play = sound.id;
    button.setAttribute('aria-label', 'Play ' + sound.name);
    button.append(icon('icon-play-all', 'is-play'), icon('icon-stop', 'is-stop'));
    if (withLabel) button.append(el('span', 'podium__play-label', 'Play'));
    return button;
  }

  function paintPlaying(button) {
    const id = button.dataset.play;
    const playing = Boolean(id) && board.isPlaying(id);
    const sound = soundById.get(id);
    button.classList.toggle('is-playing', playing);
    if (sound) button.setAttribute('aria-label', (playing ? 'Stop ' : 'Play ') + sound.name);
    const label = button.querySelector('.podium__play-label');
    if (label) label.textContent = playing ? 'Stop' : 'Play';
  }

  board.onPlayback((id) => {
    viewEl.querySelectorAll('[data-play]').forEach((button) => {
      if (button.dataset.play === id) paintPlaying(button);
    });
  });

  viewEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-play]');
    if (button && button.dataset.play) {
      const id = button.dataset.play;
      if (board.isPlaying(id)) board.stop(id);
      else board.play(id, button);
      return;
    }
    if (event.target.closest('#ranksBack')) show('home');
  });

  // ---------- The podium ----------

  function buildSpot(index) {
    const spot = el('li', 'podium__spot podium__spot--' + (index + 1));
    spot.dataset.medal = MEDALS[index];
    const card = el('div', 'podium__card');
    const trophy = icon('icon-cup', 'podium__trophy');
    const place = el('span', 'podium__place');
    const name = el('span', 'podium__name');
    const meta = el('span', 'podium__meta');
    const count = el('span', 'podium__count');
    const play = buildPlayButton('podium__play', { id: '', name: '' }, true);
    card.append(trophy, place, name, meta, count, play);
    const step = el('div', 'podium__step');
    step.append(el('span', 'podium__step-number', String(index + 1)));
    spot.append(card, step);
    podiumEl.appendChild(spot);
    return { el: spot, cardEl: card, placeEl: place, nameEl: name, metaEl: meta, countEl: count, playEl: play, id: null };
  }

  function paintSpot(spot, entry, index, loading) {
    if (!entry) {
      spot.el.classList.add('is-open');
      spot.el.dataset.medal = MEDALS[index];
      spot.placeEl.textContent = ordinal(index + 1);
      spot.nameEl.textContent = loading ? 'Counting…' : 'Up for grabs';
      spot.metaEl.textContent = '';
      spot.countEl.textContent = loading ? '' : 'Play a sound twice to claim it';
      spot.playEl.hidden = true;
      spot.playEl.dataset.play = '';
      spot.id = null;
      spot.el.removeAttribute('style');
      return;
    }
    const { sound, value, place } = entry;
    const category = categoryById.get(sound.category);
    const changed = spot.id !== sound.id;
    spot.el.classList.remove('is-open');
    // Medals follow the place, so a tie for first gives two golds.
    spot.el.dataset.medal = MEDALS[Math.min(place, 3) - 1];
    spot.el.style.setProperty('--key', category.color);
    spot.el.style.setProperty('--key-side', category.side);
    spot.placeEl.textContent = ordinal(place);
    spot.nameEl.textContent = sound.name;
    spot.metaEl.textContent = category.label;
    spot.countEl.replaceChildren(el('strong', '', numberFormat.format(value)), ' ' + (value === 1 ? 'play' : 'plays'));
    spot.playEl.hidden = false;
    spot.playEl.dataset.play = sound.id;
    paintPlaying(spot.playEl);
    if (changed && spot.id !== null) animateIn(spot.cardEl);
    else if (shown.has(sound.id) && shown.get(sound.id) !== value) bump(spot.countEl);
    spot.id = sound.id;
  }

  // ---------- The list ----------

  function rowFor(sound) {
    if (rows.has(sound.id)) return rows.get(sound.id);
    const category = categoryById.get(sound.category);
    const row = el('li', 'rank-row');
    row.style.setProperty('--key', category.color);
    row.style.setProperty('--key-side', category.side);
    const place = el('span', 'rank-row__place');
    const play = buildPlayButton('rank-row__play', sound, false);
    const main = el('span', 'rank-row__main');
    const name = el('span', 'rank-row__name', sound.name);
    const meta = el('span', 'rank-row__meta');
    meta.append(el('span', 'rank-row__dot'), category.label);
    const bar = el('span', 'rank-row__bar');
    const fill = el('span', 'rank-row__fill');
    bar.appendChild(fill);
    main.append(name, meta, bar);
    const count = el('span', 'rank-row__count');
    row.append(place, play, main, count);
    const entry = { el: row, placeEl: place, countEl: count, fillEl: fill, playEl: play };
    rows.set(sound.id, entry);
    return entry;
  }

  // Rows slide from where they were to where they now rank, rather than jumping.
  function reorderList(entries, leaderValue) {
    const before = new Map();
    if (!reducedMotion.matches) {
      rows.forEach((row, id) => {
        if (row.el.isConnected) before.set(id, row.el.getBoundingClientRect().top);
      });
    }

    const wanted = entries.map((entry) => {
      const row = rowFor(entry.sound);
      row.placeEl.textContent = entry.place;
      row.el.dataset.place = entry.place;
      row.countEl.replaceChildren(el('strong', '', numberFormat.format(entry.value)),
        el('span', '', entry.value === 1 ? 'play' : 'plays'));
      row.fillEl.style.width = Math.max(2, (entry.value / leaderValue) * 100).toFixed(1) + '%';
      paintPlaying(row.playEl);
      return { id: entry.sound.id, row, value: entry.value };
    });

    const current = Array.from(listEl.children);
    const elements = wanted.map((item) => item.row.el);
    if (elements.length !== current.length || elements.some((node, i) => node !== current[i])) {
      const focused = listEl.contains(document.activeElement) ? document.activeElement : null;
      listEl.replaceChildren(...elements);
      if (focused && focused.isConnected) focused.focus({ preventScroll: true });
    }

    wanted.forEach(({ id, row, value }) => {
      if (before.has(id)) {
        const delta = before.get(id) - row.el.getBoundingClientRect().top;
        if (Math.abs(delta) > 1 && row.el.animate) {
          row.el.animate([{ transform: 'translateY(' + delta + 'px)' }, { transform: 'none' }],
            { duration: 420, easing: 'cubic-bezier(.2, .8, .2, 1)' });
        }
      } else if (shown.size && !reducedMotion.matches) {
        animateIn(row.el);
      }
      if (shown.has(id) && shown.get(id) !== value) bump(row.countEl);
    });
  }

  function animateIn(node) {
    if (reducedMotion.matches || !node.animate) return;
    node.animate([
      { opacity: 0, transform: 'translateY(10px) scale(.97)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 360, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  }

  function bump(node) {
    node.classList.remove('is-bumped');
    void node.offsetWidth; // Restarts the animation if it's still running.
    node.classList.add('is-bumped');
  }

  // ---------- Drawing ----------

  function renderSoon() {
    if (renderQueued || viewEl.hidden) return;
    renderQueued = true;
    window.requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    if (viewEl.hidden) return;
    const entries = ranking();
    const status = counter.status();
    const loading = status.reading > 0;
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    const searching = terms.length > 0;
    const leaderValue = entries.length ? entries[0].value : 1;

    // The podium.
    if (!spots.length) spots = [0, 1, 2].map(buildSpot);
    spots.forEach((spot, i) => paintSpot(spot, entries[i], i, loading));
    podiumEl.classList.toggle('is-loading', loading && !entries.length);
    podiumEl.hidden = searching || (!entries.length && !loading && !status.offline);

    // The list. A search looks through every ranked sound, podium included.
    const listed = searching
      ? entries.filter((entry) => terms.every((term) => searchText.get(entry.sound.id).includes(term)))
      : entries.slice(3);
    reorderList(listed, leaderValue);
    listEl.hidden = !listed.length;
    noMatchEl.hidden = !searching || listed.length > 0;
    if (searching && !listed.length) {
      noMatchEl.textContent = 'No ranked sound matches “' + query.trim() + '”. It might not have two plays yet.';
    }

    // The empty board, once we know it's really empty.
    emptyEl.hidden = entries.length > 0 || loading || status.offline;

    // Stats.
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    totalEl.textContent = entries.length || !loading ? numberFormat.format(total) : '–';
    rankedEl.textContent = entries.length + ' of ' + sounds.length;
    leaderEl.textContent = entries.length ? entries[0].sound.name : '–';

    const unranked = sounds.length - entries.length;
    footEl.hidden = loading || !entries.length || unranked === 0;
    footEl.textContent = unranked === 1
      ? '1 sound is still waiting for its second play.'
      : unranked + ' sounds are still waiting for their second play. Go give them some love.';

    // Progress while counts come in.
    if (loading) {
      if (status.reading > refreshTotal) refreshTotal = status.reading;
      const done = refreshTotal - status.reading;
      progressEl.hidden = false;
      progressEl.classList.remove('is-offline');
      progressBarEl.style.width = Math.max(4, (done / refreshTotal) * 100).toFixed(1) + '%';
      progressTextEl.textContent = status.offline
        ? 'Having trouble reaching the counter. Still trying…'
        : 'Tallying plays… ' + done + ' of ' + refreshTotal + ' sounds';
      progressEl.classList.toggle('is-offline', status.offline);
    } else {
      refreshTotal = 0;
      progressEl.hidden = true;
    }

    entries.forEach((entry) => shown.set(entry.sound.id, entry.value));
  }

  counter.subscribe(renderSoon);

  searchEl.addEventListener('input', () => {
    query = searchEl.value;
    render();
  });

  searchEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && searchEl.value) {
      event.stopPropagation(); // Clears the search rather than stopping every sound.
      searchEl.value = '';
      query = '';
      render();
    }
  });

  // ---------- Switching views ----------

  function current() {
    return window.location.hash === VIEW_HASH ? 'leaderboard' : 'home';
  }

  function startLive() {
    counter.refresh(ids);
    refreshTotal = Math.max(refreshTotal, counter.status().reading);
    if (liveTimer === null) {
      liveTimer = setInterval(() => {
        if (!document.hidden) counter.refresh(ids);
      }, LIVE_REFRESH_MS);
    }
  }

  function stopLive() {
    if (liveTimer !== null) clearInterval(liveTimer);
    liveTimer = null;
  }

  function apply(view) {
    const onBoard = view === 'leaderboard';
    document.body.dataset.view = view;
    homeEls.forEach((node) => {
      node.hidden = onBoard;
    });
    viewEl.hidden = !onBoard;
    tabs.forEach((tab) => {
      if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
    document.title = onBoard ? BOARD_TITLE : HOME_TITLE;
    if (onBoard) {
      startLive();
      render();
    } else {
      stopLive();
    }
  }

  function show(view) {
    if (view === current()) return;
    const url = view === 'leaderboard'
      ? window.location.pathname + window.location.search + VIEW_HASH
      : window.location.pathname + window.location.search;
    window.history.pushState({ view }, '', url);
    apply(view);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      show(tab.dataset.view);
    });
  });

  window.addEventListener('popstate', () => apply(current()));
  window.addEventListener('hashchange', () => apply(current()));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !viewEl.hidden) counter.refresh(ids);
  });

  window.SoundViews = { current, show };

  apply(current());
})();
