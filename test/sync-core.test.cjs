'use strict';
// v0.7.0 Step6：同期の共通基盤（時計・並び順キー・状態とマージ・ライブラリとの変換・端末と同期の流れ）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Clock = require('../src/core/sync-clock.cjs');
const Order = require('../src/core/sync-order.cjs');
const S = require('../src/core/sync-state.cjs');
const L = require('../src/core/sync-library.cjs');
const E = require('../src/core/sync-engine.cjs');
const { ValidateLibrary } = require('../src/core/library-data.cjs');

const DAY = 86400000, T0 = Date.UTC(2026, 10, 13);
const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pid = n => id(1, n), tid = n => id(2, n);
let counter = 0; const createId = () => id(9, ++counter);
const url = n => `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'a')}/`;
const track = (n, title = `曲${n}`, extra = {}) => ({ id: tid(n), title, addedAt: '2026-11-13T00:00:00.000Z', type: 'bilibili', url: url(n), ...extra });
const list = (n, name, entries = [], childIds = [], extra = {}) => ({ id: pid(n), name, icon: '', entries, childIds, createdAt: '2026-11-13T00:00:00.000Z', lastAddedAt: '', includeInAll: true, ...extra });
const library = (playlists, rootPlaylistIds, videoAliases = []) => ({ version: 3, identityVersion: 2, videoAliases, rootPlaylistIds, playlists });
// ValidateLibrary（既存の起動時検証）を通した結果。mediaIdなど既存の検証が付ける情報も含めて、正準な文字列にする。
const Check = result => { const validated = ValidateLibrary({ ...result.library }); return JSON.stringify({ roots: result.library.rootPlaylistIds, lists: validated.map(p => [p.id, p.name, p.includeInAll, p.childIds, p.entries.map(e => [e.id, e.title, e.url || e.fileName, e.mediaId])]) }); };
const Shape = lib => lib.playlists.map(p => ({ id: p.id, name: p.name, childIds: p.childIds, entries: p.entries.map(e => [e.id, e.title]) }));

test('HLC strings compare as plain strings, always advance, and a far-ahead clock never blocks later edits elsewhere', () => {
  let a = Clock.Tick('', T0, 'devA'), b = Clock.Tick(a, T0, 'devA');
  assert.ok(a < b && b < Clock.Tick(b, T0 - DAY, 'devA'), '時計が戻っても進む'); assert.ok(Clock.Tick('', 1, 'x') < Clock.Tick('', 2, 'x') && Clock.GENESIS < Clock.Tick('', 1, 'x'));
  const ahead = Clock.Tick('', T0 + 365 * DAY, 'devFuture'); let seen = Clock.Observe('', ahead, T0, 'devB');
  const later = Clock.Tick(seen, T0 + 1000, 'devB'); assert.ok(later > ahead, '相手の時計が1年進んでいても、受信後の自分の編集はそれより後になる');
  assert.deepEqual(Clock.Parse(Clock.Format(5, 7, 'd.1')), { wall: 5, counter: 7, deviceId: 'd.1' });
  for (const bad of ['', 'x', '000000000000-0000-', '000000000000-0000-a b', 5]) assert.throws(() => Clock.Parse(bad));
  let overflow = Clock.Format(10, 0xFFFF, 'd'); assert.equal(Clock.Parse(Clock.Tick(overflow, 10, 'd')).wall, 11, 'カウンターが上限なら壁時計を進める');
});

test('order keys: Between always yields a strictly ordered key, tolerates equal keys, and Spread stays short', () => {
  let state = 12345; const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  const keys = [Order.Between('', null)];
  for (let i = 0; i < 2000; i++) {
    const at = Math.floor(random() * (keys.length + 1)), low = at ? keys[at - 1] : '', high = at < keys.length ? keys[at] : null, key = Order.Between(low, high);
    assert.ok(Order.IsKey(key) && key > low && (high === null || key < high), `${low} < ${key} < ${high}`); keys.splice(at, 0, key);
  }
  assert.deepEqual([...keys].sort(), keys, '挿入した順序どおりに文字列比較で並ぶ');
  assert.ok(Order.Between('V', 'V') > 'V' && Order.Between('W', 'V') > 'W', '同じ・逆順のキーでも例外にならない');
  const spread = Order.Spread(999); assert.deepEqual([...spread].sort(), spread); assert.ok(Math.max(...spread.map(k => k.length)) <= 3);
  assert.throws(() => Order.Between('0', null)); assert.equal(Order.IsKey('0'), false);
});

