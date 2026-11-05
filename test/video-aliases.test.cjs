'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Store } = require('../src/core/store.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');
const { DuplicateIndex } = require('../src/core/duplicates.cjs');
const { BilibiliDownloadSource } = require('../src/core/bilibili-download.cjs');
const { VideoAliases } = require('../src/core/library-identity.cjs');
const { AdditionReview } = require('../src/core/addition-review.cjs');
const pair = { aid: 123, bvid: 'BV1Q541167Qg' };
function Setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir), a = store.data.activePlaylistId;
  store.Apply({ type: 'add', playlistId: a, urls: 'av123' });
  store.Apply({ type: 'create', name: '別リスト' }); const b = store.data.activePlaylistId;
  store.Apply({ type: 'add', playlistId: b, urls: pair.bvid });
  store.Apply({ type: 'add', playlistId: b, urls: `https://www.bilibili.com/video/${pair.bvid}?p=2` });
  return { dir, store, a, b };
}
test('confirmed aliases persist, merge only matching parts, and preserve rows, titles and URLs', t => {
  const { dir, store, a, b } = Setup(t), before = structuredClone(store.data);
  const winner = store.Playlist(a).entries[0].mediaId;
  assert.notEqual(winner, store.Playlist(b).entries[0].mediaId);
  assert.equal(store.RememberVideo(ParseBilibili('av123'), pair), true);
  assert.equal(store.Playlist(b).entries[0].mediaId, winner);
  assert.notEqual(store.Playlist(b).entries[1].mediaId, winner);
  const rows = value => value.playlists.flatMap(p => p.entries).map(({ mediaId, ...e }) => e);
  assert.deepEqual(rows(store.data), rows(before));
  assert.deepEqual(new Store(dir).data, store.data);
  assert.deepEqual(store.data.videoAliases, [{ aid: '123', bvid: pair.bvid }]);
  store.Save = () => assert.fail('confirmed pair must not save repeatedly');
  assert.equal(store.RememberVideo(ParseBilibili(pair.bvid), pair), false);
});
test('known aliases drive duplicate review, additions and transfers after restart without a lookup', t => {
  const h = Setup(t); h.store.RememberVideo('av123', pair);
  const store = new Store(h.dir), av = store.Playlist(h.a).entries[0];
  const index = new DuplicateIndex([av], store.IdentityKey());
  assert.ok(index.Find({ ...ParseBilibili(pair.bvid), title: '違う曲名' }));
  store.Apply({ type: 'add', playlistId: h.a, urls: pair.bvid });
  assert.equal(store.Playlist(h.a).entries.length, 1);
  const result = store.Transfer({ playlistId: h.a, entryId: av.id, destinationIds: [h.b], mode: 'move' });
  assert.equal(result.skipped, 1); assert.equal(store.Playlist(h.a).entries.length, 0);
  assert.equal(store.Playlist(h.b).entries[0].mediaId, av.mediaId);
});
test('unrelated metadata and contradictory mappings never merge entries', t => {
  const { store } = Setup(t), original = store.Snapshot();
  for (const data of [{ bvid: pair.bvid }, { ...pair, aid: 456 }, { ...pair, aid: 123.5 }]) assert.equal(store.RememberVideo('av123', data), false);
  assert.deepEqual(store.Snapshot(), original);
  store.RememberVideo('av123', pair); const saved = store.Snapshot(), bytes = fs.readFileSync(store.file);
  assert.throws(() => store.RememberVideo('av456', { ...pair, aid: 456 }), /矛盾/);
  assert.deepEqual(store.Snapshot(), saved); assert.deepEqual(fs.readFileSync(store.file), bytes);
});
test('a review created before alias confirmation must be reviewed again even if its rows have not changed', async t => {
  const { store, a, b } = Setup(t);
  store.Apply({ type: 'remove', playlistId: b, entryId: store.Playlist(b).entries[0].id });
  const review = new AdditionReview(store);
  const plan = review.PrepareItems(a, [{ entry: { ...ParseBilibili(pair.bvid), title: '全く別の名前' } }]);
  assert.equal(plan.normalCount, 1);
  store.RememberVideo('av123', pair);
  await assert.rejects(review.Commit(plan.id), /確認中/);
  assert.equal(store.Playlist(a).entries.length, 1);
});
test('failed alias persistence restores the table and all original media IDs for retry', t => {
  const { store, dir } = Setup(t), before = store.Snapshot(), bytes = fs.readFileSync(store.file);
  const mock = t.mock.method(fs, 'renameSync', () => { throw new Error('disk full'); });
  try { assert.throws(() => store.RememberVideo('av123', pair), /disk full/); } finally { mock.mock.restore(); }
  assert.deepEqual(store.Snapshot(), before); assert.deepEqual(fs.readFileSync(store.file), bytes);
  assert.deepEqual(new Store(dir).data, before);
  assert.equal(store.RememberVideo('av123', pair), true);
});
test('identity schema 1 upgrades with a raw backup and no ID changes before confirmation', t => {
  const { store, dir } = Setup(t), old = structuredClone(store.data); old.identityVersion = 1; delete old.videoAliases;
  const bytes = Buffer.from(JSON.stringify(old)); fs.writeFileSync(store.file, bytes);
  const upgraded = new Store(dir), rows = x => x.playlists.flatMap(p => p.entries);
  assert.equal(upgraded.data.identityVersion, 2); assert.deepEqual(rows(upgraded.data), rows(old));
  const backup = fs.readdirSync(dir).find(n => n.startsWith('library.pre-0.6.7-'));
  assert.deepEqual(fs.readFileSync(path.join(dir, backup)), bytes);
});
test('malformed and conflicting saved aliases stop without replacing the library or backup', t => {
  const { store, dir } = Setup(t), data = structuredClone(store.data);
  for (const aliases of [[{ aid: '0', bvid: pair.bvid }], [pair], [{ aid: '123', bvid: pair.bvid }, { aid: '456', bvid: pair.bvid }]]) {
    data.videoAliases = aliases;
    const bytes = Buffer.from(JSON.stringify(data)); fs.writeFileSync(store.file, bytes);
    assert.throws(() => new Store(dir), e => e.identityDataInvalid);
    assert.deepEqual(fs.readFileSync(store.file), bytes);
  }
  assert.throws(() => VideoAliases({}));
});
test('real metadata adapter reports only verified pairs through the persistence callback', async t => {
  const { store } = Setup(t);
  const source = new BilibiliDownloadSource(async () => new Response(JSON.stringify({ code: 0, data: { ...pair, pic: 'https://i0.hdslb.com/test.png' } })), (entry, data) => store.RememberVideo(entry, data));
  await source.Cover(ParseBilibili('av123'), new AbortController().signal);
  assert.equal(store.data.videoAliases.length, 1);
  const wrong = new BilibiliDownloadSource(async () => new Response(JSON.stringify({ code: 0, data: { ...pair, aid: 456 } })), () => assert.fail('wrong video must not be reported'));
  await wrong.Cover(ParseBilibili('av123'), new AbortController().signal);
});
