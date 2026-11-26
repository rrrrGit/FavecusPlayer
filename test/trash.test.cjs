'use strict';
// 最近削除（保管・復元・同期整合・PC保管ファイルと配線）のテスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readMain, readApp } = require('./support-source.cjs');
const Actions = require('../src/core/library-actions.cjs');
const Trash = require('../src/core/trash.cjs');
const { ValidateLibrary } = require('../src/core/library-data.cjs');
const App = require('../src/core/library-app.cjs');
const Eng = require('../src/core/sync-engine.cjs');
const { TrashStore } = require('../src/core/trash-store.cjs');
const { Store } = require('../src/core/store.cjs');

const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = n => id(1, n), E = n => id(2, n), M = n => id(3, n);
const NOW = '2026-11-19T12:00:00.000Z';
let counter = 100;
const ctx = { createId: () => id(9, counter++), now: () => NOW, cleanTitle: v => String(v) };
const entry = (n, extra = {}) => ({ id: E(n), mediaId: M(n), type: 'bilibili', title: `曲${n}`, addedAt: '2026-11-14T00:00:00.000Z', url: `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'a')}/`, ...extra });
const list = (n, entries = [], childIds = []) => ({ id: P(n), name: `リスト${n}`, icon: '', entries, childIds, createdAt: '2026-11-14T00:00:00.000Z', lastAddedAt: '', includeInAll: true });
function Library() {
  return {
    version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: P(1), rootPlaylistIds: [P(1), P(5)],
    playlists: [list(1, [entry(1)], [P(2), P(3)]), list(2, [entry(2), entry(3)], [P(4)]), list(3, [entry(4)], [P(4)]), list(4, [entry(5)]), list(5, [entry(6)])],
  };
}
const clone = v => JSON.parse(JSON.stringify(v));
const Delete = (library, action) => {
  const before = clone(library), after = clone(library);
  assert.equal(Actions.Apply(after, action, ctx), true);
  return { before, after, item: Trash.Capture(before, after, action, NOW) };
};
const restore = (library, item) => { const copy = clone(library); Trash.Restore(copy, item); return copy; };

test('restoring deleted playlists restores promoted children, multi-parent refs, and root/last positions', () => {
  const { before, after, item } = Delete(Library(), { type: 'delete', playlistId: P(2) });
  assert.notDeepEqual(after, before);
  assert.equal(item.kind, 'playlist');
  assert.match(item.label, /リスト2/);
  assert.deepEqual(restore(after, item), before);
  ValidateLibrary(restore(after, item));

  const multi = Library();
  multi.playlists[0].childIds = [P(2), P(3), P(4)];
  const r2 = Delete(multi, { type: 'delete', playlistId: P(4) });
  assert.equal(r2.item.changes.length, 3);
  assert.deepEqual(restore(r2.after, r2.item), r2.before);

  for (const target of [P(5), P(1), P(3)]) {
    const r3 = Delete(Library(), { type: 'delete', playlistId: target });
    const result = restore(r3.after, r3.item);
    assert.deepEqual({ ...result, activePlaylistId: 0 }, { ...r3.before, activePlaylistId: 0 });
    assert.equal(result.activePlaylistId, r3.after.activePlaylistId);
  }
});

test('changes made after delete are preserved when restoring (moved child is not pulled back)', () => {
  const { after, item } = Delete(Library(), { type: 'delete', playlistId: P(2) });
  const moved = clone(after);
  assert.equal(Actions.Apply(moved, { type: 'playlist-move', playlistId: P(4), parentId: P(5) }, ctx), true);
  const result = restore(moved, item);
  assert.deepEqual(result.playlists.find(p => p.id === P(5)).childIds, [P(4)]);
  assert.deepEqual(result.playlists.find(p => p.id === P(2)).childIds, []);
  assert.ok(result.playlists.find(p => p.id === P(1)).childIds.includes(P(2)));
  assert.equal(result.activePlaylistId, moved.activePlaylistId);
  ValidateLibrary(result);
});

