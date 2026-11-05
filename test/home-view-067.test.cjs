'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Page, PAGE_SIZE } = require('../src/ui/home-view.js');
function Data() {
  return { settings: {}, rootPlaylistIds: ['a', 'b', 'shared'], playlists: [
    { id: 'a', name: '親A', entries: [{ id: 'a1' }], childIds: ['shared', 'empty'] },
    { id: 'b', name: '親B', entries: [], childIds: ['shared'] },
    { id: 'shared', name: '共有の子', entries: [{ id: 's1' }], childIds: ['leaf'], includeInAll: false },
    { id: 'leaf', name: '孫', entries: [{ id: 'l1' }], childIds: [] },
    { id: 'empty', name: '空', entries: [], childIds: [] }
  ] };
}
test('home cards keep actual roots and shared paths, count descendants once and show excluded or empty lists', () => {
  const data = Data(), before = structuredClone(data), roots = Page(data);
  assert.deepEqual(roots.cards.map(p => p.id), ['a', 'b']); assert.deepEqual(roots.cards.map(p => p.count), [3, 2]);
  assert.deepEqual(Page(data, { path: ['a'] }).cards.map(p => p.id), ['shared', 'empty']);
  assert.equal(Page(data, { path: ['a'] }).cards[0].includeInAll, false);
  const shared = Page(data, { path: ['b', 'shared'] }); assert.deepEqual(shared.path.map(p => p.id), ['b', 'shared']); assert.equal(shared.cards[0].id, 'leaf');
  data.playlists[0].childIds.push('leaf'); assert.equal(Page(data).cards[0].count, 3);
  data.playlists[0].childIds.pop(); assert.deepEqual(data, before);
});
test('999 root cards are paginated without losing order or constructing all card details', () => {
  const data = { settings: {}, playlists: Array.from({ length: 999 }, (_, n) => ({ id: `p${n}`, name: `${n}`, entries: [], childIds: [] })) };
  data.rootPlaylistIds = data.playlists.map(p => p.id);
  const ids = [];
  for (let page = 0; page < Math.ceil(999 / PAGE_SIZE); page++) {
    const view = Page(data, { page }); assert.ok(view.cards.length <= PAGE_SIZE); assert.equal(view.total, 999); ids.push(...view.cards.map(p => p.id));
  }
  assert.deepEqual(ids, data.rootPlaylistIds);
  assert.equal(Page(data, { page: 999 }).page, 41); assert.equal(Page(data, { page: NaN }).page, 0);
  assert.equal(Page(data, { page: -1 }).page, 0);
  for (const p of data.playlists.slice(PAGE_SIZE)) Object.defineProperty(p, 'icon', { get() { throw Error('off-page artwork was read'); } });
  assert.equal(Page(data).cards.length, PAGE_SIZE);
});
test('home validates every parent edge after move or deletion and clamps an obsolete page', () => {
  const data = Data(); data.playlists[0].childIds = ['empty'];
  const moved = Page(data, { path: ['a', 'shared', 'leaf'], page: 100 });
  assert.deepEqual(moved.path.map(p => p.id), ['a']); assert.deepEqual(moved.cards.map(p => p.id), ['empty']); assert.equal(moved.page, 0);
  data.rootPlaylistIds = ['b']; data.playlists = data.playlists.filter(p => p.id !== 'a');
  assert.deepEqual(Page(data, { path: ['a'] }).path, []);
  assert.deepEqual(Page({ playlists: [], rootPlaylistIds: [] }), { path: [], page: 0, pages: 1, total: 0, cards: [] });
});
test('home supports 999-level paths and bounds cyclic input without mutating it', () => {
  const data = { rootPlaylistIds: ['p0'], playlists: Array.from({ length: 999 }, (_, n) => ({ id: `p${n}`, name: `${n}`, entries: [], childIds: n < 998 ? [`p${n + 1}`] : [] })) };
  assert.equal(Page(data).cards[0].childCount, 1);
  assert.equal(Page(data, { path: data.playlists.map(p => p.id) }).path.length, 999);
  data.playlists[998].childIds = ['p997'];
  assert.equal(Page(data, { path: data.playlists.map(p => p.id) }).cards.length, 0);
});
test('home uses the existing sibling sort and playlist artwork without mixing song identities', () => {
  const data = Data(); data.settings.playlistSort = 'count-asc'; data.playlists[1].icon = 'data:image/png;base64,aWNvbg==';
  const view = Page(data); assert.deepEqual(view.cards.map(p => p.id), ['b', 'a']); assert.equal(view.cards[0].icon, data.playlists[1].icon);
  data.settings.playlistSort = 'manual'; assert.deepEqual(Page(data).cards.map(p => p.id), ['a', 'b']);
});
