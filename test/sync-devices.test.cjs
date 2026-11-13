'use strict';
// v0.7.0 Step6：端末同士の同期（オフライン編集・削除後の復活防止・共有の子・循環・復旧・上限・長期オフライン・乱択）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Clock = require('../src/core/sync-clock.cjs');
const S = require('../src/core/sync-state.cjs');
const L = require('../src/core/sync-library.cjs');
const E = require('../src/core/sync-engine.cjs');
const { ValidateLibrary } = require('../src/core/library-data.cjs');

const DAY = 86400000, T0 = Date.UTC(2026, 10, 13);
const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pid = n => id(1, n), tid = n => id(2, n);
const url = n => `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'a')}/`;
const track = (n, title = `曲${n}`, extra = {}) => ({ id: tid(n), title, addedAt: '2026-11-13T00:00:00.000Z', type: 'bilibili', url: url(n), ...extra });
const list = (n, name, entries = [], childIds = [], extra = {}) => ({ id: pid(n), name, icon: '', entries, childIds, createdAt: '2026-11-13T00:00:00.000Z', lastAddedAt: '', includeInAll: true, ...extra });
const library = (playlists, rootPlaylistIds, videoAliases = []) => ({ version: 3, identityVersion: 2, videoAliases, rootPlaylistIds, playlists });
// 既存の起動時検証（ValidateLibrary）を通した結果を、正準な文字列にする。通らなければ例外（起動を止める状態を作らない確認）。
const Check = lib => { const validated = ValidateLibrary(JSON.parse(JSON.stringify(lib))); return JSON.stringify({ roots: lib.rootPlaylistIds, lists: validated.map(p => [p.id, p.name, p.includeInAll, p.childIds, p.entries.map(e => [e.id, e.title, e.url || e.fileName, e.mediaId])]) }); };
const View = d => Check(d.view);
const Playlist = (lib, n) => lib.playlists.find(p => p.id === pid(n));
const Edited = (d, change) => { const next = JSON.parse(JSON.stringify(d.view)); change(next); return next; };
const Setup = (names, base, now = T0) => {
  const repo = new E.MemorySyncRepository(), devices = names.map(n => E.NewDevice(n));
  if (base) for (const d of devices) E.Initialize(d, base, now);
  return { repo, devices };
};
const SyncAll = async (repo, devices, now, context) => { for (let round = 0; round < 3; round++) for (const d of devices) assert.equal((await E.Sync(d, repo, now, context)).ok, true); };
const Base = () => library([list(1, '親', [track(1), track(2), track(3)], [pid(2), pid(3)]), list(2, '子A', [track(4)]), list(3, '子B')], [pid(1)]);

test('offline edits on two devices merge without loss, and every device converges to the same valid library', async () => {
  const { repo, devices: [a, b] } = Setup(['devA', 'devB'], Base()); await SyncAll(repo, [a, b], T0);
  E.Edit(a, Edited(a, n => { Playlist(n, 1).name = 'Aが改名'; Playlist(n, 2).entries.push(track(10, 'Aが追加')); }), T0 + 1000);
  E.Edit(b, Edited(b, n => { Playlist(n, 1).entries.reverse(); Playlist(n, 3).entries.push(track(11, 'Bが追加')); n.playlists.push(list(6, 'Bの新規')); n.rootPlaylistIds.push(pid(6)); }), T0 + 2000);
  repo.online = false; assert.equal((await E.Sync(a, repo, T0 + 3000)).ok, false); assert.ok(a.outbox.length > 0, 'オフライン中の変更はoutboxに残る'); repo.online = true;
  await SyncAll(repo, [a, b], T0 + 4000); assert.equal(View(a), View(b));
  assert.equal(Playlist(a.view, 1).name, 'Aが改名'); assert.deepEqual(Playlist(a.view, 1).entries.map(e => e.id), [tid(3), tid(2), tid(1)], 'Bの並べ替え');
  assert.ok(Playlist(a.view, 2).entries.some(e => e.title === 'Aが追加') && Playlist(a.view, 3).entries.some(e => e.title === 'Bが追加') && Playlist(a.view, 6), '双方の追加が残る');
  assert.equal(a.outbox.length + b.outbox.length, 0);
});

