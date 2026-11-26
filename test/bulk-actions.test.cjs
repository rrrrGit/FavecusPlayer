'use strict';
// 複数選択の一括操作（entries-transfer・remove-many・PC/iPhone配線）のテスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Actions = require('../src/core/library-actions.cjs');
const Trash = require('../src/core/trash.cjs');
const App = require('../src/core/library-app.cjs');
const { Store } = require('../src/core/store.cjs');

let counter = 0;
const ctx = { createId: () => 'n' + (++counter), now: () => '2026-11-21T00:00:00.000Z', cleanTitle: text => String(text || '').trim() };
const video = (id, bv, title) => ({ id, type: 'bilibili', videoId: bv, url: `https://www.bilibili.com/video/${bv}/`, part: 1, title, addedAt: '2026-01-01T00:00:00.000Z' });
function library() {
  return {
    version: 3, activePlaylistId: 'p1', rootPlaylistIds: ['p1', 'p2', 'p3'], settings: {},
    playlists: [
      { id: 'p1', name: 'A', icon: '', childIds: [], includeInAll: true, entries: [video('a', 'BV1aaaaaaaaa', '曲A'), video('b', 'BV1bbbbbbbbb', '曲B'), video('c', 'BV1ccccccccc', '曲C')] },
      { id: 'p2', name: 'B', icon: '', childIds: [], includeInAll: true, entries: [video('b2', 'BV1bbbbbbbbb', '曲B（別）')] },
      { id: 'p3', name: 'C', icon: '', childIds: [], includeInAll: true, entries: [] },
    ],
  };
}
const titles = (data, id) => data.playlists.find(p => p.id === id).entries.map(e => e.title);

test('TransferEntries handles copy/move semantics, ID retention, duplicate skipping, and rejects bad requests atomically', () => {
  const copyData = library();
  const copyRes = Actions.TransferEntries(copyData, ctx, { playlistId: 'p1', entryIds: ['a', 'b', 'c'], destinationIds: ['p2'], mode: 'copy' });
  assert.equal(copyRes.added, 2);
  assert.equal(copyRes.skipped, 1);
  assert.equal(copyRes.moved, false);
  assert.deepEqual(titles(copyData, 'p2'), ['曲B（別）', '曲A', '曲C']);
  assert.deepEqual(titles(copyData, 'p1'), ['曲A', '曲B', '曲C']);
  assert.ok(copyData.playlists[1].entries.slice(1).every(e => !['a', 'c'].includes(e.id)));
  assert.deepEqual(copyRes.moves.map(m => m.destinations[0].playlistId), ['p2', 'p2', 'p2']);

  const moveData = library();
  const moveRes = Actions.TransferEntries(moveData, ctx, { playlistId: 'p1', entryIds: ['a', 'b'], destinationIds: ['p2', 'p3'], mode: 'move' });
  assert.equal(moveRes.moved, true);
  assert.deepEqual(titles(moveData, 'p1'), ['曲C']);
  assert.deepEqual(titles(moveData, 'p2'), ['曲B（別）', '曲A']);
  assert.deepEqual(titles(moveData, 'p3'), ['曲A', '曲B']);
  assert.equal(moveData.playlists[1].entries.find(e => e.title === '曲A').id, 'a');
  assert.notEqual(moveData.playlists[2].entries.find(e => e.title === '曲A').id, 'a');
  assert.equal(moveRes.moves.find(m => m.entryId === 'b').destinations[0].entryId, 'b2');

  const badData = library(), snapshot = JSON.stringify(badData);
  const run = options => () => Actions.TransferEntries(badData, ctx, options);
  assert.throws(run({ playlistId: 'p1', entryIds: ['a'], destinationIds: ['p1'], mode: 'copy' }), /元のプレイリスト以外/);
  assert.throws(run({ playlistId: 'p1', entryIds: ['a'], destinationIds: [], mode: 'copy' }), /移動・追加先/);
  assert.throws(run({ playlistId: 'p1', entryIds: [], destinationIds: ['p2'], mode: 'copy' }), /曲を選んでください/);
  assert.throws(run({ playlistId: 'p1', entryIds: ['nope'], destinationIds: ['p2'], mode: 'copy' }), /見つかりません/);
  assert.throws(run({ playlistId: 'p1', entryIds: ['a'], destinationIds: ['p2'], mode: 'swap' }), /移動・追加先/);
  assert.throws(run({ playlistId: 'p1', entryIds: ['a'], destinationIds: ['zz'], mode: 'copy' }), /見つかりません/);
  assert.equal(JSON.stringify(badData), snapshot);
});

