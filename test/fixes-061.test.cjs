'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DownloadFetch } = require('../src/core/download-fetch.cjs');
const { OfflineLibrary } = require('../src/core/offline-library.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');
const { BuildActivity } = require('../src/core/discord.cjs');
const tree = require('../src/ui/library-tree.js');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('download transport avoids the Chromium fetch path and scopes login cookies to API requests', async () => {
  const calls = [], cookieCalls = [];
  const session = { fetch: () => assert.fail('blocked Chromium transport must not be used'), getUserAgent: () => 'test-agent', cookies: { get: async request => { cookieCalls.push(request); return [{ name: 'session', value: 'private' }]; } } };
  const fetch = DownloadFetch(session, async (url, options) => { calls.push({ url, options }); return new Response('data'); });
  await fetch('https://api.bilibili.com/x/player/playurl?cid=1', { credentials: 'include', headers: { Referer: 'https://www.bilibili.com/' }, redirect: 'error' });
  assert.equal(calls[0].options.headers.get('cookie'), 'session=private'); assert.equal(calls[0].options.headers.get('referer'), 'https://www.bilibili.com/');
  for (const url of ['https://a.bilivideo.com/file.m4s', 'https://i0.hdslb.com/cover.jpg']) await fetch(url, { credentials: 'include', headers: { Cookie: 'must-not-forward', Authorization: 'must-not-forward' } });
  assert.equal(cookieCalls.length, 1);
  for (const call of calls.slice(1)) { assert.equal(call.options.headers.has('cookie'), false); assert.equal(call.options.headers.has('authorization'), false); assert.equal(call.options.redirect, 'manual'); }
  for (const url of ['https://evil.test/file', 'https://api.bilibili.com/unknown', 'https://user:pass@api.bilibili.com/x/player/playurl']) await assert.rejects(fetch(url));
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(fetch('https://api.bilibili.com/x/player/playurl', { signal: aborted.signal })); assert.equal(calls.length, 3);
});

function Manager(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-061-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let mediaTransfers = 0, covers = 0;
  const options = { directory: path.join(root, 'downloads'), settingsFile: path.join(root, 'settings.json'), ffmpeg: process.execPath,
    resolve: async (entry, kind) => ({ kind, url: entry.url, aliases: [ParseBilibili('BV1Q541167Qg').url], thumbnailURL: 'https://i0.hdslb.com/cover.png', height: 720, streams: [{}] }),
    transfer: async (_fetch, _stream, target) => { mediaTransfers++; fs.writeFileSync(target, 'input'); return 5; },
    assemble: async (_exe, _plan, _files, target) => { fs.writeFileSync(target, 'complete media'); return 100; },
    thumbnail: async () => { covers++; return PNG; }, cover: async () => 'https://i0.hdslb.com/cover.png', ...extra };
  return { root, options, library: new OfflineLibrary(options), mediaTransfers: () => mediaTransfers, covers: () => covers };
}
const save = async (library, kind = 'video') => { library.Start([ParseBilibili('av123')], { kind, playlistId: 'p', playlistName: 'リスト' }); await library.done; };
test('media and cover survive restart and play from saved files for AV and BV aliases without fetching', async t => {
  const h = Manager(t); await save(h.library); const media = h.library.Find(ParseBilibili('av123'));
  assert.equal(h.library.Cover(media.token), PNG); assert.ok(fs.existsSync(h.library.ResolvePath(media.thumbnail.file))); assert.equal(h.mediaTransfers(), 1);
  const restarted = new OfflineLibrary({ ...h.options, fetch: () => assert.fail('offline playback must not fetch') });
  assert.equal(restarted.Find(ParseBilibili('BV1Q541167Qg')).token, media.token); assert.equal(restarted.Cover(ParseBilibili('BV1Q541167Qg')), PNG);
  await save(restarted); assert.equal(restarted.job.skipped, 1); assert.equal(h.mediaTransfers(), 1); assert.equal(h.covers(), 1);
  await save(restarted, 'audio'); assert.equal(restarted.Find(ParseBilibili('av123'), 'audio').kind, 'audio'); assert.equal(restarted.Cover(ParseBilibili('av123')), PNG);
});
test('old downloads can acquire only the missing cover and image failure does not discard playable media', async t => {
  let fail = true; const h = Manager(t, { thumbnail: async () => { if (fail) throw new Error('offline'); return PNG; } });
  await save(h.library); assert.equal(h.library.job.completed, 1); assert.equal(h.library.job.thumbnailFailed, 1); assert.equal(h.library.Cover(ParseBilibili('av123')), null);
  const saved = h.library.Find(ParseBilibili('av123')); fail = false;
  await save(h.library); assert.equal(h.library.job.skipped, 1); assert.equal(h.library.Cover(saved.token), PNG); assert.equal(h.mediaTransfers(), 1);
  const cover = h.library.Find(ParseBilibili('av123')).thumbnail; fs.writeFileSync(h.library.ResolvePath(cover.file), 'broken');
  await save(h.library); assert.equal(h.library.Cover(saved.token), PNG); assert.equal(h.mediaTransfers(), 1);
  const index = path.join(h.library.directory, 'index.json'), record = JSON.parse(fs.readFileSync(index)); record.files[0].thumbnail.file = '../outside.png'; fs.writeFileSync(index, JSON.stringify(record));
  const restarted = new OfflineLibrary(h.options); assert.ok(restarted.Find(ParseBilibili('av123'))); assert.equal(restarted.Cover(saved.token), null);
});
test('all-playlists manual order follows the hierarchy and includes excluded, empty and shared lists exactly once', () => {
  const make = (id, childIds = [], includeInAll = true) => ({ id, name: id, childIds, includeInAll, entries: [] });
  const data = { playlists: [make('お気に入り'), make('流星ワールドアクター'), make('サクラノ刻'), make('ケロQ・枕', ['サクラノ刻'], false), make('EroGameSongs', ['ケロQ・枕', '流星ワールドアクター']), make('共有', ['サクラノ刻']), make('未接続')], rootPlaylistIds: ['お気に入り', 'EroGameSongs', '共有'], settings: { playlistSort: 'manual' } };
  assert.deepEqual(tree.AllLists(data), ['お気に入り', 'EroGameSongs', 'ケロQ・枕', 'サクラノ刻', '流星ワールドアクター', '共有', '未接続']);
  assert.equal(new Set(tree.AllLists(data)).size, data.playlists.length);
  data.settings.playlistSort = 'name'; assert.deepEqual(tree.AllLists(data), tree.Ordered(data, data.playlists.map(p => p.id)));
});
test('Discord retains the app icon and emits public thumbnail and selected-part links separately', () => {
  const media = { source: 'bilibili', title: '曲', paused: false, duration: 100, position: 5, thumbnailURL: 'https://i0.hdslb.com/cover.jpg', videoURL: 'https://www.bilibili.com/video/av123/?p=2&tracking=private' };
  const result = BuildActivity(media, false, Date.now(), 'original_icon');
  assert.equal(result.assets.large_image, 'original_icon'); assert.equal(result.assets.small_image, media.thumbnailURL);
  assert.equal(result.assets.small_url, 'https://www.bilibili.com/video/av123/?p=2');
  for (const removed of [result.details_url, result.buttons, result.assets.large_url]) assert.equal(removed, undefined);
  const local = BuildActivity({ ...media, source: 'local', thumbnailURL: 'file:///private/cover.png' }, false); assert.equal(local.buttons, undefined); assert.equal(local.details_url, undefined); assert.equal(local.assets.small_image, undefined);
});