test('a deleted list is never resurrected by a stale update, duplicate pushes are harmless, and a revival must be explicit', async () => {
  const { repo, devices: [a, b] } = Setup(['devA', 'devB'], Base()); await SyncAll(repo, [a, b], T0);
  E.Edit(a, Edited(a, n => { n.playlists = n.playlists.filter(p => p.id !== pid(3)); Playlist(n, 1).childIds = [pid(2)]; }), T0 + 1000);
  E.Edit(b, Edited(b, n => { Playlist(n, 3).name = 'Bの古い更新'; }), T0 + 500);
  const duplicated = [...b.outbox, ...b.outbox]; await E.Sync(a, repo, T0 + 2000); await E.Sync(b, repo, T0 + 2000); await repo.Push('devB', duplicated); await repo.Push('devB', duplicated);
  await SyncAll(repo, [a, b], T0 + 3000); assert.equal(Playlist(a.view, 3), undefined, '削除は、より古い時刻の更新に勝つ'); assert.equal(View(a), View(b));
  assert.equal(repo.log.length, new Set(repo.log.map(e => JSON.stringify(e.change))).size, '重複した送信はログを増やさない');
  E.Edit(b, Edited(b, n => { n.playlists.push(list(3, 'もう一度作った')); Playlist(n, 1).childIds.push(pid(3)); }), T0 + 4000);
  await SyncAll(repo, [a, b], T0 + 5000); assert.equal(Playlist(a.view, 3)?.name, 'もう一度作った', '新しい時刻の明示的な再作成だけが復活させる'); assert.equal(View(a), View(b));
});

test('a shared child keeps its other parent when one parent is deleted, and an orphan attaches to the top level without a new record', async () => {
  const base = library([list(1, '親1', [], [pid(3)]), list(2, '親2', [], [pid(3)]), list(3, '共有の子', [track(1)]), list(4, '一人っ子の親', [], [pid(5)]), list(5, '一人っ子', [track(2)])], [pid(1), pid(2), pid(4)]);
  const { repo, devices: [a, b] } = Setup(['devA', 'devB'], base); await SyncAll(repo, [a, b], T0);
  E.Edit(a, Edited(a, n => { n.playlists = n.playlists.filter(p => p.id !== pid(1) && p.id !== pid(4)); n.rootPlaylistIds = [pid(2)]; }), T0 + 1000);
  await SyncAll(repo, [a, b], T0 + 2000);
  assert.deepEqual(Playlist(b.view, 2).childIds, [pid(3)], '共有の子は、もう一方の親に残る'); assert.equal(Playlist(b.view, 3).entries.length, 1, '子の曲は失われない');
  assert.ok(b.view.rootPlaylistIds.includes(pid(5)), '親を失った子は最上位へ'); assert.ok(b.lastView.derived.edges.includes(S.EdgeId(S.ROOT, pid(5))), '導いた辺として扱う');
  assert.equal(b.state.records[S.EdgeId(S.ROOT, pid(5))], undefined, '導いた辺はレコードにしない（端末ごとに修復が食い違わない）'); assert.equal(View(a), View(b));
  const before = JSON.stringify(b.state); E.Edit(b, JSON.parse(JSON.stringify(b.view)), T0 + 3000); assert.equal(JSON.stringify(b.state), before, '表示を変えない編集は、導いた修復を書き込まない');
});

