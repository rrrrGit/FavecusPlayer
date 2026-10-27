'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { AdditionReview } = require('../src/core/addition-review.cjs');
const { DuplicateIndex } = require('../src/core/duplicates.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');
const Entry = (title, id) => ({ title, ...ParseBilibili(`av${id}`) });
function Setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-add-045-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'data')), a = store.data.activePlaylistId;
  store.Apply({ type: 'create', name: 'A' }); const b = store.data.activePlaylistId;
  return { root, store, a, b, review: new AdditionReview(store, options) };
}
test('the supplied Natsunohi example identifies three candidates without matching Natsunohi Graph', () => {
  const index = new DuplicateIndex([Entry('ナツノヒ', 1)]);
  for (const title of ['双语字幕ナツノヒ - Nina77', 'ナツノヒ - Nina77', '「ナツノヒ」']) assert.ok(index.Find(Entry(title, 2)), title);
  for (const title of ['夢乃ゆき ナツノヒグラフ', 'ナツノヒグラフ', 'ナツノヒグラフ - Nina77']) assert.equal(index.Find(Entry(title, 2)), null, title);
  const artist = new DuplicateIndex([Entry('ナツノヒ - Nina77', 3)]);
  assert.equal(artist.Find(Entry('別の曲 - Nina77', 4)), null);
  assert.ok(new DuplicateIndex([Entry('SOME SONG', 5)]).Find(Entry('ｓｏｍｅ　ｓｏｎｇ', 6)));
  assert.equal(new DuplicateIndex([Entry('Summer song', 7)]).Find(Entry('Summer songbird', 8)), null);
});
test('review performs no writes; only checked duplicate rows are added per destination, including identical URLs', async t => {
  const { store, a, b, review } = Setup(t);
  store.Apply({ type: 'add', playlistId: a, urls: 'av1', title: 'ナツノヒ' }); const existing = store.Playlist(a).entries[0];
  const before = store.Snapshot(), bytes = fs.readFileSync(store.file);
  const plan = await review.Prepare({ type: 'add-videos', destinationIds: [a, b], videos: [Entry('別の表示名', 1), Entry('双语字幕ナツノヒ - Nina77', 2), Entry('夢乃ゆき ナツノヒグラフ', 3)] });
  assert.equal(plan.conflicts.length, 2); assert.equal(plan.normalCount, 4); assert.deepEqual(store.Snapshot(), before); assert.deepEqual(fs.readFileSync(store.file), bytes);
  const sameURL = plan.conflicts.find(row => row.reason.includes('URL'));
  const result = await review.Commit(plan.id, [sameURL.id]);
  assert.equal(result.added, 5); assert.equal(result.skipped, 1);
  assert.equal(store.Playlist(a).entries.length, 3); assert.equal(store.Playlist(b).entries.length, 3);
  assert.equal(store.Playlist(a).entries[0].id, existing.id); assert.equal(store.Playlist(a).entries[0].title, 'ナツノヒ');
  assert.equal(store.Playlist(a).entries[1].url, existing.url); assert.notEqual(store.Playlist(a).entries[1].id, existing.id);
  assert.deepEqual(new Store(store.directory).Snapshot(), store.Snapshot());
  await assert.rejects(() => review.Commit(plan.id, [sameURL.id]));
});
test('duplicates within the same input batch are individually reviewable and can intentionally share a URL', async t => {
  const { store, a, review } = Setup(t);
  const plan = await review.Prepare({ type: 'add-videos', destinationIds: [a], videos: [Entry('ナツノヒ', 1), Entry('ナツノヒ - Nina77', 2), Entry('ナツノヒ', 1)] });
  assert.equal(plan.normalCount, 1); assert.equal(plan.conflicts.length, 2); assert.equal(plan.conflicts[0].matches[0].origin, '今回一緒に追加する曲');
  const result = await review.Commit(plan.id, plan.conflicts.map(row => row.id)); assert.equal(result.added, 3);
  assert.equal(new Set(store.Playlist(a).entries.map(e => e.id)).size, 3);
});
test('cancelling, stale library changes, expired reviews and invalid checkboxes never add silently', async t => {
  let now = 0; const { store, a, review } = Setup(t, { now: () => now });
  const action = { type: 'add', destinationIds: [a], urls: 'av1', title: '曲' };
  let plan = await review.Prepare(action); review.Cancel(plan.id); await assert.rejects(() => review.Commit(plan.id)); assert.equal(store.Playlist(a).entries.length, 0);
  plan = await review.Prepare(action); await assert.rejects(() => review.Commit(plan.id, ['unreviewed'])); assert.equal(store.Playlist(a).entries.length, 0);
  store.Apply({ type: 'rename', playlistId: a, name: '新しい名前' }); await assert.rejects(() => review.Commit(plan.id), /変更/);
  plan = await review.Prepare(action); now = 31 * 60000; await assert.rejects(() => review.Commit(plan.id), /有効時間/);
  assert.equal(store.Playlist(a).entries.length, 0);
});
test('unrelated volume and display updates do not invalidate the review, and save failure rolls back the addition', async t => {
  const { store, a, review } = Setup(t);
  const plan = await review.Prepare({ type: 'add', destinationIds: [a], urls: 'av1', title: '曲' });
  store.Apply({ type: 'settings', settings: { volume: .5, thumbnailMode: true } });
  const before = store.Snapshot(), bytes = fs.readFileSync(store.file), save = store.Save;
  store.Save = () => { throw new Error('disk full'); }; await assert.rejects(() => review.Commit(plan.id), /disk full/); store.Save = save;
  assert.deepEqual(store.Snapshot(), before); assert.deepEqual(fs.readFileSync(store.file), bytes);
  assert.equal((await review.Commit(plan.id)).added, 1); assert.equal(store.data.settings.volume, .5);
});
test('file review does not copy until confirmed, shares bytes between destinations and cleans cancelled conversion', async t => {
  const { root, store, a, b, review } = Setup(t), file = path.join(root, 'ナツノヒ.mp3'); fs.writeFileSync(file, 'original');
  let plan = await review.PrepareFiles([a, b], [file]); assert.equal(fs.readdirSync(store.media).length, 0);
  await review.Commit(plan.id); assert.equal(fs.readdirSync(store.media).length, 1); assert.equal(store.Playlist(a).entries[0].fileName, store.Playlist(b).entries[0].fileName);
  plan = await review.PrepareFiles([a], [file]); assert.equal(plan.conflicts.length, 1); await review.Commit(plan.id, []); assert.equal(fs.readdirSync(store.media).length, 1);
  const wma = path.join(root, '新曲.wma'); fs.writeFileSync(wma, 'input'); let finish;
  store.options.convertWma = async (_source, target) => { fs.writeFileSync(target, 'partial'); await new Promise(resolve => { finish = resolve; }); };
  plan = await review.PrepareFiles([a], [wma]); const pending = review.Commit(plan.id); review.Cancel(plan.id); finish();
  await assert.rejects(() => pending, /取りやめ/); assert.equal(fs.readdirSync(store.media).length, 1); assert.equal(store.Playlist(a).entries.length, 1); assert.equal(fs.readFileSync(wma, 'utf8'), 'input');
});
test('URL-only additions resolve titles before comparison and report lookup failures honestly', async t => {
  const { store, a, review } = Setup(t, { resolveTitle: async entry => { if (entry.videoId === 'av3') throw new Error('offline'); return 'ナツノヒ - Nina77'; } });
  store.Apply({ type: 'add', playlistId: a, urls: 'av1', title: 'ナツノヒ' });
  const plan = await review.Prepare({ type: 'add', destinationIds: [a], urls: 'av2\nav3' });
  assert.equal(plan.conflicts.length, 1); assert.equal(plan.conflicts[0].title, 'ナツノヒ - Nina77'); assert.match(plan.warnings[0], /1曲.*URL/);
  const result = await review.Commit(plan.id, []); assert.equal(result.added, 1); assert.equal(store.Playlist(a).entries.at(-1).videoId, 'av3');
});
test('parts use distinct URLs and the combined capacity limit is enforced before committing', async t => {
  const { store, a, b, review } = Setup(t);
  store.Apply({ type: 'add', playlistId: a, urls: 'https://www.bilibili.com/video/av1/?p=1', title: '曲A' });
  let plan = await review.Prepare({ type: 'add-videos', destinationIds: [a], videos: [{ url: 'https://www.bilibili.com/video/av1/?p=2', title: '曲B' }] });
  assert.equal(plan.conflicts.length, 0); await review.Commit(plan.id);
  const first = store.Playlist(a).entries[0]; store.Playlist(a).entries = Array.from({ length: 9999 }, (_, index) => ({ ...first, id: String(index) }));
  plan = await review.Prepare({ type: 'add', destinationIds: [a, b], urls: 'av5', title: '新しい曲' });
  await assert.rejects(() => review.Commit(plan.id), /10000/); assert.equal(store.Playlist(b).entries.length, 0);
});
