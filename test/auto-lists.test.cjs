'use strict';
// 自動リスト（よく聴く曲・最近追加した曲・未再生・お気に入り）の選び方と接続テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readMain, readApp } = require('./support-source.cjs');
const { Select } = require('../src/core/auto-lists.cjs');
const App = require('../src/core/library-app.cjs');

const entry = (id, addedAt) => ({ id, addedAt, title: id });
const library = {
  playlists: [
    { id: 'p1', entries: [entry('a', '2026-01-01T00:00:00.000Z'), entry('b', '2026-03-01T00:00:00.000Z'), entry('c', '2026-02-01T00:00:00.000Z')] },
    { id: 'p2', entries: [entry('a2', '2026-04-01T00:00:00.000Z'), entry('d', '2026-05-01T00:00:00.000Z'), entry('nokey', '2026-06-01T00:00:00.000Z')] },
  ],
};
const keys = { a: 'K1', a2: 'K1', b: 'K2', c: 'K3', d: 'K4' };
const ids = list => list.map(i => i.id);

test('frequent, recent, and unplayed deduplicate same media by newest registration and sort accurately', () => {
  const freq = Select({ library, keys, counts: { K1: 5, K2: 5, K3: 1 } });
  assert.deepEqual(ids(freq.frequent), ['a2', 'b', 'c']);
  assert.equal(freq.frequent[0].count, 5);

  const zero = Select({ library, keys, counts: {} });
  assert.equal(ids(zero.recent).filter(id => id === 'a' || id === 'a2').length, 1);
  assert.deepEqual(zero.recent.find(i => i.id === 'a2'), { id: 'a2', playlistId: 'p2', count: 0 });
  assert.deepEqual(ids(Select({ library, keys }).recent), ['nokey', 'd', 'a2', 'b', 'c']);

  const unplayed = Select({ library, keys, counts: { K1: 2, K3: 1 } });
  assert.deepEqual(ids(unplayed.unplayed), ['nokey', 'd', 'b']);
});

test('limits, invalid counts, and empty or malformed libraries are handled safely', () => {
  const result = Select({ library, keys, counts: { K1: -3, K2: 'x', K3: 2.9 }, limits: { recent: 2, frequent: 1, unplayed: 1 } });
  assert.equal(result.recent.length, 2);
  assert.deepEqual(ids(result.frequent), ['c']);
  assert.equal(result.frequent[0].count, 2);
  assert.equal(result.unplayed.length, 1);

  for (const input of [undefined, {}, { library: null }, { library: { playlists: [{ entries: [null, { id: 5 }] }] } }]) {
    assert.deepEqual(Select(input), { frequent: [], recent: [], unplayed: [] });
  }
});

test('favorites auto list returns deduplicated newest entries only when requested', () => {
  assert.equal(Select({ library, keys, counts: {} }).favorites, undefined);
  const result = Select({ library, keys, counts: {}, favorites: ['K1', 'K3', 'K9'] });
  assert.deepEqual(ids(result.favorites), ['a2', 'c']);
  assert.deepEqual(Select({ library, keys, counts: {}, favorites: [] }).favorites, []);
  assert.deepEqual(ids(Select({ library, keys, counts: {}, favorites: ['K1', 'K2', 'K3'], limits: { favorites: 1 } }).favorites), ['a2']);
  assert.deepEqual(ids(Select({ library, keys, counts: {}, favorites: ['id:nokey'] }).favorites), []);
});

test('a queue can be started over an explicit list of song ids (auto lists), in that order', () => {
  const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const entries = [1, 2, 3, 4].map(n => ({ id: id(2, n), mediaId: id(3, n), type: 'bilibili', title: `曲${n}`, addedAt: '2026-11-14T00:00:00.000Z', url: `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'a')}/` }));
  const lib = { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: id(1, 1), rootPlaylistIds: [id(1, 1)], playlists: [{ id: id(1, 1), name: 'リスト', icon: '', entries, childIds: [], createdAt: '2026-11-14T00:00:00.000Z', lastAddedAt: '', includeInAll: true }] };
  const text = JSON.stringify(lib), playable = entries.map(e => e.id), entryIds = [entries[2].id, entries[0].id, 'missing', entries[3].id];
  const started = App.QueueStart({ text, scope: 'auto:frequent', entryIds, entryId: entries[2].id, shuffle: false, playable });
  assert.equal(started.id, entries[2].id);
  assert.equal(started.playlistId, id(1, 1));
  assert.deepEqual(App.QueueList().upcoming, [entries[0].id, entries[3].id]);
  const moved = App.QueueMove({ direction: 1, repeat: 'off', sync: { text, scope: 'auto:frequent', entryIds, entryId: entries[2].id, ownScope: id(1, 1), shuffle: false, playable } });
  assert.equal(moved.id, entries[0].id);
  assert.equal(App.AutoLists({ text, keys: { [entries[0].id]: 'K' }, counts: { K: 3 } }).frequent[0].id, entries[0].id);
});

test('PC and iPhone wire auto lists and favorites through the shared selection', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(read('src/preloads/ui.cjs'), /autoList: invoke\('library:auto-list'\), autoPlay: invoke\('player:auto-play'\)/);
  const main = readMain(), app = readApp();
  assert.match(main, /AutoListsCore\.Select\(/);
  assert.match(main, /Handle\('player:auto-play'/);
  assert.match(main, /ScopeEntries\(nextQueue\.playlistId\)/);
  assert.match(main, /AUTO_NAMES\[queue\.playlistId\] \? current\.playlistId : queue\.playlistId/);
  assert.match(main, /'auto:favorites': 'お気に入り'/);
  assert.match(main, /favorites: favorites \? favorites\.List\(\) : \[\]/);
  assert.match(app, /const auto = MakeAutoLists\(\); if \(auto\) \$\('home'\)\.append\(auto\)/);
  assert.match(app, /kind: 'favorites'/);
  assert.match(read('ios/FavecusPlayer/Playback/PlaybackEngine+Queue.swift'), /"favorites": Array\(favorites\.keys\)/);
});
