'use strict';
const { test } = require('node:test');
const { Needs } = require('./support-env.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Store } = require('../src/core/store.cjs');
const { OfflineLibrary, Key } = require('../src/core/offline-library.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');
const { LibraryArchive } = require('../src/core/library-archive.cjs');
const { ZipReader } = require('../src/core/zip.cjs');
const image = fs.readFileSync(path.join(__dirname, '../build/music.png'));
function Fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-cleanup-')); let library;
  const store = new Store(path.join(root, 'data'), { committed: () => library?.ScheduleCleanup() });
  const options = { directory: path.join(root, 'downloads'), settingsFile: path.join(root, 'settings.json'), ffmpeg: process.execPath, libraryData: () => store.data, referenceData: () => store.SavedData(), ...extra };
  library = new OfflineLibrary(options);
  const libraries = [library]; t.after(() => { for (const value of libraries) value.cleanup.Dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const add = (id = 'av123', playlistId = store.data.activePlaylistId, part = 1) => {
    store.Apply({ type: 'add', playlistId, urls: `https://www.bilibili.com/video/${id}?p=${part}` }); return store.Playlist(playlistId).entries.at(-1);
  };
  const seed = (id = 'av123', kind = 'video', part = 1, sharedCover) => {
    const url = ParseBilibili(`https://www.bilibili.com/video/${id}?p=${part}`).url, ext = kind === 'video' ? 'mp4' : 'm4a', file = `media/${id}-p${part}/${kind}-${randomUUID()}.${ext}`;
    fs.mkdirSync(path.dirname(library.ResolvePath(file)), { recursive: true }); fs.writeFileSync(library.ResolvePath(file), 'media');
    const cover = sharedCover || `${path.posix.dirname(file)}/cover-${randomUUID()}.png`; if (!sharedCover) fs.writeFileSync(library.ResolvePath(cover), image);
    const record = { token: `${Key(url, kind)}.${ext}`, url, kind, layout: 4, file, bytes: 5, thumbnail: { file: cover, bytes: image.length } }; library.CommitRecord(record); return record;
  };
  const restart = () => { library.cleanup.Dispose(); const next = new OfflineLibrary(options); libraries.push(next); return next; };
  return { root, store, library, options, add, seed, restart, remove: entry => store.Apply({ type: 'remove', playlistId: entry.playlistId || store.data.activePlaylistId, entryId: entry.id }) };
}
test('video, audio and their shared cover survive until the final registration is removed', t => {
  const h = Fixture(t), first = h.store.data.activePlaylistId, a = h.add();
  h.store.Apply({ type: 'create', parentId: first, name: '子' }); const child = h.store.data.activePlaylistId, b = h.add();
  const video = h.seed(), audio = h.seed('av123', 'audio', 1, video.thumbnail.file);
  h.store.Apply({ type: 'playlist-properties', playlistId: child, name: '子', includeInAll: false });
  h.store.Apply({ type: 'remove', playlistId: first, entryId: a.id }); h.library.FlushCleanup(); assert.ok(h.library.File(video.token)); assert.ok(h.library.File(audio.token));
  h.store.Apply({ type: 'remove', playlistId: child, entryId: b.id }); h.library.FlushCleanup();
  assert.equal(h.library.records.size, 0); assert.equal(h.library.cleanupRecords.length, 0); assert.equal(fs.existsSync(h.library.ResolvePath(video.file)), false); assert.equal(fs.existsSync(h.library.ResolvePath(video.thumbnail.file)), false);
});
test('single and batch moves commit all destinations before reference cleanup runs', t => {
  const h = Fixture(t), source = h.store.data.activePlaylistId, entry = h.add(), record = h.seed();
  h.store.Apply({ type: 'create', name: '移動先' }); const destination = h.store.data.activePlaylistId;
  const moved = h.store.Transfer({ playlistId: source, entryId: entry.id, destinationIds: [destination], mode: 'move' }); h.library.FlushCleanup();
  assert.equal(h.library.File(record.token).file, record.file);
  h.store.TransferMany({ entries: [{ playlistId: destination, entryId: moved.destinations[0].entryId }], destinationIds: [source] }); h.library.FlushCleanup(); assert.ok(h.library.File(record.token));
});
test('deleting a parent retains a promoted child reference and deleting that child clears the last reference', t => {
  const h = Fixture(t), parent = h.store.data.activePlaylistId; h.store.Apply({ type: 'create', parentId: parent, name: '子' }); const child = h.store.data.activePlaylistId;
  h.add(); const record = h.seed(); h.store.Apply({ type: 'create', name: '残すリスト' });
  h.store.Apply({ type: 'delete', playlistId: parent }); h.library.FlushCleanup(); assert.ok(h.library.File(record.token));
  h.store.Apply({ type: 'delete', playlistId: child }); h.library.FlushCleanup(); assert.equal(h.library.File(record.token), null);
});
test('confirmed aliases share references while other parts and unknown notation remain separate', t => {
  const h = Fixture(t); h.add('BV1xx411c7mD'); h.store.RememberVideo('av123', { aid: '123', bvid: 'BV1xx411c7mD' });
  const kept = h.seed(), otherPart = h.seed('av123', 'video', 2), unknown = h.seed('av456'); h.library.FlushCleanup();
  assert.ok(h.library.File(kept.token)); assert.equal(h.library.File(otherPart.token), null); assert.equal(h.library.File(unknown.token), null);
});
test('independent reader pins are idempotent and delay cleanup and directory changes until all readers finish', t => {
  const h = Fixture(t), entry = h.add(), record = h.seed(), first = h.library.Pin(record), second = h.library.Pin(record);
  h.remove(entry); h.library.FlushCleanup(); assert.ok(h.library.File(record.token));
  assert.throws(() => h.library.SetDirectory(path.join(h.root, 'other')), /再生/);
  first(); first(); h.library.FlushCleanup(); assert.ok(h.library.File(record.token)); second(); h.library.FlushCleanup(); assert.equal(h.library.File(record.token), null);
});
test('downloads, export/import and migration busy states defer cleanup', t => {
  for (const property of ['controller', 'importing', 'migrationDone']) {
    const h = Fixture(t), record = h.seed(); h.library[property] = true; h.library.FlushCleanup(); assert.ok(h.library.File(record.token));
    h.library[property] = null; h.library.FlushCleanup(); assert.equal(h.library.File(record.token), null);
  }
});
test('removing the last reference during an export retains its source until the archive has finished', async t => {
  const h = Fixture(t), entry = h.add(), record = h.seed(), output = path.join(h.root, 'export.zip'); let release, entered;
  const gate = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve), mkdir = fs.promises.mkdtemp;
  const mock = t.mock.method(fs.promises, 'mkdtemp', async prefix => { if (prefix.includes('.favecus-export-')) { entered(); await gate; } return mkdir(prefix); });
  const saving = new LibraryArchive(h.store, h.library).Export(output);
  try { await started; h.remove(entry); h.library.FlushCleanup(); assert.ok(h.library.File(record.token)); release(); await saving; }
  finally { release(); mock.mock.restore(); }
  h.library.FlushCleanup(); assert.equal(h.library.File(record.token), null);
  const zip = await new ZipReader().Open(output); assert.equal((await zip.Content(`downloads/media/${record.token}`)).toString(), 'media'); await zip.Close();
});
test('a registration deleted during download leaves no orphan after the job finishes', async t => {
  let entered, release; const started = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  const h = Fixture(t, { resolve: async (entry, kind) => ({ kind, url: entry.url, streams: [{}], duration: 1 }), transfer: async (_f, _s, file) => { entered(); await gate; fs.writeFileSync(file, 'raw'); return 3; }, assemble: async (_f, _p, _i, file) => { fs.writeFileSync(file, 'media'); return 1; } });
  const entry = h.add(); h.library.Start([entry], { kind: 'video' }); await started; h.remove(entry); h.library.FlushCleanup(); release(); await h.library.done;
  assert.equal(h.library.job.status, 'completed'); assert.equal(h.library.records.size, 0); assert.equal(h.library.cleanupRecords.length, 0);
});
test('quality replacement persists retired paths and keeps an old reader and the current shared cover intact', t => {
  const h = Fixture(t); h.add(); const old = h.seed(), release = h.library.Pin(old), current = h.seed('av123', 'video', 1, old.thumbnail.file);
  assert.equal(h.library.cleanupRecords.length, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(h.library.directory, 'index.json'))).cleanupVersion, 1);
  h.library.FlushCleanup(); assert.ok(fs.existsSync(h.library.ResolvePath(old.file))); release(); h.library.FlushCleanup();
  assert.equal(fs.existsSync(h.library.ResolvePath(old.file)), false); assert.equal(h.library.File(current.token).file, current.file); assert.ok(h.library.Cover(current.token));
});
test('locked files leave a durable deletion record and are retried after restart', t => {
  const h = Fixture(t), record = h.seed(), unlink = fs.unlinkSync;
  const mock = t.mock.method(fs, 'unlinkSync', file => { if (file === h.library.ResolvePath(record.file)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return unlink(file); });
  try { h.library.FlushCleanup(); } finally { mock.mock.restore(); }
  assert.equal(h.library.records.size, 0); assert.equal(h.library.cleanupRecords.length, 1); assert.ok(fs.existsSync(h.library.ResolvePath(record.file)));
  const restarted = h.restart(); restarted.FlushCleanup(); assert.equal(restarted.cleanupRecords.length, 0); assert.equal(fs.existsSync(restarted.ResolvePath(record.file)), false);
});
test('a re-added reference restores a still-available pending record instead of deleting its media', t => {
  const h = Fixture(t), record = h.seed(), unlink = fs.unlinkSync;
  const mock = t.mock.method(fs, 'unlinkSync', file => { if (file === h.library.ResolvePath(record.file)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return unlink(file); });
  try { h.library.FlushCleanup(); } finally { mock.mock.restore(); }
  h.add(); const restarted = h.restart(); restarted.FlushCleanup(); assert.equal(restarted.File(record.token).file, record.file); assert.equal(restarted.cleanupRecords.length, 0);
});
test('a failure while finishing deletion keeps enough durable state to finish after restart', t => {
  const h = Fixture(t), record = h.seed(), commit = h.library.CommitRecords.bind(h.library); let calls = 0;
  h.library.CommitRecords = (...args) => { if (++calls === 2) throw new Error('finish failed'); commit(...args); };
  h.library.FlushCleanup(); assert.equal(fs.existsSync(h.library.ResolvePath(record.file)), false); assert.equal(h.library.cleanupRecords.length, 1);
  const restarted = h.restart(); restarted.FlushCleanup(); assert.equal(restarted.cleanupRecords.length, 0); assert.equal(restarted.cleanup.warning, '');
});
test('failed catalog persistence prevents physical deletion and an externally edited catalog is never overwritten', t => {
  for (const change of ['failure', 'external']) {
    const h = Fixture(t), record = h.seed(), index = path.join(h.library.directory, 'index.json'); let bytes = fs.readFileSync(index, 'utf8');
    if (change === 'failure') h.library.CommitRecords = () => { throw new Error('disk full'); };
    else { bytes += '\n'; fs.writeFileSync(index, bytes); }
    h.library.FlushCleanup(); assert.equal(fs.readFileSync(index, 'utf8'), bytes); assert.ok(fs.existsSync(h.library.ResolvePath(record.file)));
  }
});
test('a failed Store save or external library edit cannot turn committed references into garbage', t => {
  for (const change of ['failed-save', 'external']) {
    const h = Fixture(t), entry = h.add(), record = h.seed();
    if (change === 'failed-save') { h.store.Save = () => { throw new Error('save failed'); }; assert.throws(() => h.remove(entry), /save failed/); }
    else fs.writeFileSync(h.store.file, '{}');
    h.library.FlushCleanup(); assert.ok(h.library.File(record.token)); assert.ok(fs.existsSync(h.library.ResolvePath(record.file)));
  }
});
test('unmanaged files, symlinks and changed file identities are preserved', { skip: Needs.symlink }, t => {
  const h = Fixture(t), record = h.seed(), extra = path.join(path.dirname(h.library.ResolvePath(record.file)), 'keep.txt'); fs.writeFileSync(extra, 'unmanaged');
  const unlink = fs.unlinkSync, mock = t.mock.method(fs, 'unlinkSync', file => { if (file === h.library.ResolvePath(record.file)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return unlink(file); });
  try { h.library.FlushCleanup(); } finally { mock.mock.restore(); }
  fs.writeFileSync(h.library.ResolvePath(record.file), 'OTHER'); h.library.FlushCleanup(); assert.equal(fs.readFileSync(h.library.ResolvePath(record.file), 'utf8'), 'OTHER'); assert.equal(fs.readFileSync(extra, 'utf8'), 'unmanaged');
  const other = Fixture(t), link = other.seed(), target = path.join(other.library.directory, 'unmanaged.mp4'); fs.renameSync(other.library.ResolvePath(link.file), target); fs.symlinkSync(target, other.library.ResolvePath(link.file));
  other.library.FlushCleanup(); assert.ok(fs.lstatSync(other.library.ResolvePath(link.file)).isSymbolicLink()); assert.ok(fs.existsSync(target));
});
test('a missing managed file is removed from the index without touching a new file that appears at the same path', t => {
  const h = Fixture(t), record = h.seed(); fs.unlinkSync(h.library.ResolvePath(record.file));
  const commit = h.library.CommitRecords.bind(h.library); let created = false;
  h.library.CommitRecords = (...args) => { commit(...args); if (!created) { created = true; fs.writeFileSync(h.library.ResolvePath(record.file), 'foreign'); } };
  h.library.FlushCleanup(); assert.equal(fs.readFileSync(h.library.ResolvePath(record.file), 'utf8'), 'foreign'); assert.equal(h.library.cleanupRecords.length, 1);
});
test('unknown deletion metadata preserves the original index and automatic cleanup requires explicit wiring', t => {
  const h = Fixture(t), record = h.seed(), index = path.join(h.library.directory, 'index.json'), data = JSON.parse(fs.readFileSync(index)); data.cleanupVersion = 99; data.cleanup = [];
  fs.writeFileSync(index, JSON.stringify(data)); const restarted = h.restart(); restarted.FlushCleanup(); assert.ok(restarted.indexError); assert.ok(fs.existsSync(restarted.ResolvePath(record.file)));
  const disabled = Fixture(t, { referenceData: undefined }), kept = disabled.seed(); disabled.library.FlushCleanup(); assert.ok(disabled.library.File(kept.token));
});
test('orphan cleanup is processed in bounded batches without dropping the remaining work', t => {
  const h = Fixture(t); for (let i = 1; i <= 105; i++) h.seed(`av${i}`);
  h.library.FlushCleanup(); assert.equal(h.library.records.size, 5); h.library.FlushCleanup(); assert.equal(h.library.records.size, 0); assert.equal(h.library.cleanupRecords.length, 0);
});
