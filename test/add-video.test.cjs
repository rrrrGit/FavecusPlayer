'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const App = require('../src/core/library-app.cjs');

const ids = Array.from({ length: 16 }, (_, i) => `00000009-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const entry = (n, video) => ({ id: `00000002-0000-4000-8000-${String(n).padStart(12, '0')}`, mediaId: `00000003-0000-4000-8000-${String(n).padStart(12, '0')}`, type: 'bilibili', title: `曲${n}`, addedAt: '2026-11-13T00:00:00.000Z', videoId: video, part: 1, url: `https://www.bilibili.com/video/${video}/` });
const list = (n, entries) => ({ id: `00000001-0000-4000-8000-${String(n).padStart(12, '0')}`, name: `リスト${n}`, icon: '', entries, childIds: [], createdAt: '2026-11-01T00:00:00.000Z', lastAddedAt: '', includeInAll: true });
const library = () => { const a = list(1, [entry(1, 'BV1aaaaaaaaa')]), b = list(2, []); return { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: a.id, rootPlaylistIds: [a.id, b.id], playlists: [a, b] }; };
const apply = (lib, action) => App.Apply({ text: JSON.stringify(lib), action, ids, now: '2026-11-14T00:00:00.000Z' });

test('add-video assigns a media id, reuses the id of the same video, and the saved library opens again', () => {
  const lib = library();
  const first = apply(lib, { type: 'add-video', playlistId: lib.playlists[1].id, url: 'https://www.bilibili.com/video/BV1aaaaaaaaa/', title: ' 同じ ' });
  assert.ok(first.text, first.error);
  const afterFirst = JSON.parse(first.text);
  assert.equal(afterFirst.playlists[1].entries[0].mediaId, lib.playlists[0].entries[0].mediaId, '同じ動画は同じメディア識別番号');
  const second = apply(afterFirst, { type: 'add-video', playlistId: lib.playlists[1].id, url: 'BV1bbbbbbbbb', title: '新しい', duration: 90 });
  const afterSecond = JSON.parse(second.text);
  const added = afterSecond.playlists[1].entries[1];
  assert.match(added.mediaId, /^[0-9a-f-]{36}$/);
  assert.equal(added.duration, 90);
  assert.equal(afterSecond.playlists[0].entries.length, 1, '他のリストは変えない');
  const opened = App.Open({ text: second.text, ids, now: '2026-11-14T00:00:00.000Z' });
  assert.ok(opened.status === 'ok' || opened.text || !opened.error, JSON.stringify(opened).slice(0, 200));
  assert.notEqual(opened.status, 'unsupported');
});

test('add-video refuses a duplicate in the same list and a non-Bilibili URL, leaving the library untouched', () => {
  const lib = library();
  assert.match(apply(lib, { type: 'add-video', playlistId: lib.playlists[0].id, url: 'BV1aaaaaaaaa' }).error, /すでに/);
  assert.ok(apply(lib, { type: 'add-video', playlistId: lib.playlists[0].id, url: 'https://example.com/video/BV1aaaaaaaaa/' }).error);
});
