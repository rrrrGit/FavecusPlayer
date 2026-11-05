'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Store } = require('../src/core/store.cjs');
const { OfflineLibrary } = require('../src/core/offline-library.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const entry = (id = 'av123', part = 1) => ParseBilibili(`https://www.bilibili.com/video/${id}?p=${part}`);
function Fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-shared-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'data')), first = store.data.activePlaylistId;
  store.Apply({ type: 'create', name: '子', parentId: first }); const child = store.data.activePlaylistId;
  store.Apply({ type: 'add', destinationIds: [first, child], urls: 'av123' });
  const count = { resolve: 0, transfer: 0, thumbnail: 0 };
  const options = { directory: path.join(root, 'downloads'), settingsFile: path.join(root, 'settings.json'), ffmpeg: process.execPath, libraryData: () => store.data,
    resolve: async (e, kind, _signal, { height }) => { count.resolve++; return { url: e.url, kind, height, duration: 10, streams: [{}], thumbnailURL: 'https://i0.hdslb.com/cover.png' }; },
    transfer: async (_fetch, _stream, file) => { count.transfer++; fs.writeFileSync(file, 'stream'); return 6; },
    assemble: async (_exe, _plan, _files, output) => { fs.writeFileSync(output, 'playable'); return 10; },
    thumbnail: async () => { count.thumbnail++; return PNG; }, ...overrides };
  return { root, store, first, child, count, options, library: new OfflineLibrary(options) };
}
async function Save(h, entries = [entry()], kind = 'video', extra = {}) {
  h.library.Start(entries, { kind, playlistId: h.first, playlistName: '親', ...extra }); await h.library.done;
  assert.equal(h.library.job.status, 'completed', JSON.stringify(h.library.job.failures));
}
test('video, audio and one shared cover use a video-and-part folder independent from list names', async t => {
  const h = Fixture(t); await Save(h); await Save(h, [entry()], 'audio');
  const video = h.library.Find(entry(), 'video', true), audio = h.library.Find(entry(), 'audio', true);
  assert.equal(video.layout, 4); assert.equal(audio.layout, 4);
  assert.equal(path.dirname(video.file), 'media/av123-p1'); assert.equal(path.dirname(audio.file), path.dirname(video.file));
  assert.equal(video.thumbnail.file, audio.thumbnail.file); assert.equal(h.count.thumbnail, 1); assert.equal(h.count.transfer, 2);
  assert.notEqual(video.token, audio.token); assert.equal(h.library.Cover(audio.token), PNG);
});
test('renames, reparenting, membership removal and subsequent saves keep shared files in place', async t => {
  const h = Fixture(t); await Save(h);
  const saved = h.library.Find(entry()), cover = saved.thumbnail.file;
  const row = h.store.Playlist(h.first).entries[0];
  h.store.Apply({ type: 'title', playlistId: h.first, entryId: row.id, title: '別の曲名' });
  h.store.Apply({ type: 'rename', playlistId: h.first, name: '別の親名' });
  h.store.Apply({ type: 'playlist-move', playlistId: h.child, parentId: null });
  h.store.Apply({ type: 'remove', playlistId: h.first, entryId: row.id });
  await h.library.ReconcileLayout(h.store.data); await h.library.Organize();
  await Save(h, h.store.Playlist(h.child).entries, 'video', { playlistId: h.child, playlistName: '子' });
  assert.equal(h.library.Find(entry()).file, saved.file); assert.equal(h.library.Find(entry()).thumbnail.file, cover);
  assert.equal(h.count.transfer, 1); assert.equal(h.count.resolve, 1); assert.equal(h.library.job.skipped, 1);
});
test('restart reuses shared files and covers without network or reorganisation', async t => {
  const h = Fixture(t); await Save(h); const before = fs.readFileSync(path.join(h.library.directory, 'index.json'));
  const saved = h.library.Find(entry()).file;
  h.library = new OfflineLibrary({ ...h.options, resolve: () => assert.fail('must not resolve saved media'), thumbnail: () => assert.fail('must not fetch saved cover') });
  await h.library.Organize(); await Save(h);
  assert.equal(h.library.Find(entry()).file, saved); assert.deepEqual(fs.readFileSync(path.join(h.library.directory, 'index.json')), before);
});
test('different parts remain in separate folders and tracking variants download only once', async t => {
  const h = Fixture(t), original = entry();
  await Save(h, [original, { ...original, url: original.url + '?spm_id_from=test' }, entry('av123', 2)]);
  assert.equal(h.library.job.total, 2); assert.equal(h.count.transfer, 2);
  assert.notEqual(path.dirname(h.library.Find(original).file), path.dirname(h.library.Find(entry('av123', 2)).file));
  assert.equal(path.dirname(h.library.Find(entry('av123', 2)).file), 'media/av123-p2');
});
test('later AV/BV confirmation keeps the saved folder and resolves both formats and availability', async t => {
  const h = Fixture(t); await Save(h); const saved = h.library.Find(entry()), bv = entry('BV1Q541167Qg');
  h.store.RememberVideo(entry(), { aid: 123, bvid: bv.videoId });
  h.library = new OfflineLibrary(h.options);
  assert.equal(h.library.Find(bv).file, saved.file);
  assert.ok(h.library.Snapshot().available.some(r => r.url === bv.url && r.kind === 'video'));
  await Save(h, [bv]); assert.equal(h.count.transfer, 1);
  await Save(h, [bv], 'audio'); assert.equal(path.dirname(h.library.Find(bv, 'audio', true).file), path.dirname(saved.file));
  assert.equal(h.count.thumbnail, 1);
});
test('overlapping alias sets serialize real transfers rather than relying on identical alias arrays', async t => {
  let release, started, transferCount = 0;
  const held = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; }); t.after(release);
  const av = entry(), bv = entry('BV1Q541167Qg');
  const h = Fixture(t, { libraryData: () => null,
    resolve: async (e, kind) => ({ url: e.url, kind, height: 720, duration: 10, streams: [{}], aliases: e.videoId === av.videoId ? [bv.url] : [], thumbnailURL: 'https://i0.hdslb.com/cover.png' }),
    transfer: async (_f, _s, file) => { transferCount++; started(); await held; fs.writeFileSync(file, 'raw'); return 3; } });
  h.library.Start([av, bv], { kind: 'video', playlistId: h.first }); await ready;
  assert.equal(transferCount, 1); assert.throws(() => h.library.Start([av], { kind: 'video' }), /進行中/);
  release(); await h.library.done;
  assert.equal(h.library.job.status, 'completed'); assert.equal(transferCount, 1);
  assert.equal(h.library.job.completed, 1); assert.equal(h.library.job.skipped, 1); assert.equal(h.library.records.size, 1);
  assert.equal(h.library.Find(av).file, h.library.Find(bv).file);
});
test('a failed first alias worker releases its lock so a waiting worker can save and retry safely', async t => {
  let attempts = 0; const bv = entry('BV1Q541167Qg');
  const h = Fixture(t, { libraryData: () => null,
    resolve: async (e, kind) => ({ url: e.url, kind, height: 720, duration: 10, streams: [{}], aliases: e.videoId === 'av123' ? [bv.url] : [], thumbnailURL: 'https://i0.hdslb.com/cover.png' }),
    assemble: async (_e, _p, _f, output) => { if (++attempts === 1) throw new Error('format failed'); fs.writeFileSync(output, 'playable'); return 10; } });
  h.library.Start([entry(), bv], { kind: 'video' }); await h.library.done;
  assert.equal(h.library.job.status, 'partial'); assert.equal(h.library.job.failed, 1); assert.equal(h.library.job.completed, 1);
  assert.equal(h.library.records.size, 1); assert.equal(fs.readdirSync(path.join(h.library.directory, '.partial')).length, 0);
});
test('failed catalog update never deletes a cover still used by a saved format', async t => {
  const h = Fixture(t); await Save(h); const video = h.library.Find(entry()), before = fs.readFileSync(path.join(h.library.directory, 'index.json'));
  const commit = h.library.CommitRecord;
  h.library.CommitRecord = r => { if (r.kind === 'audio') throw new Error('disk full'); return commit.call(h.library, r); };
  h.library.Start([entry()], { kind: 'audio' }); await h.library.done;
  assert.equal(h.library.job.status, 'partial'); assert.equal(h.library.records.size, 1);
  assert.equal(h.library.Cover(video.token), PNG); assert.deepEqual(fs.readFileSync(path.join(h.library.directory, 'index.json')), before);
  assert.equal(fs.readdirSync(path.dirname(video.path)).filter(n => /\.(mp4|m4a)$/.test(n)).length, 1);
  h.library.CommitRecord = commit; await Save(h, [entry()], 'audio'); assert.equal(h.count.thumbnail, 1);
});
test('quality replacement keeps the folder, the other format and their shared cover', async t => {
  const h = Fixture(t); await Save(h); await Save(h, [entry()], 'audio');
  const before = h.library.Find(entry(), 'video', true), audio = h.library.Find(entry(), 'audio', true);
  await Save(h, [entry()], 'video', { height: 1080 });
  const after = h.library.Find(entry(), 'video', true);
  assert.equal(path.dirname(after.file), path.dirname(before.file)); assert.notEqual(after.file, before.file); assert.equal(fs.existsSync(before.path), false);
  assert.equal(h.library.Find(entry(), 'audio', true).file, audio.file); assert.equal(h.library.Cover(audio.token), PNG); assert.equal(h.count.thumbnail, 1);
});
test('a pair confirmed before the first save chooses a canonical folder while parts remain separate', async t => {
  const h = Fixture(t), bv = entry('BV1Q541167Qg'); h.store.RememberVideo(entry(), { aid: 123, bvid: bv.videoId });
  await Save(h, [entry(), entry('av123', 2)]);
  assert.equal(path.dirname(h.library.Find(bv).file), 'media/BV1Q541167Qg-p1');
  assert.equal(path.dirname(h.library.Find(entry('BV1Q541167Qg', 2)).file), 'media/BV1Q541167Qg-p2');
});
test('quality replacement through the other video notation preserves the original catalog token', async t => {
  const h = Fixture(t); await Save(h); const old = h.library.Find(entry());
  h.store.RememberVideo(entry(), { aid: 123, bvid: 'BV1Q541167Qg' });
  const bv = entry('BV1Q541167Qg'); await Save(h, [bv], 'video', { height: 1080 });
  assert.equal(h.library.records.size, 1); assert.equal(h.library.Find(bv).token, old.token);
  assert.equal(h.library.Find(entry()).height, 1080); assert.equal(fs.existsSync(old.path), false);
  const restarted = new OfflineLibrary(h.options);
  assert.equal(restarted.indexError, ''); assert.equal(restarted.Find(bv).token, old.token); assert.equal(restarted.Cover(bv), PNG);
});
test('a conflicting destination file is left untouched when an exclusive media copy fails', async t => {
  const h = Fixture(t), relative = 'media/av123-p1/existing.mp4', file = h.library.ResolvePath(relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'keep unmanaged bytes');
  h.library.TrackPath = () => relative;
  h.library.Start([entry()], { kind: 'video' }); await h.library.done;
  assert.equal(h.library.job.status, 'partial'); assert.equal(fs.readFileSync(file, 'utf8'), 'keep unmanaged bytes'); assert.equal(h.library.records.size, 0);
});
test('an alias for a different part is rejected before transferring any media', async t => {
  const h = Fixture(t, { resolve: async (e, kind) => ({ url: e.url, kind, streams: [{}], aliases: [entry('av123', 2).url] }) });
  h.library.Start([entry()], { kind: 'video' }); await h.library.done;
  assert.equal(h.library.job.status, 'partial'); assert.equal(h.count.transfer, 0); assert.equal(h.library.records.size, 0);
});
test('cancelling an aliased save drains waiting workers without starting a second transfer', async t => {
  let started, calls = 0; const ready = new Promise(resolve => { started = resolve; }), bv = entry('BV1Q541167Qg');
  const h = Fixture(t, { libraryData: () => null,
    resolve: async (e, kind) => ({ url: e.url, kind, streams: [{}], aliases: e.videoId === 'av123' ? [bv.url] : [] }),
    transfer: async (_f, _s, _file, _url, signal) => {
      calls++; started(); await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); if (signal.aborted) reject(signal.reason); });
    } });
  h.library.Start([entry(), bv], { kind: 'video' }); await ready; h.library.Cancel(); await h.library.done;
  assert.equal(calls, 1); assert.equal(h.library.job.status, 'cancelled'); assert.equal(h.library.controller, null); assert.equal(h.library.records.size, 0);
  assert.deepEqual(fs.readdirSync(path.join(h.library.directory, '.partial')), []);
});
