/* The timeline rules, with no page or audio involved. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const load = (file, extra = {}, globals = {}) => {
  const window = { ...extra };
  const context = vm.createContext({ window, console, Math, Number, Array, Map, Set, JSON, String, ...globals });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return window;
};
const core = load('js/strings-core.js').StringsCore;
const plain = (value) => JSON.parse(JSON.stringify(value));
const clip = (at, length, lane = 0, extra = {}) => ({ sound: 'a', at, from: 0, length, lane, ...extra });

test('freeStart keeps a spot that is free, and slides to the closest gap if not', () => {
  const clips = [clip(1, 1), clip(4, 1)];
  assert.equal(core.freeStart(clips, 0, 1, 2.5), 2.5);
  assert.equal(core.freeStart(clips, 1, 1, 1.5), 1.5, 'another track is empty');
  assert.equal(core.freeStart(clips, 0, 1, 0.9), 0, 'closest gap is before');
  assert.equal(core.freeStart(clips, 0, 1, 1.8), 2, 'closest gap is after');
  assert.equal(core.freeStart(clips, 0, 2, 4.2), 5, 'too long for the gap before it');
  assert.equal(core.freeStart(clips, 0, 1, -3), 0);
});

test('freeStart ignores the clip being moved', () => {
  const moving = clip(1, 1);
  assert.equal(core.freeStart([moving], 0, 1, 1.5, moving), 1.5);
});

test('freeLane finds the first track with room', () => {
  assert.equal(core.freeLane([clip(0, 2), clip(0, 2, 1)], 1, 0), 2);
  assert.equal(core.freeLane([clip(0, 2)], 1, 3), 0);
});

test('laneCount keeps a spare track, within limits', () => {
  assert.equal(core.laneCount([]), 4);
  assert.equal(core.laneCount([clip(0, 1, 5)]), 7);
  assert.equal(core.laneCount([clip(0, 1, core.MAX_LANES - 1)]), core.MAX_LANES);
});

test('trimming the front keeps the audio in place, within what the sound and track allow', () => {
  const trimmed = clip(2, 2, 0, { from: 1 });
  assert.deepEqual(plain(core.trimStart(trimmed, 2.5, [trimmed])), { at: 2.5, from: 1.5, length: 1.5 });
  assert.deepEqual(plain(core.trimStart(trimmed, 0, [trimmed])), { at: 1, from: 0, length: 3 }, 'stops at the sound\'s start');
  const before = clip(0, 1.5);
  assert.equal(core.trimStart(trimmed, 0, [before, trimmed]).at, 1.5, 'stops at the clip before it');
  assert.ok(Math.abs(core.trimStart(trimmed, 99, [trimmed]).length - core.MIN_CLIP) < 1e-9, 'never disappears');
});

test('trimming the end stops at the sound\'s end and the next clip', () => {
  const trimmed = clip(1, 1, 0, { from: 0.5 });
  assert.equal(core.trimEnd(trimmed, 1.5, [trimmed], 3).length, 0.5);
  assert.equal(core.trimEnd(trimmed, 9, [trimmed], 3).length, 2.5, 'only 2.5s of sound is left');
  assert.equal(core.trimEnd(trimmed, 9, [trimmed, clip(2.5, 1)], 3).length, 1.5, 'the next clip');
  assert.equal(core.trimEnd(trimmed, 0, [trimmed], 3).length, core.MIN_CLIP);
});

test('split makes two clips that play the same audio', () => {
  const [left, right] = core.split(clip(1, 2, 0, { from: 0.5 }), 2);
  assert.deepEqual(plain(left), plain(clip(1, 1, 0, { from: 0.5 })));
  assert.deepEqual(plain(right), plain(clip(2, 1, 0, { from: 1.5 })));
  assert.equal(core.split(clip(1, 2), 1.01), null, 'too close to the start');
  assert.equal(core.split(clip(1, 2), 5), null, 'not inside it');
});

test('snapping lines up either edge of a clip', () => {
  assert.equal(core.snapMove(1.95, 1, [2], 0.1), 2, 'by its start');
  assert.equal(core.snapMove(0.95, 1, [2], 0.1), 1, 'by its end');
  assert.equal(core.snapMove(1.5, 1, [4], 0.1), 1.5, 'nothing close');
});

test('serialize rounds, leaves out the normal volume and drops editor-only fields', () => {
  const saved = core.serialize([
    { key: 2, sound: 'b', at: 1.23456, from: 0, length: 0.5, lane: 1, gain: 0.5 },
    { key: 1, sound: 'a', at: 0, from: 0, length: 1, lane: 0, gain: 1 },
  ]);
  assert.deepEqual(plain(saved), [
    { sound: 'a', at: 0, from: 0, length: 1, lane: 0 },
    { sound: 'b', at: 1.235, from: 0, length: 0.5, lane: 1, gain: 0.5 },
  ]);
  assert.equal(core.isValid({ id: 'x', name: 'x', clips: saved }), true);
});

test('isValid refuses anything that could break playback', () => {
  const good = { id: 'x', name: 'y', clips: [clip(0, 1)] };
  assert.equal(core.isValid(good), true);
  assert.equal(core.isValid({ ...good, name: '' }), false);
  assert.equal(core.isValid({ ...good, clips: 'no' }), false);
  [{ at: -1 }, { length: 0 }, { lane: 1.5 }, { from: NaN }, { gain: 9 }, { sound: '' }].forEach((bad) => {
    assert.equal(core.isValid({ ...good, clips: [{ ...clip(0, 1), ...bad }] }), false, JSON.stringify(bad));
  });
});

test('colors lists each category once, in the order they are heard', () => {
  const categories = { a: { color: '#a' }, b: { color: '#b' } };
  const clips = [{ ...clip(5, 1), sound: 'b' }, { ...clip(0, 1), sound: 'a' }, { ...clip(9, 1), sound: 'a' }];
  assert.deepEqual(core.colors(clips, (id) => categories[id]).map((c) => c.color), ['#a', '#b']);
  assert.equal(core.colors([], () => null).length, 1, 'a fallback when none are known');
  assert.equal(core.gradient(['#a']), '#a');
  assert.equal(core.gradient(['#a', '#b']), 'linear-gradient(115deg, #a, #b)');
});

test('mixPeaks follows the timeline, the trim, and the loudest clip at each moment', () => {
  const peaks = { values: [0, 1], duration: 2 }; // Silent for a second, then loud.
  const clips = [{ ...clip(0, 1), from: 1 }, { ...clip(1, 1), from: 0 }];
  assert.deepEqual(plain(core.mixPeaks(clips, () => peaks, 2)), [1, 0]);
  const together = [clip(0, 2), { ...clip(0, 1), lane: 1, from: 1 }];
  assert.deepEqual(plain(core.mixPeaks(together, () => peaks, 2)), [1, 1]);
  assert.deepEqual(plain(core.mixPeaks([], () => peaks, 2)), [0, 0]);
});

function fakeAudio() {
  const sources = [];
  const param = () => ({
    value: 1,
    events: [],
    setValueAtTime(value, time) { this.events.push(['set', value, time]); },
    linearRampToValueAtTime(value, time) { this.events.push(['ramp', value, time]); },
    setTargetAtTime() {},
  });
  class AudioContext {
    constructor() { this.currentTime = 10; this.state = 'running'; }
    createGain() { return { gain: param(), connect() {} }; }
    createDynamicsCompressor() {
      return { threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, connect() {} };
    }
    createBufferSource() {
      const source = {
        connect() {},
        start(...args) { this.started = args; },
        stop(time) { this.stopped = time; },
      };
      sources.push(source);
      return source;
    }
  }
  class OfflineAudioContext {
    decodeAudioData(data, resolve) { resolve({ duration: 2 }); }
  }
  const { SoundEngine } = load('js/engine.js', { AudioContext, OfflineAudioContext }, {
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
  });
  return { engine: SoundEngine, sources };
}

const soundFor = (id) => (id === 'gone' ? undefined : { id, src: id + '.mp3' });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, actual + ' is not ' + expected);

test('a string schedules each clip at its place, with its trim', async () => {
  const { engine, sources } = fakeAudio();
  const voice = await engine.startClips('s', [
    { sound: 'a', at: 0, from: 0.5, length: 1, lane: 0 },
    { sound: 'b', at: 0.75, from: 0, length: 1, lane: 1, gain: 0.5 },
    { sound: 'gone', at: 5, from: 0, length: 1, lane: 0 },
  ], soundFor);
  assert.equal(sources.length, 2, 'a sound that no longer exists is skipped');
  close(sources[0].started[0], 10.03);
  close(sources[0].started[1], 0.5);
  close(sources[0].started[2], 1);
  close(sources[1].started[0], 10.78);
  close(voice.duration, 1.75);
});

test('a string can start partway through, and clips already over are skipped', async () => {
  const { engine, sources } = fakeAudio();
  const voice = await engine.startClips('s', [
    { sound: 'a', at: 0, from: 0, length: 1, lane: 0 },
    { sound: 'b', at: 1, from: 0, length: 1.5, lane: 0 },
    { sound: 'c', at: 3, from: 0, length: 1, lane: 0 },
  ], soundFor, { offset: 1.5 });
  assert.equal(sources.length, 2);
  close(sources[0].started[0], 10.03);
  close(sources[0].started[1], 0.5);
  close(sources[0].started[2], 1);
  close(sources[1].started[0], 11.53);
  close(voice.duration, 2.5);
});

test('a clip plays no further than its sound, however long it claims to be', async () => {
  const { engine, sources } = fakeAudio();
  await engine.startClips('s', [{ sound: 'a', at: 0, from: 1.5, length: 9, lane: 0 }], soundFor);
  close(sources[0].started[2], 0.5);
});

test('stopping a string stops every clip in it, and starting it again replaces it', async () => {
  const { engine, sources } = fakeAudio();
  const clips = [
    { sound: 'a', at: 0, from: 0, length: 1, lane: 0 },
    { sound: 'b', at: 9, from: 0, length: 1, lane: 0 },
  ];
  await engine.startClips('s', clips, soundFor);
  await engine.startClips('s', clips, soundFor);
  assert.equal(sources.filter((source) => source.stopped !== undefined).length, 2, 'the first run');
  engine.stopAll();
  assert.equal(sources.filter((source) => source.stopped !== undefined).length, 4, 'and the second');
});

test('a regular sound still starts and stops', async () => {
  const { engine, sources } = fakeAudio();
  const voice = await engine.start({ id: 'a', src: 'a.mp3' });
  assert.equal(voice.duration, 2);
  engine.stop('a');
  assert.notEqual(sources[0].stopped, undefined);
});
