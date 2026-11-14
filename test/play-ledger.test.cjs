'use strict';
// v0.7.1 Step4：再生回数の台帳（端末ごとの加算カウンタ）。Windows版・iPhone版の共通規則。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/core/play-ledger.cjs');

const SONG = 'bili:BV1aaaaaaaaa:p1', OTHER = 'bili:BV1bbbbbbbbb:p2', LOCAL = 'local:0a0b0c0d-0000-4000-8000-000000000001.mp3';
const JAN = Date.UTC(2027, 0, 15, 3, 0, 0), JAN_END = Date.UTC(2027, 0, 31, 14, 59, 59), FEB_START = Date.UTC(2027, 0, 31, 15, 0, 0);

test('a play adds one to this device row and the total is the sum of the current epoch', () => {
  const ledger = L.NewLedger('pc');
  const row = L.Increment(ledger, SONG, JAN);
  L.Increment(ledger, SONG, JAN); L.Increment(ledger, OTHER, JAN);
  assert.equal(row.id, `pc|0|2027-01|${SONG}`);
  assert.equal(L.Count(ledger, SONG), 2); assert.equal(L.Count(ledger, OTHER), 1); assert.equal(L.Count(ledger, 'bili:BV1ccccccccc:p1'), 0);
});

test('months change at midnight Japan time, not at the device time zone', () => {
  assert.equal(L.MonthOf(JAN_END), '2027-01'); assert.equal(L.MonthOf(FEB_START), '2027-02');
  const ledger = L.NewLedger('pc');
  L.Increment(ledger, SONG, JAN_END); L.Increment(ledger, SONG, FEB_START);
  assert.deepEqual(Object.keys(ledger.rows).sort(), [`pc|0|2027-01|${SONG}`, `pc|0|2027-02|${SONG}`]);
  assert.equal(L.Count(ledger, SONG), 2, 'the total spans months');
});

test('two devices sum their own rows; merging rows is idempotent, commutative and never double counts', () => {
  const pc = L.NewLedger('pc'), phone = L.NewLedger('phone');
  for (let i = 0; i < 3; i++) L.Increment(pc, SONG, JAN);
  for (let i = 0; i < 2; i++) L.Increment(phone, SONG, JAN);
  const toPhone = L.SyncRows(pc), toPc = L.SyncRows(phone);
  L.MergeRows(phone, toPhone); L.MergeRows(pc, toPc);
  L.MergeRows(phone, toPhone); L.MergeRows(pc, toPc); // 同じ行をもう一度受け取っても、増えない
  assert.equal(L.Count(pc, SONG), 5); assert.equal(L.Count(phone, SONG), 5);
  // 古い（小さい）行が遅れて届いても、減らない
  L.MergeRows(pc, [{ device: 'phone', epoch: 0, month: '2027-01', key: SONG, n: 1 }]);
  assert.equal(L.Count(pc, SONG), 5);
  // 受け取りの順序が逆でも同じ
  const a = L.NewLedger('x'), b = L.NewLedger('y');
  L.MergeRows(a, [...toPhone, ...toPc]); L.MergeRows(b, [...toPc, ...toPhone]);
  assert.deepEqual(a.rows, b.rows);
});

test('reset raises the epoch; the highest epoch wins everywhere and old rows are kept as history', () => {
  const pc = L.NewLedger('pc'), phone = L.NewLedger('phone');
  L.Increment(pc, SONG, JAN); L.Increment(phone, SONG, JAN);
  L.MergeRows(pc, L.SyncRows(phone)); L.MergeRows(phone, L.SyncRows(pc));
  assert.equal(L.Count(pc, SONG), 2);
  assert.equal(L.Reset(pc), 1); // PCでリセット
  assert.equal(L.Count(pc, SONG), 0);
  L.MergeEpoch(phone, 1);
  assert.equal(L.Count(phone, SONG), 0, '世代が移ると、前の世代の回数は合計に入らない');
  assert.equal(Object.keys(phone.rows).length, 2, '古い世代の行は、履歴として残る');
  // リセット後の再生は、新しい世代の行へ
  L.Increment(phone, SONG, JAN); L.MergeRows(pc, L.SyncRows(phone));
  assert.equal(L.Count(pc, SONG), 1); assert.equal(L.Count(phone, SONG), 1);
});

