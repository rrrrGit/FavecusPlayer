'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { spawnSync } = require('node:child_process');
const { OfflineLibrary } = require('../src/core/offline-library.cjs');
const { EstimateDownloads, DownloadSelection, PlanBytes, JobTiming } = require('../src/core/download-estimate.cjs');
const { Store, ValidateSettings } = require('../src/core/store.cjs');
const { LibraryArchive } = require('../src/core/library-archive.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');
const { WriteZip, ZipReader } = require('../src/core/zip.cjs');
const { ReadDownloads } = require('../src/core/offline-archive.cjs');
const { BuildActivity } = require('../src/core/discord.cjs');
const { Repository, ReleaseURL, CheckRelease } = require('../src/core/releases.cjs');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const entry = n => ({ ...ParseBilibili(`av${n}`), title: `楽曲${n}` });
function Temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-062-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function Offline(root, extra = {}) { return new OfflineLibrary({ directory: path.join(root, 'downloads'), settingsFile: path.join(root, 'settings.json'), ffmpeg: process.execPath,
  resolve: async (e, kind) => ({ kind, url: e.url, height: 720, duration: 120, streams: [{ size: 10000 }], thumbnailURL: 'https://i0.hdslb.com/cover.png' }),
  transfer: async (_fetch, _stream, target, _url, _signal, progress) => { fs.writeFileSync(target, 'stream'); progress(6, 6); return 6; },
  assemble: async (_exe, _plan, _files, target) => { fs.writeFileSync(target, 'playable fixture'); return 120; }, thumbnail: async () => PNG, ...extra }); }
