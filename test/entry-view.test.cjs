'use strict';
// 曲の並べ替え・絞り込み（共通の規則 ui/entry-view.js）と、プレイリストごとの選択の保存（core/list-views.cjs）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const EntryView = require('../src/ui/entry-view.js');
const { ListViewStore } = require('../src/core/list-views.cjs');

const song = (id, title, extra = {}) => ({ id, title, type: 'bilibili', videoId: 'BV' + id, addedAt: '2026-01-01T00:00:00.000Z', ...extra });
const songs = [
  song('a', 'みかん', { addedAt: '2026-03-01T00:00:00.000Z', duration: 200 }),
  song('b', 'あおぞら', { addedAt: '2026-01-01T00:00:00.000Z', duration: 0 }),
  song('c', 'Zebra', { addedAt: '2026-02-01T00:00:00.000Z', duration: 100, type: 'local', fileName: 'c.mp3' }),
  song('d', 'apple 10', { addedAt: '2026-04-01T00:00:00.000Z', duration: 300 }),
  song('e', 'apple 9', { addedAt: '2026-05-01T00:00:00.000Z' })
];
const counts = { a: 3, b: 0, c: 3, d: 1, e: 0 }, likes = new Set(['b', 'd']), saved = new Set(['a', 'c']);
const ctx = { count: e => counts[e.id], favorite: e => likes.has(e.id), saved: e => saved.has(e.id) };
const ids = (view, list = songs) => EntryView.Apply(list, view, ctx).map(e => e.id).join('');

test('the default view keeps the saved manual order and never changes the input array', () => {
  const copy = [...songs];
  assert.equal(ids({}), 'abcde');
  assert.equal(ids(undefined), 'abcde');
  assert.equal(EntryView.IsActive({}), false);
  assert.deepEqual(songs, copy);
  assert.notEqual(EntryView.Apply(songs, {}, ctx), songs, '新しい配列');
});

test('every sort order works and ties keep the manual order', () => {
  assert.equal(ids({ sort: 'title' }), 'edcba', 'apple 9 → apple 10（数は、数として比べる）→ Zebra（英字が先）→ あおぞら → みかん');
  assert.equal(ids({ sort: 'count-desc' }), 'acdbe', '同じ回数は、元の順');
  assert.equal(ids({ sort: 'count-asc' }), 'bedac');
  assert.equal(ids({ sort: 'added-desc' }), 'edacb');
  assert.equal(ids({ sort: 'added-asc' }), 'bcade');
  assert.equal(ids({ sort: 'duration-desc' }), 'dacbe', '長さが分からない曲は、最後');
  assert.equal(ids({ sort: 'duration-asc' }), 'cadbe', '長さが分からない曲は、向きに関係なく最後');
  assert.equal(ids({ sort: 'favorite-first' }), 'bdace');
});

test('filters combine with each other and with a sort', () => {
  assert.equal(ids({ favorite: 'on' }), 'bd');
  assert.equal(ids({ favorite: 'off' }), 'ace');
  assert.equal(ids({ saved: 'saved' }), 'ac');
  assert.equal(ids({ saved: 'unsaved' }), 'bde');
  assert.equal(ids({ source: 'local' }), 'c');
  assert.equal(ids({ source: 'bilibili' }), 'abde');
  assert.equal(ids({ played: 'played' }), 'acd');
  assert.equal(ids({ played: 'unplayed' }), 'be');
  assert.equal(ids({ favorite: 'off', played: 'played', sort: 'added-desc' }), 'ac');
  assert.equal(ids({ saved: 'saved', favorite: 'on' }), '');
  assert.equal(EntryView.IsFiltering({ sort: 'title' }), false);
  assert.equal(EntryView.IsFiltering({ played: 'played' }), true);
});

test('unknown values fall back to the default, and missing context functions count as zero or false', () => {
  assert.deepEqual(EntryView.Normalize({ sort: 'nope', favorite: 'maybe', saved: 5, source: null, played: {} }), EntryView.DEFAULT);
  assert.deepEqual(EntryView.Normalize('x'), EntryView.DEFAULT);
  assert.equal(EntryView.Apply(songs, { favorite: 'on' }).length, 0, 'ctx がなければ、お気に入りはなし');
  assert.equal(EntryView.Apply(songs, { sort: 'count-desc' }, { count: () => NaN }).map(e => e.id).join(''), 'abcde');
});

test('items can be wrapped objects (rows of the list) through getEntry', () => {
  const rows = songs.map((entry, index) => ({ entry, index }));
  assert.equal(EntryView.Apply(rows, { favorite: 'on', sort: 'title' }, ctx, row => row.entry).map(row => row.index).join(''), '31');
});