test('devices that reset at the same time converge on the same epoch', () => {
  const pc = L.NewLedger('pc'), phone = L.NewLedger('phone');
  L.Reset(pc); L.Reset(phone);
  L.MergeEpoch(pc, phone.epoch); L.MergeEpoch(phone, pc.epoch);
  assert.equal(pc.epoch, 1); assert.equal(phone.epoch, 1);
  assert.equal(L.MergeEpoch(phone, 0), false, '小さい世代では戻らない');
});

test('the legacy per-song counts are imported once into the legacy month, keeping unconvertible keys out', () => {
  const ledger = L.NewLedger('pc');
  const keyOf = old => old.startsWith('https://www.bilibili.com/video/') ? 'bili:' + old.split('/video/')[1].replace(/\/.*$/, '') + ':p1' : old.startsWith('local:') ? old : null;
  const counts = { 'https://www.bilibili.com/video/BV1aaaaaaaaa/': 4, [LOCAL]: 2, junk: 9 };
  assert.deepEqual(L.ImportLegacy(ledger, counts, keyOf), { imported: 2, skipped: 1 });
  assert.equal(L.Count(ledger, SONG), 4); assert.equal(L.Count(ledger, LOCAL), 2);
  assert.ok(Object.keys(ledger.rows).every(id => id.includes('|legacy|')));
  assert.deepEqual(L.ImportLegacy(ledger, counts, keyOf), { imported: 0, skipped: 0 }, '2回目は何もしない');
  assert.equal(L.Count(ledger, SONG), 4);
});

test('only Bilibili songs are synced; local songs stay on the device', () => {
  const ledger = L.NewLedger('pc');
  L.Increment(ledger, SONG, JAN); L.Increment(ledger, LOCAL, JAN);
  assert.deepEqual(L.SyncRows(ledger).map(row => row.key), [SONG]);
});

test('invalid rows are ignored or dropped without breaking the ledger', () => {
  const ledger = L.NewLedger('pc');
  assert.equal(L.MergeRows(ledger, [{ device: 'a|b', epoch: 0, month: '2027-01', key: SONG, n: 1 }, { device: 'a', epoch: -1, month: '2027-01', key: SONG, n: 1 }, { device: 'a', epoch: 0, month: '2027-13', key: SONG, n: 1 }, { device: 'a', epoch: 0, month: '2027-01', key: 'https://evil', n: 1 }, { device: 'a', epoch: 0, month: '2027-01', key: SONG, n: 0 }, null]), 0);
  const { ledger: cleaned, dropped } = L.Clean({ version: 1, deviceId: 'pc', epoch: 0, rows: { [`pc|0|2027-01|${SONG}`]: 3, broken: 1, [`pc|0|2027-01|${OTHER}`]: -2 } });
  assert.equal(dropped, 2); assert.equal(L.Count(cleaned, SONG), 3);
  assert.throws(() => L.Clean({ version: 2 }));
});

test('the tracker counts after 3 seconds of real playback, once, and ignores seeks and pauses', () => {
  const tracker = new L.PlayTracker(); let now = 0;
  const report = (position, extra = {}) => { now += 1000; return tracker.Observe({ position, duration: 200, paused: false, ...extra }, now); };
  tracker.Begin(SONG, 0);
  assert.equal(report(1), null); assert.equal(report(2), null); assert.equal(report(3), null);
  assert.equal(report(4), SONG, '実再生が3秒に届いたら1回');
  assert.equal(report(5), null, '同じ再生では、続けて数えない');
  tracker.Begin(OTHER, now);
  report(0); report(100); report(101); // シークで飛んだ時間は数えない
  assert.equal(report(102), null);
  tracker.Begin(OTHER, now);
  report(1, { paused: true }); report(2, { paused: true }); report(3, { paused: true });
  assert.equal(report(4, { paused: true }), null, '一時停止中は数えない');
});

test('a short song counts when most of it was played to the end', () => {
  const tracker = new L.PlayTracker(); let now = 0;
  tracker.Begin(SONG, 0);
  const report = (position, extra = {}) => { now += 1000; return tracker.Observe({ position, duration: 2, paused: false, ...extra }, now); };
  report(0); report(1);
  assert.equal(report(2, { ended: true }), SONG);
});

test('shuffle weight is 1/(1+count)', () => {
  assert.equal(L.Weight(0), 1); assert.equal(L.Weight(1), 0.5); assert.equal(L.Weight(3), 0.25);
});
