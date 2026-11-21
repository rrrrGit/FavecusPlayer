'use strict';
// 再生履歴・再生統計・自動リストの設定（v0.7.4。共通のJS＝PC版・iPhone版で同じ規則）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const History = require('../src/core/play-history.cjs');
const { HistoryStore } = require('../src/core/play-history-store.cjs');
const Settings = require('../src/core/auto-list-settings.cjs');
const { AutoListSettingsStore } = require('../src/core/auto-list-settings-store.cjs');
const Ledger = require('../src/core/play-ledger.cjs');
const { Select } = require('../src/core/auto-lists.cjs');
const App = require('../src/core/library-app.cjs');

const T = Date.UTC(2026, 10, 21, 12, 0, 0); // 2026-11-21

test('history: newest first, the same song counted again within a minute is one record, capped, bad rows dropped', () => {
  let items = [];
  items = History.Add(items, 'local:a.mp3', T);
  items = History.Add(items, 'local:b.mp3', T + 120000);
  items = History.Add(items, 'local:b.mp3', T + 150000);
  assert.deepEqual(items.map(i => i.key), ['local:b.mp3', 'local:a.mp3']);
  assert.equal(items[0].at, T + 150000, '1分以内の同じ曲は、新しい時刻の1件に');
  items = History.Add(items, 'local:a.mp3', T + 600000);
  assert.deepEqual(items.map(i => i.key), ['local:a.mp3', 'local:b.mp3', 'local:a.mp3'], '離れた再生は、別の記録');
  assert.deepEqual(History.RecentKeys(items), ['local:a.mp3', 'local:b.mp3'], '同じ曲は、いちばん新しい1回だけ');
  assert.deepEqual(History.Add(items, 'bad key!', T), History.Clean({ items }), '正しくないキーは、足さない');
  assert.deepEqual(History.Clean({ items: [{ key: 'ok', at: 5 }, { key: '', at: 5 }, { key: 'x', at: 'no' }, null, { key: 'y', at: -1 }] }), [{ key: 'ok', at: 5 }]);
  let many = [];
  for (let i = 0; i < History.MAX_ITEMS + 50; i++) many = History.Add(many, `local:s${i}.mp3`, T + i * 120000);
  assert.equal(many.length, History.MAX_ITEMS);
  assert.equal(many[0].key, `local:s${History.MAX_ITEMS + 49}.mp3`);
  assert.equal(History.RecentKeys(many, 3).length, 3);
});

test('history file: saved atomically, restored, cleared; a broken file means empty', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-hist-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'n', 'play-history.json'), store = new HistoryStore(file);
  store.Add('local:a.mp3', T); store.Add('local:b.mp3', T + 300000);
  assert.deepEqual(new HistoryStore(file).Keys(10), ['local:b.mp3', 'local:a.mp3']);
  assert.equal(fs.existsSync(file + '.tmp'), false);
  store.Clear(); assert.deepEqual(new HistoryStore(file).Keys(10), []);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{ broken'); assert.deepEqual(new HistoryStore(file).Keys(10), []);
});

test('the recently played auto list follows history order, merges same media, and appears only when history is passed', () => {
  const entry = (id, key) => ({ id, addedAt: '2026-01-01T00:00:00.000Z', title: id, key });
  const library = { playlists: [{ id: 'p1', entries: [entry('a', 'K1'), entry('b', 'K2'), entry('c', 'K3')] }, { id: 'p2', entries: [entry('a2', 'K1')] }] };
  const keys = { a: 'K1', a2: 'K1', b: 'K2', c: 'K3' };
  assert.equal(Select({ library, keys }).history, undefined);
  const result = Select({ library, keys, history: ['K3', 'GONE', 'K1', 'K3', 'K2'] });
  assert.deepEqual(result.history.map(i => i.id).length, 3);
  assert.deepEqual(result.history.map(i => i.id)[0], 'c');
  assert.deepEqual(Select({ library, keys, history: ['K1', 'K2', 'K3'], limits: { history: 2 } }).history.length, 2);
  assert.deepEqual(Select({ library, keys, history: [] }).history, []);
});

test('auto list conditions: the minimum plays for frequent and the number of days for recent; defaults keep the old behavior', () => {
  const day = 86400000, now = Date.UTC(2026, 10, 21);
  const iso = daysAgo => new Date(now - daysAgo * day).toISOString();
  const library = { playlists: [{ id: 'p', entries: [{ id: 'new', addedAt: iso(3) }, { id: 'mid', addedAt: iso(40) }, { id: 'old', addedAt: iso(400) }] }] };
  const keys = { new: 'K1', mid: 'K2', old: 'K3' }, counts = { K1: 1, K2: 4, K3: 9 };
  const ids = list => list.map(i => i.id);
  assert.deepEqual(ids(Select({ library, keys, counts }).frequent), ['old', 'mid', 'new']);
  assert.deepEqual(ids(Select({ library, keys, counts, frequentMin: 3 }).frequent), ['old', 'mid']);
  assert.deepEqual(ids(Select({ library, keys, counts, frequentMin: 10 }).frequent), []);
  assert.deepEqual(ids(Select({ library, keys, counts }).recent), ['new', 'mid', 'old']);
  assert.deepEqual(ids(Select({ library, keys, counts, recentDays: 7, nowMs: now }).recent), ['new']);
  assert.deepEqual(ids(Select({ library, keys, counts, recentDays: 90, nowMs: now }).recent), ['new', 'mid']);
});