test('two moves that are valid alone but form a cycle together are resolved identically on every device', async () => {
  const base = library([list(1, 'A', [], [pid(3)]), list(2, 'B'), list(3, 'C')], [pid(1), pid(2)]);
  const { repo, devices } = Setup(['devA', 'devB', 'devC'], base); await SyncAll(repo, devices, T0); const [a, b, c] = devices;
  E.Edit(a, Edited(a, n => { Playlist(n, 1).childIds = []; n.rootPlaylistIds = [pid(2), pid(3)]; Playlist(n, 3).childIds = [pid(1)]; }), T0 + 1000); // C が A の親になる
  E.Edit(b, Edited(b, n => { n.rootPlaylistIds = [pid(1)]; Playlist(n, 1).childIds = [pid(3), pid(2)]; }), T0 + 2000); // B を A の子へ
  await SyncAll(repo, devices, T0 + 3000); assert.equal(new Set(devices.map(View)).size, 1, '全端末で同じ結果'); assert.ok(c);
  const stamp = Clock.Format(5000, 0, 'z'), cycleEdge = { id: S.EdgeId(pid(2), pid(1)), f: { order: ['V', stamp], born: [stamp, stamp], deleted: [false, stamp] } };
  const records = L.FromLibrary(library([list(1, 'X', [], [pid(2)]), list(2, 'Y')], [pid(1)]));
  const forward = L.Materialize(S.Merge(S.NewState(), [...records, cycleEdge]).state), backward = L.Materialize(S.Merge(S.NewState(), [cycleEdge, ...[...records].reverse()]).state);
  assert.deepEqual(forward.cut, [S.EdgeId(pid(2), pid(1))], '循環を作る辺のうち最も新しい1本だけを無効にする'); ValidateLibrary(forward.library);
  assert.equal(JSON.stringify(forward.library), JSON.stringify(backward.library), '適用の順序に依存しない');
});

test('tracks added to a list that another device deleted offline are rescued into a derived recovery list, and older ones go with the list', async () => {
  const { repo, devices: [a, b] } = Setup(['devA', 'devB'], Base()); await SyncAll(repo, [a, b], T0);
  E.Edit(a, Edited(a, n => { n.playlists = n.playlists.filter(p => p.id !== pid(3)); Playlist(n, 1).childIds = [pid(2)]; }), T0 + 1000);
  E.Edit(b, Edited(b, n => { Playlist(n, 3).entries.push(track(20, 'オフラインで追加')); }), T0 + 5000); // 削除より後にBが追加
  await SyncAll(repo, [a, b], T0 + 6000); assert.equal(View(a), View(b));
  const recovery = a.lastView.recovered; assert.equal(recovery.length, 1); assert.equal(recovery[0].playlistId, pid(3)); assert.deepEqual(recovery[0].tracks, [tid(20)]);
  const rescued = a.view.playlists.find(p => p.id === recovery[0].recoveryId); assert.ok(rescued.name.startsWith('復旧') && rescued.entries[0].title === 'オフラインで追加'); assert.equal(recovery[0].recoveryId, L.DerivedId(`recovery:${pid(3)}`), '復旧用リストのIDは削除されたリストのIDから決まる');
  assert.ok(a.view.rootPlaylistIds.includes(recovery[0].recoveryId));
  const old = Setup(['devA', 'devB'], library([list(1, 'L', [track(1)])], [pid(1)])); await SyncAll(old.repo, old.devices, T0);
  E.Edit(old.devices[0], library([], []), T0 + 9000); E.Edit(old.devices[1], Edited(old.devices[1], n => { Playlist(n, 1).entries[0].title = '古い更新'; }), T0 + 100); await SyncAll(old.repo, old.devices, T0 + 10000);
  assert.deepEqual(old.devices[0].view.playlists.map(p => p.id), [L.DerivedId('default-list')], 'リストの削除より前の曲はリストとともに消える（復旧しない）。リストが0個になるときは、起動を止めないよう既定のリストを導く'); assert.equal(old.devices[0].view.playlists[0].entries.length, 0); assert.equal(old.devices[0].lastView.recovered.length, 0);
});

test('the playlist cap converges: every device keeps the same first N lists and holds the rest, nothing is deleted, and the result stays valid', async () => {
  const lists = [1, 2, 3, 4, 5, 6].map(n => list(n, `L${n}`, [track(n)])), base = library([lists[0]], [pid(1)]), context = { maxPlaylists: 3 };
  const { repo, devices: [a, b] } = Setup(['devA', 'devB'], base); await SyncAll(repo, [a, b], T0, context);
  E.Edit(a, Edited(a, n => { for (const x of [lists[1], lists[2], lists[3]]) { n.playlists.push(JSON.parse(JSON.stringify(x))); n.rootPlaylistIds.push(x.id); } }), T0 + 1000, context);
  E.Edit(b, Edited(b, n => { for (const x of [lists[4], lists[5]]) { n.playlists.push(JSON.parse(JSON.stringify(x))); n.rootPlaylistIds.push(x.id); } }), T0 + 2000, context);
  await SyncAll(repo, [a, b], T0 + 3000, context);
  assert.equal(View(a), View(b)); assert.equal(a.view.playlists.length, 3); assert.deepEqual(a.lastView.held.playlists, b.lastView.held.playlists); assert.equal(a.lastView.held.playlists.length, 3);
  assert.deepEqual(a.lastView.held.tracks, b.lastView.held.tracks); assert.equal(Object.keys(a.state.records).filter(k => k.startsWith('p:')).length, 6, '保留したリストも状態から消さない');
  assert.ok(a.view.playlists.every(p => a.view.rootPlaylistIds.includes(p.id)) && a.view.rootPlaylistIds.length === 3, '保留したリストを指す辺は表示から外す');
  assert.equal(E.Refresh(a, { maxPlaylists: 99 }).library.playlists.length, 6, '上限を超えない端末では、保留していたリストがそのまま現れる');
});