test('the per-list choice is saved atomically, restored, removed at the default, and a broken file is ignored', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-lv-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sub', 'list-views.json');
  const store = new ListViewStore(file);
  assert.deepEqual(store.All(), {});
  assert.deepEqual(store.Set('p1', { sort: 'title', favorite: 'on', bogus: 1 }), { sort: 'title', favorite: 'on', saved: 'any', source: 'any', played: 'any' });
  assert.deepEqual(new ListViewStore(file).Get('p1').sort, 'title');
  assert.equal(store.Set('p1', {}), null, '既定に戻したら、記録を消す');
  assert.deepEqual(new ListViewStore(file).All(), {});
  assert.throws(() => store.Set('', { sort: 'title' }), /正しくありません/);
  fs.writeFileSync(file, '{ broken');
  assert.deepEqual(new ListViewStore(file).All(), {});
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('tree.Rows arrange hook, App.ArrangeEntries, and PC/iPhone wiring stay consistent', () => {
  const tree = require('../src/ui/library-tree.js');
  const App = require('../src/core/library-app.cjs');
  const { readMain, readApp } = require('./support-source.cjs');
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const mk = (id, title) => ({ id, title, type: 'bilibili', videoId: 'BV' + id, url: `https://www.bilibili.com/video/BV${id}/`, part: 1 });
  const data = {
    version: 3, activePlaylistId: 'p1', rootPlaylistIds: ['p1'], settings: {},
    playlists: [{ id: 'p1', name: 'L', icon: '', childIds: ['p2'], includeInAll: true, entries: [mk('a', 'みかん'), mk('b', 'あおぞら'), mk('c', 'Zebra')] },
      { id: 'p2', name: 'C', icon: '', childIds: [], includeInAll: true, entries: [mk('x', '子の曲')] }]
  };
  const rows = tree.Rows(data, 'p1', new Set(), '', (playlist, list) => (playlist.id === 'p1' ? EntryView.Apply(list, { sort: 'title' }, {}, row => row.entry) : list)).filter(row => row.entry);
  assert.deepEqual(rows.map(row => row.entry.id), ['c', 'b', 'a']);
  assert.deepEqual(rows.map(row => row.index), [2, 1, 0]);
  assert.equal(tree.Rows(data, 'p1', new Set(), '', (_p, list) => EntryView.Apply(list, { source: 'local' }, {}, row => row.entry)).filter(row => row.entry).length, 0);

  const items = [
    { id: 'a', title: 'B', type: 'bilibili', count: 1, favorite: false, saved: true },
    { id: 'b', title: 'A', type: 'local', count: 5, favorite: true, saved: true },
    { id: 'c', title: 'C', type: 'bilibili', count: 0, favorite: true, saved: false }
  ];
  assert.deepEqual(App.ArrangeEntries({ items, view: { sort: 'title' } }).ids, ['b', 'a', 'c']);
  assert.deepEqual(App.ArrangeEntries({ items, view: { favorite: 'on', sort: 'count-desc' } }).ids, ['b', 'c']);
  assert.deepEqual(App.ArrangeEntries({ items, view: { saved: 'unsaved' } }).ids, ['c']);
  assert.deepEqual(App.ArrangeEntries({ items: 'bad', view: {} }).ids, []);

  const main = readMain(), app = readApp();
  assert.match(main, /const ArrangedEntries = scope =>/);
  assert.match(main, /: KeepCurrent\(scope, ArrangedEntries\(scope\)\);/);
  assert.match(main, /Handle\('list:view-set'/); assert.match(main, /Handle\('list:stats'/);
  assert.match(read('src/preloads/ui.cjs'), /listViewSet: invoke\('list:view-set'\)/);
  assert.match(app, /tree\.Rows\(state, ViewScope\(\), expandedEntryLists, filter, ArrangeRows\)/);
  assert.match(read('src/ui/index.html'), /<script src="entry-view\.js" defer><\/script>/);
  const swift = read('ios/FavecusPlayer/Library/ListViewStore.swift');
  for (const sort of EntryView.SORTS) assert.ok(swift.includes(`"${sort}"`));
  for (const key of ['favorite', 'saved', 'source', 'played']) for (const value of EntryView.FILTERS[key]) assert.ok(swift.includes(`"${value}"`));
  assert.match(read('ios/FavecusPlayer/Playback/PlaybackEngine.swift'), /scopeArrangedIds\(scope\)/);
  assert.match(read('ios/FavecusPlayer/Playback/PlaybackEngine+Views.swift'), /listViews\.view\(for: \$0\.id\)/);
});
