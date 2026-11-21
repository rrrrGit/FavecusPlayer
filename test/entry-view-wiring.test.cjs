'use strict';
// 曲の並べ替え・絞り込み：一覧の行（tree.Rows）への組み込みと、main・画面の接続。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const tree = require('../src/ui/library-tree.js');
const EntryView = require('../src/ui/entry-view.js');
const { readMain, readApp } = require('./support-source.cjs');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

const entry = (id, title) => ({ id, title, type: 'bilibili', videoId: 'BV' + id, url: `https://www.bilibili.com/video/BV${id}/`, part: 1 });
const data = {
  version: 3, activePlaylistId: 'p1', rootPlaylistIds: ['p1'], settings: {},
  playlists: [{ id: 'p1', name: 'L', icon: '', childIds: ['p2'], includeInAll: true, entries: [entry('a', 'みかん'), entry('b', 'あおぞら'), entry('c', 'Zebra')] },
    { id: 'p2', name: 'C', icon: '', childIds: [], includeInAll: true, entries: [entry('x', '子の曲')] }]
};

test('Rows applies the arrange hook to a list own songs only, and keeps the original numbers', () => {
  const arrange = (playlist, rows) => (playlist.id === 'p1' ? EntryView.Apply(rows, { sort: 'title' }, {}, row => row.entry) : rows);
  const rows = tree.Rows(data, 'p1', new Set(), '', arrange).filter(row => row.entry);
  assert.deepEqual(rows.map(row => row.entry.id), ['c', 'b', 'a'], '曲名の順（英字が先）');
  assert.deepEqual(rows.map(row => row.index), [2, 1, 0], '元の番号を保つ');
  const plain = tree.Rows(data, 'p1', new Set(), '').filter(row => row.entry);
  assert.deepEqual(plain.map(row => row.entry.id), ['a', 'b', 'c'], 'hook なしは、保存した順');
  const filtered = tree.Rows(data, 'p1', new Set(), '', (playlist, list) => EntryView.Apply(list, { source: 'local' }, {}, row => row.entry)).filter(row => row.entry);
  assert.equal(filtered.length, 0);
});

test('main applies the choice to the play order and the screen reads it through the shared module', () => {
  const main = readMain(), app = readApp();
  assert.match(main, /const ArrangedEntries = scope =>/);
  assert.match(main, /: ArrangedEntries\(scope\);/, 'ScopeEntries（曲送り・同期）も、同じ順');
  assert.match(main, /async function Play\(playlistId, entryId, resume = null\) \{\s*const entries = ArrangedEntries\(playlistId\)/);
  assert.match(main, /async function ShufflePlay\(playlistId\) \{\s*const entries = ArrangedEntries\(playlistId\)/);
  assert.match(main, /Handle\('list:view-set'/);
  assert.match(main, /Handle\('list:stats'/);
  assert.match(read('src/preloads/ui.cjs'), /listViewSet: invoke\('list:view-set'\)/);
  assert.match(app, /tree\.Rows\(state, ViewScope\(\), expandedEntryLists, filter, ArrangeRows\)/);
  assert.match(app, /window\.FavecusEntryView\.Apply\(rows, view, ctx, row => row\.entry\)/);
  assert.match(read('src/ui/index.html'), /<script src="entry-view\.js" defer><\/script>/);
  assert.match(main, /'entry-view\.js'/, 'アプリのプロトコルの許可リスト');
});
