/*
 * Audio engine. Each file is decoded into an AudioBuffer up front, so the app always
 * knows a sound's exact length and can start it with no delay.
 */
(function () {
  'use strict';

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;

  const SAMPLE_RATE = 44100;

  const buffers = new Map(); // sound id -> Promise<AudioBuffer>
  const voices = new Map(); // sound id -> the voice currently sounding

  let context = null;
  let master = null;
  let volume = 1;

  function getContext() {
    if (!context) {
      context = new AudioCtx();
      master = context.createGain();
      master.gain.value = volume;
      // Acts as a limiter, so stacking several sounds doesn't crackle.
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.2;
      master.connect(limiter);
      limiter.connect(context.destination);
    }
    return context;
  }

  // Browsers keep audio suspended until a user gesture, so call this from inside one.
  function unlock() {
    const ctx = getContext();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  async function decodeFile(src) {
    const response = await fetch(src);
    if (!response.ok) throw new Error('Could not fetch ' + src + ' (' + response.status + ')');
    const data = await response.arrayBuffer();
    // An offline context can decode before any user gesture, unlike a regular one.
    const decoder = new OfflineCtx(1, 1, SAMPLE_RATE);
    return new Promise((resolve, reject) => decoder.decodeAudioData(data, resolve, reject));
  }

  function load(sound) {
    if (!buffers.has(sound.id)) {
      const pending = decodeFile(sound.src);
      // Forget failures so that pressing the key again retries the load.
      pending.catch(() => buffers.delete(sound.id));
      buffers.set(sound.id, pending);
    }
    return buffers.get(sound.id);
  }

  function stop(id) {
    const voice = voices.get(id);
    if (!voice) return;
    voices.delete(id);
    // A very short fade avoids an audible click from cutting the waveform mid-cycle.
    const now = context.currentTime;
    voice.gain.gain.setTargetAtTime(0, now, 0.012);
    voice.source.stop(now + 0.06);
  }

  // Starts a sound, replacing the same sound if it's already going.
  // Resolves to { duration, elapsed() } with both in seconds.
  async function start(sound) {
    const buffer = await load(sound);
    const ctx = getContext();
    stop(sound.id);

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(master);

    const startedAt = ctx.currentTime;
    const voice = { source, gain };
    source.onended = () => {
      if (voices.get(sound.id) === voice) voices.delete(sound.id);
    };
    voices.set(sound.id, voice);
    source.start();

    return { duration: buffer.duration, elapsed: () => ctx.currentTime - startedAt };
  }

  function stopAll() {
    Array.from(voices.keys()).forEach(stop);
  }

  function setVolume(value) {
    volume = value;
    if (master) master.gain.setTargetAtTime(value, context.currentTime, 0.015);
  }

  // Loudness over time as `count` values from 0 to 1, for drawing a waveform.
  function peaks(buffer, count) {
    const samples = buffer.getChannelData(0);
    const size = samples.length / count;
    const stride = Math.max(1, Math.floor(size / 200));
    const result = [];
    for (let bar = 0; bar < count; bar++) {
      const from = Math.floor(bar * size);
      const to = Math.floor((bar + 1) * size);
      let peak = 0;
      for (let i = from; i < to; i += stride) {
        const level = Math.abs(samples[i]);
        if (level > peak) peak = level;
      }
      // The square root lifts quiet tails so that fading sounds still draw visibly.
      result.push(Math.sqrt(Math.min(1, peak)));
    }
    return result;
  }

  window.SoundEngine = {
    supported: Boolean(AudioCtx && OfflineCtx),
    unlock,
    load,
    start,
    stop,
    stopAll,
    setVolume,
    peaks,
  };
})();
