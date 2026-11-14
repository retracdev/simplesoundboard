/*
 * The page behind a shared sound link, such as /sound/get-out.
 *
 * Every sound has its own generated page (sound/<id>.html) so link previews get that sound's
 * title and card. The same page doubles as 404.html: there it reads the sound from the address,
 * which also accepts a sound's name, like /sound/Get%20Out!, and swaps to the proper link.
 *
 * The big button plays through the same engine and counter as the board, so plays from here
 * count toward the Sound Leaderboard under the same rules.
 */
(function () {
  'use strict';

  const { categories, sounds } = window.SOUND_CATALOG;
  const engine = window.SoundEngine;
  const counter = window.SoundCounter;

  const VOLUME_KEY = 'simple-soundboard:volume'; // Shared with the board.
  const PRESS_MS = 70;
  const MIN_RISE_SECONDS = 0.22;
  const WAVE_BARS = 56;
  const ROWS = 5;
  const NOTE_ICONS = ['icon-note-eighth', 'icon-note-beamed', 'icon-note-quarter'];
  const CANDY = [
    ['#35d6c8', '#12877c'], ['#ab8fff', '#6442c9'], ['#ff7eb6', '#c0407b'],
    ['#ffc93c', '#bd8406'], ['#ff8360', '#bf4526'], ['#93e571', '#479c2c'],
  ];

  const $ = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const categoryById = new Map(categories.map((category) => [category.id, category]));

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
    svg.setAttribute('aria-hidden', 'true');
    return svg;
  }

  function formatSeconds(seconds) {
    if (seconds < 10) return seconds.toFixed(1) + 's';
    if (seconds < 60) return Math.round(seconds) + 's';
    const whole = Math.round(seconds);
    return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
  }

  function shuffled(list) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  // ---------- Which sound ----------

  // The same rule the page generator uses, so a name in the address finds its sound.
  function slug(text) {
    return String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ').replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function requested() {
    const fromPage = document.body.dataset.soundId;
    if (fromPage) return { isSoundPath: true, raw: fromPage };
    const match = window.location.pathname.match(/^\/sounds?\/([^/]+)\/?$/i);
    if (!match) return { isSoundPath: false, raw: '' };
    let raw = match[1];
    try {
      raw = decodeURIComponent(raw);
    } catch (error) {
      // Keep it as typed.
    }
    return { isSoundPath: true, raw: raw.replace(/\.html$/i, '') };
  }

  function resolve(raw) {
    if (!raw) return null;
    const lower = raw.toLowerCase();
    const wanted = slug(raw);
    return sounds.find((sound) => sound.id === raw)
      || sounds.find((sound) => sound.id.toLowerCase() === lower)
      || sounds.find((sound) => sound.id === wanted)
      || sounds.find((sound) => slug(sound.name) === wanted)
      || null;
  }

  // ---------- Banner ----------

  function buildBannerTitle() {
    const art = $('bannerArt');
    let index = 0;
    [['Simple', true], ['Soundboard', false]].forEach(([word, isPlain], w) => {
      if (w) art.appendChild(document.createTextNode(' '));
      const group = el('span', 'share-banner__word');
      Array.from(word).forEach((character, i) => {
        const letter = el('span', 'letter', character);
        const [color, side] = isPlain ? ['#f3f0ff', '#8b86a3'] : CANDY[i % CANDY.length];
        letter.style.setProperty('--c', color);
        letter.style.setProperty('--d', side);
        letter.style.setProperty('--i', index);
        letter.style.setProperty('--tw', (index % 2 ? 2.6 : -2.6) + 'deg');
        group.appendChild(letter);
        index++;
      });
      art.appendChild(group);
    });
  }

  function buildRibbon() {
    const track = $('ribbonTrack');
    const set = el('div', 'ribbon__set');
    const list = shuffled(sounds);
    const words = Math.max(list.length, 40);
    for (let i = 0; i < words; i++) {
      set.appendChild(el('span', 'ribbon__word', list[i % list.length].name.toLowerCase()));
      set.appendChild(icon(NOTE_ICONS[i % NOTE_ICONS.length]));
    }
    track.appendChild(set);
    track.appendChild(set.cloneNode(true));
  }

  // ---------- Explore section ----------

  function buildExplore() {
    $('exploreCount').textContent = sounds.length;
    const rows = $('exploreRows');
    const list = shuffled(sounds);
    const perRow = Math.max(12, Math.ceil(list.length / ROWS));
    for (let r = 0; r < ROWS; r++) {
      const row = el('div', 'explore__row');
      const track = el('div', 'explore__track');
      track.style.setProperty('--t', (70 + r * 11) + 's');
      if (r % 2) track.classList.add('explore__track--reverse');
      const set = el('div', 'explore__set');
      for (let i = 0; i < perRow; i++) {
        const sound = list[(r * perRow + i) % list.length];
        const category = categoryById.get(sound.category);
        const tile = el('span', 'tile');
        tile.style.setProperty('--key', category.color);
        tile.style.setProperty('--key-side', category.side);
        tile.appendChild(el('span', 'tile__name', sound.name));
        const foot = el('span', 'tile__foot');
        foot.appendChild(icon('icon-play'));
        foot.appendChild(el('span', 'tile__bar'));
        tile.appendChild(foot);
        set.appendChild(tile);
      }
      track.appendChild(set);
      track.appendChild(set.cloneNode(true));
      row.appendChild(track);
      rows.appendChild(row);
    }

    const random = $('randomSound');
    random.addEventListener('click', (event) => {
      const current = document.body.dataset.resolved;
      const others = sounds.filter((sound) => sound.id !== current);
      const pick = others[Math.floor(Math.random() * others.length)];
      if (!pick) return;
      event.preventDefault();
      window.location.href = '/sound/' + encodeURIComponent(pick.id);
    });
  }

  // ---------- Not found ----------

  function showMissing(isSoundPath, raw) {
    document.body.dataset.state = 'missing';
    $('stageEyebrow').textContent = isSoundPath ? 'Sound not found' : 'Page not found';
    $('stageTitle').textContent = isSoundPath ? 'That sound slipped away.' : 'Nothing to hear here.';
    const text = $('missingText');
    text.textContent = isSoundPath && raw
      ? 'We couldn’t find a sound called “' + raw + '”. It may have been renamed. Try one of these instead:'
      : 'This page doesn’t exist, but these sounds do:';
    const list = $('missingList');
    shuffled(sounds).slice(0, 4).forEach((sound) => {
      const category = categoryById.get(sound.category);
      const item = el('li');
      const link = el('a', 'missing__link', sound.name);
      link.href = '/sound/' + encodeURIComponent(sound.id);
      link.style.setProperty('--key', category.color);
      link.style.setProperty('--key-side', category.side);
      item.appendChild(link);
      list.appendChild(item);
    });
    document.title = (isSoundPath ? 'Sound not found' : 'Page not found') + ' · Simple Soundboard';
  }

  // ---------- The big button ----------

  function setupSound(sound) {
    const category = categoryById.get(sound.category);
    const playable = Object.assign({}, sound, { src: '/' + sound.src.replace(/^\/+/, '') });
    const mega = $('mega');
    const slot = $('megaSlot');
    const timeEl = $('megaTime');
    const labelEl = $('megaLabel');
    const baseEl = $('waveBase');
    const litEl = $('waveLit');
    const stage = $('stage');

    document.body.dataset.state = 'ready';
    document.body.dataset.resolved = sound.id;
    stage.style.setProperty('--key', category.color);
    stage.style.setProperty('--key-side', category.side);
    $('stageEyebrow').textContent = 'Someone shared a sound with you';
    $('stageTitle').textContent = sound.name;
    $('stageCategory').textContent = category.label;
    mega.setAttribute('aria-label', 'Play ' + sound.name);
    document.title = sound.name + ' · Simple Soundboard';

    let duration = null;
    let restingLabel = '';
    let run = null;
    let frameRequested = false;

    function setMotion(depth, progress) {
      slot.style.setProperty('--depth', depth.toFixed(4));
      slot.style.setProperty('--progress', progress.toFixed(4));
    }

    function paintWave(buffer) {
      const values = engine.peaks(buffer, WAVE_BARS);
      const step = 100 / (values.length - 1);
      let d = '';
      values.forEach((value, i) => {
        const x = (i * step).toFixed(2);
        const h = Math.max(0.06, value) * 15;
        d += 'M' + x + ' ' + (16 - h).toFixed(2) + 'V' + (16 + h).toFixed(2);
      });
      baseEl.setAttribute('d', d);
      litEl.setAttribute('d', d);
    }

    function settle(spring) {
      run = null;
      setMotion(0, 0);
      labelEl.textContent = 'Play again';
      timeEl.textContent = restingLabel;
      if (spring) {
        slot.classList.remove('is-pop');
        void slot.offsetWidth;
        slot.classList.add('is-pop');
      }
    }

    function tick() {
      frameRequested = false;
      if (!run) return;
      const now = performance.now();
      const sunk = run.fromDepth + (1 - run.fromDepth) * Math.min(1, (now - run.pressedAt) / PRESS_MS);
      let depth = sunk;
      let progress = 0;
      if (run.voice) {
        const elapsed = run.voice.elapsed();
        const rise = elapsed / Math.max(run.voice.duration, MIN_RISE_SECONDS);
        if (rise >= 1) return settle(true);
        depth = Math.min(sunk, 1 - rise);
        progress = run.voice.duration ? Math.min(1, elapsed / run.voice.duration) : 1;
        timeEl.textContent = formatSeconds(Math.max(0, run.voice.duration - elapsed));
      }
      run.depth = depth;
      setMotion(depth, progress);
      requestFrame();
      return undefined;
    }

    function requestFrame() {
      if (!frameRequested) {
        frameRequested = true;
        window.requestAnimationFrame(tick);
      }
    }

    function press() {
      if (!engine.supported) {
        labelEl.textContent = 'This browser can’t play sounds';
        return;
      }
      engine.unlock();
      const current = { pressedAt: performance.now(), fromDepth: run ? run.depth : 0, depth: 0, voice: null };
      current.depth = current.fromDepth;
      run = current;
      slot.classList.remove('is-pop', 'is-broken');
      labelEl.textContent = 'Playing';
      celebrate(sound, category);
      requestFrame();
      engine.start(playable, { onComplete: (id, completedAt) => counter.hit(id, completedAt) })
        .then((voice) => {
          if (run !== current) return;
          current.voice = voice;
          if (duration === null) duration = voice.duration;
        })
        .catch((error) => {
          console.warn('Could not start "' + sound.name + '"', error);
          if (run === current) settle(false);
          labelEl.textContent = 'Couldn’t load it. Try again';
          slot.classList.add('is-broken');
        });
    }

    mega.addEventListener('click', press);

    // Space anywhere on the page plays it, unless something else has focus and wants the key.
    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== ' ' && event.key !== 'Enter') return;
      const target = event.target;
      if (target && target !== document.body && target !== document.documentElement) return;
      event.preventDefault();
      mega.focus({ preventScroll: true });
      press();
    });

    if (engine.supported) {
      engine.load(playable).then((buffer) => {
        duration = buffer.duration;
        restingLabel = formatSeconds(duration);
        if (!run) timeEl.textContent = restingLabel;
        paintWave(buffer);
      }).catch(() => {
        timeEl.textContent = '';
      });
    } else {
      labelEl.textContent = 'This browser can’t play sounds';
    }

    // ---------- Plays ----------

    const playsEl = $('stagePlays');
    function paintPlays() {
      const value = counter.value(sound.id);
      if (value === null) {
        playsEl.textContent = counter.status().offline ? 'Plays unavailable' : 'Counting plays…';
        return;
      }
      playsEl.textContent = value.toLocaleString() + (value === 1 ? ' play' : ' plays');
    }
    counter.subscribe((ids) => {
      if (!ids.length || ids.includes(sound.id)) paintPlays();
    });
    counter.refresh([sound.id]);
    paintPlays();

    // ---------- Share ----------

    $('stageShare').addEventListener('click', () => copyLink(canonicalUrl(sound)));
  }

  // A note hops off the button, like on the board.
  let hopIndex = 0;
  function celebrate(sound, category) {
    if (reducedMotion.matches || !Element.prototype.animate) return;
    const box = $('mega').getBoundingClientRect();
    if (!box.width) return;
    for (let n = 0; n < 3; n++) {
      const note = icon(NOTE_ICONS[(hopIndex + n) % NOTE_ICONS.length]);
      const drift = ((hopIndex + n) % 2 ? 1 : -1) * (30 + ((hopIndex + n) * 23) % 90);
      note.style.left = box.left + box.width * (0.3 + n * 0.2) + 'px';
      note.style.top = box.top + 18 + 'px';
      note.style.fill = n === 1 ? category.color : CANDY[(hopIndex + n) % CANDY.length][0];
      $('burst').appendChild(note);
      note.animate([
        { transform: 'translate(0, 0) scale(.5) rotate(-10deg)', opacity: 0 },
        { transform: 'translate(' + drift * 0.3 + 'px, -40px) scale(1.25) rotate(8deg)', opacity: 1, offset: 0.2 },
        { transform: 'translate(' + drift + 'px, -150px) scale(.9) rotate(-14deg)', opacity: 0 },
      ], { duration: 1000 + n * 120, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => note.remove();
    }
    const letters = document.querySelectorAll('.letter');
    if (letters.length) {
      letters[hopIndex % letters.length].animate([
        { translate: '0 0', scale: '1' },
        { translate: '0 -.22em', scale: '1.12', offset: 0.4 },
        { translate: '0 0', scale: '1' },
      ], { duration: 340, easing: 'ease-out' });
    }
    hopIndex++;
  }

  // ---------- Who shared it ----------

  // A signed-in sharer's link carries ?from=<account id>. The id is looked up here, so the page
  // shows that account's current username and nothing else can be written into the page through
  // the link. Link previews use the page's fixed tags, so the name never appears there.
  async function showSharer() {
    let id = null;
    try {
      id = new URLSearchParams(window.location.search).get('from');
    } catch (error) {
      return;
    }
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(
        'https://space-api.retrac-space.workers.dev/v1/players/id/' + encodeURIComponent(id),
        { credentials: 'omit', signal: controller.signal }
      );
      if (!response.ok) return;
      const body = await response.json();
      const username = body && body.data && typeof body.data.username === 'string'
        ? body.data.username.trim() : '';
      if (!username || username.length > 64 || document.body.dataset.state !== 'ready') return;
      const eyebrow = $('stageEyebrow');
      const line = el('span');
      line.append(el('strong', 'stage__sharer', username), ' shared a sound with you');
      eyebrow.replaceChildren(line);
      eyebrow.classList.add('is-named');
    } catch (error) {
      // Keep "Someone".
    } finally {
      clearTimeout(timeout);
    }
  }

  function canonicalUrl(sound) {
    return window.location.origin + '/sound/' + encodeURIComponent(sound.id);
  }

  let toastTimer = null;
  function toast(message) {
    const node = $('shareToast');
    node.textContent = message;
    node.hidden = false;
    node.classList.remove('is-showing');
    void node.offsetWidth;
    node.classList.add('is-showing');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.classList.remove('is-showing');
      node.hidden = true;
    }, 2200);
  }

  async function copyLink(url) {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch (error) {
      window.prompt('Copy this link:', url);
    }
  }

  // ---------- Volume ----------

  function setupVolume() {
    const input = $('volume');
    let stored = null;
    try {
      const value = Number(window.localStorage.getItem(VOLUME_KEY));
      if (window.localStorage.getItem(VOLUME_KEY) !== null && value >= 0 && value <= 100) stored = value;
    } catch (error) {
      // Storage can be blocked.
    }
    if (stored !== null) input.value = stored;
    function apply(value) {
      input.style.setProperty('--fill', value + '%');
      engine.setVolume(Math.pow(value / 100, 2));
    }
    input.addEventListener('input', () => {
      const value = Number(input.value);
      apply(value);
      try {
        window.localStorage.setItem(VOLUME_KEY, String(value));
      } catch (error) {
        // Still works for this visit.
      }
    });
    apply(Number(input.value));
  }

  // ---------- Start up ----------

  buildBannerTitle();
  buildRibbon();
  buildExplore();
  setupVolume();

  const { isSoundPath, raw } = requested();
  const sound = resolve(raw);
  if (sound) {
    const canonical = '/sound/' + encodeURIComponent(sound.id);
    if (window.location.pathname !== canonical) {
      try {
        window.history.replaceState(null, '', canonical + window.location.search + window.location.hash);
      } catch (error) {
        // The address just stays as it was.
      }
    }
    setupSound(sound);
    showSharer();
  } else {
    showMissing(isSoundPath, raw);
  }
})();
