'use strict';
// v0.7.3 F3：自動リスト（よく聴く曲・最近追加した曲・未再生）の選び方。
const { test } = require('node:test');
const { readMain, readApp } = require('./support-source.cjs');
const assert = require('node:assert/strict');
const { Select } = require('../src/core/auto-lists.cjs');

const entry = (id, addedAt) => ({ id, addedAt, title: id });
const library = {
  playlists: [
    { id: 'p1', entries: [entry('a', '2026-01-01T00:00:00.000Z'), entry('b', '2026-03-01T00:00:00.000Z'), entry('c', '2026-02-01T00:00:00.000Z')] },
    { id: 'p2', entries: [entry('a2', '2026-04-01T00:00:00.000Z'), entry('d', '2026-05-01T00:00:00.000Z'), entry('nokey', '2026-06-01T00:00:00.000Z')] }
  ]
};
// a と a2 は同じメディア（K1）。nokey は、キーなし。
const keys = { a: 'K1', a2: 'K1', b: 'K2', c: 'K3', d: 'K4' };
const ids = list => list.map(i => i.id);

test('frequent: only played songs, most played first, ties by newest registration', () => {
  const result = Select({ library, keys, counts: { K1: 5, K2: 5, K3: 1 } });
  assert.deepEqual(ids(result.frequent), ['a2', 'b', 'c'], 'K1とK2は同数：登録が新しい a2（K1の代表）が先');
  assert.equal(result.frequent[0].count, 5);
});

test('the same media is one song, represented by its newest registration', () => {
  const result = Select({ library, keys, counts: {} });
  assert.equal(ids(result.recent).filter(id => id === 'a' || id === 'a2').length, 1);
  assert.ok(ids(result.recent).includes('a2'));
  assert.deepEqual(result.recent.find(i => i.id === 'a2'), { id: 'a2', playlistId: 'p2', count: 0 });
});

test('recent: newest registration first, across all lists', () => {
  assert.deepEqual(ids(Select({ library, keys }).recent), ['nokey', 'd', 'a2', 'b', 'c']);
});

test('unplayed: count 0 (and songs without a key), newest first', () => {
  const result = Select({ library, keys, counts: { K1: 2, K3: 1 } });
  assert.deepEqual(ids(result.unplayed), ['nokey', 'd', 'b']);
});

test('limits cut each list, and a song never has a negative or broken count', () => {
  const result = Select({ library, keys, counts: { K1: -3, K2: 'x', K3: 2.9 }, limits: { recent: 2, frequent: 1, unplayed: 1 } });
  assert.equal(result.recent.length, 2);
  assert.deepEqual(ids(result.frequent), ['c']);
  assert.equal(result.frequent[0].count, 2);
  assert.equal(result.unplayed.length, 1);
});

test('an empty or malformed library gives empty lists', () => {
  for (const input of [undefined, {}, { library: null }, { library: { playlists: [{ entries: [null, { id: 5 }] }] } }]) {
    assert.deepEqual(Select(input), { frequent: [], recent: [], unplayed: [] });
  }
});

test('a queue can be started over an explicit list of song ids (auto lists), in that order', () => {
  const App = require('../src/core/library-app.cjs');
  const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const entries = [1, 2, 3, 4].map(n => ({ id: id(2, n), mediaId: id(3, n), type: 'bilibili', title: `曲${n}`, addedAt: '2026-11-14T00:00:00.000Z', url: `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'a')}/` }));
  const lib = { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: id(1, 1), rootPlaylistIds: [id(1, 1)], playlists: [{ id: id(1, 1), name: 'リスト', icon: '', entries, childIds: [], createdAt: '2026-11-14T00:00:00.000Z', lastAddedAt: '', includeInAll: true }] };
  const text = JSON.stringify(lib), playable = entries.map(e => e.id), entryIds = [entries[2].id, entries[0].id, 'missing', entries[3].id];
  const started = App.QueueStart({ text, scope: 'auto:frequent', entryIds, entryId: entries[2].id, shuffle: false, playable });
  assert.equal(started.id, entries[2].id);
  assert.equal(started.playlistId, id(1, 1));
  assert.deepEqual(App.QueueList().upcoming, [entries[0].id, entries[3].id], '指定の順番（存在しない曲は除く）');
  const moved = App.QueueMove({ direction: 1, repeat: 'off', sync: { text, scope: 'auto:frequent', entryIds, entryId: entries[2].id, ownScope: id(1, 1), shuffle: false, playable } });
  assert.equal(moved.id, entries[0].id);
  const picked = App.AutoLists({ text, keys: { [entries[0].id]: 'K' }, counts: { K: 3 } });
  assert.equal(picked.frequent[0].id, entries[0].id);
});

test('PC: the home shows the auto lists below the playlists and plays them through the shared selection', () => {
  const fs = require('node:fs'), path = require('node:path');
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(read('src/preloads/ui.cjs'), /autoList: invoke\('library:auto-list'\), autoPlay: invoke\('player:auto-play'\)/);
  const main = readMain();
  assert.match(main, /AutoListsCore\.Select\(/, '選び方は、共通の core/auto-lists.cjs');
  assert.match(main, /Handle\('player:auto-play'/);
  assert.match(main, /ScopeEntries\(nextQueue\.playlistId\)/, '次の曲は、自動リストの並びから選ぶ');
  assert.match(main, /AUTO_NAMES\[queue\.playlistId\] \? '\*' : queue\.playlistId/, '前回の続き：自動リストの再生は、全体を範囲として保存');
  const app = readApp();
  assert.match(app, /const auto = MakeAutoLists\(\); if \(auto\) \$\('home'\)\.append\(auto\)/);
});

test('favorites (v0.7.4): favorite media only, newest registration first, one per media, returned only when asked', () => {
  assert.equal(Select({ library, keys, counts: {} }).favorites, undefined, '渡さなければ、返さない（共通テストデータを変えない）');
  const result = Select({ library, keys, counts: {}, favorites: ['K1', 'K3', 'K9'] });
  assert.deepEqual(ids(result.favorites), ['a2', 'c'], 'K1は1曲にまとめ（新しい a2）、登録の新しい順');
  assert.deepEqual(Select({ library, keys, counts: {}, favorites: [] }).favorites, []);
  assert.deepEqual(ids(Select({ library, keys, counts: {}, favorites: ['K1', 'K2', 'K3'], limits: { favorites: 1 } }).favorites), ['a2']);
  assert.deepEqual(ids(Select({ library, keys, counts: {}, favorites: ['id:nokey'] }).favorites), [], 'キーのない曲は、お気に入りにならない');
});

test('the favorites list is wired on both platforms', () => {
  const fs = require('node:fs'), path = require('node:path');
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(readMain(), /'auto:favorites': 'お気に入り'/);
  assert.match(readMain(), /favorites: favorites \? favorites\.List\(\) : \[\]/);
  assert.match(readApp(), /kind: 'favorites'/);
  assert.match(read('ios/FavecusPlayer/Library/AutoLists.swift'), /case frequent, recent, unplayed, favorites/);
  assert.match(read('ios/FavecusPlayer/Playback/PlaybackEngine.swift'), /"favorites": Array\(favorites\.keys\)/);
});
