/*
 * Audio engine. Each file is decoded into an AudioBuffer up front, so the app always
 * knows a sound's exact length and can start it with no delay.
 */
(function () {
  'use strict';

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;

  const SAMPLE_RATE = 44100;
  const CLIPS_LEAD_SECONDS = 0.03; // Time to schedule every clip before the first has to play.
  const CLIP_FADE_SECONDS = 0.004;

  const buffers = new Map(); // sound id -> Promise<AudioBuffer>
  const stretches = new Map(); // sound id -> { factor, result: Promise<AudioBuffer> }
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

  // Makes the version of a sound that plays at the right speed once its pitch is set by playing it
  // faster or slower. Each sound keeps only its latest, so this can't outgrow the sounds themselves.
  function stretched(sound, buffer, factor) {
    const cached = stretches.get(sound.id);
    if (cached && cached.factor === factor) return cached.result;
    const result = new Promise((resolve) => setTimeout(resolve)).then(() => {
      const channels = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
      const output = window.TuneCore.stretch(channels, factor);
      // An offline context, so this can get ready before any user gesture, like decoding does.
      const made = new OfflineCtx(1, 1, buffer.sampleRate).createBuffer(output.length, output[0].length, buffer.sampleRate);
      output.forEach((samples, c) => made.getChannelData(c).set(samples));
      return made;
    });
    result.catch(() => stretches.delete(sound.id));
    stretches.set(sound.id, { factor, result });
    return result;
  }

  // What to play for a sound with this speed and pitch (see tune-core.js), and how fast to play it.
  async function tuned(sound, tune) {
    const buffer = await load(sound);
    if (!tune) return { buffer, rate: 1 };
    if (tune.pitch === undefined || tune.pitch === tune.speed) return { buffer, rate: tune.speed };
    return { buffer: await stretched(sound, buffer, tune.pitch / tune.speed), rate: tune.pitch };
  }

  // Gets a sound ready ahead of time, so the first press doesn't have to wait.
  function prepare(sound, tune) {
    tuned(sound, tune).catch(() => {}); // Pressing it tries again and reports the problem.
  }

  function stop(id) {
    const voice = voices.get(id);
    if (!voice) return;
    if (voice.finish) voice.finish();
    voice.stopped = true;
    voices.delete(id);
    // A very short fade avoids an audible click from cutting the waveform mid-cycle.
    const now = context.currentTime;
    voice.gain.gain.setTargetAtTime(0, now, 0.012);
    voice.sources.forEach((source) => source.stop(now + 0.06));
  }

  // Starts a sound, replacing the same sound if it's already going.
  // Resolves to { duration, elapsed() } with both in seconds.
  // options.loop repeats it until stopped. options.id runs it as its own voice, so it doesn't
  // replace a press of the same sound, and stop(options.id) is what stops it. options.tune plays
  // it at that speed and pitch, and the duration is how long it takes at that speed.
  // options.onComplete(soundId, completedAt) includes the completion time on performance.now's clock.
  async function start(sound, options) {
    const id = (options && options.id) || sound.id;
    const { buffer, rate } = await tuned(sound, options && options.tune);
    const ctx = getContext();
    stop(id);

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    if (rate !== 1) source.playbackRate.value = rate;
    source.loop = Boolean(options && options.loop);
    source.connect(gain);
    gain.connect(master);

    const startedAt = ctx.currentTime;
    const voice = { sources: [source], gain };
    const duration = buffer.duration / rate;
    let counted = 0;
    let completionTimer = null;
    function countCompleted(naturalEnd) {
      if (voice.stopped || !options || !options.onComplete) return;
      // Keep short loops from flooding counting. Preserve actual completion times when timers lag.
      const elapsed = ctx.currentTime - startedAt;
      const completed = source.loop
        ? (elapsed < duration ? 0 : 1 + Math.floor((elapsed - duration) / Math.max(duration, 1)))
        : Number(naturalEnd || ctx.currentTime - startedAt >= duration);
      while (counted < completed) {
        counted++;
        const end = source.loop ? duration + (counted - 1) * Math.max(duration, 1) : duration;
        options.onComplete(sound.id, performance.now() - Math.max(0, elapsed - end) * 1000);
      }
    }
    voice.finish = () => {
      countCompleted(false);
      if (completionTimer !== null) clearInterval(completionTimer);
    };
    source.onended = () => {
      countCompleted(true);
      if (completionTimer !== null) clearInterval(completionTimer);
      if (voices.get(id) === voice) voices.delete(id);
    };
    voices.set(id, voice);
    source.start();
    if (source.loop && options && options.onComplete) {
      completionTimer = setInterval(() => countCompleted(false), 1000);
    }

    return { duration, elapsed: () => ctx.currentTime - startedAt };
  }

  // Starts a whole timeline of clips as one voice, so stopping `id` stops all of it. Starting
  // waits for every file, so nothing comes in late. options.offset starts partway through.
  // soundFor(id) returns a sound from the catalog, or nothing for one that no longer exists.
  async function startClips(id, clips, soundFor, options) {
    const offset = (options && options.offset) || 0;
    const playable = clips.filter((clip) => soundFor(clip.sound));
    const loaded = await Promise.all(playable.map((clip) => load(soundFor(clip.sound))));
    const ctx = getContext();
    stop(id);

    const gain = ctx.createGain();
    gain.connect(master);
    const startsAt = ctx.currentTime + CLIPS_LEAD_SECONDS;
    const voice = { sources: [], gain };
    const completions = [];
    voice.finish = () => completions.forEach((complete) => complete(false));
    let last = offset;

    playable.forEach((clip, i) => {
      const buffer = loaded[i];
      const from = Math.min(clip.from, buffer.duration);
      const speed = clip.speed === undefined ? 1 : clip.speed;
      const length = Math.min(clip.length, (buffer.duration - from) / speed);
      const clipEnd = clip.at + length;
      if (length <= 0 || clipEnd <= offset) return;
      last = Math.max(last, clipEnd);

      const skipped = Math.max(0, offset - clip.at);
      const played = length - skipped;
      const when = startsAt + Math.max(0, clip.at - offset);
      const level = clip.gain === undefined ? 1 : clip.gain;
      const fade = Math.min(CLIP_FADE_SECONDS, played / 2); // A trim can cut mid-wave, which clicks.

      const source = ctx.createBufferSource();
      const clipGain = ctx.createGain();
      source.buffer = buffer;
      if (speed !== 1) source.playbackRate.value = speed;
      clipGain.gain.setValueAtTime(0, when);
      clipGain.gain.linearRampToValueAtTime(level, when + fade);
      clipGain.gain.setValueAtTime(level, when + played - fade);
      clipGain.gain.linearRampToValueAtTime(0, when + played);
      source.connect(clipGain);
      clipGain.connect(gain);
      let counted = false;
      // A trimmed clip or a playback started partway through never plays the full sound.
      const fullSound = from === 0 && skipped === 0
        && Math.abs(played * speed - buffer.duration) <= 1 / buffer.sampleRate;
      const complete = (naturalEnd) => {
        if (counted || voice.stopped || !fullSound || !options || !options.onComplete) return;
        if (!naturalEnd && ctx.currentTime < when + played) return;
        counted = true;
        options.onComplete(clip.sound, performance.now() - Math.max(0, ctx.currentTime - when - played) * 1000);
      };
      completions.push(complete);
      source.onended = () => {
        complete(true);
        voice.sources = voice.sources.filter((other) => other !== source);
        if (!voice.sources.length && voices.get(id) === voice) voices.delete(id);
      };
      voice.sources.push(source);
      // These two are in the sound's own seconds, whatever speed it plays at.
      source.start(when, from + skipped * speed, played * speed);
    });

    if (voice.sources.length) voices.set(id, voice);
    return { duration: last - offset, elapsed: () => Math.max(0, ctx.currentTime - startsAt) };
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
    prepare,
    start,
    startClips,
    stop,
    stopAll,
    setVolume,
    peaks,
  };
})();