test('a device offline longer than the tombstone retention resyncs from a snapshot, keeps its stale edits as conflicts, and resurrects nothing', async () => {
  const { repo, devices: [a, b] } = Setup(['devA', 'devB'], Base()); await SyncAll(repo, [a, b], T0);
  E.Edit(a, Edited(a, n => { n.playlists = n.playlists.filter(p => p.id !== pid(3)); Playlist(n, 1).childIds = [pid(2)]; }), T0 + 1000); await SyncAll(repo, [a], T0 + 2000);
  E.Edit(b, Edited(b, n => { Playlist(n, 3).name = '91日オフラインのBが編集'; }), T0 + 3000); // Bは同期しないまま
  const later = T0 + 91 * DAY; assert.ok(repo.Compact(later) >= 1, '保持期間（90日）を過ぎたTombstoneを整理する');
  const result = await E.Sync(b, repo, later + 1000); assert.equal(result.ok, true); assert.equal(result.resynced, true);
  assert.equal(Playlist(b.view, 3), undefined, '削除したリストは復活しない'); assert.equal(b.conflicts.length > 0 && b.conflicts.every(c => c.reason === 'stale'), true, '古い未送信の変更は競合として残す'); assert.equal(b.outbox.length, 0, '送らない');
  await SyncAll(repo, [a, b], later + 2000); assert.equal(View(a), View(b)); assert.equal(Playlist(a.view, 3), undefined);
});

test('a track moves between lists and keeps its identity, local-file tracks sync as unfilled references, and conflicting aliases are ignored deterministically', async () => {
  const lib = library([list(1, 'L1', [track(1), { id: tid(8), title: 'ローカル', addedAt: '', type: 'local', fileName: `${tid(8)}.flac` }]), list(2, 'L2')], [pid(1), pid(2)]);
  const { repo, devices: [a, b] } = Setup(['devA', 'devB'], lib); await SyncAll(repo, [a, b], T0);
  E.Edit(a, Edited(a, n => { const moved = Playlist(n, 1).entries.shift(); Playlist(n, 2).entries.push(moved); n.videoAliases = [{ aid: '170001', bvid: 'BV1xx411c7mD' }]; }), T0 + 1000);
  E.Edit(b, Edited(b, n => { n.videoAliases = [{ aid: '170002', bvid: 'BV1xx411c7mD' }]; }), T0 + 2000); // 同じBVに別のaid：矛盾
  await SyncAll(repo, [a, b], T0 + 3000); assert.equal(View(a), View(b)); assert.deepEqual(Playlist(a.view, 2).entries.map(e => e.id), [tid(1)], '移動した曲は同じIDのまま');
  assert.equal(a.view.videoAliases.length, 1, '矛盾する対応は、bornの古い方だけ採用する');
  assert.equal(Playlist(a.view, 1).entries[0].fileName, `${tid(8)}.flac`); assert.equal(JSON.stringify(a.state).includes('.flac'), true, '拡張子だけを同期する'); assert.equal(JSON.stringify(a.state).includes('fileName'), false, 'ファイル名は同期しない');
});

