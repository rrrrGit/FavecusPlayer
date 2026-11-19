'use strict';
// v0.7.3 F4：最近削除（保管と復元の規則）。復元は、削除を元に戻し、あとの変更を壊さない。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Actions = require('../src/core/library-actions.cjs');
const Trash = require('../src/core/trash.cjs');
const { ValidateLibrary } = require('../src/core/library-data.cjs');

const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = n => id(1, n), E = n => id(2, n), M = n => id(3, n);
const NOW = '2026-11-19T12:00:00.000Z';
let counter = 100;
const ctx = { createId: () => id(9, counter++), now: () => NOW, cleanTitle: v => String(v) };
const entry = (n, extra = {}) => ({ id: E(n), mediaId: M(n), type: 'bilibili', title: `曲${n}`, addedAt: '2026-11-14T00:00:00.000Z', url: `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'a')}/`, ...extra });
const list = (n, entries = [], childIds = []) => ({ id: P(n), name: `リスト${n}`, icon: '', entries, childIds, createdAt: '2026-11-14T00:00:00.000Z', lastAddedAt: '', includeInAll: true });
// p1（最上位）の子：p2・p3。p4 は p2 と p3 の両方の子（複数の親）。p5 も最上位。
function Library() {
  return { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: P(1), rootPlaylistIds: [P(1), P(5)],
    playlists: [list(1, [entry(1)], [P(2), P(3)]), list(2, [entry(2), entry(3)], [P(4)]), list(3, [entry(4)], [P(4)]), list(4, [entry(5)]), list(5, [entry(6)])] };
}
const clone = v => JSON.parse(JSON.stringify(v));
const Delete = (library, action) => { const before = clone(library), after = clone(library); assert.equal(Actions.Apply(after, action, ctx), true); return { before, after, item: Trash.Capture(before, after, action, NOW) }; };
const restore = (library, item) => { const copy = clone(library); Trash.Restore(copy, item); return copy; };

test('restoring a deleted playlist gives back the exact original library (children promoted by the delete go back too)', () => {
  const { before, after, item } = Delete(Library(), { type: 'delete', playlistId: P(2) });
  assert.notDeepEqual(after, before);
  assert.equal(item.kind, 'playlist');
  assert.match(item.label, /リスト2/);
  assert.deepEqual(restore(after, item), before);
  ValidateLibrary(restore(after, item));
});

test('deleting and restoring the playlist that has two parents (p4 is under p2 and p3)', () => {
  const lib = Library(); lib.playlists[0].childIds = [P(2), P(3), P(4)]; // p4 は、p1 の子でもある
  const { before, after, item } = Delete(lib, { type: 'delete', playlistId: P(4) });
  assert.equal(item.changes.length, 3, '含んでいた3つの親の並びを記録');
  assert.deepEqual(restore(after, item), before);
});

test('a root-level playlist and a playlist with the last position restore to the same place', () => {
  for (const target of [P(5), P(1), P(3)]) {
    const { before, after, item } = Delete(Library(), { type: 'delete', playlistId: target });
    const result = restore(after, item);
    assert.deepEqual({ ...result, activePlaylistId: 0 }, { ...before, activePlaylistId: 0 }, `リスト ${target} を戻す（選択中のリストは、削除のときの変更のまま）`);
    assert.equal(result.activePlaylistId, after.activePlaylistId);
  }
});

test('changes made after the delete are kept: a child the user moved is not pulled back', () => {
  const { after, item } = Delete(Library(), { type: 'delete', playlistId: P(2) }); // p4 が p1 へ繰り上がる
  const moved = clone(after);
  assert.equal(Actions.Apply(moved, { type: 'playlist-move', playlistId: P(4), parentId: P(5) }, ctx), true);
  const result = restore(moved, item);
  assert.deepEqual(result.playlists.find(p => p.id === P(5)).childIds, [P(4)], 'あとで動かした先に、そのまま');
  assert.deepEqual(result.playlists.find(p => p.id === P(2)).childIds, [], '動かした子は、取り戻さない');
  assert.ok(result.playlists.find(p => p.id === P(1)).childIds.includes(P(2)), '元の親の、元の位置へ');
  assert.equal(result.activePlaylistId, moved.activePlaylistId, '選択中のリストは、変えない');
  ValidateLibrary(result);
});

