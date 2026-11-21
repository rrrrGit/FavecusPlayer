'use strict';
// v0.7.3 F5：音量の自動調整（規則・測定の出力の読み取り・結果の保存）。iPhone版は、同じ数値表で確認する（ios/FavecusPlayerTests/LoudnessTests.swift）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { Gain, ParseMeanVolume, Measure, LoudnessStore } = require('../src/core/loudness.cjs');

// 平均音量（dB）→ 倍率。iPhone版のテストにも、同じ表がある。
const TABLE = [[-30, 1], [-20, 1], [-16, 1], [-14, 0.7943], [-10, 0.5012], [-6, 0.3162], [-3, 0.25], [0, 0.25]];

test('only songs louder than the target are lowered, never raised, and never below 0.25', () => {
  for (const [db, expected] of TABLE) assert.ok(Math.abs(Gain(db) - expected) < 0.001, `${db} dB → ${Gain(db)}`);
  assert.equal(Gain(NaN), 1);
  assert.equal(Gain(-70), 1, '無音に近い曲は、変えない');
  assert.equal(Gain(null), 1);
});

test('mean_volume is read from the volumedetect report', () => {
  const report = '[Parsed_volumedetect_0 @ 0000] n_samples: 1234\n[Parsed_volumedetect_0 @ 0000] mean_volume: -17.3 dB\n[Parsed_volumedetect_0 @ 0000] max_volume: -0.9 dB';
  assert.equal(ParseMeanVolume(report), -17.3);
  assert.equal(ParseMeanVolume('mean_volume: -inf dB'), null);
  assert.equal(ParseMeanVolume('no report'), null);
});

function FakeSpawn(report, code = 0) {
  return () => {
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => { child.stderr.emit('data', report); child.emit('close', code); });
    return child;
  };
}

test('measure returns the mean volume, or null when ffmpeg fails', async () => {
  assert.equal(await Measure('ffmpeg', 'a.mp3', { spawnFn: FakeSpawn('mean_volume: -9.5 dB') }), -9.5);
  assert.equal(await Measure('ffmpeg', 'a.mp3', { spawnFn: FakeSpawn('mean_volume: -9.5 dB', 1) }), null);
  assert.equal(await Measure('ffmpeg', 'a.mp3', { spawnFn: () => { throw new Error('no ffmpeg'); } }), null);
});

test('the store measures a file once, remembers it across restarts, and measures again when the file changes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-loud-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const media = path.join(dir, 'song.m4a'), file = path.join(dir, 'loudness.json'); fs.writeFileSync(media, 'x'.repeat(100));
  let runs = 0;
  const options = { spawnFn: (...args) => { runs++; return FakeSpawn('mean_volume: -10.0 dB')(...args); } };
  const store = new LoudnessStore(file, 'ffmpeg', options);
  const [a, b] = await Promise.all([store.GainFor(media), store.GainFor(media)]);
  assert.ok(Math.abs(a - 0.5012) < 0.001 && a === b);
  assert.equal(runs, 1, '同時の要求は、1回の測定にまとめる');
  assert.equal(new LoudnessStore(file, 'ffmpeg', options).Cached(media), a, '再起動しても、覚えている');
  assert.equal(await new LoudnessStore(file, 'ffmpeg', options).GainFor(media), a);
  assert.equal(runs, 1);
  fs.writeFileSync(media, 'y'.repeat(200)); // ファイルが変わった
  await new LoudnessStore(file, 'ffmpeg', options).GainFor(media);
  assert.equal(runs, 2, '変わったら、測り直す');
});

test('without ffmpeg, a missing file, or a failed measurement, the volume is left unchanged', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-loud-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const media = path.join(dir, 'song.m4a'); fs.writeFileSync(media, 'x');
  assert.equal(await new LoudnessStore(path.join(dir, 'l.json'), null).GainFor(media), 1);
  assert.equal(await new LoudnessStore(path.join(dir, 'l.json'), 'ffmpeg').GainFor(path.join(dir, 'missing.m4a')), 1);
  assert.equal(await new LoudnessStore(path.join(dir, 'l.json'), 'ffmpeg', { spawnFn: FakeSpawn('', 1) }).GainFor(media), 1);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  assert.equal(new LoudnessStore(path.join(dir, 'broken.json'), 'ffmpeg').Cached(media), null);
});

test('at most two ffmpeg measurements run at the same time, the rest wait in order and all finish', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-loud-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = [];
  for (let i = 0; i < 6; i++) { const f = path.join(dir, `s${i}.m4a`); fs.writeFileSync(f, 'x'.repeat(100 + i)); files.push(f); }
  let active = 0, peak = 0;
  const spawnFn = () => {
    active++; peak = Math.max(peak, active);
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setTimeout(() => { active--; child.stderr.emit('data', 'mean_volume: -10.0 dB'); child.emit('close', 0); }, 15);
    return child;
  };
  const store = new LoudnessStore(path.join(dir, 'l.json'), 'ffmpeg', { spawnFn });
  const gains = await Promise.all(files.map(f => store.GainFor(f)));
  assert.equal(peak, 2);
  assert.equal(gains.length, 6);
  assert.ok(gains.every(g => g > 0 && g <= 1));
  assert.equal(store.running, 0);
});