test('remove-many captures individual trash items and shared App.Apply supports remove-many and entries-transfer', () => {
  const data = library();
  assert.equal(Actions.Apply(data, { type: 'remove-many', playlistId: 'p1', entryIds: ['a', 'c', 'ghost'] }, ctx), true);
  assert.deepEqual(titles(data, 'p1'), ['曲B']);
  assert.throws(() => Actions.Apply(data, { type: 'remove-many', playlistId: 'p1', entryIds: ['ghost'] }, ctx), /見つかりません/);
  assert.throws(() => Actions.Apply(data, { type: 'remove-many', playlistId: 'p1', entryIds: [] }, ctx), /選んでください/);

  const before = library(), after = library();
  Actions.Apply(after, { type: 'remove-many', playlistId: 'p1', entryIds: ['a', 'c'] }, ctx);
  const items = Trash.CaptureMany(before, after, { type: 'remove-many', playlistId: 'p1', entryIds: ['a', 'c', 'ghost'] }, '2026-11-21T00:00:00.000Z');
  assert.equal(items.length, 2);
  assert.ok(items.every(item => item.kind === 'entry' && item.playlistId === 'p1'));
  assert.equal(new Set(items.map(item => item.id)).size, 2);
  assert.deepEqual(Trash.CaptureMany(before, after, { type: 'rename', playlistId: 'p1' }, '2026-11-21T00:00:00.000Z'), []);

  const text = JSON.stringify(library());
  const result = App.Apply({ text, action: { type: 'remove-many', playlistId: 'p1', entryIds: ['a', 'b'] }, keepTrash: true, createIds: [], now: '2026-11-21T00:00:00.000Z' });
  assert.equal(result.error, undefined);
  assert.equal(result.trashItems.length, 2);
  assert.equal(JSON.parse(result.trash).entry.id, JSON.parse(result.trashItems[0]).entry.id);
  const copy = App.Apply({ text, action: { type: 'entries-transfer', playlistId: 'p1', entryIds: ['a'], destinationIds: ['p3'], mode: 'copy' }, keepTrash: true, ids: ['11111111-1111-4111-8111-111111111111'], now: '2026-11-21T00:00:00.000Z' });
  assert.equal(copy.error, undefined);
  assert.equal(JSON.parse(copy.text).playlists[2].entries.length, 1);
  assert.equal(copy.trash, undefined);
});

test('Windows Store TransferEntries is all-or-nothing and remove-many archives per song', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-bulk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kept = [], store = new Store(dir, { trash: item => kept.push(item) });
  const first = store.data.playlists[0].id;
  store.Apply({ type: 'add', playlistId: first, urls: 'https://www.bilibili.com/video/BV1aaaaaaaaa/\nhttps://www.bilibili.com/video/BV1bbbbbbbbb/\nhttps://www.bilibili.com/video/BV1ccccccccc/', title: '曲' });
  store.Apply({ type: 'create', name: '先', select: false });
  const target = store.data.playlists[1].id, entryIds = store.data.playlists[0].entries.map(e => e.id);
  const result = store.TransferEntries({ playlistId: first, entryIds: entryIds.slice(0, 2), destinationIds: [target], mode: 'copy' });
  assert.equal(result.added, 2);
  assert.equal(result.state.playlists[1].entries.length, 2);
  assert.throws(() => store.TransferEntries({ playlistId: first, entryIds: ['nope'], destinationIds: [target], mode: 'copy' }), /見つかりません/);
  assert.equal(store.data.playlists[1].entries.length, 2);
  store.Apply({ type: 'remove-many', playlistId: first, entryIds: entryIds.slice(0, 2) });
  assert.equal(kept.length, 2);
  assert.equal(new Store(dir).data.playlists[0].entries.length, 1);
});

test('iPhone bulk action wiring allocates sufficient IDs, stores all trash items, and enforces 100-link limit', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const store = read('ios/FavecusPlayer/Library/LibraryStore.swift');
  const detail = read('ios/FavecusPlayer/Library/PlaylistDetailView.swift');
  const bulk = read('ios/FavecusPlayer/Library/BulkViews.swift');
  assert.match(store, /freshIds\(count: Self\.idsNeeded\(for: action\)\)/);
  assert.match(store, /entries\.count \+ 4/);
  assert.match(store, /ids\.count \* destinations\.count \+ 4/);
  assert.match(store, /for kept in items \{ trash\.add\(json: kept\) \}/);
  for (const type of ['entries-transfer', 'remove-many', '"title"']) assert.ok(detail.includes(type));
  assert.match(detail, /struct TransferRequest/);
  assert.match(detail, /songActions\(entry\)/);
  assert.match(bulk, /struct PlaylistPickerSheet/);
  assert.match(bulk, /maxLinks = 100/);
  assert.match(bulk, /isRefusal == true \|\| error is URLError/);
  assert.match(read('src/core/store.cjs'), /1回につき1〜100件/);
});
