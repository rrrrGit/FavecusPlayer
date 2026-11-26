'use strict';
// 再生回数の台帳（共通規則 play-ledger.cjs、PC保存 play-counts.cjs、weightedShuffleAt タイムスタンプ）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const L = require('../src/core/play-ledger.cjs');
const { PlayCounts } = require('../src/core/play-counts.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');
const { Store } = require('../src/core/store.cjs');

const SONG = 'bili:BV1aaaaaaaaa:p1', OTHER = 'bili:BV1bbbbbbbbb:p2', LOCAL = 'local:0a0b0c0d-0000-4000-8000-000000000001.mp3';
const JAN = Date.UTC(2027, 0, 15, 3, 0, 0), JAN_END = Date.UTC(2027, 0, 31, 14, 59, 59), FEB_START = Date.UTC(2027, 0, 31, 15, 0, 0);
const Temp = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-ledger-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };
const songEntry = ParseBilibili('https://www.bilibili.com/video/BV1aaaaaaaaa/'), part2Entry = ParseBilibili('https://www.bilibili.com/video/BV1aaaaaaaaa/?p=2');
const localEntry = { type: 'local', fileName: '0a0b0c0d-0000-4000-8000-000000000001.mp3' };

test('Increment sums current epoch across JST month boundaries and computes 1/(1+count) weight', () => {
  assert.equal(L.MonthOf(JAN_END), '2027-01'); assert.equal(L.MonthOf(FEB_START), '2027-02');
  const ledger = L.NewLedger('pc');
  const row = L.Increment(ledger, SONG, JAN_END);
  L.Increment(ledger, SONG, FEB_START); L.Increment(ledger, OTHER, JAN);
  assert.equal(row.id, `pc|0|2027-01|${SONG}`);
  assert.equal(L.Count(ledger, SONG), 2); assert.equal(L.Count(ledger, OTHER), 1); assert.equal(L.Count(ledger, 'bili:BV1ccccccccc:p1'), 0);
  assert.deepEqual([L.Weight(0), L.Weight(1), L.Weight(3)], [1, 0.5, 0.25]);
});

test('two devices sum their own rows; merging rows is idempotent, commutative and never double counts', () => {
  const pc = L.NewLedger('pc'), phone = L.NewLedger('phone');
  for (let i = 0; i < 3; i++) L.Increment(pc, SONG, JAN);
  for (let i = 0; i < 2; i++) L.Increment(phone, SONG, JAN);
  const toPhone = L.SyncRows(pc), toPc = L.SyncRows(phone);
  L.MergeRows(phone, toPhone); L.MergeRows(pc, toPc);
  L.MergeRows(phone, toPhone); L.MergeRows(pc, toPc);
  assert.equal(L.Count(pc, SONG), 5); assert.equal(L.Count(phone, SONG), 5);
  L.MergeRows(pc, [{ device: 'phone', epoch: 0, month: '2027-01', key: SONG, n: 1 }]);
  assert.equal(L.Count(pc, SONG), 5);
  const a = L.NewLedger('x'), b = L.NewLedger('y');
  L.MergeRows(a, [...toPhone, ...toPc]); L.MergeRows(b, [...toPc, ...toPhone]);
  assert.deepEqual(a.rows, b.rows);
});

test('reset raises epoch, highest epoch wins, old rows stay as history, and simultaneous resets converge', () => {
  const pc = L.NewLedger('pc'), phone = L.NewLedger('phone');
  L.Increment(pc, SONG, JAN); L.Increment(phone, SONG, JAN);
  L.MergeRows(pc, L.SyncRows(phone)); L.MergeRows(phone, L.SyncRows(pc));
  assert.equal(L.Reset(pc), 1); assert.equal(L.Count(pc, SONG), 0);
  L.MergeEpoch(phone, 1);
  assert.equal(L.Count(phone, SONG), 0); assert.equal(Object.keys(phone.rows).length, 2);
  L.Increment(phone, SONG, JAN); L.MergeRows(pc, L.SyncRows(phone));
  assert.equal(L.Count(pc, SONG), 1); assert.equal(L.Count(phone, SONG), 1);

  const a = L.NewLedger('a'), b = L.NewLedger('b');
  L.Reset(a); L.Reset(b);
  L.MergeEpoch(a, b.epoch); L.MergeEpoch(b, a.epoch);
  assert.equal(a.epoch, 1); assert.equal(b.epoch, 1); assert.equal(L.MergeEpoch(b, 0), false);
});

