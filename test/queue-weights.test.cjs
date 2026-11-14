'use strict';
// v0.7.1 Step4：iPhone版のシャッフルに、再生回数の重み（1/(1+回数)）を渡せる。重みがなければ均等（従来どおり）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const App = require('../src/core/library-app.cjs');
const Ledger = require('../src/core/play-ledger.cjs');

const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entry = n => ({ id: id(2, n), mediaId: id(3, n), type: 'bilibili', title: `曲${n}`, addedAt: '2026-11-14T00:00:00.000Z', url: `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'a')}/` });
const entries = [1, 2, 3, 4, 5, 6].map(entry);
const library = { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: id(1, 1), rootPlaylistIds: [id(1, 1)], playlists: [{ id: id(1, 1), name: 'リスト', icon: '', entries, childIds: [], createdAt: '2026-11-14T00:00:00.000Z', lastAddedAt: '', includeInAll: true }] };
const text = JSON.stringify(library), playable = entries.map(e => e.id);

// 先頭に来る曲を、seedを変えて数える（先頭は、開始した曲を除いた次の曲ではなく、抽選の最初）
function FirstCounts(weights, rounds = 400) {
  const firsts = new Map();
  for (let seed = 1; seed <= rounds; seed++) {
    const result = App.QueueStart({ text, scope: '*', entryId: entries[5].id, shuffle: true, playable, weights, seed });
    const next = App.QueueMove({ direction: 1, repeat: 'off', automatic: false });
    assert.ok(result.id && next.id);
    firsts.set(next.id, (firsts.get(next.id) || 0) + 1);
  }
  return firsts;
}

test('with no weights the shuffle is uniform; with weights, rarely played songs come first much more often', () => {
  const uniform = FirstCounts(undefined);
  for (const e of entries.slice(0, 5)) assert.ok((uniform.get(e.id) || 0) > 40, '均等なら、どの曲もそれなりに先に来る');
  const weights = {};
  for (const e of entries) weights[e.id] = Ledger.Weight(e.id === entries[0].id ? 50 : 0); // 曲1だけ、50回再生済み
  const weighted = FirstCounts(weights);
  assert.ok((weighted.get(entries[0].id) || 0) < (uniform.get(entries[0].id) || 0) / 3, '回数が多い曲は、先に来にくい');
});

test('an unknown weight for a song falls back to 1, and the shuffle still plays every song once per cycle', () => {
  App.QueueStart({ text, scope: '*', entryId: entries[0].id, shuffle: true, playable, weights: { [entries[1].id]: 0.01 }, seed: 3 });
  const seen = new Set([entries[0].id]);
  for (let i = 0; i < 5; i++) seen.add(App.QueueMove({ direction: 1, repeat: 'off', automatic: false }).id);
  assert.equal(seen.size, 6, 'すべての曲が1回ずつ出る（重みが小さくても、排除しない）');
});