test('restoring a removed song restores position once and refuses conflicts or forged items without mutating library', () => {
  const r = Delete(Library(), { type: 'remove', playlistId: P(2), entryId: E(2) });
  assert.deepEqual(restore(r.after, r.item), r.before);
  assert.throws(() => Trash.Restore(restore(r.after, r.item), r.item), /すでに戻っています/);

  const { after, item } = Delete(Library(), { type: 'delete', playlistId: P(2) });
  const revived = clone(after); revived.playlists.push(list(2));
  assert.throws(() => Trash.Restore(revived, item), /すでに戻っています/);
  const dup = clone(after); dup.playlists[0].entries.push(entry(2));
  const dupBefore = clone(dup);
  assert.throws(() => Trash.Restore(dup, item), /すでに別の場所/);
  assert.deepEqual(dup, dupBefore);

  const songRemoval = Delete(Library(), { type: 'remove', playlistId: P(5), entryId: E(6) });
  const noList = clone(songRemoval.after);
  noList.playlists = noList.playlists.filter(p => p.id !== P(5));
  noList.rootPlaylistIds = [P(1)];
  assert.throws(() => Trash.Restore(noList, songRemoval.item), /元のプレイリストがない/);
  const same = clone(songRemoval.after);
  same.playlists.find(p => p.id === P(5)).entries.push(entry(99, { url: entry(6).url, mediaId: M(6) }));
  assert.throws(() => Trash.Restore(same, songRemoval.item), /同じ動画/);

  for (const bad of [null, {}, { ...item, kind: 'x' }, { ...item, playlist: { ...item.playlist, id: 'not-an-id' } }, { ...item, changes: 'x' }, { ...item, position: -1 }, { ...item, deletedAt: 'never' }]) {
    assert.throws(() => Trash.Restore(clone(after), bad), /正しくない/);
  }
});

test('prune drops >30d items and caps count; capture filters non-deletes; shared App.Apply restores', () => {
  const make = (iso, n) => ({ ...Delete(Library(), { type: 'remove', playlistId: P(2), entryId: E(2) }).item, id: `t${n}`, deletedAt: iso });
  const kept = Trash.Prune([make('2026-10-01T00:00:00.000Z', 1), make('2026-11-18T00:00:00.000Z', 2), make('2026-11-10T00:00:00.000Z', 3)], NOW);
  assert.deepEqual(kept.map(i => i.id), ['t2', 't3']);
  assert.equal(Trash.Summary(kept[0], NOW).daysLeft, 29);
  assert.equal(Trash.Prune(Array.from({ length: 250 }, (_, n) => make('2026-11-18T00:00:00.000Z', n)), NOW).length, Trash.MAX_ITEMS);

  const lib = Library();
  assert.equal(Trash.Capture(lib, lib, { type: 'rename', playlistId: P(2), name: 'x' }, NOW), null);
  assert.equal(Trash.Capture(lib, lib, { type: 'delete', playlistId: P(2) }, NOW), null);
  assert.equal(Trash.Capture(lib, lib, { type: 'remove', playlistId: P(2), entryId: 'missing' }, NOW), null);

  const { before, after, item } = Delete(Library(), { type: 'delete', playlistId: P(2) });
  const result = App.Apply({ text: JSON.stringify(after), action: { type: 'restore', item }, ids: [], now: NOW });
  assert.equal(result.error, undefined);
  assert.deepEqual(JSON.parse(result.text), before);
});

const T0 = Date.UTC(2026, 10, 13);
const SetupSync = base => {
  const repo = new Eng.MemorySyncRepository(), devices = ['devA', 'devB'].map(n => Eng.NewDevice(n));
  for (const d of devices) Eng.Initialize(d, base, T0);
  return { repo, devices };
};
const SyncAll = async (repo, devices, now) => { for (let round = 0; round < 3; round++) for (const d of devices) assert.equal((await Eng.Sync(d, repo, now)).ok, true); };
const Canon = view => JSON.stringify({ roots: view.rootPlaylistIds, lists: view.playlists.map(p => [p.id, p.name, p.childIds, p.entries.map(e => e.id)]).sort() });
const syncLibrary = () => { const l = Library(); delete l.activePlaylistId; return l; };

test('sync: restoring a deleted playlist converges on both devices with songs, order, and children intact', async () => {
  const { repo, devices: [a, b] } = SetupSync(syncLibrary());
  await SyncAll(repo, [a, b], T0);
  const original = Canon(a.view);
  const view = clone(a.view), action = { type: 'delete', playlistId: P(2) }, before = clone(view);
  assert.equal(Actions.Apply(view, action, ctx), true);
  const item = Trash.Capture(before, view, action, NOW);
  Eng.Edit(a, view, T0 + 1000);
  await SyncAll(repo, [a, b], T0 + 2000);
  assert.equal(b.view.playlists.some(p => p.id === P(2)), false);
  const restored = clone(a.view); Trash.Restore(restored, item);
  Eng.Edit(a, restored, T0 + 3000);
  await SyncAll(repo, [a, b], T0 + 4000);
  assert.equal(Canon(b.view), original);
  assert.equal(Canon(a.view), Canon(b.view));
  ValidateLibrary(clone(b.view));
});

