'use strict';
// v0.7.2 C1：再生キュー（これから再生する曲の一覧・並べ替え・選んで移る）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const App = require('../src/core/library-app.cjs');

const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entry = n => ({ id: id(2, n), mediaId: id(3, n), type: 'bilibili', title: `曲${n}`, addedAt: '2026-11-14T00:00:00.000Z', url: `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'a')}/` });
const entries = [1, 2, 3, 4, 5].map(entry);
const library = { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: id(1, 1), rootPlaylistIds: [id(1, 1)], playlists: [{ id: id(1, 1), name: 'リスト', icon: '', entries, childIds: [], createdAt: '2026-11-14T00:00:00.000Z', lastAddedAt: '', includeInAll: true }] };
const text = JSON.stringify(library), playable = entries.map(e => e.id), scope = id(1, 1);
const start = (extra = {}) => App.QueueStart({ text, scope, entryId: entries[0].id, shuffle: false, playable, ...extra });
const ids = n => entries[n - 1].id;

test('the list shows the playing song and the songs still to come, in order', () => {
  start();
  const list = App.QueueList();
  assert.equal(list.current, ids(1));
  assert.deepEqual(list.upcoming, [ids(2), ids(3), ids(4), ids(5)]);
});

test('reordering moves only songs still to come, and the new order is what plays next', () => {
  start();
  assert.equal(App.QueueReorder({ from: 3, to: 0 }).ok, true); // 曲5を、先頭へ
  assert.deepEqual(App.QueueList().upcoming, [ids(5), ids(2), ids(3), ids(4)]);
  assert.equal(App.QueueMove({ direction: 1, repeat: 'off' }).id, ids(5));
  assert.equal(App.QueueReorder({ from: 9, to: 0 }).ok, false, '範囲外は、何もしない');
  assert.equal(App.QueueReorder({ from: 0, to: -1 }).ok, false);
  assert.deepEqual(App.QueueList().upcoming, [ids(2), ids(3), ids(4)]);
});

test('a custom order survives the library sync that runs on every move (non-shuffle)', () => {
  start();
  App.QueueReorder({ from: 2, to: 0 }); // 曲4を、曲2の前へ
  const sync = { text, scope, entryId: ids(1), ownScope: scope, shuffle: false, playable };
  const moved = App.QueueMove({ direction: 1, repeat: 'off', sync });
  assert.equal(moved.id, ids(4));
  assert.deepEqual(App.QueueList().upcoming, [ids(2), ids(3), ids(5)]);
});

test('jumping to a queued song plays it next without dropping the songs in between', () => {
  start();
  const jumped = App.QueueJump({ id: ids(4) });
  assert.equal(jumped.id, ids(4)); assert.equal(jumped.playlistId, scope);
  assert.equal(App.QueueList().current, ids(4));
  assert.deepEqual(App.QueueList().upcoming, [ids(5)]);
  assert.equal(App.QueueJump({ id: ids(2) }).id, null, 'すでに過ぎた曲・キューにない曲には移らない');
});

test('reorder works in shuffle mode as well and keeps every song exactly once', () => {
  start({ shuffle: true, seed: 7 });
  const before = App.QueueList().upcoming;
  assert.equal(App.QueueReorder({ from: 0, to: before.length - 1 }).ok, true);
  const after = App.QueueList().upcoming;
  assert.deepEqual([...after].sort(), [...before].sort());
  assert.equal(after.at(-1), before[0]);
});