test('derived lists (the default list and recovery lists) become real records only when the user edits them, and a deleted recovery list stays deleted', async () => {
  const { repo, devices: [a, b] } = Setup(['devA', 'devB'], library([list(1, 'L', [track(1)])], [pid(1)])); await SyncAll(repo, [a, b], T0);
  E.Edit(a, library([], []), T0 + 1000); await SyncAll(repo, [a, b], T0 + 2000);
  const defaultId = L.DerivedId('default-list'); assert.deepEqual(a.view.playlists.map(p => p.id), [defaultId]); assert.equal(a.state.records[S.PlaylistId(defaultId)], undefined, '導いた既定のリストはレコードにしない');
  E.Edit(a, Edited(a, n => { n.playlists[0].name = '自分で改名'; n.playlists[0].entries.push(track(30, '追加')); }), T0 + 3000); await SyncAll(repo, [a, b], T0 + 4000);
  assert.equal(View(a), View(b)); assert.equal(b.view.playlists[0].name, '自分で改名'); assert.equal(b.view.playlists[0].entries.length, 1); assert.ok(a.state.records[S.PlaylistId(defaultId)], '編集すると実体のレコードになる');
  const two = Setup(['devA', 'devB'], library([list(1, 'A'), list(2, 'B')], [pid(1), pid(2)])); await SyncAll(two.repo, two.devices, T0);
  E.Edit(two.devices[0], Edited(two.devices[0], n => { n.playlists = n.playlists.filter(p => p.id !== pid(2)); n.rootPlaylistIds = [pid(1)]; }), T0 + 1000);
  E.Edit(two.devices[1], Edited(two.devices[1], n => { Playlist(n, 2).entries.push(track(40, '救われる曲')); }), T0 + 5000); await SyncAll(two.repo, two.devices, T0 + 6000);
  const recoveryId = L.DerivedId(`recovery:${pid(2)}`); assert.ok(two.devices[0].view.playlists.some(p => p.id === recoveryId));
  E.Edit(two.devices[0], Edited(two.devices[0], n => { n.playlists.find(p => p.id === recoveryId).name = '整理した復旧リスト'; }), T0 + 7000); await SyncAll(two.repo, two.devices, T0 + 8000);
  assert.equal(View(two.devices[0]), View(two.devices[1])); assert.equal(two.devices[1].view.playlists.filter(p => p.id === recoveryId).length, 1, '改名しても復旧用リストは1つ'); assert.equal(two.devices[1].view.playlists.find(p => p.id === recoveryId).name, '整理した復旧リスト');
  E.Edit(two.devices[0], Edited(two.devices[0], n => { n.playlists = n.playlists.filter(p => p.id !== recoveryId); n.rootPlaylistIds = n.rootPlaylistIds.filter(x => x !== recoveryId); }), T0 + 9000); await SyncAll(two.repo, two.devices, T0 + 10000);
  assert.equal(two.devices[1].view.playlists.some(p => p.id === recoveryId), false, '利用者が削除した復旧用リストは戻らない'); assert.equal(View(two.devices[0]), View(two.devices[1]));
});
test('a seeded random run of three devices keeps every materialization identical and valid after random partial syncs', async () => {
  for (const seed of Array.from({ length: Number(process.env.FUZZ_SEEDS || 6) }, (_, i) => i + 1)) {
    let rng = seed * 7919; const random = () => (rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296, pick = items => items[Math.floor(random() * items.length)];
    let next = 100; const base = library([list(1, 'R', [track(1)]), list(2, 'S', [track(2)])], [pid(1), pid(2)]);
    const { repo, devices } = Setup(['devA', 'devB', 'devC'], base); await SyncAll(repo, devices, T0);
    const detach = (lib, target) => { for (const p of lib.playlists) p.childIds = p.childIds.filter(c => c !== target); lib.rootPlaylistIds = lib.rootPlaylistIds.filter(c => c !== target); };
    const operate = (d, step) => {
      const lib = JSON.parse(JSON.stringify(d.view));
      if (!lib.playlists.length) { lib.playlists.push(list(next, `N${next}`)); lib.rootPlaylistIds.push(pid(next)); next++; E.Edit(d, lib, T0 + step); return; }
      const target = pick(lib.playlists), kind = Math.floor(random() * 9);
      if (kind === 0) { const p = list(next, `N${next}`); lib.playlists.push(p); next++; if (random() < .5) lib.rootPlaylistIds.push(p.id); else target.childIds.push(p.id); }
      else if (kind === 1) target.name = `改名${step}`;
      else if (kind === 2) target.entries.splice(Math.floor(random() * (target.entries.length + 1)), 0, track(next++, `曲${step}`));
      else if (kind === 3 && target.entries.length) { const [entry] = target.entries.splice(Math.floor(random() * target.entries.length), 1); pick(lib.playlists).entries.push(entry); }
      else if (kind === 4 && target.entries.length) target.entries.splice(Math.floor(random() * target.entries.length), 1);
      else if (kind === 5) { target.childIds = [...target.childIds].reverse(); lib.rootPlaylistIds.reverse(); }
      else if (kind === 6) {
        const dest = pick(lib.playlists), below = new Set(), walk = x => { below.add(x); for (const c of lib.playlists.find(p => p.id === x)?.childIds || []) if (!below.has(c)) walk(c); };
        walk(target.id); if (!below.has(dest.id)) { detach(lib, target.id); dest.childIds.splice(Math.floor(random() * (dest.childIds.length + 1)), 0, target.id); }
      }
      else if (kind === 7 && lib.playlists.length > 1) { lib.playlists = lib.playlists.filter(p => p.id !== target.id); detach(lib, target.id); }
      else if (kind === 8) { detach(lib, target.id); lib.rootPlaylistIds.splice(Math.floor(random() * (lib.rootPlaylistIds.length + 1)), 0, target.id); }
      E.Edit(d, lib, T0 + step);
    };
    for (let step = 1; step <= Number(process.env.FUZZ_STEPS || 60); step++) {
      operate(pick(devices), step * 10);
      if (random() < .4) { repo.online = random() < .85; await E.Sync(pick(devices), repo, T0 + step * 10 + 5); repo.online = true; }
      for (const d of devices) ValidateLibrary(JSON.parse(JSON.stringify(d.view)));
    }
    await SyncAll(repo, devices, T0 + 100000); await SyncAll(repo, devices, T0 + 100001);
    const views = devices.map(View); assert.equal(new Set(views).size, 1, `seed ${seed}: 全端末のライブラリが一致する`); for (const d of devices) assert.equal(d.outbox.length, 0);
    const fresh = E.NewDevice('devFresh'); await E.Sync(fresh, repo, T0 + 100002); assert.equal(View(fresh), views[0], `seed ${seed}: 後から参加した端末も同じ結果`);
  }
});

test('Compact with nothing to remove does not force a resync: a late-joining device keeps its own library', async () => {
  const { repo, devices: [a] } = Setup(['devA'], Base()); await SyncAll(repo, [a], T0);
  assert.equal(repo.Compact(T0 + DAY), 0);
  const phone = E.NewDevice('iphone'); E.Initialize(phone, library([list(7, 'iPhoneの', [track(30)])], [pid(7)]), T0 + DAY);
  const r = await E.Sync(phone, repo, T0 + DAY); assert.equal(r.ok, true); assert.equal(r.resynced, false);
  await SyncAll(repo, [a, phone], T0 + DAY); assert.ok(Playlist(a.view, 7) && Playlist(phone.view, 7)); assert.equal(phone.conflicts.length, 0);
});

test('a resync keeps new creations and updates to known records as outbox, and drops only updates to compacted records', async () => {
  const { repo, devices: [a, b] } = Setup(['devA', 'devB'], Base()); await SyncAll(repo, [a, b], T0);
  E.Edit(a, Edited(a, n => { n.playlists = n.playlists.filter(p => p.id !== pid(3)); Playlist(n, 1).childIds = [pid(2)]; }), T0 + 1000); await SyncAll(repo, [a], T0 + 1000);
  E.Edit(b, Edited(b, n => { Playlist(n, 3).name = '古い改名'; n.playlists.push(list(8, 'Bの新規')); n.rootPlaylistIds.push(pid(8)); Playlist(n, 2).name = '子A改'; }), T0 + 2000);
  repo.Compact(T0 + 1000 + 91 * DAY);
  await SyncAll(repo, [b, a], T0 + 1000 + 91 * DAY);
  assert.equal(View(a), View(b)); assert.ok(!Playlist(b.view, 3), '削除済みは復活しない'); assert.ok(Playlist(a.view, 8), '新規作成は届く'); assert.equal(Playlist(a.view, 2).name, '子A改');
  assert.equal(b.conflicts.length, 1);
});

test('edits made while an async push is in flight stay in the outbox and are sent later', async () => {
  const { repo, devices: [a, b] } = Setup(['devA', 'devB'], Base()); await SyncAll(repo, [a, b], T0);
  E.Edit(a, Edited(a, n => Playlist(n, 2).entries.push(track(40, '1つ目'))), T0 + 1000);
  const push = repo.Push.bind(repo); repo.Push = async (device, changes) => { E.Edit(a, Edited(a, n => Playlist(n, 2).entries.push(track(41, '送信中に追加'))), T0 + 1500); return push(device, changes); };
  await E.Sync(a, repo, T0 + 2000); repo.Push = push; assert.ok(a.outbox.length > 0);
  await SyncAll(repo, [a, b], T0 + 3000); assert.equal(View(a), View(b)); assert.ok(Playlist(b.view, 2).entries.some(e => e.title === '送信中に追加'));
});

test('a rescued track survives Compact identically on old and new devices', async () => {
  const { repo, devices: [a, b] } = Setup(['devA', 'devB'], Base()); await SyncAll(repo, [a, b], T0);
  E.Edit(a, Edited(a, n => { n.playlists = n.playlists.filter(p => p.id !== pid(3)); Playlist(n, 1).childIds = [pid(2)]; }), T0 + 1000);
  E.Edit(b, Edited(b, n => Playlist(n, 3).entries.push(track(50, 'rescued'))), T0 + 5000);
  await SyncAll(repo, [a, b], T0 + 6000); repo.Compact(T0 + 91 * DAY);
  const d = E.NewDevice('devD'); await E.Sync(d, repo, T0 + 91 * DAY); await SyncAll(repo, [a, b, d], T0 + 91 * DAY);
  assert.equal(View(a), View(d)); assert.ok(d.view.playlists.some(p => p.entries.some(e => e.title === 'rescued')));
});

test('inserting at the same position many times never exceeds the key limit', async () => {
  const { repo, devices: [a] } = Setup(['devA'], library([list(1, 'L', [track(1), track(2)])], [pid(1)]));
  for (let i = 0; i < 900; i++) E.Edit(a, Edited(a, n => Playlist(n, 1).entries.splice(1, 0, track(100 + i))), T0 + i * 10);
  assert.equal(Playlist(a.view, 1).entries.length, 902); assert.equal((await E.Sync(a, repo, T0 + 100000)).ok, true);
});

test('invalid or far-future pulled data fails without changing the device or its outbox', async () => {
  const { repo, devices: [a] } = Setup(['devA'], Base());
  E.Edit(a, Edited(a, n => { Playlist(n, 1).name = '編集'; }), T0 + 1000);
  const before = JSON.stringify([a.outbox, a.state, a.cursor, a.conflicts]);
  for (const pulled of [{ changes: [{ id: 'p:x', f: {} }], cursor: 1 }, { changes: [{ id: S.PlaylistId(pid(9)), f: { name: ['x', 'ffffffffffff-0000-z'] } }], cursor: 1 }, { resync: true, snapshot: [{ id: 'bad' }], cursor: 1 }]) {
    const fake = { PullNow: () => pulled, PushNow: () => ({ cursor: 1 }) }; assert.equal(E.SyncNow(a, fake, T0 + 2000).ok, false);
  }
  assert.equal(JSON.stringify([a.outbox, a.state, a.cursor, a.conflicts]), before);
});

test('derived lists are not persisted by unrelated edits', () => {
  const d = E.NewDevice('devA'); E.Initialize(d, library([], []), T0);
  assert.ok(d.view.playlists.length === 1, '既定リストが導かれる');
  const keys = Object.keys(d.state.records).length;
  E.Edit(d, Edited(d, n => { n.playlists.push(list(5, '追加')); n.rootPlaylistIds.push(pid(5)); }), T0 + 1000);
  const defaults = L.DerivedId('default-list'); assert.equal(d.state.records[S.PlaylistId(defaults)], undefined);
  assert.ok(Object.keys(d.state.records).length > keys);
});
