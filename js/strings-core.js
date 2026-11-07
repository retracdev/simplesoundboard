/*
 * The rules of a string, with no page or audio involved.
 *
 * A string is { id, name, clips }, and each clip is one sound placed on the timeline:
 *   sound   the sound's id, or "string:" and an id for another string used as one clip
 *   at      when it starts in the string, in seconds
 *   from    how far into the sound it starts, which is what trimming the front changes
 *   length  how much of the sound plays
 *   lane    which track it sits on
 *   gain    its volume, left out at the normal 1
 */
(function () {
  'use strict';

  const MIN_CLIP = 0.05;
  const MAX_TIME = 300;
  const MAX_CLIPS = 64;
  const MAX_PLAYED_CLIPS = 256; // Strings inside strings multiply fast, and each clip is a voice.
  const MAX_EXPAND_STEPS = 4000;
  const STRING_PREFIX = 'string:';
  const MAX_LANES = 12;
  const MIN_LANES = 4;
  const MAX_NAME = 40;
  const MAX_GAIN = 2;
  const EPSILON = 0.0005;
  const FALLBACK_COLOR = { color: '#8b86a3', side: '#4a4560' };
  const SUMMARY_MIN_NAMES = 2;
  const SUMMARY_MAX_NAMES = 4;
  const SUMMARY_CHARACTERS = 28; // About what fits on a small key beside "and 2 others".

  const ms = (value) => Math.round(value * 1000) / 1000;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const end = (clip) => clip.at + clip.length;
  const clipGain = (clip) => (clip.gain === undefined ? 1 : clip.gain);

  const duration = (clips) => clips.reduce((longest, clip) => Math.max(longest, end(clip)), 0);

  function neighbors(clips, lane, ignore) {
    return clips.filter((clip) => clip.lane === lane && clip !== ignore).sort((a, b) => a.at - b.at);
  }

  // The start closest to `desired` where a clip of this length fits without covering another.
  // Returns null if it can't fit anywhere on this track.
  function freeStart(clips, lane, length, desired, ignore) {
    const others = neighbors(clips, lane, ignore);
    const fits = (time) => time >= 0 && time + length <= MAX_TIME + EPSILON
      && others.every((other) => time + length <= other.at + EPSILON || time >= end(other) - EPSILON);
    const start = clamp(desired, 0, Math.max(0, MAX_TIME - length));
    if (fits(start)) return start;
    let best = null;
    others.forEach((other) => {
      [end(other), other.at - length].forEach((time) => {
        if (fits(time) && (best === null || Math.abs(time - start) < Math.abs(best - start))) best = time;
      });
    });
    return best;
  }

  // The first track with room at exactly this time, or null when every track is taken.
  function freeLane(clips, length, time) {
    for (let lane = 0; lane < MAX_LANES; lane++) {
      if (freeStart(clips, lane, length, time) === time) return lane;
    }
    return null;
  }

  // Always keeps one empty track at the bottom to drag onto.
  function laneCount(clips) {
    const used = clips.reduce((highest, clip) => Math.max(highest, clip.lane + 1), 0);
    return clamp(used + 1, MIN_LANES, MAX_LANES);
  }

  function snapTargets(clips, ignore, playhead) {
    const targets = [0, playhead];
    clips.forEach((clip) => {
      if (clip !== ignore) targets.push(clip.at, end(clip));
    });
    return targets;
  }

  function snapTime(time, targets, tolerance) {
    let best = time;
    let distance = tolerance;
    targets.forEach((target) => {
      if (Math.abs(target - time) <= distance) {
        distance = Math.abs(target - time);
        best = target;
      }
    });
    return best;
  }

  // Lines up whichever edge of a moving clip is closest to something.
  function snapMove(at, length, targets, tolerance) {
    const startShift = snapTime(at, targets, tolerance) - at;
    const finish = at + length;
    const endShift = snapTime(finish, targets, tolerance) - finish;
    if (!startShift) return at + endShift;
    if (!endShift) return at + startShift;
    return at + (Math.abs(endShift) < Math.abs(startShift) ? endShift : startShift);
  }

  // Trimming the front keeps the audio where it is on the timeline and hides or reveals it.
  function trimStart(clip, time, clips) {
    const before = neighbors(clips, clip.lane, clip).filter((other) => other.at < clip.at).pop();
    const low = Math.max(0, clip.at - clip.from, before ? end(before) : 0);
    const at = clamp(time, low, end(clip) - MIN_CLIP);
    return { at, from: clip.from + (at - clip.at), length: end(clip) - at };
  }

  function trimEnd(clip, time, clips, soundLength) {
    const after = neighbors(clips, clip.lane, clip).find((other) => other.at >= end(clip) - EPSILON);
    const high = Math.min(clip.at + (soundLength - clip.from), after ? after.at : Infinity, MAX_TIME);
    return { length: Math.max(MIN_CLIP, Math.min(time, high) - clip.at) };
  }

  // Cuts a clip in two at a time inside it, or returns null if a side would be too short.
  function split(clip, time) {
    if (time < clip.at + MIN_CLIP || time > end(clip) - MIN_CLIP) return null;
    const left = time - clip.at;
    return [
      { ...clip, length: left },
      { ...clip, at: time, from: clip.from + left, length: clip.length - left },
    ];
  }

  const nestedId = (soundId) => (soundId.startsWith(STRING_PREFIX) ? soundId.slice(STRING_PREFIX.length) : null);

  // Turns clips that may include other strings into the plain sounds that actually play, with
  // each string's trim, position and volume applied to what's inside it. A string that no longer
  // exists is skipped, and so is one that would end up inside itself. lookup(id) gives a string.
  function expand(clips, lookup) {
    const played = [];
    let steps = 0;
    function walk(list, offset, windowStart, windowEnd, gain, path) {
      list.forEach((clip) => {
        if (played.length >= MAX_PLAYED_CLIPS || steps >= MAX_EXPAND_STEPS) return;
        steps++;
        const at = offset + clip.at;
        const start = Math.max(at, windowStart);
        const finish = Math.min(at + clip.length, windowEnd);
        if (finish <= start) return;
        const from = clip.from + (start - at);
        const level = gain * clipGain(clip);
        const id = nestedId(clip.sound);
        if (id === null) {
          played.push({ ...clip, at: start, from, length: finish - start, gain: level });
          return;
        }
        const string = lookup(id);
        if (string && !path.includes(id)) walk(string.clips, start - from, start, finish, level, [...path, id]);
      });
    }
    walk(clips, 0, 0, Infinity, 1, []);
    return played;
  }

  // Whether a string has another one inside it, however deep.
  function uses(string, id, lookup, seen = new Set()) {
    return string.clips.some((clip) => {
      const inner = nestedId(clip.sound);
      if (inner === null) return false;
      if (inner === id) return true;
      if (seen.has(inner)) return false;
      seen.add(inner);
      const next = lookup(inner);
      return Boolean(next) && uses(next, id, lookup, seen);
    });
  }

  // What gets saved: rounded so it stays small, and in time order.
  function serialize(clips) {
    return clips.map((clip) => {
      const saved = {
        sound: clip.sound,
        at: ms(clip.at),
        from: ms(clip.from),
        length: ms(clip.length),
        lane: clip.lane,
      };
      if (clipGain(clip) !== 1) saved.gain = ms(clipGain(clip));
      return saved;
    }).sort((a, b) => a.at - b.at || a.lane - b.lane);
  }

  function isValid(string) {
    const number = (value, low, high) => typeof value === 'number' && Number.isFinite(value)
      && value >= low && value <= high;
    return Boolean(string) && typeof string === 'object' && !Array.isArray(string)
      && typeof string.id === 'string' && string.id !== ''
      && typeof string.name === 'string' && string.name !== ''
      && Array.isArray(string.clips) && string.clips.every((clip) => clip && typeof clip === 'object'
        && typeof clip.sound === 'string' && clip.sound !== ''
        && number(clip.at, 0, Infinity) && number(clip.from, 0, Infinity)
        && number(clip.length, 0, Infinity) && clip.length > 0
        && Number.isInteger(clip.lane) && clip.lane >= 0
        && (clip.gain === undefined || number(clip.gain, 0, MAX_GAIN)));
  }

  // Every category a string uses, once each, in the order you'd hear them.
  function colors(clips, categoryOf) {
    const seen = new Map();
    [...clips].sort((a, b) => a.at - b.at).forEach((clip) => {
      const category = categoryOf(clip.sound);
      if (category && !seen.has(category.color)) seen.set(category.color, category);
    });
    return seen.size ? Array.from(seen.values()) : [FALLBACK_COLOR];
  }

  function gradient(values) {
    return values.length === 1 ? values[0] : 'linear-gradient(115deg, ' + values.join(', ') + ')';
  }

  // Loudness over a whole string, for drawing its key's waveform. Clips playing at once are
  // combined by taking the loudest. peaksOf(soundId) gives { values, duration }.
  function mixPeaks(clips, peaksOf, count) {
    const total = duration(clips);
    const bars = new Array(count).fill(0);
    if (!total) return bars;
    clips.forEach((clip) => {
      const peaks = peaksOf(clip.sound);
      if (!peaks || !peaks.values.length || !peaks.duration) return;
      for (let bar = 0; bar < count; bar++) {
        const time = (bar + 0.5) / count * total;
        if (time < clip.at || time >= end(clip)) continue;
        const position = (clip.from + time - clip.at) / peaks.duration;
        const value = peaks.values[Math.min(peaks.values.length - 1, Math.floor(position * peaks.values.length))] || 0;
        bars[bar] = Math.max(bars[bar], Math.min(1, value * Math.sqrt(clipGain(clip))));
      }
    });
    return bars;
  }

  // Says what's in a string: "Faa, Boom (Vine), and 2 others". Short names leave room for more.
  function summarize(names) {
    let shown = Math.min(SUMMARY_MIN_NAMES, names.length);
    while (shown < Math.min(SUMMARY_MAX_NAMES, names.length)
      && names.slice(0, shown + 1).join(', ').length <= SUMMARY_CHARACTERS) shown++;
    const others = names.length - shown;
    const listed = names.slice(0, shown);
    if (others) return listed.join(', ') + ', and ' + others + (others === 1 ? ' other' : ' others');
    if (shown < 3) return listed.join(' and ');
    return listed.slice(0, -1).join(', ') + ', and ' + listed[shown - 1];
  }

  window.StringsCore = {
    MIN_CLIP, MAX_TIME, MAX_CLIPS, MAX_PLAYED_CLIPS, MAX_LANES, MAX_NAME, MAX_GAIN, STRING_PREFIX,
    clamp, end, clipGain, duration,
    freeStart, freeLane, laneCount,
    snapTargets, snapTime, snapMove,
    trimStart, trimEnd, split,
    nestedId, expand, uses,
    serialize, isValid,
    colors, gradient, mixPeaks, summarize,
  };
})();
