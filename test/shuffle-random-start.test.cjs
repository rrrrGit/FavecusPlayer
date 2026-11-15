'use strict';
// v0.7.2 A2：プレイリストのシャッフル再生で、最初の曲も、再生範囲の中からランダムに選ぶ（先頭の曲に固定しない）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const App = require('../src/core/library-app.cjs');
const Ledger = require('../src/core/play-ledger.cjs');

const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entry = n => ({ id: id(2, n), mediaId: id(3, n), type: 'bilibili', title: `曲${n}`, addedAt: '2026-11-14T00:00:00.000Z', url: `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'a')}/` });
const entries = [1, 2, 3, 4, 5, 6].map(entry);
const library = { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: id(1, 1), rootPlaylistIds: [id(1, 1)], playlists: [{ id: id(1, 1), name: 'リスト', icon: '', entries, childIds: [], createdAt: '2026-11-14T00:00:00.000Z', lastAddedAt: '', includeInAll: true }] };
const text = JSON.stringify(library), playable = entries.map(e => e.id), scope = id(1, 1);

test('randomStart picks every song as the first one over many starts, not always the head of the list', () => {
  const firsts = new Map();
  for (let seed = 1; seed <= 300; seed++) {
    const result = App.QueueStart({ text, scope, shuffle: true, randomStart: true, playable, seed });
    assert.ok(result.id && result.playlistId);
    firsts.set(result.id, (firsts.get(result.id) || 0) + 1);
  }
  for (const e of entries) assert.ok((firsts.get(e.id) || 0) > 20, `${e.title}も最初に来る`);
});

test('randomStart still plays every song once per cycle, and follows the weights', () => {
  const first = App.QueueStart({ text, scope, shuffle: true, randomStart: true, playable, seed: 5 });
  const seen = new Set([first.id]);
  for (let i = 0; i < 5; i++) seen.add(App.QueueMove({ direction: 1, repeat: 'off', automatic: false }).id);
  assert.equal(seen.size, 6);
  const weights = {};
  for (const e of entries) weights[e.id] = Ledger.Weight(e.id === entries[0].id ? 50 : 0);
  let heavy = 0;
  for (let seed = 1; seed <= 300; seed++) if (App.QueueStart({ text, scope, shuffle: true, randomStart: true, playable, weights, seed }).id === entries[0].id) heavy++;
  assert.ok(heavy < 15, '回数が多い曲は、最初にも来にくい');
});

test('without randomStart, the given entry stays first (unchanged behavior)', () => {
  assert.equal(App.QueueStart({ text, scope, entryId: entries[2].id, shuffle: true, playable, seed: 1 }).id, entries[2].id);
});
