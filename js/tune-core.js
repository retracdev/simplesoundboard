/*
 * The rules for a sound's speed and pitch, with no page involved.
 *
 * A tune is { speed } or { speed, pitch }, and sounds without one have no tune at all.
 *   speed   how fast it plays, where 2 is twice as fast
 *   pitch   how high it sounds, where 1.5 is 150%. Left out, speed changes the pitch too, like
 *           speeding up a tape. Present, speed leaves the pitch alone and this sets it instead.
 *
 * Browsers can only change speed and pitch together, so a separate pitch takes stretch(), which
 * makes the sound longer or shorter without changing its pitch. Playing that faster or slower
 * then gives any mix of the two.
 */
(function () {
  'use strict';

  const MIN_SPEED = 0.25;
  const MAX_SPEED = 4;
  const SPEED_STEP = 0.05;
  const MIN_PITCH = 0.5;
  const MAX_PITCH = 2;
  const PITCH_STEP = 0.05;
  const SNAP = 0.04; // Close to normal counts as normal.

  const FRAME = 2048; // About 46 ms at this site's sample rate, short enough to keep sharp sounds.
  const HOP = FRAME / 2;
  const SEARCH = 512; // How far from its ideal spot a frame may start, to line up with the last.
  const COARSE_STEP = 8;
  const COMPARE_STEP = 4;

  const inRange = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

  function isValid(tune) {
    return Boolean(tune) && typeof tune === 'object' && !Array.isArray(tune)
      && inRange(tune.speed, MIN_SPEED, MAX_SPEED)
      && (tune.pitch === undefined || inRange(tune.pitch, MIN_PITCH, MAX_PITCH));
  }

  // What to store for these values, which is nothing at all for a sound played normally.
  function normalize(speed, pitch) {
    if (speed === 1 && (pitch === undefined || pitch === 1)) return null;
    return pitch === undefined ? { speed } : { speed, pitch };
  }

  // Sliders run from 0 to 100, even in ratios, so the middle is normal and each end is the same
  // number of doublings away from it.
  function fromSlider(value, min, max, step) {
    const ratio = min * Math.pow(max / min, value / 100);
    if (Math.abs(ratio - 1) < SNAP) return 1;
    const stepped = Math.round(ratio / step) * step;
    return Math.round(Math.min(max, Math.max(min, stepped)) * 100) / 100;
  }

  const toSlider = (ratio, min, max) => Math.log(ratio / min) / Math.log(max / min) * 100;

  const speedFromSlider = (value) => fromSlider(value, MIN_SPEED, MAX_SPEED, SPEED_STEP);
  const pitchFromSlider = (value) => fromSlider(value, MIN_PITCH, MAX_PITCH, PITCH_STEP);
  const speedToSlider = (speed) => toSlider(speed, MIN_SPEED, MAX_SPEED);
  const pitchToSlider = (pitch) => toSlider(pitch, MIN_PITCH, MAX_PITCH);

  const formatSpeed = (speed) => Math.round(speed * 100) / 100 + 'x';
  const formatPitch = (pitch) => Math.round(pitch * 100) + '%';

  function mixDown(channels) {
    if (channels.length === 1) return channels[0];
    const mono = new Float32Array(channels[0].length);
    channels.forEach((channel) => {
      for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
    });
    return mono;
  }

  // How much the audio starting at `start` looks like what the last frame would have gone on to
  // play. Starting the next frame somewhere alike is what stops the overlap from sounding hollow.
  function similarity(mono, natural, start) {
    let shared = 0;
    let energy = 0;
    for (let i = 0; i < HOP; i += COMPARE_STEP) {
      const a = natural + i;
      const b = start + i;
      const x = a >= 0 && a < mono.length ? mono[a] : 0;
      const y = b >= 0 && b < mono.length ? mono[b] : 0;
      shared += x * y;
      energy += y * y;
    }
    return shared / Math.sqrt(energy + 1e-9);
  }

  // Frames stay inside the sound, so its first and last moments keep their full level.
  function bestStart(mono, natural, wanted) {
    const latest = Math.max(0, mono.length - FRAME);
    const ideal = Math.min(latest, Math.max(0, wanted));
    let best = ideal;
    let bestScore = similarity(mono, natural, ideal);
    const consider = (start) => {
      if (start < 0 || start > latest) return;
      const score = similarity(mono, natural, start);
      if (score > bestScore) {
        best = start;
        bestScore = score;
      }
    };
    for (let start = ideal - SEARCH; start <= ideal + SEARCH; start += COARSE_STEP) consider(start);
    const rough = best;
    for (let start = rough - COARSE_STEP + 1; start < rough + COARSE_STEP; start++) consider(start);
    return best;
  }

  // Makes a sound `factor` times as long at the same pitch, by overlapping short frames of it
  // (WSOLA). Takes and returns one Float32Array per channel. All channels share the same frame
  // positions, which keeps stereo sounds from wandering.
  function stretch(channels, factor) {
    const length = channels[0].length;
    const outLength = Math.max(1, Math.round(length * factor));
    const output = channels.map(() => new Float32Array(outLength));
    const mono = mixDown(channels);

    // Windows half a frame apart add up to exactly 1, so the overlap needs no other correction.
    const window = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FRAME);

    // Starts half a frame early so the first samples get their full level too.
    let previous = -HOP;
    for (let at = -HOP; at < outLength; at += HOP) {
      const read = at === -HOP ? -HOP : bestStart(mono, previous + HOP, Math.round((at + HOP) / factor) - HOP);
      for (let c = 0; c < channels.length; c++) {
        const from = channels[c];
        const to = output[c];
        const first = Math.max(0, -at, -read);
        const last = Math.min(FRAME, outLength - at, length - read);
        for (let i = first; i < last; i++) to[at + i] += from[read + i] * window[i];
      }
      previous = read;
    }
    return output;
  }

  window.TuneCore = {
    MIN_SPEED,
    MAX_SPEED,
    MIN_PITCH,
    MAX_PITCH,
    isValid,
    normalize,
    speedFromSlider,
    pitchFromSlider,
    speedToSlider,
    pitchToSlider,
    formatSpeed,
    formatPitch,
    stretch,
  };
})();
