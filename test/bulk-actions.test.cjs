'use strict';
// 複数選択の一括操作（共通の操作 entries-transfer・remove-many。PC版・iPhone版で同じ規則）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
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
      { id: 'p3', name: 'C', icon: '', childIds: [], includeInAll: true, entries: [] }
    ]
  };
}
const titles = (data, id) => data.playlists.find(p => p.id === id).entries.map(e => e.title);

test('copy: songs already in the destination are skipped, new ones get new ids, the source stays', () => {
  const data = library(), result = Actions.TransferEntries(data, ctx, { playlistId: 'p1', entryIds: ['a', 'b', 'c'], destinationIds: ['p2'], mode: 'copy' });
  assert.equal(result.added, 2); assert.equal(result.skipped, 1); assert.equal(result.moved, false);
  assert.deepEqual(titles(data, 'p2'), ['曲B（別）', '曲A', '曲C']);
  assert.deepEqual(titles(data, 'p1'), ['曲A', '曲B', '曲C']);
  const copies = data.playlists[1].entries.slice(1);
  assert.ok(copies.every(e => !['a', 'c'].includes(e.id)), '新しいID');
  assert.deepEqual(result.moves.map(m => m.destinations[0].playlistId), ['p2', 'p2', 'p2']);
});

test('move: the first new destination keeps the id, the source loses the songs, duplicates in the destination are merged', () => {
  const data = library(), result = Actions.TransferEntries(data, ctx, { playlistId: 'p1', entryIds: ['a', 'b'], destinationIds: ['p2', 'p3'], mode: 'move' });
  assert.equal(result.moved, true);
  assert.deepEqual(titles(data, 'p1'), ['曲C']);
  assert.deepEqual(titles(data, 'p2'), ['曲B（別）', '曲A']);
  assert.deepEqual(titles(data, 'p3'), ['曲A', '曲B']);
  assert.equal(data.playlists[1].entries.find(e => e.title === '曲A').id, 'a', '最初の追加先は、IDを引き継ぐ');
  assert.notEqual(data.playlists[2].entries.find(e => e.title === '曲A').id, 'a');
  assert.equal(result.moves.find(m => m.entryId === 'b').destinations[0].entryId, 'b2', '同じ動画は、既にある曲を指す');
});

test('bad requests change nothing and explain why', () => {
  const data = library(), snapshot = JSON.stringify(data);
  const run = options => () => Actions.TransferEntries(data, ctx, options);
  assert.throws(run({ playlistId: 'p1', entryIds: ['a'], destinationIds: ['p1'], mode: 'copy' }), /元のプレイリスト以外/);
  assert.throws(run({ playlistId: 'p1', entryIds: ['a'], destinationIds: [], mode: 'copy' }), /移動・追加先/);
  assert.throws(run({ playlistId: 'p1', entryIds: [], destinationIds: ['p2'], mode: 'copy' }), /曲を選んでください/);
  assert.throws(run({ playlistId: 'p1', entryIds: ['nope'], destinationIds: ['p2'], mode: 'copy' }), /見つかりません/);
  assert.throws(run({ playlistId: 'p1', entryIds: ['a'], destinationIds: ['p2'], mode: 'swap' }), /移動・追加先/);
  assert.throws(run({ playlistId: 'p1', entryIds: ['a'], destinationIds: ['zz'], mode: 'copy' }), /見つかりません/);
  assert.equal(JSON.stringify(data), snapshot);
});

test('remove-many removes the found songs and fails when none are found', () => {
  const data = library();
  assert.equal(Actions.Apply(data, { type: 'remove-many', playlistId: 'p1', entryIds: ['a', 'c', 'ghost'] }, ctx), true);
  assert.deepEqual(titles(data, 'p1'), ['曲B']);
  assert.throws(() => Actions.Apply(data, { type: 'remove-many', playlistId: 'p1', entryIds: ['ghost'] }, ctx), /見つかりません/);
  assert.throws(() => Actions.Apply(data, { type: 'remove-many', playlistId: 'p1', entryIds: [] }, ctx), /選んでください/);
});

test('removing many songs is kept in recently-deleted one song at a time, and each can be restored', () => {
  const before = library(), data = library();
  Actions.Apply(data, { type: 'remove-many', playlistId: 'p1', entryIds: ['a', 'c'] }, ctx);
  const items = Trash.CaptureMany(before, data, { type: 'remove-many', playlistId: 'p1', entryIds: ['a', 'c', 'ghost'] }, '2026-11-21T00:00:00.000Z');
  assert.equal(items.length, 2);
  assert.ok(items.every(item => item.kind === 'entry' && item.playlistId === 'p1'));
  assert.equal(new Set(items.map(item => item.id)).size, 2, '保管のIDは、曲ごとに別');
  assert.deepEqual(Trash.CaptureMany(before, data, { type: 'rename', playlistId: 'p1' }, 'x'.repeat(0) || '2026-11-21T00:00:00.000Z'), []);
});

test('the shared Apply entry (iPhone) returns every trash item for remove-many and keeps the single-item field', () => {
  const text = JSON.stringify(library());
  const result = App.Apply({ text, action: { type: 'remove-many', playlistId: 'p1', entryIds: ['a', 'b'] }, keepTrash: true, createIds: [], now: '2026-11-21T00:00:00.000Z' });
  if (result.error) assert.fail(result.error);
  assert.equal(result.trashItems.length, 2);
  assert.equal(JSON.parse(result.trash).entry.id, JSON.parse(result.trashItems[0]).entry.id);
  const copy = App.Apply({ text, action: { type: 'entries-transfer', playlistId: 'p1', entryIds: ['a'], destinationIds: ['p3'], mode: 'copy' }, keepTrash: true, ids: ['11111111-1111-4111-8111-111111111111'], now: '2026-11-21T00:00:00.000Z' });
  if (copy.error) assert.fail(copy.error);
  assert.equal(JSON.parse(copy.text).playlists[2].entries.length, 1);
  assert.equal(copy.trash, undefined);
});

test('the Windows store: TransferEntries is all-or-nothing and remove-many goes to recently deleted per song', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-bulk-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kept = [], store = new Store(dir, { trash: item => kept.push(item) });
  const first = store.data.playlists[0].id;
  store.Apply({ type: 'add', playlistId: first, urls: 'https://www.bilibili.com/video/BV1aaaaaaaaa/\nhttps://www.bilibili.com/video/BV1bbbbbbbbb/\nhttps://www.bilibili.com/video/BV1ccccccccc/', title: '曲' });
  store.Apply({ type: 'create', name: '先', select: false });
  const target = store.data.playlists[1].id, ids = store.data.playlists[0].entries.map(e => e.id);
  const result = store.TransferEntries({ playlistId: first, entryIds: ids.slice(0, 2), destinationIds: [target], mode: 'copy' });
  assert.equal(result.added, 2);
  assert.equal(result.state.playlists[1].entries.length, 2);
  assert.throws(() => store.TransferEntries({ playlistId: first, entryIds: ['nope'], destinationIds: [target], mode: 'copy' }), /見つかりません/);
  assert.equal(store.data.playlists[1].entries.length, 2, '失敗したら、変わらない');
  store.Apply({ type: 'remove-many', playlistId: first, entryIds: ids.slice(0, 2) });
  assert.equal(kept.length, 2);
  assert.equal(new Store(dir).data.playlists[0].entries.length, 1, '保存された');
});
