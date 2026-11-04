'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Store } = require('../src/core/store.cjs');
const { OfflineLibrary, Key } = require('../src/core/offline-library.cjs');
const { LibraryArchive } = require('../src/core/library-archive.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');
function Fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-lifetime-')); let library; const notifications = [];
  const store = new Store(path.join(root, 'data'), { committed: () => library?.ScheduleCleanup() });
  library = new OfflineLibrary({ directory: path.join(root, 'downloads'), settingsFile: path.join(root, 'settings.json'), ffmpeg: process.execPath, libraryData: () => store.data, referenceData: () => store.SavedData(), changed: value => notifications.push(value) });
  t.after(() => { library.cleanup.Dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const add = (id = 'av123') => { store.Apply({ type: 'add', playlistId: store.data.activePlaylistId, urls: id }); return store.Playlist(store.data.activePlaylistId).entries.at(-1); };
  const seed = (id = 'av123', layout = 4) => {
    const url = ParseBilibili(id).url, file = layout === 4 ? `media/${id}-p1/video-${randomUUID()}.mp4` : `legacy/${id}-${randomUUID()}.mp4`;
    fs.mkdirSync(path.dirname(library.ResolvePath(file)), { recursive: true }); fs.writeFileSync(library.ResolvePath(file), 'media');
    const record = { token: Key(url, 'video') + '.mp4', url, kind: 'video', layout, file, bytes: 5, aliases: [url] }; library.CommitRecord(record); return record;
  };
  return { root, store, library, notifications, add, seed };
}
test('enabled migration delegates old-file deletion to reader-aware cleanup and resumes after release', async t => {
  const h = Fixture(t); h.add(); const old = h.seed('av123', 3), release = h.library.Pin(old);
  await h.library.Organize(); assert.equal(h.library.File(old.token).layout, 4); assert.notEqual(h.library.File(old.token).file, old.file);
  assert.ok(fs.existsSync(h.library.ResolvePath(old.file))); assert.equal(fs.existsSync(h.library.ResolvePath('.layout-migration.json')), false); assert.equal(h.library.cleanupRecords.length, 1);
  release(); h.library.FlushCleanup(); assert.equal(fs.existsSync(h.library.ResolvePath(old.file)), false); assert.equal(h.library.cleanupRecords.length, 0);
});
test('migration retains an old file whose content changed before index commit even when its length stayed the same', async t => {
  const h = Fixture(t); h.add(); const old = h.seed('av123', 3), commit = h.library.CommitRecord.bind(h.library);
  h.library.CommitRecord = record => { fs.writeFileSync(h.library.ResolvePath(old.file), 'OTHER'); commit(record); };
  await h.library.Organize(); assert.equal(fs.readFileSync(h.library.File(old.token).path, 'utf8'), 'media');
  assert.equal(fs.readFileSync(h.library.ResolvePath(old.file), 'utf8'), 'OTHER'); assert.ok(h.library.cleanupRecords[0].files.find(f => f.file === old.file).blocked);
});
test('archive rollback and post-write exception recovery preserve preexisting cleanup metadata and pinned files', async t => {
  for (const failure of ['store', 'after-index-write']) {
    const source = Fixture(t), target = Fixture(t); source.add(); source.seed(); target.add('av999'); const old = target.seed('av999'), release = target.library.Pin(old); target.seed('av999');
    const pending = JSON.stringify(target.library.cleanupRecords), before = target.store.Snapshot(), file = path.join(source.root, 'export.zip');
    await new LibraryArchive(source.store, source.library).Export(file); const archive = new LibraryArchive(target.store, target.library), plan = await archive.Prepare(file);
    if (failure === 'store') target.store.Save = () => { throw new Error('store failed'); };
    else {
      const commit = target.library.CommitRecords.bind(target.library); let first = true;
      target.library.CommitRecords = (...args) => { commit(...args); if (first) { first = false; throw new Error('reported after write'); } };
    }
    await assert.rejects(archive.Commit(plan.id, plan.playlists.map(p => p.id)), /failed|reported after write/);
    assert.deepEqual(target.store.Snapshot(), before); assert.equal(JSON.stringify(target.library.cleanupRecords), pending); assert.ok(fs.existsSync(target.library.ResolvePath(old.file)));
    const data = JSON.parse(fs.readFileSync(path.join(target.library.directory, 'index.json'))); assert.equal(data.cleanupVersion, 1); assert.equal(data.files.length, 1); release();
  }
  const source = Fixture(t), fresh = Fixture(t); source.add(); source.seed(); const file = path.join(source.root, 'fresh.zip'); await new LibraryArchive(source.store, source.library).Export(file);
  const archive = new LibraryArchive(fresh.store, fresh.library), plan = await archive.Prepare(file); fresh.store.Save = () => { throw new Error('fresh save failed'); };
  await assert.rejects(archive.Commit(plan.id, plan.playlists.map(p => p.id)), /fresh save failed/); fresh.library.FlushCleanup();
  assert.equal(fresh.library.indexBytes, null); assert.equal(fresh.library.cleanup.warning, ''); assert.equal(fs.existsSync(path.join(fresh.library.directory, 'index.json')), false);
});
test('an imported replacement keeps the old owned descriptor when the existing cache file is damaged', async t => {
  const source = Fixture(t), target = Fixture(t); source.add(); source.seed(); target.add(); const old = target.seed(); fs.writeFileSync(target.library.ResolvePath(old.file), 'CHANGED FILE');
  const file = path.join(source.root, 'export.zip'); await new LibraryArchive(source.store, source.library).Export(file);
  const archive = new LibraryArchive(target.store, target.library), plan = await archive.Prepare(file); assert.equal((await archive.Commit(plan.id, plan.playlists.map(p => p.id))).downloaded, 1);
  target.library.FlushCleanup(); assert.equal(fs.readFileSync(target.library.Find(ParseBilibili('av123')).path, 'utf8'), 'media'); assert.equal(fs.readFileSync(target.library.ResolvePath(old.file), 'utf8'), 'CHANGED FILE');
  assert.ok(target.library.cleanupRecords.some(item => item.record.file === old.file));
  const unsafe = Fixture(t), record = unsafe.seed(), outside = path.join(unsafe.root, 'outside.json'); fs.writeFileSync(outside, '{}'); fs.symlinkSync(outside, path.join(unsafe.library.directory, '.layout-migration.json'));
  assert.doesNotThrow(() => unsafe.library.FlushCleanup()); assert.ok(fs.existsSync(unsafe.library.ResolvePath(record.file))); assert.ok(unsafe.library.cleanup.warning);
});
test('a cleanup batch bounds library reads and index rewrites and cached references detect later disk edits', t => {
  const h = Fixture(t); for (let i = 1; i <= 100; i++) h.seed(`av${i}`);
  let reads = 0, writes = 0; const read = fs.readFileSync, commit = h.library.CommitRecords.bind(h.library);
  const mock = t.mock.method(fs, 'readFileSync', (file, ...args) => { if (file === h.store.file) reads++; return read(file, ...args); });
  h.library.CommitRecords = (...args) => { writes++; return commit(...args); };
  try { h.library.FlushCleanup(); assert.equal(h.library.records.size, 0); assert.ok(reads <= 2, `library reads: ${reads}`); assert.ok(writes <= 3, `index writes: ${writes}`); }
  finally { mock.mock.restore(); }
  assert.ok(h.store.SavedData()); fs.writeFileSync(h.store.file, '{}'); assert.equal(h.store.SavedData(), null);
  assert.ok(h.notifications.some(n => n.available?.length === 0));
});
test('busy entries at the front of a cleanup queue do not starve later entries', async t => {
  const h = Fixture(t), records = []; for (let i = 1; i <= 105; i++) records.push(h.seed(`av${i}`));
  const pending = records.map(record => h.library.cleanup.Retire([], record, 'unused')[0]); h.library.CommitRecords(new Map(), { cleanup: pending });
  const busy = new Set(records.slice(0, 100).map(r => h.library.ResolvePath(r.file))), unlink = fs.unlinkSync;
  const mock = t.mock.method(fs, 'unlinkSync', file => { if (busy.has(file)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return unlink(file); });
  try {
    h.library.FlushCleanup(); await new Promise(setImmediate); await new Promise(setImmediate);
    assert.ok(records.slice(100).every(r => !fs.existsSync(h.library.ResolvePath(r.file)))); assert.equal(h.library.cleanupRecords.length, 100);
  } finally { mock.mock.restore(); }
  h.library.FlushCleanup(); assert.equal(h.library.cleanupRecords.length, 0);
});