test('SyncRows excludes local songs and Clean/MergeRows drop invalid rows without breaking ledger', () => {
  const ledger = L.NewLedger('pc');
  L.Increment(ledger, SONG, JAN); L.Increment(ledger, LOCAL, JAN);
  assert.deepEqual(L.SyncRows(ledger).map(row => row.key), [SONG]);
  assert.equal(L.MergeRows(ledger, [{ device: 'a|b', epoch: 0, month: '2027-01', key: SONG, n: 1 }, { device: 'a', epoch: -1, month: '2027-01', key: SONG, n: 1 }, { device: 'a', epoch: 0, month: '2027-13', key: SONG, n: 1 }, { device: 'a', epoch: 0, month: '2027-01', key: 'https://evil', n: 1 }, { device: 'a', epoch: 0, month: '2027-01', key: SONG, n: 0 }, null]), 0);
  const { ledger: cleaned, dropped } = L.Clean({ version: 1, deviceId: 'pc', epoch: 0, rows: { [`pc|0|2027-01|${SONG}`]: 3, broken: 1, [`pc|0|2027-01|${OTHER}`]: -2 } });
  assert.equal(dropped, 2); assert.equal(L.Count(cleaned, SONG), 3);
  assert.throws(() => L.Clean({ version: 2 }));
});

test('PlayTracker counts once after 3s real playback or short-song end, ignoring seeks and pauses', () => {
  const tracker = new L.PlayTracker(); let now = 0;
  const report = (position, extra = {}) => { now += 1000; return tracker.Observe({ position, duration: 200, paused: false, ...extra }, now); };
  tracker.Begin(SONG, 0);
  assert.equal(report(1), null); assert.equal(report(2), null); assert.equal(report(3), null);
  assert.equal(report(4), SONG); assert.equal(report(5), null);
  tracker.Begin(OTHER, now); report(0); report(100); report(101); assert.equal(report(102), null);
  tracker.Begin(OTHER, now); report(1, { paused: true }); report(2, { paused: true }); report(3, { paused: true }); assert.equal(report(4, { paused: true }), null);

  const shortTracker = new L.PlayTracker(); let t2 = 0;
  shortTracker.Begin(SONG, 0);
  const shortReport = (position, extra = {}) => { t2 += 1000; return shortTracker.Observe({ position, duration: 2, paused: false, ...extra }, t2); };
  shortReport(0); shortReport(1);
  assert.equal(shortReport(2, { ended: true }), SONG);
});

test('legacy play-counts.json is imported once into legacy month without modifying original file', t => {
  const ledger = L.NewLedger('pc');
  const keyOf = old => old.startsWith('https://www.bilibili.com/video/') ? 'bili:' + old.split('/video/')[1].replace(/\/.*$/, '') + ':p1' : old.startsWith('local:') ? old : null;
  assert.deepEqual(L.ImportLegacy(ledger, { 'https://www.bilibili.com/video/BV1aaaaaaaaa/': 4, [LOCAL]: 2, junk: 9 }, keyOf), { imported: 2, skipped: 1 });
  assert.equal(L.Count(ledger, SONG), 4); assert.equal(L.Count(ledger, LOCAL), 2);
  assert.deepEqual(L.ImportLegacy(ledger, { [LOCAL]: 5 }, keyOf), { imported: 0, skipped: 0 });

  const root = Temp(t), legacy = path.join(root, 'play-counts.json'), file = path.join(root, 'play-ledger.json');
  const text = JSON.stringify({ version: 1, counts: { [songEntry.url]: 5, [`local:${localEntry.fileName}`]: 2, [part2Entry.url]: 1 } });
  fs.writeFileSync(legacy, text);
  const first = new PlayCounts(file, () => {}, { legacyFile: legacy });
  assert.equal(first.Count(songEntry), 5); assert.equal(first.Count(part2Entry), 1); assert.equal(first.Count(localEntry), 2);
  assert.equal(fs.readFileSync(legacy, 'utf8'), text);
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, counts: { [songEntry.url]: 99 } }));
  assert.equal(new PlayCounts(file, () => {}, { legacyFile: legacy }).Count(songEntry), 5);
});