test('merge is idempotent, commutative and associative, and untrusted changes are rejected without partial application', () => {
  const stamp = (n, device = 'd') => Clock.Format(1000 + n, 0, device), rec = (name, v, h) => ({ id: S.PlaylistId(pid(1)), f: { [name]: [v, h] } });
  const changes = [rec('name', 'A', stamp(1, 'a')), rec('name', 'B', stamp(1, 'b')), rec('includeInAll', false, stamp(2)), rec('deleted', true, stamp(3)), rec('name', 'C', stamp(0)), rec('deleted', false, stamp(2))];
  const result = order => S.Canonical(order.reduce((state, c) => S.Merge(state, [c]).state, S.NewState()));
  const base = result(changes); let permutations = 0;
  const permute = (items, prefix = []) => { if (!items.length) { assert.equal(result(prefix), base); permutations++; return; } items.forEach((item, i) => permute([...items.slice(0, i), ...items.slice(i + 1)], [...prefix, item])); };
  permute(changes); assert.equal(permutations, 720);
  const once = S.Merge(S.NewState(), changes).state, twice = S.Merge(once, changes); assert.equal(twice.changed, false); assert.equal(twice.state, once, '再適用は状態を変えない');
  assert.equal(S.Value(once.records[S.PlaylistId(pid(1))], 'name'), 'B', '時刻が同じなら端末IDの大きい方'); assert.equal(S.Value(once.records[S.PlaylistId(pid(1))], 'deleted'), true, '削除は、より古い再作成に勝つ');
  for (const bad of [null, {}, { id: 'x', f: {} }, { id: S.PlaylistId(pid(1)), f: { name: ['x', 'bad'] } }, { id: S.PlaylistId(pid(1)), f: { unknown: [1, stamp(1)] } }, { id: S.PlaylistId(pid(1)), f: { name: [5, stamp(1)] } }, { id: S.EdgeId(pid(1), 'zz'), f: { order: ['V', stamp(1)] } }, { id: S.TrackId(tid(1)), f: { url: ['x'.repeat(3000), stamp(1)] } }, { id: S.EdgeId(pid(1), pid(2)), f: { order: ['0', stamp(1)] } }])
    assert.throws(() => S.Merge(S.NewState(), [bad]), undefined, JSON.stringify(bad).slice(0, 60));
  assert.throws(() => S.Merge(S.NewState(), [rec('name', 'ok', stamp(1)), { id: 'bad', f: {} }]));
});

test('a library converts to records and back with the same hierarchy, order, ids and a passing startup validation', () => {
  const lib = library([list(1, '親', [track(1), track(2)], [pid(2), pid(3)]), list(2, '子A', [track(3)], [pid(4)]), list(3, '子B', [], [pid(4)]), list(4, '共有の孫', [track(4, '孫の曲'), { id: tid(5), title: 'ローカル', addedAt: '', type: 'local', fileName: `${tid(5)}.mp3` }]), list(5, '別の最上位', [], [], { includeInAll: false })], [pid(5), pid(1)],
    [{ aid: '170001', bvid: 'BV1xx411c7mD' }]);
  const records = L.FromLibrary(lib), again = L.FromLibrary(JSON.parse(JSON.stringify(lib)));
  assert.deepEqual(records, again, '同じライブラリからは同じレコード（決定的）');
  const state = S.Merge(S.NewState(), records).state, result = L.Materialize(state);
  assert.deepEqual(Shape(result.library), Shape(lib).sort((a, b) => a.id < b.id ? -1 : 1), '階層・順序・IDが一致'); assert.deepEqual(result.library.rootPlaylistIds, [pid(5), pid(1)], '最上位の順序');
  assert.deepEqual(result.library.videoAliases, lib.videoAliases); assert.deepEqual(result.derived.edges, []); assert.deepEqual(result.cut, []);
  ValidateLibrary(result.library);
  assert.equal(S.Merge(state, records).changed, false, '再変換しても状態は変わらない');
  const local = result.library.playlists.find(p => p.id === pid(4)).entries.find(e => e.type === 'local'); assert.equal(local.fileName, `${tid(5)}.mp3`, 'ローカル曲は、この端末に実体がなければIDから導いた未充足の参照');
  const withFile = L.Materialize(state, { localFileName: (trackId, ext) => `${id(7, 1)}${ext}` }); assert.equal(withFile.library.playlists.find(p => p.id === pid(4)).entries.find(e => e.type === 'local').fileName, `${id(7, 1)}.mp3`);
});

test('the fast media key used while deriving equals LibraryMediaKey for bilibili, part, alias and local entries', () => {
  const { LibraryMediaKey } = require('../src/core/library-identity.cjs');
  const aliases = [{ aid: '170001', bvid: 'BV1xx411c7mD' }];
  const entries = [
    track(1), track(2, 'p2', { url: `${url(2)}?p=2` }),
    { id: tid(3), title: 'av', addedAt: '', type: 'bilibili', url: 'https://www.bilibili.com/video/av170001/' },
    { id: tid(4), title: 'bv', addedAt: '', type: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD/?p=3' },
    { id: tid(5), title: 'local', addedAt: '', type: 'local', fileName: `${tid(5)}.mp3` }];
  const lib = library([list(1, 'L', entries)], [pid(1)], aliases);
  const state = S.Merge(S.NewState(), L.FromLibrary(lib)).state;
  const result = L.Materialize(state, { mediaIdFor: key => key });
  const keyOf = LibraryMediaKey(result.library.videoAliases);
  const out = result.library.playlists[0].entries;
  assert.equal(out.length, entries.length);
  for (const entry of out) assert.equal(entry.mediaId, keyOf(entry));
});