async function Save(library, entries, playlistId = 'test', kind = 'video') { library.Start(entries, { playlistId, playlistName: '音楽', kind }); await library.done; assert.equal(library.job.failed, 0); }
test('capacity uses all streams, bitrate fallback and temporary-file headroom; estimation never transfers media', async t => {
  const root = Temp(t), entries = [entry(123), entry(456)]; let calls = 0;
  assert.equal(PlanBytes({ duration: 10, streams: [{ size: 100 }, { bandwidth: 800 }] }), 1100);
  assert.equal(PlanBytes({ duration: 10, streams: [{}] }), null);
  const estimate = await EstimateDownloads(entries, { kind: 'video', height: 720 }, { directory: root, cached: () => null, cover: () => null, signal: new AbortController().signal, pause: async () => {}, resolve: async () => { calls++; return { streams: [{ size: 1000 }, { size: 400 }], thumbnailURL: 'cover' }; } });
  assert.equal(calls, 2); assert.equal(estimate.total, 2); assert.equal(estimate.downloadBytes, 2800 + 2 * 256 * 1024); assert.ok(estimate.requiredBytes > estimate.fileBytes); assert.ok(estimate.freeBytes > 0); assert.ok(estimate.secondsMax >= estimate.secondsMin); assert.deepEqual(fs.readdirSync(root), []);
  const library = Offline(root, { transfer: () => assert.fail('estimate transferred media') }); const first = await library.Estimate([entries[0]], { kind: 'video', playlistId: 'a' });
  assert.equal(library.records.size, 0); assert.equal(fs.existsSync(library.directory), false);
  assert.throws(() => library.Start([entries[1]], { kind: 'video', estimateId: first.id }), /再計算/);
  library.estimate.createdAt -= 600001; assert.throws(() => library.Start([entries[0]], { kind: 'video', estimateId: first.id }), /再計算/);
  assert.equal(DownloadSelection([entry(1), entry(1), { type: 'local' }], { kind: 'audio' }).length, 1);
});
test('cached media, missing sizes, limits and cancellation cannot become a false zero-size estimate', async t => {
  const root = Temp(t), signal = new AbortController().signal;
  const dependencies = { directory: root, signal, pause: async () => {}, cached: () => null, cover: () => null, resolve: async () => ({ streams: [{}] }) };
  const unknown = await EstimateDownloads([entry(1)], { kind: 'audio' }, dependencies); assert.equal(unknown.unknown, 1); assert.equal(unknown.secondsMax, null);
  const cached = await EstimateDownloads([entry(1)], { kind: 'audio' }, { ...dependencies, cached: () => ({ token: 'saved' }), cover: () => PNG, resolve: () => assert.fail() }); assert.equal(cached.skipped, 1); assert.equal(cached.requiredBytes, 0);
  const limited = Object.assign(new Error('limit'), { stopBatch: true }); let calls = 0;
  await assert.rejects(EstimateDownloads([entry(1), entry(2)], { kind: 'audio' }, { ...dependencies, resolve: async () => { calls++; throw limited; } }), /limit/); assert.equal(calls, 1);
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(EstimateDownloads([entry(1)], { kind: 'audio' }, { ...dependencies, signal: aborted.signal }));
});
test('whole-download timing uses bytes across tracks and freezes elapsed time after completion', async t => {
  const root = Temp(t), library = Offline(root); await Save(library, [entry(1), entry(2)]); assert.equal(library.job.downloadedBytes, 12);
  const job = { status: 'running', total: 3, finished: 1, startedAt: 1000, downloadedBytes: 200000, estimate: { downloadBytes: 600000, unknown: 0 } };
  const progress = JobTiming(job, 11000); assert.equal(progress.elapsedSeconds, 10); assert.equal(progress.remainingSeconds, 26);
  assert.equal(JobTiming({ ...job, status: 'completed', endedAt: 21000 }, 100000).elapsedSeconds, 20);
});
test('new media keeps both formats and covers in a song folder; old layout migration preserves bytes and survives restart', async t => {
  const root = Temp(t), library = Offline(root); await Save(library, [entry(123)]); await Save(library, [entry(123)], 'test', 'audio');
  const video = library.Find(entry(123), 'video'), audio = library.Find(entry(123), 'audio'); assert.equal(path.dirname(video.file), path.dirname(audio.file)); assert.equal(video.file.split('/').length, 3); assert.equal(path.dirname(video.thumbnail.file), path.dirname(video.file));
  const oldFile = 'old/saved-song.mp4', oldCover = 'old/saved-song.thumbnail.png'; fs.mkdirSync(path.join(library.directory, 'old')); fs.copyFileSync(video.path, library.ResolvePath(oldFile)); fs.copyFileSync(library.ResolvePath(video.thumbnail.file), library.ResolvePath(oldCover));
  library.CommitRecord({ ...video, layout: undefined, file: oldFile, thumbnail: { ...video.thumbnail, file: oldCover } });
  await library.Organize(); const moved = library.Find(entry(123), 'video'); assert.equal(moved.layout, 2); assert.equal(fs.readFileSync(moved.path, 'utf8'), 'playable fixture'); assert.equal(library.Cover(moved.token), PNG); assert.equal(fs.existsSync(library.ResolvePath(oldFile)), false);
  const restarted = Offline(root); assert.equal(restarted.Find(entry(123)).file, moved.file); const before = fs.readFileSync(path.join(library.directory, 'index.json'), 'utf8'); await restarted.Organize(); assert.equal(fs.readFileSync(path.join(library.directory, 'index.json'), 'utf8'), before);
});
async function ArchiveFixture(t) {
  const root = Temp(t), from = new Store(path.join(root, 'source')), offline = Offline(path.join(root, 'source')), first = from.data.activePlaylistId;
  from.Apply({ type: 'add', playlistId: first, urls: 'av123' }); from.Apply({ type: 'create', name: '別リスト' }); const second = from.data.activePlaylistId; from.Apply({ type: 'add', playlistId: second, urls: 'av456' });
  await Save(offline, from.Playlist(first).entries, first); await Save(offline, from.Playlist(first).entries, first, 'audio'); await Save(offline, from.Playlist(second).entries, second);
  const file = path.join(root, 'backup.zip'); const exported = await new LibraryArchive(from, offline).Export(file); assert.equal(exported.downloaded, 3);
  const to = new Store(path.join(root, 'target')), target = Offline(path.join(root, 'target')); return { root, from, first, second, file, to, target, archive: new LibraryArchive(to, target) };
}
test('playlist ZIP restores only selected saved video, audio and cover with unused playlist IDs preserved and no downloads', async t => {
  const h = await ArchiveFixture(t), plan = await h.archive.Prepare(h.file); assert.equal(plan.playlists.find(p => p.id === h.first).downloaded, 2);
  const result = await h.archive.Commit(plan.id, [h.first]); assert.equal(result.downloaded, 2); assert.equal(result.imported, 1); assert.equal(h.target.records.size, 2); assert.equal(h.target.Find(entry(456)), null);
  assert.equal(h.target.Cover(entry(123)), PNG); assert.equal(fs.readFileSync(h.target.Find(entry(123)).path, 'utf8'), 'playable fixture'); assert.equal(result.state.activePlaylistId, h.first);
  const restarted = Offline(path.join(h.root, 'target')); assert.equal(restarted.Find(entry(123), 'audio').kind, 'audio'); assert.equal(restarted.Cover(entry(123)), PNG);
  const again = await h.archive.Prepare(h.file); const repeated = await h.archive.Commit(again.id, [h.first]); assert.equal(repeated.downloaded, 0); assert.equal(h.target.records.size, 2);
});
test('failed selected import rolls back the download index and all copied media without replacing existing data', async t => {
  const h = await ArchiveFixture(t), plan = await h.archive.Prepare(h.file), before = h.to.Snapshot(); h.to.Save = () => { throw new Error('disk failure'); };
  await assert.rejects(h.archive.Commit(plan.id, [h.first]), /disk failure/); assert.deepEqual(h.to.Snapshot(), before); assert.equal(h.target.records.size, 0); assert.equal(fs.existsSync(path.join(h.target.directory, 'index.json')), false); assert.equal(h.target.importing, false);
  const files = fs.readdirSync(h.target.directory, { recursive: true }).filter(f => /\.(mp4|m4a|png)$/.test(f)); assert.equal(files.length, 0);
});
test('download manifests reject traversal, byte mismatches and unsafe covers before extracting media', async t => {
  const h = await ArchiveFixture(t), zip = await new ZipReader().Open(h.file); t.after(() => zip.Close());
  const records = JSON.parse((await zip.Content('downloads/catalog.json')).toString()); records.files[0].media = '../escape';
  const fake = { entries: zip.entries, Content: async () => Buffer.from(JSON.stringify(records)) }; await assert.rejects(ReadDownloads(fake), /参照/);
});
test('ZIP64 output interoperates with a separate reader and rejects broken ZIP64 locators', async t => {
  const root = Temp(t), file = path.join(root, 'wide.zip'); await WriteZip(file, [{ name: 'media/song.mp4', data: Buffer.from('abc') }], { forceZip64: true });
  const zip = await new ZipReader().Open(file); assert.equal((await zip.Content('media/song.mp4')).toString(), 'abc'); await zip.Close();
  const read = spawnSync('python3', ['-c', "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;assert z.read('media/song.mp4')==b'abc'", file], { encoding: 'utf8' }); assert.equal(read.status, 0, read.stderr);
  const bytes = fs.readFileSync(file), at = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07])); bytes.writeUInt32LE(2, at + 16); fs.writeFileSync(file, bytes); await assert.rejects(new ZipReader().Open(file), /分割ZIP/);
});
test('Discord links only the song image for either supported size and leaves application identity unchanged', () => {
  const media = { source: 'bilibili', title: '曲', videoURL: entry(123).url, thumbnailURL: 'https://i0.hdslb.com/cover.png' };
  for (const size of ['small', 'large']) {
    const result = BuildActivity(media, false, Date.now(), 'original_icon', size), opposite = size === 'small' ? 'large' : 'small';
    assert.equal(result.assets[`${size}_image`], media.thumbnailURL); assert.equal(result.assets[`${opposite}_image`], 'original_icon'); assert.equal(result.assets[`${size}_url`], media.videoURL); assert.equal(result.assets[`${opposite}_url`], undefined); assert.equal(result.details_url, undefined); assert.equal(result.buttons, undefined); assert.equal(result.url, undefined);
  }
  assert.equal(BuildActivity({ ...media, thumbnailURL: null }, false).assets.small_url, undefined);
  assert.equal(ValidateSettings({ discordThumbnailSize: 'large' }).discordThumbnailSize, 'large'); assert.equal(ValidateSettings({ discordThumbnailSize: 'invalid' }).discordThumbnailSize, 'small');
});
test('GitHub updates validate the repository and semver, remain read-only and handle unpublished or limited releases', async () => {
  assert.equal(Repository('https://github.com/owner/player/releases/latest'), 'owner/player'); assert.equal(ReleaseURL('owner/player'), 'https://github.com/owner/player/releases/latest');
  for (const value of ['https://github.com.evil.test/a/b', 'https://user@github.com/a/b', 'owner/../other', 'https://github.com/a/b?token=x']) assert.throws(() => Repository(value));
  const calls = [], fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ tag_name: 'v0.10.0', draft: false, prerelease: false })); };
  const result = await CheckRelease('owner/player', '0.6.2', fetch); assert.equal(result.available, true); assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.method, undefined); assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal((await CheckRelease('owner/player', '0.11.0', fetch)).available, false);
  await assert.rejects(CheckRelease('owner/player', '0.6.2', async () => new Response('', { status: 404 })), /公開リリース/);
  await assert.rejects(CheckRelease('owner/player', '0.6.2', async () => new Response('', { status: 429 })), /取得制限/);
});

test('ZIP64 reads a central directory beyond 4 GiB without loading the media archive into memory', async t => {
  const root = Temp(t), small = path.join(root, 'small.zip'), large = path.join(root, 'sparse.zip'); await WriteZip(small, [{ name: 'media/a.mp4', data: Buffer.from('abc') }], { forceZip64: true });
  const bytes = fs.readFileSync(small), directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])), end = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])), locator = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
  const position = 0x100000000 + 128; bytes.writeBigUInt64LE(BigInt(position), end + 48); bytes.writeBigUInt64LE(BigInt(position + end - directory), locator + 8);
  const file = await fs.promises.open(large, 'wx'); await file.write(bytes.subarray(0, directory), 0, directory, 0); await file.write(bytes.subarray(directory), 0, bytes.length - directory, position); await file.close();
  const reader = await new ZipReader().Open(large); try { assert.equal((await reader.Content('media/a.mp4')).toString(), 'abc'); } finally { await reader.Close(); }
});