test('settings snap to the allowed choices, bad values become the default, and the file survives a restart', t => {
  assert.deepEqual(Settings.Normalize({}), { limits: { frequent: 50, recent: 50, unplayed: 200, favorites: 200, history: 100 }, frequentMin: 1, recentDays: 0 });
  const odd = Settings.Normalize({ limits: { frequent: 33, recent: 'x', history: 9999 }, frequentMin: 4, recentDays: 20 });
  assert.equal(odd.limits.frequent, 20, '近い選択肢へ（33は、20と50のうち近い20）');
  assert.equal(odd.limits.recent, 50);
  assert.equal(odd.limits.history, 500);
  assert.equal(odd.frequentMin, 3);
  assert.equal(odd.recentDays, 30, '20日は、7日と30日のうち近い30日');
  assert.equal(Settings.IsDefault({}), true);
  assert.equal(Settings.IsDefault({ frequentMin: 5 }), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-als-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.json'), store = new AutoListSettingsStore(file);
  assert.equal(store.Set({ frequentMin: 5, limits: { recent: 20 } }).frequentMin, 5);
  assert.equal(new AutoListSettingsStore(file).Get().limits.recent, 20);
  fs.writeFileSync(file, '{ broken'); assert.deepEqual(new AutoListSettingsStore(file).Get(), Settings.Normalize({}));
});

test('stats: monthly totals for the last months with zero months included, top songs overall and this month, current epoch only', () => {
  const ledger = Ledger.NewLedger('dev1');
  const add = (key, ms, times = 1) => { for (let i = 0; i < times; i++) Ledger.Increment(ledger, key, ms); };
  add('local:a.mp3', Date.UTC(2026, 10, 3), 5);   // 2026-11
  add('local:b.mp3', Date.UTC(2026, 10, 9), 2);   // 2026-11
  add('local:a.mp3', Date.UTC(2026, 8, 15), 4);   // 2026-09
  add('local:c.mp3', Date.UTC(2025, 11, 1), 7);   // 2025-12
  const stats = Ledger.Stats(ledger, { nowMs: Date.UTC(2026, 10, 21), months: 6 });
  assert.equal(stats.total, 18);
  assert.deepEqual(stats.months.map(m => m.month), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  assert.deepEqual(stats.months.map(m => m.plays), [0, 0, 0, 4, 0, 7]);
  assert.deepEqual(stats.top.map(t => `${t.key}:${t.count}`), ['local:a.mp3:9', 'local:c.mp3:7', 'local:b.mp3:2']);
  assert.deepEqual(stats.thisMonthTop.map(t => `${t.key}:${t.count}`), ['local:a.mp3:5', 'local:b.mp3:2']);
  assert.equal(Ledger.Stats(ledger, { nowMs: Date.UTC(2026, 10, 21), months: 99 }).months.length, 60, '最大60か月');
  assert.equal(Ledger.Stats(ledger, { nowMs: Date.UTC(2026, 10, 21), topLimit: 1 }).top.length, 1);
  Ledger.Reset(ledger);
  assert.equal(Ledger.Stats(ledger, { nowMs: Date.UTC(2026, 10, 21) }).total, 0, '世代を替えたら、前の回数は数えない');
});

test('the shared entry points work for iPhone', () => {
  const items = App.HistoryAdd({ items: [], key: 'local:a.mp3', at: T }).items;
  assert.equal(items.length, 1);
  assert.deepEqual(App.HistoryKeys({ items, limit: 5 }).keys, ['local:a.mp3']);
  assert.equal(App.AutoListSettingsNormalize({ settings: { frequentMin: 5 } }).settings.frequentMin, 5);
  assert.deepEqual(App.AutoListSettingsNormalize({ settings: {} }).choices.limits, [10, 20, 50, 100, 200, 500]);
  const ledger = Ledger.NewLedger('d1'); Ledger.Increment(ledger, 'local:z.mp3', Date.UTC(2026, 10, 1));
  assert.equal(App.LedgerStats({ text: JSON.stringify(ledger), nowMs: Date.UTC(2026, 10, 21), months: 3 }).months.at(-1).plays, 1);
  assert.ok(App.LedgerStats({ text: '{' }).error);
});

test('the iPhone choices, kinds and wiring match the shared JS', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const swift = read('ios/FavecusPlayer/Library/Insights.swift');
  const list = values => values.join(', ');
  assert.ok(swift.includes(`limitChoices = [${list(Settings.LIMIT_CHOICES)}]`));
  assert.ok(swift.includes(`frequentMinChoices = [${list(Settings.FREQUENT_MIN_CHOICES)}]`));
  assert.ok(swift.includes(`recentDaysChoices = [${list(Settings.RECENT_DAYS_CHOICES)}]`));
  for (const [kind, limit] of Object.entries(Settings.DEFAULT.limits)) assert.ok(swift.includes(`"${kind}": ${limit}`), `既定の件数 ${kind}`);
  const kinds = read('ios/FavecusPlayer/Library/AutoLists.swift');
  assert.match(kinds, /case frequent, recent, unplayed, favorites, history/);
  assert.match(read('ios/FavecusPlayer/Playback/PlayCountStore.swift'), /onCounted\?\(key\)/);
  assert.match(read('ios/FavecusPlayer/FavecusPlayerApp.swift'), /playCounts\.onCounted = /);
  assert.match(read('ios/FavecusPlayer/Playback/PlaybackEngine+Queue.swift'), /"history"\] = await history\?\.keys\(limit: 500\)/);
  // PC の配線
  const { readMain } = require('./support-source.cjs');
  const main = readMain();
  assert.match(main, /playCounts\.onCounted = \(key, at\) => historyStore\.Add\(key, at\)/);
  assert.match(main, /Handle\('stats:get'/);
  assert.match(main, /Handle\('autolist:settings'/);
  assert.match(main, /'auto:history': '最近聴いた曲'/);
  assert.match(read('src/core/play-counts.cjs'), /this\.onCounted\?\.\(key, this\.now\(\)\)/);
});
