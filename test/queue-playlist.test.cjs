'use strict';
// 再生キューを、新しいプレイリストとして保存する（共通の操作 queue-playlist。PC版・iPhone版で同じ規則）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Actions = require('../src/core/library-actions.cjs');

let counter = 0;
const ctx = { createId: () => 'id' + (++counter), now: () => '2026-11-21T00:00:00.000Z', cleanTitle: text => String(text || '').trim() };
const video = (id, bv, title) => ({ id, type: 'bilibili', videoId: bv, url: `https://www.bilibili.com/video/${bv}/`, part: 1, title, addedAt: '2026-01-01T00:00:00.000Z' });
function library() {
  return {
    version: 3, activePlaylistId: 'p1', rootPlaylistIds: ['p1', 'p2'], settings: {},
    playlists: [
      { id: 'p1', name: 'A', icon: '', childIds: [], includeInAll: true, entries: [video('a1', 'BV1aaaaaaaaa', '曲A'), video('a2', 'BV1bbbbbbbbb', '曲B')] },
      { id: 'p2', name: 'B', icon: '', childIds: [], includeInAll: true, entries: [video('b1', 'BV1ccccccccc', '曲C'), video('b2', 'BV1aaaaaaaaa', '曲A（別リスト）')] }
    ]
  };
}

test('the queue becomes a new playlist in queue order, copying songs under new ids and leaving the sources alone', () => {
  const data = library(), before = JSON.stringify(data.playlists.map(p => p.entries.map(e => e.id)));
  assert.equal(Actions.Apply(data, { type: 'queue-playlist', name: '今日のキュー', entries: [{ playlistId: 'p2', entryId: 'b1' }, { playlistId: 'p1', entryId: 'a2' }, { playlistId: 'p1', entryId: 'a1' }] }, ctx), true);
  const created = data.playlists.at(-1);
  assert.equal(created.name, '今日のキュー');
  assert.deepEqual(created.entries.map(e => e.title), ['曲C', '曲B', '曲A']);
  assert.ok(created.entries.every(e => !['a1', 'a2', 'b1', 'b2'].includes(e.id)), '新しいID');
  assert.equal(new Set(created.entries.map(e => e.id)).size, 3);
  assert.deepEqual(data.rootPlaylistIds, ['p1', 'p2', created.id], '最上位の末尾');
  assert.equal(data.activePlaylistId, 'p1', '開いているリストは変えない');
  assert.equal(JSON.stringify(data.playlists.slice(0, 2).map(p => p.entries.map(e => e.id))), before, '元のリストは変わらない');
});

test('songs of the same media are merged into one, unknown songs are skipped, and an empty result is an error', () => {
  const data = library();
  Actions.Apply(data, { type: 'queue-playlist', name: 'まとめ', entries: [{ playlistId: 'p1', entryId: 'a1' }, { playlistId: 'p2', entryId: 'b2' }, { playlistId: 'p1', entryId: 'none' }, { playlistId: 'zz', entryId: 'a1' }] }, ctx);
  assert.deepEqual(data.playlists.at(-1).entries.map(e => e.videoId), ['BV1aaaaaaaaa'], '同じ動画は1つ');
  const copy = library();
  assert.throws(() => Actions.Apply(copy, { type: 'queue-playlist', name: 'x', entries: [{ playlistId: 'p1', entryId: 'none' }] }, ctx), /見つかりません/);
  assert.throws(() => Actions.Apply(copy, { type: 'queue-playlist', name: 'x', entries: [] }, ctx), /保存する曲がありません/);
  assert.equal(copy.playlists.length, 2, '失敗したら、リストは増えない');
});

test('it can go under a parent, can select the new list, and uses a default name', () => {
  const data = library();
  Actions.Apply(data, { type: 'queue-playlist', parentId: 'p1', select: true, entries: [{ playlistId: 'p2', entryId: 'b1' }] }, ctx);
  const created = data.playlists.at(-1);
  assert.equal(created.name, '再生キュー');
  assert.deepEqual(data.playlists[0].childIds, [created.id]);
  assert.equal(data.activePlaylistId, created.id);
  assert.throws(() => Actions.Apply(library(), { type: 'queue-playlist', parentId: 'nope', entries: [{ playlistId: 'p2', entryId: 'b1' }] }, ctx), /見つかりません/);
});

test('the Windows store accepts the action, saves it, and keeps media identity numbers for copied songs', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { Store } = require('../src/core/store.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-qp-'));
  try {
    const store = new Store(dir), first = store.data.playlists[0].id;
    store.Apply({ type: 'add', playlistId: first, urls: 'https://www.bilibili.com/video/BV1aaaaaaaaa/\nhttps://www.bilibili.com/video/BV1bbbbbbbbb/', title: '曲' });
    const [one, two] = store.data.playlists[0].entries;
    const snapshot = store.Apply({ type: 'queue-playlist', name: 'キュー', entries: [{ playlistId: first, entryId: two.id }, { playlistId: first, entryId: one.id }] });
    assert.equal(snapshot.playlists.length, 2);
    const created = snapshot.playlists[1];
    assert.deepEqual(created.entries.map(e => e.videoId), ['BV1bbbbbbbbb', 'BV1aaaaaaaaa']);
    assert.equal(created.entries[0].mediaId, two.mediaId, '同じ動画は、同じメディア番号');
    assert.equal(snapshot.activePlaylistId, first);
    assert.equal(new Store(dir).data.playlists.length, 2, '保存された');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