test('restoring a removed song puts it back at its old position, once', () => {
  const { before, after, item } = Delete(Library(), { type: 'remove', playlistId: P(2), entryId: E(2) });
  assert.deepEqual(restore(after, item), before);
  const again = restore(after, item);
  assert.throws(() => Trash.Restore(again, item), /すでに戻っています/);
});

test('restoring is refused, with a reason and no change, when it would conflict', () => {
  const { after, item } = Delete(Library(), { type: 'delete', playlistId: P(2) });
  // 同じIDのリストがすでにある（同期で復活したなど）
  const revived = clone(after); revived.playlists.push(list(2));
  assert.throws(() => Trash.Restore(revived, item), /すでに戻っています/);
  // 曲のIDが、別の場所にすでにある
  const dup = clone(after); dup.playlists[0].entries.push(entry(2));
  const before = clone(dup);
  assert.throws(() => Trash.Restore(dup, item), /すでに別の場所/);
  // 元のリストがない曲
  const songRemoval = Delete(Library(), { type: 'remove', playlistId: P(5), entryId: E(6) });
  const noList = clone(songRemoval.after); noList.playlists = noList.playlists.filter(p => p.id !== P(5)); noList.rootPlaylistIds = [P(1)];
  assert.throws(() => Trash.Restore(noList, songRemoval.item), /元のプレイリストがない/);
  // 同じ動画が、そのリストにすでにある
  const same = clone(songRemoval.after); same.playlists.find(p => p.id === P(5)).entries.push(entry(99, { url: entry(6).url, mediaId: M(6) }));
  assert.throws(() => Trash.Restore(same, songRemoval.item), /同じ動画/);
  assert.deepEqual(dup, before, '失敗した復元は、ライブラリを変えない（例外の前に変更していないこと）');
});

test('a damaged or forged trash item is rejected', () => {
  const { after, item } = Delete(Library(), { type: 'delete', playlistId: P(2) });
  for (const bad of [null, {}, { ...item, kind: 'x' }, { ...item, playlist: { ...item.playlist, id: 'not-an-id' } }, { ...item, changes: 'x' }, { ...item, position: -1 }, { ...item, deletedAt: 'never' }]) {
    assert.throws(() => Trash.Restore(clone(after), bad), /正しくない/);
  }
});

test('items older than 30 days are dropped, the newest are kept, and the summary counts the days left', () => {
  const make = (iso, n) => ({ ...Delete(Library(), { type: 'remove', playlistId: P(2), entryId: E(2) }).item, id: `t${n}`, deletedAt: iso });
  const items = [make('2026-10-01T00:00:00.000Z', 1), make('2026-11-18T00:00:00.000Z', 2), make('2026-11-10T00:00:00.000Z', 3)];
  const kept = Trash.Prune(items, NOW);
  assert.deepEqual(kept.map(i => i.id), ['t2', 't3']);
  const s = Trash.Summary(kept[0], NOW);
  assert.equal(s.daysLeft, 29);
  assert.equal(Trash.Prune(Array.from({ length: 250 }, (_, n) => make('2026-11-18T00:00:00.000Z', n)), NOW).length, Trash.MAX_ITEMS);
});

test('only delete and remove are captured, and only when something was actually deleted', () => {
  const lib = Library();
  assert.equal(Trash.Capture(lib, lib, { type: 'rename', playlistId: P(2), name: 'x' }, NOW), null);
  assert.equal(Trash.Capture(lib, lib, { type: 'delete', playlistId: P(2) }, NOW), null, '削除されていなければ、保管しない');
  assert.equal(Trash.Capture(lib, lib, { type: 'remove', playlistId: P(2), entryId: 'missing' }, NOW), null);
});

