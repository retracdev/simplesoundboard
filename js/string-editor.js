/*
 * The string editor: a timeline with tracks, like a small video editor but for sounds.
 *
 * Sounds are dragged in from the library on the left. On the timeline, clips can be moved along
 * and between tracks, trimmed from either end, cut in two, copied and given their own volume.
 * Clips on different tracks play over each other. On one track they can't overlap, so a clip
 * dropped on another slides to the closest gap.
 *
 * Dragging uses pointer events rather than the browser's own drag and drop, which doesn't work
 * on touch screens.
 */
(function () {
  'use strict';

  const core = window.StringsCore;
  const engine = window.SoundEngine;
  const { categories, sounds } = window.SOUND_CATALOG;

  const LANE_HEIGHT = 68;
  const PIXELS_PER_SECOND = 90;
  const MIN_ZOOM = 15;
  const MAX_ZOOM = 400;
  const SPARE_SECONDS = 8; // Empty timeline past the last clip, to drag into.
  const SNAP_PX = 8;
  const LIFT_DISTANCE_PX = 4;
  const TOUCH_HOLD_MS = 180;
  const TOUCH_SLOP_PX = 8;
  const SCROLL_EDGE_PX = 36;
  const SCROLL_SPEED_PX = 10;
  const NUDGE_SECONDS = 0.1;
  const WAVE_BARS_PER_SECOND = 24;
  const MAX_WAVE_BARS = 400;
  const RULER_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
  const RULER_MIN_GAP_PX = 64;
  const DELETE_CONFIRM_MS = 3000;
  const PREVIEW_VOICE = 'string-editor';

  const soundById = new Map(sounds.map((sound) => [sound.id, sound]));
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const soundFor = (id) => soundById.get(id);
  const categoryOf = (id) => {
    const sound = soundFor(id);
    return sound && categoryById.get(sound.category);
  };

  const soundLengths = new Map(); // sound id -> seconds, once it has loaded
  const wavePaths = new Map(); // sound id -> { path, width }, drawn over the whole sound

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, label) {
    const node = el('button', className, text);
    node.type = 'button';
    if (label) node.setAttribute('aria-label', label);
    return node;
  }

  function normalize(text) {
    return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  }

  function formatClock(seconds) {
    const whole = Math.floor(seconds);
    return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0')
      + '.' + String(Math.floor((seconds - whole) * 100)).padStart(2, '0');
  }

  function formatTick(seconds, step) {
    if (seconds < 60) return (step < 1 ? seconds.toFixed(step < 0.5 ? 2 : 1) : String(seconds)) + 's';
    return Math.floor(seconds / 60) + ':' + String(Math.round(seconds % 60)).padStart(2, '0');
  }

  // ---------- The dialog's parts ----------

  const dialog = el('dialog', 'string-editor');
  dialog.setAttribute('aria-labelledby', 'string-editor-title');

  const header = el('header', 'string-editor__header');
  const title = el('h2', 'sr-only', 'String editor');
  title.id = 'string-editor-title';
  const nameEl = el('input', 'string-editor__name');
  nameEl.type = 'text';
  nameEl.maxLength = core.MAX_NAME;
  nameEl.placeholder = 'Name your string';
  nameEl.autocomplete = 'off';
  nameEl.spellcheck = false;
  nameEl.setAttribute('aria-label', 'String name');
  const messageEl = el('p', 'string-editor__message');
  messageEl.setAttribute('role', 'status');
  const deleteEl = button('signin-button signin-button--quiet string-editor__delete', 'Delete string');
  const cancelEl = button('signin-button signin-button--quiet', 'Cancel');
  const saveEl = button('signin-button', 'Save string');
  header.append(title, nameEl, messageEl, deleteEl, cancelEl, saveEl);

  const discardBar = el('div', 'string-editor__discard');
  discardBar.hidden = true;
  const keepEl = button('signin-button signin-button--quiet', 'Keep editing');
  const discardEl = button('signin-button signin-button--danger', 'Discard');
  discardBar.append(el('p', '', 'Discard your changes to this string?'), keepEl, discardEl);

  const library = el('aside', 'string-editor__library');
  library.setAttribute('aria-label', 'Sounds');
  const searchEl = el('input', 'string-editor__search');
  searchEl.type = 'search';
  searchEl.placeholder = 'Search sounds';
  searchEl.autocomplete = 'off';
  searchEl.spellcheck = false;
  searchEl.setAttribute('aria-label', 'Search sounds');
  const listEl = el('div', 'string-editor__list');
  const noMatchEl = el('p', 'string-editor__no-match', 'No sounds match that.');
  noMatchEl.hidden = true;
  listEl.appendChild(noMatchEl);
  library.append(searchEl, listEl);

  const stage = el('section', 'string-editor__stage');
  stage.setAttribute('aria-label', 'Timeline');
  const toolbar = el('div', 'string-editor__toolbar');
  const playEl = button('string-editor__play', 'Play');
  const clockEl = el('span', 'string-editor__clock', formatClock(0));
  const splitEl = button('string-editor__tool', 'Split', 'Split the selected clip at the playhead');
  const duplicateEl = button('string-editor__tool', 'Duplicate', 'Duplicate the selected clip');
  const removeEl = button('string-editor__tool', 'Remove', 'Remove the selected clip');
  const undoEl = button('string-editor__tool', 'Undo');
  const redoEl = button('string-editor__tool', 'Redo');

  function slider(label, min, max, value, className) {
    const wrap = el('label', 'string-editor__slider ' + className);
    const input = el('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.value = value;
    wrap.append(el('span', '', label), input);
    return { wrap, input };
  }
  const gainControl = slider('Clip volume', 0, core.MAX_GAIN * 100, 100, 'string-editor__gain');
  const zoomControl = slider('Zoom', 0, 100, 50, 'string-editor__zoom');
  toolbar.append(playEl, clockEl, splitEl, duplicateEl, removeEl, gainControl.wrap, undoEl, redoEl, zoomControl.wrap);

  const timeline = el('div', 'string-editor__timeline');
  timeline.tabIndex = -1;
  const content = el('div', 'string-editor__content');
  const labels = el('div', 'string-editor__labels');
  const area = el('div', 'string-editor__area');
  const ruler = el('div', 'string-editor__ruler');
  ruler.setAttribute('aria-hidden', 'true');
  const tracks = el('div', 'string-editor__tracks');
  const lanesEl = el('div', 'string-editor__lanes');
  const dropEl = el('div', 'string-editor__drop');
  dropEl.hidden = true;
  const playheadEl = el('div', 'string-editor__playhead');
  playheadEl.setAttribute('aria-hidden', 'true');
  tracks.append(lanesEl, dropEl);
  area.append(ruler, tracks, playheadEl);
  content.append(labels, area);
  timeline.appendChild(content);

  const hint = el('p', 'string-editor__hint',
    'Drag sounds onto a track. Drag a clip to move it, or its edges to trim it. Space plays, S splits, Delete removes, Ctrl+Z undoes.');
  stage.append(toolbar, timeline, hint);

  const work = el('div', 'string-editor__work');
  work.append(library, stage);
  const panel = el('div', 'string-editor__panel');
  panel.append(header, discardBar, work);
  dialog.appendChild(panel);
  document.body.appendChild(dialog);

  // ---------- The session ----------

  let session = null;
  let nextKey = 1;

  const zoomToScale = (value) => MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, value / 100);
  const scaleToZoom = (scale) => Math.log(scale / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM) * 100;

  const selectedClip = () => session && session.clips.find((clip) => clip.key === session.selected);
  const snapshot = () => JSON.stringify(session.clips.map(({ key, ...clip }) => clip));
  const currentState = () => JSON.stringify({ name: nameEl.value.trim(), clips: snapshot() });

  function setMessage(text) {
    messageEl.textContent = text || '';
  }

  // Call this before changing clips. It's what undo goes back to.
  function remember() {
    session.undo.push(snapshot());
    session.redo = [];
  }

  function restore(saved) {
    session.clips = JSON.parse(saved).map((clip) => ({ ...clip, key: nextKey++ }));
    session.selected = null;
    render();
  }

  function undoOrRedo(from, to) {
    if (!from.length) return;
    stopPlaying();
    to.push(snapshot());
    restore(from.pop());
  }

  // ---------- Drawing ----------

  function wavePath(soundId) {
    if (wavePaths.has(soundId)) return wavePaths.get(soundId);
    return null;
  }

  // Draws the whole sound once. A trimmed clip just shows part of that drawing.
  async function ensureLoaded(soundId) {
    const sound = soundFor(soundId);
    const buffer = await engine.load(sound);
    soundLengths.set(soundId, buffer.duration);
    if (!wavePaths.has(soundId)) {
      const bars = Math.max(20, Math.min(MAX_WAVE_BARS, Math.ceil(buffer.duration * WAVE_BARS_PER_SECOND)));
      const path = engine.peaks(buffer, bars).map((value, i) => {
        const height = Math.max(0.5, value * 11);
        return 'M' + (i * 2 + 1) + ' ' + (12 - height).toFixed(2) + 'V' + (12 + height).toFixed(2);
      }).join('');
      wavePaths.set(soundId, { path, width: bars * 2 });
    }
    return buffer.duration;
  }

  function buildClipEl(clip) {
    const node = el('div', 'string-clip');
    node.tabIndex = 0;
    node.dataset.key = clip.key;
    node.setAttribute('role', 'group');
    const sound = soundFor(clip.sound);
    const category = categoryOf(clip.sound);
    if (category) {
      node.style.setProperty('--key', category.color);
      node.style.setProperty('--key-side', category.side);
    }
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'string-clip__wave');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.appendChild(document.createElementNS(svgNS, 'path'));
    const name = el('span', 'string-clip__name', sound ? sound.name : clip.sound);
    const start = el('span', 'string-clip__handle string-clip__handle--start');
    const finish = el('span', 'string-clip__handle string-clip__handle--end');
    start.dataset.trim = 'start';
    finish.dataset.trim = 'end';
    node.append(svg, name, start, finish);
    return node;
  }

  function placeClipEl(clip) {
    let node = session.clipEls.get(clip.key);
    if (!node) {
      node = buildClipEl(clip);
      session.clipEls.set(clip.key, node);
      tracks.appendChild(node);
    }
    node.style.left = clip.at * session.scale + 'px';
    node.style.top = clip.lane * LANE_HEIGHT + 'px';
    node.style.width = clip.length * session.scale + 'px';
    node.classList.toggle('is-selected', clip.key === session.selected);
    const sound = soundFor(clip.sound);
    node.setAttribute('aria-label', (sound ? sound.name : clip.sound) + ', track ' + (clip.lane + 1)
      + ', starts at ' + formatClock(clip.at) + ', lasts ' + formatClock(clip.length));

    const wave = wavePath(clip.sound);
    const length = soundLengths.get(clip.sound);
    if (wave && length) {
      const svg = node.querySelector('svg');
      const unit = wave.width / length;
      svg.setAttribute('viewBox', clip.from * unit + ' 0 ' + clip.length * unit + ' 24');
      svg.firstChild.setAttribute('d', wave.path);
    }
    return node;
  }

  function renderRuler(width) {
    const step = RULER_STEPS.find((candidate) => candidate * session.scale >= RULER_MIN_GAP_PX)
      || RULER_STEPS[RULER_STEPS.length - 1];
    const ticks = [];
    const count = Math.floor(width / session.scale / step);
    for (let i = 0; i <= count; i++) {
      const time = Math.round(i * step * 100) / 100;
      const tick = el('span', 'string-editor__tick', formatTick(time, step));
      tick.style.left = time * session.scale + 'px';
      ticks.push(tick);
    }
    ruler.replaceChildren(...ticks);
  }

  function render() {
    const lanes = core.laneCount(session.clips);
    if (lanes !== session.lanes) {
      session.lanes = lanes;
      lanesEl.replaceChildren(...Array.from({ length: lanes }, () => el('div', 'string-editor__lane')));
      labels.replaceChildren(el('div', 'string-editor__corner'),
        ...Array.from({ length: lanes }, (_, i) => el('div', 'string-editor__label', String(i + 1))));
    }
    tracks.style.height = lanes * LANE_HEIGHT + 'px';

    const wanted = new Set(session.clips.map((clip) => clip.key));
    session.clipEls.forEach((node, key) => {
      if (!wanted.has(key)) {
        node.remove();
        session.clipEls.delete(key);
      }
    });
    session.clips.forEach(placeClipEl);

    const seconds = Math.min(core.MAX_TIME, core.duration(session.clips) + SPARE_SECONDS);
    const available = Math.max(0, timeline.clientWidth - labels.offsetWidth);
    const width = Math.max(available, seconds * session.scale);
    if (width !== session.width || session.scale !== session.rulerScale) {
      session.width = width;
      session.rulerScale = session.scale;
      area.style.width = width + 'px';
      renderRuler(width);
    }
    renderPlayhead();
    renderToolbar();
  }

  function renderPlayhead() {
    playheadEl.style.left = session.playhead * session.scale + 'px';
    clockEl.textContent = formatClock(session.playhead);
  }

  function renderToolbar() {
    const clip = selectedClip();
    const canSplit = clip && core.split(clip, session.playhead);
    splitEl.disabled = !canSplit;
    duplicateEl.disabled = !clip;
    removeEl.disabled = !clip;
    gainControl.input.disabled = !clip;
    if (clip) gainControl.input.value = Math.round(core.clipGain(clip) * 100);
    undoEl.disabled = !session.undo.length;
    redoEl.disabled = !session.redo.length;
    playEl.textContent = session.playing ? 'Stop' : 'Play';
    playEl.classList.toggle('is-playing', Boolean(session.playing));
    playEl.disabled = !session.clips.length;
    saveEl.disabled = !session.clips.length;
  }

  // ---------- Positions ----------

  const timeAt = (clientX) => (clientX - area.getBoundingClientRect().left) / session.scale;

  function laneAt(clientY) {
    const lane = Math.floor((clientY - tracks.getBoundingClientRect().top) / LANE_HEIGHT);
    return core.clamp(lane, 0, session.lanes - 1);
  }

  function overTracks(x, y) {
    const box = timeline.getBoundingClientRect();
    const trackBox = tracks.getBoundingClientRect();
    return x >= box.left && x <= box.right && y >= Math.max(box.top, trackBox.top) && y <= Math.min(box.bottom, trackBox.bottom);
  }

  function snapMove(time, length, ignore, event) {
    if (event && event.altKey) return time; // Alt places a clip freely.
    return core.snapMove(time, length, core.snapTargets(session.clips, ignore, session.playhead), SNAP_PX / session.scale);
  }

  // Keeps the timeline moving while something is dragged against its edge.
  function startEdgeScroll(onScroll) {
    let frame = null;
    let pointer = null;
    const step = () => {
      if (pointer) {
        const box = timeline.getBoundingClientRect();
        let dx = 0;
        if (pointer.x < box.left + SCROLL_EDGE_PX + labels.offsetWidth) dx = -SCROLL_SPEED_PX;
        else if (pointer.x > box.right - SCROLL_EDGE_PX) dx = SCROLL_SPEED_PX;
        if (dx) {
          const before = timeline.scrollLeft;
          timeline.scrollLeft += dx;
          if (timeline.scrollLeft !== before) onScroll();
        }
      }
      frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return {
      track(x, y) { pointer = { x, y }; },
      stop() { window.cancelAnimationFrame(frame); },
    };
  }

  // ---------- Changing clips ----------

  function select(key) {
    session.selected = key;
    session.clips.forEach(placeClipEl);
    renderToolbar();
  }

  async function addClip(soundId, lane, at) {
    const current = session;
    setMessage('');
    if (current.clips.length >= core.MAX_CLIPS) {
      setMessage('A string can hold ' + core.MAX_CLIPS + ' clips at most.');
      return;
    }
    let length;
    try {
      length = await ensureLoaded(soundId);
    } catch (error) {
      console.warn('Could not load "' + soundId + '"', error);
      if (session === current) setMessage('Couldn’t load that sound. Try again.');
      return;
    }
    if (session !== current) return;
    const clipLength = Math.min(length, core.MAX_TIME);
    const targetLane = lane === null ? core.freeLane(session.clips, clipLength, at) : lane;
    const useLane = targetLane === null ? 0 : targetLane;
    const start = core.freeStart(session.clips, useLane, clipLength, at);
    if (start === null) {
      setMessage('There’s no room for that sound on this track.');
      return;
    }
    stopPlaying();
    remember();
    const clip = { key: nextKey++, sound: soundId, at: start, from: 0, length: clipLength, lane: useLane };
    session.clips.push(clip);
    session.selected = clip.key;
    render();
  }

  function removeSelected() {
    const clip = selectedClip();
    if (!clip) return;
    stopPlaying();
    remember();
    session.clips = session.clips.filter((other) => other !== clip);
    session.selected = null;
    render();
    timeline.focus({ preventScroll: true });
  }

  function splitSelected() {
    const clip = selectedClip();
    const parts = clip && core.split(clip, session.playhead);
    if (!parts) return;
    if (session.clips.length >= core.MAX_CLIPS) {
      setMessage('A string can hold ' + core.MAX_CLIPS + ' clips at most.');
      return;
    }
    stopPlaying();
    remember();
    Object.assign(clip, parts[0]);
    const right = { ...parts[1], key: nextKey++ };
    session.clips.push(right);
    session.selected = right.key;
    render();
  }

  function duplicateSelected() {
    const clip = selectedClip();
    if (!clip) return;
    if (session.clips.length >= core.MAX_CLIPS) {
      setMessage('A string can hold ' + core.MAX_CLIPS + ' clips at most.');
      return;
    }
    const start = core.freeStart(session.clips, clip.lane, clip.length, core.end(clip));
    if (start === null) {
      setMessage('There’s no room for a copy on this track.');
      return;
    }
    stopPlaying();
    remember();
    const copy = { ...clip, key: nextKey++, at: start };
    session.clips.push(copy);
    session.selected = copy.key;
    render();
  }

  function moveClip(clip, lane, time) {
    const start = core.freeStart(session.clips, lane, clip.length, time, clip);
    if (start === null) return false;
    clip.lane = lane;
    clip.at = start;
    return true;
  }

  function nudge(clip, dx, dy) {
    const lane = core.clamp(clip.lane + dy, 0, core.MAX_LANES - 1);
    stopPlaying();
    remember();
    if (!moveClip(clip, lane, clip.at + dx)) session.undo.pop();
    render();
  }

  function trimToPlayhead(clip, side) {
    const changes = side === 'start'
      ? core.trimStart(clip, session.playhead, session.clips)
      : core.trimEnd(clip, session.playhead, session.clips, soundLengths.get(clip.sound) || clip.from + clip.length);
    stopPlaying();
    remember();
    Object.assign(clip, changes);
    render();
  }

  // ---------- Playing ----------

  function stopPlaying(keepPosition) {
    if (!session || !session.playing) return;
    const run = session.playing;
    session.playing = null;
    window.cancelAnimationFrame(run.frame);
    engine.stop(PREVIEW_VOICE);
    if (!keepPosition) session.playhead = run.startedFrom;
    renderPlayhead();
    renderToolbar();
  }

  async function play() {
    if (!session.clips.length || !engine.supported) return;
    engine.unlock();
    const total = core.duration(session.clips);
    const from = session.playhead >= total ? 0 : session.playhead;
    const run = { startedFrom: from, frame: null };
    session.playing = run;
    session.playhead = from;
    renderToolbar();
    let voice;
    const current = session;
    try {
      voice = await engine.startClips(PREVIEW_VOICE, session.clips, soundFor, { offset: from });
    } catch (error) {
      console.warn('Could not play this string', error);
      if (session === current && session.playing === run) {
        session.playing = null;
        renderToolbar();
        setMessage('Couldn’t load a sound in this string. Try again.');
      }
      return;
    }
    if (session !== current || session.playing !== run) {
      engine.stop(PREVIEW_VOICE); // Stopped while its sounds were still loading.
      return;
    }
    const step = () => {
      if (session !== current || session.playing !== run) return;
      const elapsed = voice.elapsed();
      if (elapsed >= voice.duration) {
        stopPlaying();
        return;
      }
      session.playhead = from + elapsed;
      renderPlayhead();
      // Follows the playhead off the right edge of the timeline.
      const x = session.playhead * session.scale;
      const left = timeline.scrollLeft;
      const visible = timeline.clientWidth - labels.offsetWidth;
      if (x > left + visible - SCROLL_EDGE_PX) timeline.scrollLeft = x - SCROLL_EDGE_PX;
      run.frame = window.requestAnimationFrame(step);
    };
    run.frame = window.requestAnimationFrame(step);
  }

  function togglePlay() {
    if (!session) return;
    if (session.playing) stopPlaying();
    else play();
  }

  function setPlayhead(time) {
    session.playhead = core.clamp(time, 0, core.MAX_TIME);
    renderPlayhead();
    renderToolbar();
  }

  // ---------- Dragging clips and the playhead ----------

  let gesture = null;

  function endGesture(cancelled) {
    const finished = gesture;
    gesture = null;
    if (!finished) return;
    if (finished.edge) finished.edge.stop();
    try {
      tracks.releasePointerCapture(finished.pointerId);
    } catch (error) {
      // It had already been released.
    }
    dialog.classList.remove('is-dragging-clip');
    if (cancelled) {
      Object.assign(finished.clip, finished.start);
      render();
    } else if (snapshot() !== finished.before) {
      session.undo.push(finished.before);
      session.redo = [];
      render();
    }
  }

  function applyGesture(x, y, event) {
    const { clip } = gesture;
    const pointerTime = timeAt(x);
    if (gesture.mode === 'move') {
      const desired = snapMove(pointerTime - gesture.grab, clip.length, clip, event);
      moveClip(clip, laneAt(y), desired);
    } else if (gesture.mode === 'start') {
      const time = event && event.altKey ? pointerTime
        : core.snapTime(pointerTime, core.snapTargets(session.clips, clip, session.playhead), SNAP_PX / session.scale);
      Object.assign(clip, core.trimStart(clip, time, session.clips));
    } else {
      const time = event && event.altKey ? pointerTime
        : core.snapTime(pointerTime, core.snapTargets(session.clips, clip, session.playhead), SNAP_PX / session.scale);
      Object.assign(clip, core.trimEnd(clip, time, session.clips, soundLengths.get(clip.sound) || clip.from + clip.length));
    }
    render();
  }

  tracks.addEventListener('pointerdown', (event) => {
    if (gesture || event.button !== 0) return;
    const node = event.target.closest('.string-clip');
    if (!node) {
      select(null);
      setPlayhead(Math.max(0, timeAt(event.clientX)));
      stopPlaying(true);
      return;
    }
    const clip = session.clips.find((other) => String(other.key) === node.dataset.key);
    select(clip.key);
    stopPlaying();
    const handle = event.target.closest('[data-trim]');
    gesture = {
      clip,
      mode: handle ? handle.dataset.trim : 'move',
      pointerId: event.pointerId,
      grab: timeAt(event.clientX) - clip.at,
      before: snapshot(),
      start: { at: clip.at, from: clip.from, length: clip.length, lane: clip.lane },
      x: event.clientX,
      y: event.clientY,
    };
    gesture.edge = startEdgeScroll(() => {
      if (gesture) applyGesture(gesture.x, gesture.y, null);
    });
    gesture.edge.track(event.clientX, event.clientY);
    try {
      tracks.setPointerCapture(event.pointerId);
    } catch (error) {
      // The pointer has already gone. The next event ends the drag.
    }
    dialog.classList.add('is-dragging-clip');
  });

  tracks.addEventListener('pointermove', (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    gesture.edge.track(event.clientX, event.clientY);
    applyGesture(event.clientX, event.clientY, event);
  });

  tracks.addEventListener('pointerup', (event) => {
    if (gesture && event.pointerId === gesture.pointerId) endGesture(false);
  });
  tracks.addEventListener('pointercancel', (event) => {
    if (gesture && event.pointerId === gesture.pointerId) endGesture(true);
  });

  let scrubbing = null;

  ruler.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    stopPlaying(true);
    scrubbing = event.pointerId;
    try {
      ruler.setPointerCapture(event.pointerId);
    } catch (error) {
      // The pointer has already gone.
    }
    setPlayhead(Math.max(0, timeAt(event.clientX)));
  });
  ruler.addEventListener('pointermove', (event) => {
    if (scrubbing === event.pointerId) setPlayhead(Math.max(0, timeAt(event.clientX)));
  });
  ['pointerup', 'pointercancel'].forEach((type) => ruler.addEventListener(type, () => {
    scrubbing = null;
  }));

  // ---------- The library ----------

  const rows = sounds.map((sound) => {
    const category = categoryById.get(sound.category);
    const row = el('div', 'string-sound');
    row.dataset.sound = sound.id;
    row.style.setProperty('--key', category.color);
    row.style.setProperty('--key-side', category.side);
    const main = button('string-sound__main', undefined, 'Preview ' + sound.name);
    main.append(el('span', 'string-sound__dot'), el('span', 'string-sound__name', sound.name));
    const add = button('string-sound__add', '+', 'Add ' + sound.name + ' at the playhead');
    row.append(main, add);
    listEl.insertBefore(row, noMatchEl);
    return {
      row,
      sound,
      text: normalize([sound.name, category.label, sound.tags || ''].join(' ')),
    };
  });

  function filterLibrary() {
    const terms = normalize(searchEl.value).split(/\s+/).filter(Boolean);
    let shown = 0;
    rows.forEach(({ row, text }) => {
      const match = terms.every((term) => text.includes(term));
      row.hidden = !match;
      if (match) shown++;
    });
    noMatchEl.hidden = shown > 0;
  }

  let previewing = null;

  function stopPreview() {
    if (previewing) engine.stop(previewing);
    previewing = null;
  }

  function preview(sound) {
    if (!engine.supported) return;
    engine.unlock();
    stopPreview();
    previewing = sound.id;
    engine.start(sound).catch(() => setMessage('Couldn’t load that sound. Try again.'));
  }

  // Dragging a sound out of the library.
  let carry = null;
  let suppressPreview = false;

  function positionCarry() {
    const { x, y } = carry;
    carry.float.style.transform = 'translate(' + (x + 10) + 'px, ' + (y + 10) + 'px)';
    if (!overTracks(x, y)) {
      dropEl.hidden = true;
      carry.target = null;
      return;
    }
    const length = soundLengths.get(carry.sound.id) || 1;
    const lane = laneAt(y);
    const at = core.freeStart(session.clips, lane, length, snapMove(timeAt(x), length, null, null));
    if (at === null) {
      dropEl.hidden = true;
      carry.target = null;
      return;
    }
    carry.target = { lane, at };
    dropEl.hidden = false;
    dropEl.style.left = at * session.scale + 'px';
    dropEl.style.top = lane * LANE_HEIGHT + 'px';
    dropEl.style.width = length * session.scale + 'px';
  }

  function liftCarry() {
    carry.lifted = true;
    carry.float = el('div', 'string-sound__float', carry.sound.name);
    carry.float.style.setProperty('--key', categoryById.get(carry.sound.category).color);
    dialog.appendChild(carry.float);
    dialog.classList.add('is-dragging-sound');
    ensureLoaded(carry.sound.id).catch(() => {});
    carry.edge = startEdgeScroll(() => {
      if (carry) positionCarry();
    });
    carry.edge.track(carry.x, carry.y);
    try {
      carry.row.setPointerCapture(carry.pointerId);
    } catch (error) {
      // The pointer has already gone. The next event ends the drag.
    }
    positionCarry();
  }

  function endCarry(drop) {
    const finished = carry;
    carry = null;
    if (!finished) return;
    clearTimeout(finished.holdTimer);
    if (!finished.lifted) return;
    finished.edge.stop();
    finished.float.remove();
    dialog.classList.remove('is-dragging-sound');
    dropEl.hidden = true;
    suppressPreview = true;
    setTimeout(() => {
      suppressPreview = false;
    }, 0);
    if (drop && finished.target) addClip(finished.sound.id, finished.target.lane, finished.target.at);
  }

  listEl.addEventListener('pointerdown', (event) => {
    if (carry || event.button !== 0 || event.target.closest('.string-sound__add')) return;
    const row = event.target.closest('.string-sound');
    if (!row) return;
    carry = {
      row,
      sound: soundFor(row.dataset.sound),
      pointerId: event.pointerId,
      touch: event.pointerType !== 'mouse',
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      lifted: false,
      target: null,
      holdTimer: null,
    };
    if (carry.touch) {
      carry.holdTimer = setTimeout(() => {
        if (carry) liftCarry();
      }, TOUCH_HOLD_MS);
    }
  });

  listEl.addEventListener('pointermove', (event) => {
    if (!carry || event.pointerId !== carry.pointerId) return;
    carry.x = event.clientX;
    carry.y = event.clientY;
    if (!carry.lifted) {
      const travel = Math.hypot(carry.x - carry.startX, carry.y - carry.startY);
      if (carry.touch) {
        // Moved before the pause was up, so this is a scroll and not a drag.
        if (travel > TOUCH_SLOP_PX) endCarry(false);
        return;
      }
      if (travel < LIFT_DISTANCE_PX) return;
      liftCarry();
    }
    carry.edge.track(carry.x, carry.y);
    positionCarry();
  });

  listEl.addEventListener('pointerup', (event) => {
    if (carry && event.pointerId === carry.pointerId) endCarry(true);
  });
  listEl.addEventListener('pointercancel', (event) => {
    if (carry && event.pointerId === carry.pointerId) endCarry(false);
  });

  // Once a finger has lifted a sound, the list mustn't scroll underneath it.
  listEl.addEventListener('touchmove', (event) => {
    if (carry && carry.lifted) event.preventDefault();
  }, { passive: false });

  listEl.addEventListener('click', (event) => {
    if (suppressPreview) return;
    const row = event.target.closest('.string-sound');
    if (!row) return;
    const sound = soundFor(row.dataset.sound);
    if (event.target.closest('.string-sound__add')) addClip(sound.id, null, session.playhead);
    else if (event.target.closest('.string-sound__main')) preview(sound);
  });

  searchEl.addEventListener('input', filterLibrary);

  // ---------- Saving and closing ----------

  function finish(afterClose) {
    stopPlaying(true);
    endGesture(true);
    endCarry(false);
    stopPreview();
    const { trigger } = session;
    session.clipEls.forEach((node) => node.remove());
    session = null;
    dialog.close();
    if (afterClose) afterClose();
    else if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  function requestClose() {
    if (!session) return;
    if (currentState() === session.initial) {
      finish();
      return;
    }
    discardBar.hidden = false;
    keepEl.focus({ preventScroll: true });
  }

  function save() {
    const name = nameEl.value.trim();
    if (!name) {
      setMessage('Give your string a name first.');
      nameEl.focus({ preventScroll: true });
      return;
    }
    if (!session.clips.length) {
      setMessage('Add at least one sound first.');
      return;
    }
    const string = { id: session.id, name, clips: core.serialize(session.clips) };
    const problem = session.onSave(string);
    if (problem) {
      setMessage(problem);
      return;
    }
    const { onSaved } = session;
    finish(() => onSaved(string.id));
  }

  function resetDelete() {
    clearTimeout(session && session.deleteTimer);
    deleteEl.textContent = 'Delete string';
    deleteEl.classList.remove('signin-button--danger');
    deleteEl.classList.add('signin-button--quiet');
    if (session) session.deleteArmed = false;
  }

  deleteEl.addEventListener('click', () => {
    if (!session.deleteArmed) {
      session.deleteArmed = true;
      deleteEl.textContent = 'Really delete?';
      deleteEl.classList.add('signin-button--danger');
      deleteEl.classList.remove('signin-button--quiet');
      session.deleteTimer = setTimeout(resetDelete, DELETE_CONFIRM_MS);
      return;
    }
    clearTimeout(session.deleteTimer);
    const { id, onDelete } = session;
    resetDelete();
    finish(() => onDelete(id));
  });

  saveEl.addEventListener('click', save);
  cancelEl.addEventListener('click', requestClose);
  keepEl.addEventListener('click', () => {
    discardBar.hidden = true;
    cancelEl.focus({ preventScroll: true });
  });
  discardEl.addEventListener('click', () => finish());
  playEl.addEventListener('click', togglePlay);
  splitEl.addEventListener('click', splitSelected);
  duplicateEl.addEventListener('click', duplicateSelected);
  removeEl.addEventListener('click', removeSelected);
  undoEl.addEventListener('click', () => undoOrRedo(session.undo, session.redo));
  redoEl.addEventListener('click', () => undoOrRedo(session.redo, session.undo));

  let gainBefore = null;
  gainControl.input.addEventListener('input', () => {
    const clip = selectedClip();
    if (!clip) return;
    if (gainBefore === null) gainBefore = snapshot();
    stopPlaying();
    const value = Number(gainControl.input.value) / 100;
    if (value === 1) delete clip.gain;
    else clip.gain = value;
  });
  gainControl.input.addEventListener('change', () => {
    if (gainBefore !== null && gainBefore !== snapshot()) {
      session.undo.push(gainBefore);
      session.redo = [];
    }
    gainBefore = null;
    renderToolbar();
  });

  // Keeps whatever's at the left edge of the timeline in place while zooming.
  zoomControl.input.addEventListener('input', () => {
    const leftTime = timeline.scrollLeft / session.scale;
    session.scale = zoomToScale(Number(zoomControl.input.value));
    render();
    timeline.scrollLeft = leftTime * session.scale;
  });

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    requestClose();
  });

  dialog.addEventListener('keydown', (event) => {
    // The dialog's keys belong to it, not to the page's shortcuts.
    event.stopPropagation();
    if (!session) return;
    const typing = event.target === nameEl || event.target === searchEl;
    const command = event.ctrlKey || event.metaKey;
    if (typing) return;

    const key = event.key.toLowerCase();
    if (command && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) undoOrRedo(session.redo, session.undo);
      else undoOrRedo(session.undo, session.redo);
      return;
    }
    if (command && key === 'y') {
      event.preventDefault();
      undoOrRedo(session.redo, session.undo);
      return;
    }
    if (command && key === 'd') {
      event.preventDefault();
      duplicateSelected();
      return;
    }
    if (command || event.altKey) return;
    if (event.target.matches('input[type="range"]')) return;

    // A focused clip counts as the selected one.
    const focusedClip = event.target.closest && event.target.closest('.string-clip');
    if (focusedClip && String(session.selected) !== focusedClip.dataset.key) {
      select(Number(focusedClip.dataset.key));
    }
    const clip = selectedClip();

    if (event.key === ' ' && event.target.tagName !== 'BUTTON') {
      event.preventDefault();
      togglePlay();
    } else if (key === 's') {
      event.preventDefault();
      splitSelected();
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && clip) {
      event.preventDefault();
      removeSelected();
    } else if (event.key === '[' && clip) {
      trimToPlayhead(clip, 'start');
    } else if (event.key === ']' && clip) {
      trimToPlayhead(clip, 'end');
    } else if (clip && focusedClip && event.key.startsWith('Arrow')) {
      event.preventDefault();
      const size = event.shiftKey ? 1 : NUDGE_SECONDS;
      if (event.key === 'ArrowLeft') nudge(clip, -size, 0);
      else if (event.key === 'ArrowRight') nudge(clip, size, 0);
      else if (event.key === 'ArrowUp') nudge(clip, 0, -1);
      else nudge(clip, 0, 1);
    }
  });

  // Everything's sizes depend on the window, including how wide an empty timeline should look.
  window.addEventListener('resize', () => {
    if (session) render();
  });

  // ---------- Opening ----------

  // Fills in lengths and waveforms as sounds finish loading, without holding anything up. One
  // at a time, the same as the page's own loading, which shares these files.
  let libraryLoading = false;

  async function loadLibrary() {
    if (libraryLoading || !engine.supported) return;
    libraryLoading = true;
    for (const sound of sounds) {
      try {
        await ensureLoaded(sound.id);
      } catch (error) {
        // Picking this sound tries again, and says so if it still can't load.
      }
    }
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // options: { string or soundId, trigger, onSave(string) -> problem text or '', onSaved(id),
  // onDelete(id) }
  async function open(options) {
    if (session) return;
    const { string } = options;
    session = {
      id: string ? string.id : newId(),
      clips: string
        ? string.clips.filter((clip) => soundFor(clip.sound)).map((clip) => ({ ...clip, key: nextKey++ }))
        : [],
      selected: null,
      playhead: 0,
      scale: PIXELS_PER_SECOND,
      playing: null,
      undo: [],
      redo: [],
      lanes: 0,
      width: 0,
      rulerScale: 0,
      clipEls: new Map(),
      deleteArmed: false,
      trigger: options.trigger,
      onSave: options.onSave,
      onSaved: options.onSaved,
      onDelete: options.onDelete,
      initial: '',
    };
    const current = session;
    nameEl.value = string ? string.name : '';
    searchEl.value = '';
    filterLibrary();
    setMessage('');
    discardBar.hidden = true;
    deleteEl.hidden = !string;
    resetDelete();
    zoomControl.input.value = scaleToZoom(session.scale);
    timeline.scrollLeft = 0;
    dialog.showModal();
    render();
    session.initial = currentState();
    nameEl.focus({ preventScroll: true });
    loadLibrary();

    if (string) {
      // Waveforms and trim limits arrive as each sound loads.
      await Promise.allSettled(session.clips.map((clip) => ensureLoaded(clip.sound)));
      if (session === current) session.clips.forEach(placeClipEl);
      return;
    }
    if (options.soundId) {
      await addClip(options.soundId, 0, 0);
      if (session === current) {
        // Starting out with the sound that was picked isn't a change worth warning about.
        session.undo = [];
        session.initial = currentState();
        renderToolbar();
      }
    }
  }

  window.StringEditor = { open, isOpen: () => session !== null };
})();
