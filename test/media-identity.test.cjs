'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ParseBilibili } = require('../src/core/urls.cjs');
const { VideoIdentity, MediaKey, DownloadIdentity, SameVideo } = require('../src/core/media-identity.cjs');
const { Key } = require('../src/core/offline-library.cjs');
const { BilibiliDownloadSource } = require('../src/core/bilibili-download.cjs');
const details = { aid: 123, bvid: 'BV1Q541167Qg' };

test('identity ignores names and URL tracking while retaining the selected part', () => {
  const entry = { ...ParseBilibili('https://m.bilibili.com/video/av123?p=2&spm_id_from=test#position'), title: '元の名前', id: 'first' };
  const before = structuredClone(entry), identity = VideoIdentity(entry);
  assert.equal(identity.part, 2);
  assert.equal(identity.key, MediaKey({ ...entry, title: '変更後', id: 'another', playlistId: 'other' }));
  assert.notEqual(identity.key, MediaKey(ParseBilibili('av123')));
  assert.equal(identity.key, MediaKey({ url: 'https://player.bilibili.com/player.html?aid=123&p=2', type: 'bilibili' }));
  assert.deepEqual(entry, before);
});

test('av and BV share an identity only with metadata matching the input video', () => {
  const av = VideoIdentity('av123'), bv = VideoIdentity(details.bvid);
  assert.notEqual(av.key, bv.key);
  assert.equal(VideoIdentity('av123', details).key, VideoIdentity(details.bvid, details).key);
  assert.equal(VideoIdentity('av123', details).verified, true);
  assert.equal(SameVideo('av123', details.bvid), false);
  assert.equal(SameVideo('av123', details.bvid, details), true);
  assert.equal(SameVideo('av456', details.bvid, details), false);
  assert.equal(SameVideo('https://www.bilibili.com/video/av123?p=2', details.bvid, details), false);
  const partTwo = VideoIdentity('https://www.bilibili.com/video/av123?p=2', details);
  assert.equal(partTwo.aliases.length, 2);
  assert.ok(partTwo.aliases.every(url => ParseBilibili(url).part === 2));
});

test('partial, invalid or imprecise metadata cannot invent an alias', () => {
  for (const data of [{ bvid: details.bvid }, { aid: 123 }, { ...details, aid: 123.5 }, { ...details, aid: 1e18 },
    { ...details, aid: '0123' }, { ...details, bvid: '../other' }, { ...details, aid: 456 }]) {
    assert.deepEqual(VideoIdentity('av123', data).aliases, [ParseBilibili('av123').url]);
  }
  assert.equal(VideoIdentity('av999999999999999999', { ...details, aid: '999999999999999999' }).verified, true);
});

test('download identity separates formats and preserves existing catalog hashes', () => {
  const url = ParseBilibili('av123').url;
  for (const kind of ['video', 'audio']) {
    const legacy = createHash('sha256').update(`${url}\n${kind}`).digest('hex');
    assert.equal(Key(url, kind), legacy);
    assert.equal(DownloadIdentity(url, kind).key, `${url}\n${kind}`);
  }
  assert.notEqual(Key(url, 'video'), Key(url, 'audio'));
  assert.equal(DownloadIdentity('av123', 'video', details).key, DownloadIdentity(details.bvid, 'video', details).key);
  assert.throws(() => DownloadIdentity(url, 'unknown'));
});

test('legacy local reference keys remain independent from display names', () => {
  assert.equal(MediaKey({ type: 'local', fileName: 'a.mp3', title: 'A' }), MediaKey({ type: 'local', fileName: 'a.mp3', title: 'B' }));
  assert.notEqual(MediaKey({ type: 'local', fileName: 'a.mp3' }), MediaKey({ type: 'local', fileName: 'b.mp3' }));
});

test('identity rejects unsupported hosts, credentials and invalid parts', () => {
  for (const url of ['https://evil.test/video/av123', 'https://name:secret@www.bilibili.com/video/av123',
    'https://www.bilibili.com/video/av123?p=0', 'https://www.bilibili.com/video/av123?p=1.5']) {
    assert.throws(() => VideoIdentity(url));
  }
});

test('download metadata uses the common verified alias rule without changing requested URL', async () => {
  for (const aid of [123, 456]) {
    const source = new BilibiliDownloadSource(async url => new Response(JSON.stringify({ code: 0, data:
      url.includes('/web-interface/view') ? { ...details, aid, pages: [{ page: 2, cid: 20, duration: 10 }] } :
        { dash: { audio: [{ id: 1, codecs: 'mp4a', bandwidth: 64000, baseUrl: 'https://a.bilivideo.com/audio' }] } }
    })));
    const entry = ParseBilibili('https://www.bilibili.com/video/av123?p=2');
    const plan = await source.Resolve(entry, 'audio', new AbortController().signal);
    assert.equal(plan.url, entry.url);
    assert.deepEqual(plan.aliases, VideoIdentity(entry, { ...details, aid }).aliases);
    assert.equal(plan.aliases.length, aid === 123 ? 2 : 1);
  }
});