test('the restore action goes through the shared apply, so every platform uses the same rule', () => {
  const App = require('../src/core/library-app.cjs');
  const { before, after, item } = Delete(Library(), { type: 'delete', playlistId: P(2) });
  const result = App.Apply({ text: JSON.stringify(after), action: { type: 'restore', item }, ids: [], now: NOW });
  assert.equal(result.error, undefined);
  assert.deepEqual(JSON.parse(result.text), before);
});

// ---- 同期との整合（二端末のテスト用の道具は、test/sync-devices.test.cjs と同じ）
const Clock = require('../src/core/sync-clock.cjs');
const Eng = require('../src/core/sync-engine.cjs');
const DAY = 86400000, T0 = Date.UTC(2026, 10, 13);
const Setup = base => {
  const repo = new Eng.MemorySyncRepository(), devices = ['devA', 'devB'].map(n => Eng.NewDevice(n));
  for (const d of devices) Eng.Initialize(d, base, T0);
  return { repo, devices };
};
const SyncAll = async (repo, devices, now) => { for (let round = 0; round < 3; round++) for (const d of devices) assert.equal((await Eng.Sync(d, repo, now)).ok, true); };
const Canon = view => JSON.stringify({ roots: view.rootPlaylistIds, lists: view.playlists.map(p => [p.id, p.name, p.childIds, p.entries.map(e => e.id)]).sort() });
const syncLibrary = () => { const l = Library(); delete l.activePlaylistId; return l; };

test('sync: A deletes a playlist, both sync, A restores it, and B gets it back with its songs, order and children', async () => {
  const { repo, devices: [a, b] } = Setup(syncLibrary());
  await SyncAll(repo, [a, b], T0);
  const original = Canon(a.view);
  const view = clone(a.view), action = { type: 'delete', playlistId: P(2) };
  const before = clone(view);
  assert.equal(Actions.Apply(view, action, ctx), true);
  const item = Trash.Capture(before, view, action, NOW);
  Eng.Edit(a, view, T0 + 1000);
  await SyncAll(repo, [a, b], T0 + 2000);
  assert.equal(b.view.playlists.some(p => p.id === P(2)), false, 'Bにも削除が届く');
  assert.notEqual(Canon(b.view), original);
  const restored = clone(a.view); Trash.Restore(restored, item);
  Eng.Edit(a, restored, T0 + 3000);
  await SyncAll(repo, [a, b], T0 + 4000);
  assert.equal(Canon(b.view), original, 'Bにも、曲・並び・子が、元どおりに戻る');
  assert.equal(Canon(a.view), Canon(b.view));
  ValidateLibrary(clone(b.view));
});

test('sync: a song B added to the playlist while A deleted it is not lost or duplicated when A restores', async () => {
  const { repo, devices: [a, b] } = Setup(syncLibrary());
  await SyncAll(repo, [a, b], T0);
  // B は、p2 へ曲を追加（オフラインのまま）。A は、p2 を削除して同期。
  const viewB = clone(b.view); viewB.playlists.find(p => p.id === P(2)).entries.push(entry(50));
  Eng.Edit(b, viewB, T0 + 1500);
  const view = clone(a.view), action = { type: 'delete', playlistId: P(2) }, before = clone(view);
  Actions.Apply(view, action, ctx);
  const item = Trash.Capture(before, view, action, NOW);
  Eng.Edit(a, view, T0 + 1000);
  await SyncAll(repo, [a, b], T0 + 2000);
  const restored = clone(a.view);
  Trash.Restore(restored, item);
  Eng.Edit(a, restored, T0 + 3000);
  await SyncAll(repo, [a, b], T0 + 4000);
  assert.equal(Canon(a.view), Canon(b.view), '両方の端末が、同じ状態に収束');
  const all = [...a.view.playlists.flatMap(p => p.entries.map(e => e.id))];
  assert.equal(all.filter(x => x === E(50)).length, 1, 'Bが追加した曲は、失われず、重複もしない');
  for (const n of [2, 3]) assert.equal(all.filter(x => x === E(n)).length, 1, `元の曲${n}は、1つだけ`);
  ValidateLibrary(clone(a.view));
});
const E_ID = n => E_ID_of(n);
function E_ID_of(n) { return id(2, n); }

