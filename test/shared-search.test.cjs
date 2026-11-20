'use strict';
// 検索の共通の処理（PC版の一覧とiPhone版が、同じ規則を使う）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const App = require('../src/core/library-app.cjs');

const entry = (id, title, extra = {}) => ({ id, type: 'bilibili', title, videoId: 'BV' + id, url: `https://www.bilibili.com/video/BV${id}`, part: 1, ...extra });
const library = playlists => JSON.stringify({ version: 3, playlists, settings: {} });
function make() {
  return library([
    { id: 'p1', name: 'お気に入りの歌', childIds: [], entries: [entry('a1', 'ＡＢＣのうた'), entry('a2', 'ひらがなカタカナ')] },
    { id: 'p2', name: 'Work', childIds: [], entries: [entry('b1', 'abc remix'), entry('b2', 'ヒラガナ')] }
  ]);
}

test('search ignores width, case and hiragana/katakana, and every space-separated word must match', () => {
  const text = make();
  const ids = query => App.Search({ text, query }).items.map(i => i.entryId).sort();
  assert.deepEqual(ids('abc'), ['a1', 'b1'], '全角・半角・大小を同一視');
  assert.deepEqual(ids('ひらがな'), ['a2', 'b2'], 'ひらがなとカタカナを同一視');
  assert.deepEqual(ids('abc remix'), ['b1'], '空白区切りは、すべてを含む');
  assert.deepEqual(ids('abc 歌'), ['a1'], '所属リストの経路も対象');
  assert.deepEqual(ids('   '), []);
});

test('search results are paged by 50 and report the total', () => {
  const entries = Array.from({ length: 120 }, (_, i) => entry('n' + i, '曲' + i));
  const text = library([{ id: 'p', name: 'L', childIds: [], entries }]);
  const first = App.Search({ text, query: '曲', page: 0 });
  assert.equal(first.total, 120); assert.equal(first.pages, 3); assert.equal(first.items.length, 50);
  const last = App.Search({ text, query: '曲', page: 2 });
  assert.equal(last.items.length, 20);
  assert.equal(App.Search({ text, query: '曲', page: 99 }).page, 2, '範囲外は最後のページ');
});

test('a broken library gives an error object instead of throwing', () => {
  assert.ok(App.Search({ text: '{', query: 'a' }).error);
});

test('search is exposed to the iPhone through the shared bundle and the runner', () => {
  const fs = require('node:fs'), path = require('node:path');
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-shared-bundle.cjs'), 'utf8');
  const runner = fs.readFileSync(path.join(__dirname, '..', 'shared', 'runtime', 'fixture-runner.js'), 'utf8');
  assert.match(bundle, /Search: function \(json\)/);
  assert.match(runner, /const Search = json =>/);
});
