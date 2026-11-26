'use strict';
// 共通入口（library-app.cjs）の add-video と PlaylistPath の統合テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const App = require('../src/core/library-app.cjs');

test('add-video assigns/reuses mediaId, reopens cleanly, and rejects duplicates or non-Bilibili URLs', () => {
  const ids = Array.from({ length: 16 }, (_, i) => `00000009-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  const entry = (n, video) => ({ id: `00000002-0000-4000-8000-${String(n).padStart(12, '0')}`, mediaId: `00000003-0000-4000-8000-${String(n).padStart(12, '0')}`, type: 'bilibili', title: `曲${n}`, addedAt: '2026-11-13T00:00:00.000Z', videoId: video, part: 1, url: `https://www.bilibili.com/video/${video}/` });
  const list = (n, entries) => ({ id: `00000001-0000-4000-8000-${String(n).padStart(12, '0')}`, name: `リスト${n}`, icon: '', entries, childIds: [], createdAt: '2026-11-01T00:00:00.000Z', lastAddedAt: '', includeInAll: true });
  const makeLib = () => { const a = list(1, [entry(1, 'BV1aaaaaaaaa')]), b = list(2, []); return { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: a.id, rootPlaylistIds: [a.id, b.id], playlists: [a, b] }; };
  const apply = (lib, action) => App.Apply({ text: JSON.stringify(lib), action, ids, now: '2026-11-14T00:00:00.000Z' });

  const lib = makeLib();
  const first = apply(lib, { type: 'add-video', playlistId: lib.playlists[1].id, url: 'https://www.bilibili.com/video/BV1aaaaaaaaa/', title: ' 同じ ' });
  assert.ok(first.text, first.error);
  const afterFirst = JSON.parse(first.text);
  assert.equal(afterFirst.playlists[1].entries[0].mediaId, lib.playlists[0].entries[0].mediaId);
  const second = apply(afterFirst, { type: 'add-video', playlistId: lib.playlists[1].id, url: 'BV1bbbbbbbbb', title: '新しい', duration: 90 });
  const afterSecond = JSON.parse(second.text);
  const added = afterSecond.playlists[1].entries[1];
  assert.match(added.mediaId, /^[0-9a-f-]{36}$/);
  assert.equal(added.duration, 90);
  assert.equal(afterSecond.playlists[0].entries.length, 1);
  const opened = App.Open({ text: second.text, ids, now: '2026-11-14T00:00:00.000Z' });
  assert.ok(opened.status === 'ok' || opened.text || !opened.error);
  assert.notEqual(opened.status, 'unsupported');

  const lib2 = makeLib();
  assert.match(apply(lib2, { type: 'add-video', playlistId: lib2.playlists[0].id, url: 'BV1aaaaaaaaa' }).error, /すでに/);
  assert.ok(apply(lib2, { type: 'add-video', playlistId: lib2.playlists[0].id, url: 'https://example.com/video/BV1aaaaaaaaa/' }).error);
});

test('PlaylistPath resolves root-to-list paths, prefers play scope for shared lists, and handles invalid input safely', () => {
  const list = (id, name, childIds = []) => ({ id, name, icon: '', entries: [], childIds, createdAt: '2026-11-01T00:00:00.000Z', lastAddedAt: '', includeInAll: true });
  const library = { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: 'A', rootPlaylistIds: ['A', 'E'], playlists: [list('A', '親A', ['B', 'D']), list('B', '子B', ['C']), list('C', '孫C'), list('D', '子D'), list('E', '親E', ['D'])] };
  const text = JSON.stringify(library);
  const names = result => result.path.map(p => p.name);

  assert.deepEqual(names(App.PlaylistPath({ text, playlistId: 'C' })), ['親A', '子B', '孫C']);
  assert.deepEqual(App.PlaylistPath({ text, playlistId: 'C' }).path.map(p => p.id), ['A', 'B', 'C']);
  assert.deepEqual(names(App.PlaylistPath({ text, playlistId: 'A' })), ['親A']);

  assert.deepEqual(names(App.PlaylistPath({ text, playlistId: 'D', scope: '*' })), ['親A', '子D']);
  assert.deepEqual(names(App.PlaylistPath({ text, playlistId: 'D', scope: 'E' })), ['親E', '子D']);
  assert.deepEqual(names(App.PlaylistPath({ text, playlistId: 'D', scope: 'A' })), ['親A', '子D']);

  assert.deepEqual(App.PlaylistPath({ text, playlistId: 'missing' }), { path: [] });
  assert.ok(App.PlaylistPath({ text: '{', playlistId: 'A' }).error);
});