// ---- PC版の保管ファイルと、Store・mainのつなぎ
test('PC: the trash file keeps items across a restart, drops damaged ones, and counts trashed songs as references', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { TrashStore } = require('../src/core/trash-store.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-trash-')), file = path.join(dir, 'trash.json');
  try {
    const { item } = Delete(Library(), { type: 'delete', playlistId: P(2) });
    const store = new TrashStore(file, () => NOW);
    assert.equal(store.Add({ ...item, kind: 'x' }), false, '形が正しくないものは入れない');
    assert.equal(store.Add(item), true);
    assert.deepEqual(store.Entries().map(e => e.id), [E(2), E(3)], '保管中の曲は、参照として数える');
    const again = new TrashStore(file, () => NOW);
    assert.equal(again.List().length, 1);
    assert.equal(again.List()[0].daysLeft, 30);
    assert.deepEqual(again.Get(item.id).playlist.id, P(2));
    // 壊れた項目が混ざっていても、ほかの項目は使える
    fs.writeFileSync(file, JSON.stringify({ version: 1, items: [item, { id: 'broken' }, null] }));
    assert.equal(new TrashStore(file, () => NOW).List().length, 1);
    fs.writeFileSync(file, '{ not json');
    assert.equal(new TrashStore(file, () => NOW).List().length, 0);
    // 30日を過ぎたものは、読み込みのときに消える
    fs.writeFileSync(file, JSON.stringify({ version: 1, items: [item] }));
    assert.equal(new TrashStore(file, () => '2027-01-01T00:00:00.000Z').List().length, 0);
    again.Remove(item.id);
    assert.equal(new TrashStore(file, () => NOW).List().length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PC: the store keeps a deleted playlist and a removed song after a successful save, and the restore action brings them back', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { Store } = require('../src/core/store.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-store-trash-'));
  try {
    const kept = [];
    const store = new Store(dir, { trash: item => kept.push(item) });
    store.Apply({ type: 'create', name: '消すリスト', select: false });
    const target = store.data.playlists.find(p => p.name === '消すリスト');
    store.Apply({ type: 'delete', playlistId: target.id });
    assert.equal(kept.length, 1);
    assert.equal(kept[0].kind, 'playlist');
    assert.equal(store.data.playlists.some(p => p.id === target.id), false);
    store.Apply({ type: 'restore', item: kept[0] });
    assert.equal(store.data.playlists.some(p => p.id === target.id), true, '元に戻る');
    assert.throws(() => store.Apply({ type: 'restore', item: kept[0] }), /すでに戻っています/);
    assert.equal(store.data.playlists.filter(p => p.id === target.id).length, 1, '失敗した復元は、何も変えない');
    // 削除が失敗したとき（最後の1つ）は、保管しない
    const count = kept.length;
    const rest = store.data.playlists.map(p => p.id);
    for (const id of rest.slice(0, -1)) store.Apply({ type: 'delete', playlistId: id });
    assert.throws(() => store.Apply({ type: 'delete', playlistId: store.data.playlists[0].id }), /最後/);
    assert.equal(kept.length, count + rest.length - 1, '成功した削除だけを保管');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PC: main wires the trash (keep after save, restore through the shared apply, references while trashed)', () => {
  const fs = require('node:fs'), path = require('node:path');
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const main = read('src/main.cjs');
  assert.match(main, /trash: item => trashStore\.Add\(item\)/);
  assert.match(main, /store\.Apply\(\{ type: 'restore', item \}\)/);
  assert.match(main, /referenceData: \(\) => WithTrashedEntries\(store\.SavedData\(\)\)/, '保管中の曲の保存済みメディアを、整理で消さない');
  assert.match(read('src/preloads/ui.cjs'), /trashRestore: invoke\('trash:restore'\)/);
  assert.match(read('src/ui/app.js'), /\['最近削除', TrashSettings\]/);
});
