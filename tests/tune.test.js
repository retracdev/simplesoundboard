/* The rules for speed and pitch, and the time stretch, with no page or audio involved. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'tune-core.js'), 'utf8'), { window });
const core = window.TuneCore;
const plain = (value) => JSON.parse(JSON.stringify(value));

const RATE = 44100;

function sine(hertz, seconds) {
  const samples = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(2 * Math.PI * hertz * i / RATE);
  return samples;
}

// The pitch of a steady tone, from how often it crosses zero. Skips the edges, which fade.
function pitchOf(samples) {
  const from = 4096;
  const to = samples.length - 4096;
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
  }
  return crossings / ((to - from) / RATE);
}

function loudness(samples) {
  let total = 0;
  for (let i = 4096; i < samples.length - 4096; i++) total += samples[i] * samples[i];
  return Math.sqrt(total / (samples.length - 8192));
}

test('a tune needs a speed in range, and a pitch in range if it has one', () => {
  assert.equal(core.isValid({ speed: 1.25 }), true);
  assert.equal(core.isValid({ speed: 1, pitch: 1.5 }), true);
  assert.equal(core.isValid({ speed: 0.25, pitch: 0.5 }), true);
  assert.equal(core.isValid({ speed: 4, pitch: 2 }), true);
  [null, undefined, 'fast', [], {}, { speed: 0 }, { speed: 5 }, { speed: '2' }, { speed: NaN },
    { speed: 1, pitch: 0.2 }, { speed: 1, pitch: 3 }, { speed: 1, pitch: null }].forEach((tune) => {
    assert.equal(core.isValid(tune), false, JSON.stringify(tune));
  });
});

test('normal playback stores nothing, but a fixed pitch at another speed is kept', () => {
  assert.equal(core.normalize(1), null);
  assert.equal(core.normalize(1, 1), null);
  assert.deepEqual(plain(core.normalize(1.5)), { speed: 1.5 });
  assert.deepEqual(plain(core.normalize(1.5, 1)), { speed: 1.5, pitch: 1 });
  assert.deepEqual(plain(core.normalize(1, 1.5)), { speed: 1, pitch: 1.5 });
});

test('the middle of each slider is normal, and its ends are the limits', () => {
  assert.equal(core.speedFromSlider(50), 1);
  assert.equal(core.pitchFromSlider(50), 1);
  assert.equal(core.speedFromSlider(0), core.MIN_SPEED);
  assert.equal(core.speedFromSlider(100), core.MAX_SPEED);
  assert.equal(core.pitchFromSlider(0), core.MIN_PITCH);
  assert.equal(core.pitchFromSlider(100), core.MAX_PITCH);
});

test('slider values land on tidy numbers that survive a trip back through the slider', () => {
  for (let value = 0; value <= 100; value++) {
    const speed = core.speedFromSlider(value);
    assert.equal(Math.round(speed * 100) % 5, 0, 'speed ' + speed);
    assert.equal(core.isValid({ speed }), true);
    assert.equal(core.speedFromSlider(Math.round(core.speedToSlider(speed))), speed);
    const pitch = core.pitchFromSlider(value);
    assert.equal(Math.round(pitch * 100) % 5, 0, 'pitch ' + pitch);
    assert.equal(core.isValid({ speed: 1, pitch }), true);
    assert.equal(core.pitchFromSlider(Math.round(core.pitchToSlider(pitch))), pitch);
  }
});

test('labels read the way they do on the keys', () => {
  assert.equal(core.formatSpeed(1.25), '1.25x');
  assert.equal(core.formatSpeed(2), '2x');
  assert.equal(core.formatPitch(1.5), '150%');
  assert.equal(core.formatPitch(0.85), '85%');
});

[0.125, 0.5, 0.8, 1.25, 2, 8].forEach((factor) => {
  test('stretching by ' + factor + ' changes the length but not the pitch or loudness', () => {
    const input = sine(440, 4);
    const [output] = core.stretch([input], factor);
    assert.equal(output.length, Math.round(input.length * factor));
    assert.ok(Math.abs(pitchOf(output) - 440) < 440 * 0.03, 'pitch was ' + pitchOf(output));
    assert.ok(Math.abs(loudness(output) - loudness(input)) < 0.1, 'loudness was ' + loudness(output));
  });
});

test('stretching reaches both ends of the sound', () => {
  const input = new Float32Array(RATE).fill(0.5);
  const [output] = core.stretch([input], 1.5);
  assert.ok(Math.abs(output[0] - 0.5) < 0.01, 'start was ' + output[0]);
  assert.ok(Math.abs(output[output.length - 1] - 0.5) < 0.01, 'end was ' + output[output.length - 1]);
});

test('every channel of a stereo sound is stretched, and stays its own', () => {
  const left = sine(440, 0.5);
  const right = sine(880, 0.5);
  const output = core.stretch([left, right], 2);
  assert.equal(output.length, 2);
  assert.ok(Math.abs(loudness(output[0]) - loudness(left)) < 0.15);
  assert.ok(pitchOf(output[1]) > pitchOf(output[0]) * 1.5, 'the channels stay apart');
});

test('sounds shorter than one frame, and silence, come out finite and the right length', () => {
  [new Float32Array(1), new Float32Array(300).fill(0.25), new Float32Array(5000)].forEach((input) => {
    [0.125, 0.5, 2, 8].forEach((factor) => {
      const [output] = core.stretch([input], factor);
      assert.equal(output.length, Math.max(1, Math.round(input.length * factor)));
      assert.ok(output.every(Number.isFinite));
    });
  });
});