test('PlayCounts sync state, remote merge, reset, damaged backup, and in-flight dirty tracking', t => {
  const root = Temp(t), file = path.join(root, 'play-ledger.json'), events = [];
  const counts = new PlayCounts(file); counts.onChange = event => events.push(event);
  let now = 0; counts.now = () => now;
  const play = target => { counts.Begin(target); for (let i = 0; i < 6; i++) { now += 1000; counts.Observe({ position: i, duration: 200, paused: false }); } };
  play(localEntry); play(songEntry);
  assert.deepEqual(events.map(e => e.rows.length), [0, 1]);
  assert.equal(counts.SyncState().rows.length, 1);
  assert.equal(counts.MergeRemote({ rows: [{ device: 'phone', epoch: 0, month: '2027-01', key: SONG, n: 3 }] }), 1);
  assert.equal(counts.Count(songEntry), 4); assert.equal(new PlayCounts(file).Count(songEntry), 4);
  counts.Reset(); assert.deepEqual(events.at(-1), { epoch: 1 }); assert.equal(counts.Count(songEntry), 0);
  assert.equal(counts.MergeRemote({ epoch: 1 }), 0);

  const root2 = Temp(t), broken = path.join(root2, 'play-ledger.json'), warnings = [];
  fs.writeFileSync(broken, '{ broken');
  const recovered = new PlayCounts(broken, message => warnings.push(message));
  assert.equal(recovered.Count(songEntry), 0); assert.equal(warnings.length, 1);
  assert.ok(fs.readdirSync(root2).some(name => name.includes('.damaged-')));

  const root3 = Temp(t), c3 = new PlayCounts(path.join(root3, 'play-ledger.json'));
  let now3 = 0; c3.now = () => now3;
  const play3 = () => { c3.Begin(songEntry); for (let i = 0; i < 6; i++) { now3 += 1000; c3.Observe({ position: i, duration: 200, paused: false }); } };
  play3(); c3.SyncPushed(); play3();
  assert.equal(c3.SyncRead({ weighted: true, at: 0 }).rows.length, 1);
  play3(); c3.SyncPushed();
  const next = c3.SyncRead({ weighted: true, at: 0 });
  assert.equal(next.rows.length, 1); assert.equal(next.rows[0].n, 3);
  c3.SyncPushed(); assert.equal(c3.SyncRead({ weighted: true, at: 0 }).rows.length, 0);
});

test('PlayCounts merges av and BV counts/stats through confirmed aliases and InvalidateCache', t => {
  const root = Temp(t), file = path.join(root, 'play-ledger.json');
  let aliases = [];
  const counts = new PlayCounts(file, () => {}, { aliases: () => aliases });
  let now = Date.UTC(2027, 0, 10, 12, 0, 0); counts.now = () => now;
  const av = ParseBilibili('av1');
  counts.Begin(av); for (let i = 0; i < 6; i++) { now += 1000; counts.Observe({ position: i, duration: 200, paused: false }); }
  counts.Begin(songEntry); for (let i = 0; i < 6; i++) { now += 1000; counts.Observe({ position: i, duration: 200, paused: false }); }
  assert.equal(counts.Count(av), 1); assert.equal(counts.Count(songEntry), 1);
  aliases = [{ aid: '1', bvid: 'BV1aaaaaaaaa' }];
  counts.InvalidateCache();
  assert.equal(counts.Count(av), 2); assert.equal(counts.Count(songEntry), 2);
  const stats = counts.Stats({ nowMs: now });
  assert.equal(stats.top.length, 1); assert.equal(stats.top[0].key, SONG); assert.equal(stats.top[0].count, 2);
});

test('weightedShuffle preference stamps weightedShuffleAt on user change and preserves synced timestamp', t => {
  const store = new Store(Temp(t), {});
  assert.equal(store.data.settings.weightedShuffleAt, undefined);
  store.Apply({ type: 'settings', settings: { shuffle: true } });
  assert.equal(store.data.settings.weightedShuffleAt, undefined);
  store.Apply({ type: 'settings', settings: { weightedShuffle: true } });
  assert.equal(store.data.settings.weightedShuffleAt, undefined);
  const before = Date.now();
  store.Apply({ type: 'settings', settings: { weightedShuffle: false } });
  assert.equal(store.data.settings.weightedShuffle, false);
  assert.ok(store.data.settings.weightedShuffleAt >= before);

  const store2 = new Store(Temp(t), {});
  store2.Apply({ type: 'settings', settings: { weightedShuffle: false, weightedShuffleAt: 12345 } });
  assert.deepEqual([store2.data.settings.weightedShuffle, store2.data.settings.weightedShuffleAt], [false, 12345]);
  store2.Apply({ type: 'settings', settings: { shuffle: true } });
  assert.deepEqual([store2.data.settings.weightedShuffle, store2.data.settings.weightedShuffleAt], [false, 12345]);
});
