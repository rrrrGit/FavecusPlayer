'use strict';
// v0.7.1 Step3：曲の所在（ホームからそのリストまでの階層）。iPhone版の再生画面とWindows版の「再生中」「次に再生」で同じ規則（Tree.Path）を使う。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const App = require('../src/core/library-app.cjs');

const list = (id, name, childIds = []) => ({ id, name, icon: '', entries: [], childIds, createdAt: '2026-11-01T00:00:00.000Z', lastAddedAt: '', includeInAll: true });
// 親A → 子B → 孫C、親A → 子D、別の親E → 子D（子Dは複数の親から共有）
const library = { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: 'A', rootPlaylistIds: ['A', 'E'], playlists: [list('A', '親A', ['B', 'D']), list('B', '子B', ['C']), list('C', '孫C'), list('D', '子D'), list('E', '親E', ['D'])] };
const text = JSON.stringify(library);
const names = result => result.path.map(p => p.name);

test('the path runs from the top-level list down to the playing list', () => {
  assert.deepEqual(names(App.PlaylistPath({ text, playlistId: 'C' })), ['親A', '子B', '孫C']);
  assert.deepEqual(App.PlaylistPath({ text, playlistId: 'C' }).path.map(p => p.id), ['A', 'B', 'C']);
  assert.deepEqual(names(App.PlaylistPath({ text, playlistId: 'A' })), ['親A']);
});

test('a list shared by several parents prefers the path through the play scope, otherwise the first path in display order', () => {
  assert.deepEqual(names(App.PlaylistPath({ text, playlistId: 'D', scope: '*' })), ['親A', '子D']);
  assert.deepEqual(names(App.PlaylistPath({ text, playlistId: 'D', scope: 'E' })), ['親E', '子D']);
  assert.deepEqual(names(App.PlaylistPath({ text, playlistId: 'D', scope: 'A' })), ['親A', '子D']);
});

test('an unknown list gives an empty path and broken input gives an error, never a throw', () => {
  assert.deepEqual(App.PlaylistPath({ text, playlistId: 'missing' }), { path: [] });
  assert.ok(App.PlaylistPath({ text: '{', playlistId: 'A' }).error);
});