test('sync: a song added offline by B while A deleted the playlist is neither lost nor duplicated after restore', async () => {
  const { repo, devices: [a, b] } = SetupSync(syncLibrary());
  await SyncAll(repo, [a, b], T0);
  const viewB = clone(b.view); viewB.playlists.find(p => p.id === P(2)).entries.push(entry(50));
  Eng.Edit(b, viewB, T0 + 1500);
  const view = clone(a.view), action = { type: 'delete', playlistId: P(2) }, before = clone(view);
  Actions.Apply(view, action, ctx);
  const item = Trash.Capture(before, view, action, NOW);
  Eng.Edit(a, view, T0 + 1000);
  await SyncAll(repo, [a, b], T0 + 2000);
  const restored = clone(a.view); Trash.Restore(restored, item);
  Eng.Edit(a, restored, T0 + 3000);
  await SyncAll(repo, [a, b], T0 + 4000);
  assert.equal(Canon(a.view), Canon(b.view));
  const all = a.view.playlists.flatMap(p => p.entries.map(e => e.id));
  assert.equal(all.filter(x => x === E(50)).length, 1);
  for (const n of [2, 3]) assert.equal(all.filter(x => x === E(n)).length, 1);
  ValidateLibrary(clone(a.view));
});

test('PC TrashStore persists across restarts, drops damaged/expired items, and counts trashed entries as references', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-trash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'trash.json');
  const { item } = Delete(Library(), { type: 'delete', playlistId: P(2) });
  const store = new TrashStore(file, () => NOW);
  assert.equal(store.Add({ ...item, kind: 'x' }), false);
  assert.equal(store.Add(item), true);
  assert.deepEqual(store.Entries().map(e => e.id), [E(2), E(3)]);
  const again = new TrashStore(file, () => NOW);
  assert.equal(again.List().length, 1);
  assert.equal(again.List()[0].daysLeft, 30);
  assert.deepEqual(again.Get(item.id).playlist.id, P(2));
  fs.writeFileSync(file, JSON.stringify({ version: 1, items: [item, { id: 'broken' }, null] }));
  assert.equal(new TrashStore(file, () => NOW).List().length, 1);
  fs.writeFileSync(file, '{ not json');
  assert.equal(new TrashStore(file, () => NOW).List().length, 0);
  fs.writeFileSync(file, JSON.stringify({ version: 1, items: [item] }));
  assert.equal(new TrashStore(file, () => '2027-01-01T00:00:00.000Z').List().length, 0);
  again.Remove(item.id);
  assert.equal(new TrashStore(file, () => NOW).List().length, 0);
});

test('PC Store keeps successful deletes, restores cleanly, and main/UI wire trash with offline references', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-store-trash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kept = [], store = new Store(dir, { trash: item => kept.push(item) });
  store.Apply({ type: 'create', name: '消すリスト', select: false });
  const target = store.data.playlists.find(p => p.name === '消すリスト');
  store.Apply({ type: 'delete', playlistId: target.id });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].kind, 'playlist');
  assert.equal(store.data.playlists.some(p => p.id === target.id), false);
  store.Apply({ type: 'restore', item: kept[0] });
  assert.equal(store.data.playlists.some(p => p.id === target.id), true);
  assert.throws(() => store.Apply({ type: 'restore', item: kept[0] }), /すでに戻っています/);
  const count = kept.length, rest = store.data.playlists.map(p => p.id);
  for (const pid of rest.slice(0, -1)) store.Apply({ type: 'delete', playlistId: pid });
  assert.throws(() => store.Apply({ type: 'delete', playlistId: store.data.playlists[0].id }), /最後/);
  assert.equal(kept.length, count + rest.length - 1);

  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const main = readMain();
  assert.match(main, /trash: item => trashStore\.Add\(item\)/);
  assert.match(main, /store\.Apply\(\{ type: 'restore', item \}\)/);
  assert.match(main, /referenceData: \(\) => WithTrashedEntries\(store\.SavedData\(\)\)/);
  assert.match(read('src/preloads/ui.cjs'), /trashRestore: invoke\('trash:restore'\)/);
  assert.match(readApp(), /\['最近削除', TrashSettings\]/);
});
