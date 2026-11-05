'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Index, Page, PAGE_SIZE } = require('../src/ui/library-search.js');
function Data() {
  const song = (id, title, part = 1) => ({ id, title, type: 'bilibili', videoId: 'av123', part, url: `https://www.bilibili.com/video/av123/?p=${part}` });
  return { settings: {}, rootPlaylistIds: ['a', 'b'], playlists: [
    { id: 'a', name: '親A', childIds: ['shared'], includeInAll: false, entries: [song('a1', 'サクラの曲')] },
    { id: 'b', name: '親B', childIds: ['shared'], entries: [song('b1', 'サクラの曲')] },
    { id: 'shared', name: '共有の子', childIds: ['leaf'], entries: [song('s1', '別名の同じ動画'), song('s2', 'ＡＢＣ１２３', 2)] },
    { id: 'leaf', name: '孫', childIds: [], entries: [{ id: 'local', type: 'local', title: 'ローカルの曲', fileName: 'missing.mp3', missing: true }] }
  ] };
}
test('search includes excluded and collapsed descendants and keeps duplicate media memberships separate', () => {
  const data = Data(), before = structuredClone(data), index = Index(data), result = Page(index, 'av123');
  assert.equal(result.total, 4); assert.deepEqual(result.items.map(r => r.entry.id), ['a1', 's1', 's2', 'b1']);
  assert.deepEqual(result.items.map(r => r.playlistId), ['a', 'shared', 'shared', 'b']);
  assert.equal(result.items[1].pathText, 'ホーム ＞ 親A ＞ 共有の子');
  assert.equal(Page(index, 'ローカル').items[0].entry.missing, true); assert.deepEqual(data, before);
});
test('search normalizes width, case and kana and combines title, membership, URL and part terms', () => {
  const index = Index(Data());
  assert.equal(Page(index, 'abc123 p2').total, 1); assert.equal(Page(index, 'さくら 親B').items[0].entry.id, 'b1');
  assert.equal(Page(index, '孫 ローカル').items[0].entry.id, 'local'); assert.equal(Page(index, 'bilibili.com p2').items[0].entry.id, 's2');
  assert.equal(Page(index, '   ').total, 0); assert.equal(Page(index, '<script>').total, 0);
  const data = Data(); data.settings.playlistSort = 'name'; data.playlists[0].name = 'Zの親'; data.playlists[1].name = 'Aの親';
  assert.equal(Page(Index(data), 'abc123').items[0].pathText, 'ホーム ＞ Zの親 ＞ 共有の子');
});
test('search reaches all 10000 registrations with fixed-size pages and no media deduplication', () => {
  const data = { rootPlaylistIds: ['list'], playlists: [{ id: 'list', name: '大量', childIds: [], entries: Array.from({ length: 10000 }, (_, n) => ({ id: `entry${n}`, type: 'bilibili', title: `検索用${n}`, url: 'https://www.bilibili.com/video/av123/' })) }] };
  const index = Index(data), seen = [];
  for (let page = 0; page < 200; page++) { const result = Page(index, '検索用', page); assert.equal(result.items.length, PAGE_SIZE); assert.equal(result.total, 10000); seen.push(...result.items.map(r => r.entry.id)); }
  assert.equal(new Set(seen).size, 10000); assert.equal(seen.at(-1), 'entry9999');
  assert.equal(Page(index, '検索用', Infinity).page, 0); assert.equal(Page(index, '検索用', 999).page, 199); assert.equal(Page(index, '検索用9999', 199).page, 0);
});
test('search handles 999-level paths, shared graphs and cyclic or disconnected input without route explosion', () => {
  const data = { rootPlaylistIds: ['p0'], playlists: Array.from({ length: 999 }, (_, n) => ({ id: `p${n}`, name: `階層${n}`, childIds: n < 998 ? [`p${n + 1}`] : [], entries: n === 998 ? [{ id: 'last', title: '末端の曲', type: 'bilibili' }] : [] })) };
  const result = Page(Index(data), '末端'); assert.equal(result.total, 1); assert.match(result.items[0].pathText, /階層997 ＞ 階層998$/);
  for (let n = 0; n < 997; n++) data.playlists[n].childIds.push(`p${n + 2}`);
  data.playlists[998].childIds.push('p0'); assert.equal(Index(data).records.length, 1);
});
test('a new snapshot rebuilds membership paths after rename, move and deletion without retaining stale results', () => {
  const data = Data(), oldIndex = Index(data); data.playlists[0].name = '<b>改名</b>'; data.playlists[0].childIds = []; data.playlists[1].name = '移動先';
  const moved = Page(Index(data), 'abc123'); assert.equal(moved.items[0].pathText, 'ホーム ＞ 移動先 ＞ 共有の子');
  assert.equal(Page(oldIndex, '親A').total, 4);
  data.playlists[2].entries = []; assert.equal(Page(Index(data), 'abc123').total, 0);
});
