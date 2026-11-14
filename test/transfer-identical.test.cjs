'use strict';
// 同期済みのリストのように、すでに同じ構成のリストがあるときの取り込み（iPhone版が指定する skipIdentical）。Windows版の既定（同じものも取り込んで、名前を変える）は変えない。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/core/library-transfer.cjs');

const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
let counter = 0;
const createId = () => `cccccccc-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const entry = (n, video) => ({ id: id(2, n), mediaId: id(3, n), type: 'bilibili', title: `曲${n}`, addedAt: '2026-11-13T00:00:00.000Z', videoId: video, part: 1, url: `https://www.bilibili.com/video/${video}/` });
const list = (n, name, entries, childIds = []) => ({ id: id(1, n), name, icon: '', entries, childIds, createdAt: '2026-11-01T00:00:00.000Z', lastAddedAt: '', includeInAll: true });
const library = () => {
  const parent = list(1, '親', [entry(1, 'BV1aaaaaaaaa'), entry(2, 'BV1bbbbbbbbb')], [id(1, 2)]), child = list(2, '子', [entry(3, 'BV1ccccccccc')]), other = list(3, '別', [entry(4, 'BV1ddddddddd')]);
  return { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: parent.id, rootPlaylistIds: [parent.id, other.id], playlists: [parent, child, other] };
};
const planOf = lib => {
  const exported = T.Export({ library: lib, mode: 'information', available: [] });
  return T.Prepare(T.BuildShareInput(JSON.parse(exported.identity), exported.records.map(r => JSON.parse(r.text)))).plan;
};

test('IdenticalIds finds lists with the same name, entries (by media key) and children, even with different ids', () => {
  const local = library(), incoming = library();
  // 同期した端末のように、IDが違っても、同じ構成なら同じとみなす
  for (const p of incoming.playlists) { p.id = p.id.replace(/^0000000[0-9]/, m => m); }
  assert.deepEqual(new Set(T.IdenticalIds(local, planOf(incoming))), new Set(incoming.playlists.map(p => p.id)));
  const changed = library(); changed.playlists[2].entries.reverse(); changed.playlists[0].entries.reverse();
  const ids = T.IdenticalIds(local, planOf(changed));
  assert.ok(!ids.includes(id(1, 1)), '曲の並びが違う親は同じではない');
  assert.ok(ids.includes(id(1, 2)), '同じ子は同じ');
  const renamed = library(); renamed.playlists[2].name = '別名';
  assert.ok(!T.IdenticalIds(local, planOf(renamed)).includes(id(1, 3)));
});

test('Import with skipIdentical leaves out identical lists, keeps the rest, and refuses when nothing is left; the default still duplicates', () => {
  const local = library(), incoming = library();
  incoming.playlists[2].entries.push(entry(5, 'BV1eeeeeeeee')); // 「別」だけ違う
  const plan = planOf(incoming);
  const all = [id(1, 1), id(1, 3)];
  const result = T.Import({ library: local, plan, ids: all, available: [], createId, skipIdentical: true });
  assert.equal(result.skippedIdentical, 1);
  assert.equal(result.imported, 1, '違う「別」だけを取り込む');
  assert.equal(result.library.playlists.length, local.playlists.length + 1);
  assert.throws(() => T.Import({ library: local, plan: planOf(library()), ids: [id(1, 1)], available: [], createId, skipIdentical: true }), /すでに同じ構成/);
  const duplicated = T.Import({ library: local, plan: planOf(library()), ids: [id(1, 1)], available: [], createId });
  assert.equal(duplicated.library.playlists.length, local.playlists.length + 2, '既定では、これまでどおり二重に取り込む');
  assert.ok(duplicated.library.playlists.some(p => /取り込み1/.test(p.name)));
});
