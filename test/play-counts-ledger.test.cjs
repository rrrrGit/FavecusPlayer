'use strict';
// v0.7.1 Step4：Windows版の再生回数の保存（台帳）。旧形式（play-counts.json）は変更せず、1回だけ引き継ぐ。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { PlayCounts } = require('../src/core/play-counts.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');

function Temp(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-ledger-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }
const song = ParseBilibili('https://www.bilibili.com/video/BV1aaaaaaaaa/'), part2 = ParseBilibili('https://www.bilibili.com/video/BV1aaaaaaaaa/?p=2');
const local = { type: 'local', fileName: '0a0b0c0d-0000-4000-8000-000000000001.mp3' };

test('the old play-counts.json is imported once, never modified, and its totals carry over', t => {
  const root = Temp(t), legacy = path.join(root, 'play-counts.json'), file = path.join(root, 'play-ledger.json');
  const text = JSON.stringify({ version: 1, counts: { [song.url]: 5, [`local:${local.fileName}`]: 2, [part2.url]: 1 } });
  fs.writeFileSync(legacy, text);
  const first = new PlayCounts(file, () => {}, { legacyFile: legacy });
  assert.equal(first.Count(song), 5); assert.equal(first.Count(part2), 1); assert.equal(first.Count(local), 2);
  assert.equal(fs.readFileSync(legacy, 'utf8'), text, '旧形式のファイルは変更しない');
  // 2回目の起動では、引き継ぎ済みなので、旧形式が変わっても二重に足さない
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, counts: { [song.url]: 99 } }));
  const second = new PlayCounts(file, () => {}, { legacyFile: legacy });
  assert.equal(second.Count(song), 5);
});

test('av and BV forms of one video share a count through the confirmed alias', t => {
  const root = Temp(t), file = path.join(root, 'play-ledger.json');
  const av = ParseBilibili('av1');
  const counts = new PlayCounts(file, () => {}, { aliases: () => [{ aid: '1', bvid: 'BV1aaaaaaaaa' }] });
  let now = 0; counts.now = () => now;
  counts.Begin(song);
  for (let i = 0; i < 6; i++) { now += 1000; counts.Observe({ position: i, duration: 200, paused: false }); }
  assert.equal(counts.Count(song), 1); assert.equal(counts.Count(av), 1, '対応が確認済みなら、av表記でも同じ回数');
});

test('the sync state exposes only Bilibili rows and the epoch; a remote merge and a reset notify and persist', t => {
  const root = Temp(t), file = path.join(root, 'play-ledger.json'), events = [];
  const counts = new PlayCounts(file); counts.onChange = event => events.push(event);
  let now = 0; counts.now = () => now;
  counts.Begin(local); for (let i = 0; i < 6; i++) { now += 1000; counts.Observe({ position: i, duration: 200, paused: false }); }
  counts.Begin(song); for (let i = 0; i < 6; i++) { now += 1000; counts.Observe({ position: i, duration: 200, paused: false }); }
  assert.deepEqual(events.map(e => e.rows.length), [0, 1], 'ローカルの曲は、同期へ送らない');
  const state = counts.SyncState();
  assert.equal(state.rows.length, 1); assert.equal(state.rows[0].key, 'bili:BV1aaaaaaaaa:p1');
  assert.equal(counts.MergeRemote({ rows: [{ device: 'phone', epoch: 0, month: '2027-01', key: 'bili:BV1aaaaaaaaa:p1', n: 3 }] }), 1);
  assert.equal(counts.Count(song), 4);
  assert.equal(new PlayCounts(file).Count(song), 4, '保存される');
  counts.Reset();
  assert.deepEqual(events.at(-1), { epoch: 1 }); assert.equal(counts.Count(song), 0);
  assert.equal(counts.MergeRemote({ epoch: 1 }), 0, '同じ世代では、何も変わらない');
});

test('a damaged ledger is kept aside and counting restarts from zero', t => {
  const root = Temp(t), file = path.join(root, 'play-ledger.json'), warnings = [];
  fs.writeFileSync(file, '{ broken');
  const counts = new PlayCounts(file, message => warnings.push(message));
  assert.equal(counts.Count(song), 0); assert.equal(warnings.length, 1);
  assert.ok(fs.readdirSync(root).some(name => name.includes('.damaged-')), '元の記録は残す');
});
