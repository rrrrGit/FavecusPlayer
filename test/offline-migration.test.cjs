'use strict';
const { test } = require('node:test');
const { Needs } = require('./support-env.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { OfflineLibrary, Key } = require('../src/core/offline-library.cjs');
const { LibraryArchive } = require('../src/core/library-archive.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');
const image = fs.readFileSync(path.join(__dirname, '../build/music.png'));
function Fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = { playlists: [], videoAliases: [] }, options = { directory: path.join(root, 'downloads'), settingsFile: path.join(root, 'settings.json'), ffmpeg: process.execPath, libraryData: () => data,
    resolve: async () => { throw new Error('migration must not use network'); } };
  const library = new OfflineLibrary(options), disk = name => path.join(options.directory, name);
  const add = (id = 'av123', kind = 'video', layout = 3, part = 1, cover = true) => {
    const entry = ParseBilibili(`https://www.bilibili.com/video/${id}?p=${part}`), file = `親/子/${entry.videoId}-p${part}/${kind}.${kind === 'video' ? 'mp4' : 'm4a'}`;
    fs.mkdirSync(path.dirname(disk(file)), { recursive: true }); fs.writeFileSync(disk(file), `${id}:${part}:${kind}`);
    const record = { token: `${Key(entry.url, kind)}.${kind === 'video' ? 'mp4' : 'm4a'}`, url: entry.url, kind, file, bytes: fs.statSync(disk(file)).size, height: 720 };
    if (layout !== undefined) record.layout = layout;
    if (cover) { const name = `${path.posix.dirname(file)}/cover.png`; fs.writeFileSync(disk(name), image); record.thumbnail = { file: name, bytes: image.length }; }
    library.CommitRecord(record); return record;
  };
  const journal = () => JSON.parse(fs.readFileSync(disk('.layout-migration.json'), 'utf8'));
  return { root, data, options, library, disk, add, journal };
}
test('all old layouts migrate without network, preserving tokens and bytes, sharing a cover and keeping a raw backup', async t => {
  const h = Fixture(t), video = h.add(), audio = h.add('av123', 'audio', 2), flat = h.add('av456', 'video', undefined), oldIndex = fs.readFileSync(h.disk('index.json'));
  fs.writeFileSync(h.disk('親/keep.txt'), 'unmanaged');
  await h.library.Organize();
  for (const old of [video, audio, flat]) {
    const saved = h.library.File(old.token); assert.equal(saved.layout, 4); assert.match(saved.file, /^media\/av\d+-p1\//);
    assert.equal(fs.readFileSync(saved.path, 'utf8'), `${ParseBilibili(old.url).videoId}:1:${old.kind}`); assert.equal(fs.existsSync(h.disk(old.file)), false); assert.ok(h.library.Cover(old.token));
  }
  assert.equal(h.library.File(video.token).thumbnail.file, h.library.File(audio.token).thumbnail.file);
  assert.equal(fs.existsSync(h.disk(video.thumbnail.file)), false); assert.equal(fs.existsSync(h.disk('親/子')), false); assert.equal(fs.readFileSync(h.disk('親/keep.txt'), 'utf8'), 'unmanaged');
  assert.deepEqual(fs.readFileSync(h.disk(fs.readdirSync(h.options.directory).find(n => n.startsWith('index.pre-')))), oldIndex);
  const files = [...h.library.records.values()].map(r => r.file); await h.library.Organize(); const restarted = new OfflineLibrary(h.options); await restarted.Organize();
  assert.deepEqual([...restarted.records.values()].map(r => r.file), files); assert.equal(fs.existsSync(h.disk('.layout-migration.json')), false);
});
test('confirmed aliases use one folder while parts remain separate and existing layout 4 folders stay fixed', async t => {
  const h = Fixture(t); h.data.videoAliases = [{ aid: '123', bvid: 'BV1xx411c7mD' }];
  const a = h.add(), b = h.add('BV1xx411c7mD', 'audio'), part = h.add('av123', 'video', 3, 2);
  await h.library.Organize();
  assert.equal(path.posix.dirname(h.library.File(a.token).file), 'media/BV1xx411c7mD-p1');
  assert.equal(path.posix.dirname(h.library.File(b.token).file), 'media/BV1xx411c7mD-p1');
  assert.equal(path.posix.dirname(h.library.File(part.token).file), 'media/BV1xx411c7mD-p2');
});
test('failed catalog commit keeps originals, index and completed copies for restart without recopying', async t => {
  const h = Fixture(t), old = h.add(), index = fs.readFileSync(h.disk('index.json'));
  h.library.CommitRecord = () => { throw new Error('index failure'); }; await h.library.Organize();
  assert.deepEqual(fs.readFileSync(h.disk('index.json')), index); assert.ok(fs.existsSync(h.disk(old.file))); const plan = h.journal();
  const copies = plan.files.map(f => [f.to, fs.statSync(h.disk(f.to)).mtimeMs]); const restarted = new OfflineLibrary(h.options); await restarted.Organize();
  for (const [name, time] of copies) assert.equal(fs.statSync(h.disk(name)).mtimeMs, time);
  assert.equal(restarted.File(old.token).layout, 4); assert.equal(fs.existsSync(h.disk(old.file)), false);
});
test('a preexisting shared folder wins over a direct legacy record with the other notation', async t => {
  const h = Fixture(t), first = h.add(); await h.library.Organize(); const folder = path.posix.dirname(h.library.File(first.token).file);
  h.data.videoAliases = [{ aid: '123', bvid: 'BV1xx411c7mD' }]; const second = h.add('BV1xx411c7mD');
  await h.library.Organize(); assert.equal(path.posix.dirname(h.library.File(second.token).file), folder);
});
test('changed old content and missing committed destinations are retained for recovery', async t => {
  const h = Fixture(t), old = h.add(), commit = h.library.CommitRecord.bind(h.library);
  h.library.CommitRecord = record => { commit(record); throw new Error('stop'); }; await h.library.Organize();
  const plan = h.journal(); fs.unlinkSync(h.disk(plan.updated.file)); const restarted = new OfflineLibrary(h.options); await restarted.Organize();
  assert.ok(fs.existsSync(h.disk(old.file))); assert.ok(h.journal());
  fs.copyFileSync(h.disk(old.file), h.disk(plan.updated.file)); fs.writeFileSync(h.disk(old.file), 'edited original');
  await restarted.Organize(); assert.equal(fs.readFileSync(h.disk(old.file), 'utf8'), 'edited original'); assert.equal(fs.existsSync(h.disk('.layout-migration.json')), false); assert.match(restarted.warning, /保持/);
});
test('insufficient space and permission failures retain the source and retry on restart', async t => {
  for (const code of ['ENOSPC', 'EACCES']) {
    const h = Fixture(t), old = h.add(), original = fs.promises.copyFile;
    fs.promises.copyFile = async () => { throw Object.assign(new Error(code), { code }); };
    try { await h.library.Organize(); } finally { fs.promises.copyFile = original; }
    assert.ok(fs.existsSync(h.disk(old.file))); assert.equal(h.library.File(old.token).layout, 3); assert.ok(h.journal());
    const restarted = new OfflineLibrary(h.options); await restarted.Organize(); assert.equal(restarted.File(old.token).layout, 4);
  }
});
test('backup failure performs no media writes and leaves the original index intact', async t => {
  const h = Fixture(t), old = h.add(), index = fs.readFileSync(h.disk('index.json')), original = fs.copyFileSync;
  fs.copyFileSync = () => { throw Object.assign(new Error('backup denied'), { code: 'EACCES' }); };
  try { await h.library.Organize(); } finally { fs.copyFileSync = original; }
  assert.deepEqual(fs.readFileSync(h.disk('index.json')), index); assert.ok(fs.existsSync(h.disk(old.file))); assert.equal(fs.existsSync(h.disk('media')), false);
});
test('abort after copying resumes from the journal with the old index and media intact', async t => {
  const h = Fixture(t), old = h.add(), controller = new AbortController(), original = fs.promises.copyFile;
  fs.promises.copyFile = async (...args) => { await original(...args); controller.abort(); };
  try { await assert.rejects(h.library.ReconcileLayout(h.data, controller.signal), { name: 'AbortError' }); } finally { fs.promises.copyFile = original; }
  assert.equal(h.library.File(old.token).layout, 3); assert.ok(fs.existsSync(h.disk(old.file))); assert.ok(h.journal());
  await new OfflineLibrary(h.options).Organize(); assert.equal(fs.existsSync(h.disk(old.file)), false);
});
test('a crash after the atomic index commit is recognized without replacing the saved media', async t => {
  const h = Fixture(t), old = h.add(), commit = h.library.CommitRecord.bind(h.library);
  h.library.CommitRecord = record => { commit(record); throw new Error('simulated process stop'); }; await h.library.Organize();
  assert.equal(h.journal().phase, 'copying'); const destination = h.library.File(old.token).file;
  const restarted = new OfflineLibrary(h.options); await restarted.Organize(); assert.equal(restarted.File(old.token).file, destination); assert.equal(fs.existsSync(h.disk(old.file)), false);
});
test('locked old files keep a committed journal and cleanup retries after restart', async t => {
  const h = Fixture(t), old = h.add(), original = fs.promises.unlink;
  fs.promises.unlink = async file => { if (file === h.disk(old.file)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return original(file); };
  try { await h.library.Organize(); } finally { fs.promises.unlink = original; }
  assert.equal(h.library.File(old.token).layout, 4); assert.equal(h.journal().phase, 'committed'); assert.ok(fs.existsSync(h.disk(old.file)));
  await new OfflineLibrary(h.options).Organize(); assert.equal(fs.existsSync(h.disk(old.file)), false);
});
test('an interrupted partial destination is preserved and a fresh exclusive path is used', async t => {
  const h = Fixture(t), old = h.add(), commit = h.library.CommitRecord.bind(h.library);
  h.library.CommitRecord = () => { throw new Error('stop'); }; await h.library.Organize(); const plan = h.journal(), partial = plan.files[0].to;
  fs.writeFileSync(h.disk(partial), 'unmanaged or partial'); h.library.CommitRecord = commit; await h.library.Organize();
  assert.equal(fs.readFileSync(h.disk(partial), 'utf8'), 'unmanaged or partial'); assert.notEqual(h.library.File(old.token).file, partial); assert.equal(h.library.File(old.token).layout, 4);
});
test('parallel migration calls share work and block download, directory changes and archive export', async t => {
  const h = Fixture(t), old = h.add(), original = fs.promises.copyFile; let release, entered;
  const started = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve); let count = 0;
  fs.promises.copyFile = async (...args) => { count++; entered(); await gate; return original(...args); };
  try {
    const first = h.library.Organize(); await started; const second = h.library.ReconcileLayout(h.data);
    assert.throws(() => h.library.Start([ParseBilibili('av123')], { kind: 'video' }), /進行中/);
    assert.throws(() => h.library.SetDirectory(path.join(h.root, 'other')), /変更できません/);
    await assert.rejects(new LibraryArchive({}, h.library).Export(h.disk('export.zip')), /完了後/);
    release(); await Promise.all([first, second]); assert.equal(count, 2); assert.equal(h.library.File(old.token).layout, 4);
  } finally { release(); fs.promises.copyFile = original; }
});
test('unknown or corrupted migration records and future layouts leave the original data untouched', async t => {
  for (const value of ['{broken', JSON.stringify({ version: 99 })]) {
    const h = Fixture(t), old = h.add(), index = fs.readFileSync(h.disk('index.json'));
    fs.writeFileSync(h.disk('.layout-migration.json'), value); await h.library.Organize();
    assert.deepEqual(fs.readFileSync(h.disk('index.json')), index); assert.equal(fs.readFileSync(h.disk('.layout-migration.json'), 'utf8'), value); assert.ok(fs.existsSync(h.disk(old.file)));
  }
  const h = Fixture(t), old = h.add('av123', 'video', 5); await h.library.Organize(); assert.equal(h.library.File(old.token).layout, 5); assert.ok(h.library.warning);
});
test('source changes during migration preserve concurrent edits and both media copies', async t => {
  const h = Fixture(t), old = h.add(), original = fs.promises.copyFile;
  fs.promises.copyFile = async (...args) => { await original(...args); h.library.CommitRecord({ ...old, requestedHeight: 360 }); };
  try { await h.library.Organize(); } finally { fs.promises.copyFile = original; }
  assert.equal(h.library.records.get(old.token).requestedHeight, 360); assert.ok(fs.existsSync(h.disk(old.file))); assert.ok(h.journal());
  const restarted = new OfflineLibrary(h.options); await restarted.Organize(); assert.equal(restarted.records.get(old.token).requestedHeight, 360); assert.equal(restarted.File(old.token).layout, 3);
});
test('an index edited on disk during copying is never overwritten or cleaned from a stale snapshot', async t => {
  const h = Fixture(t), old = h.add(), original = fs.promises.copyFile; let edited;
  fs.promises.copyFile = async (...args) => { await original(...args); const data = JSON.parse(fs.readFileSync(h.disk('index.json'), 'utf8')); data.files[0].externalChange = true; edited = JSON.stringify(data); fs.writeFileSync(h.disk('index.json'), edited); };
  try { await h.library.Organize(); } finally { fs.promises.copyFile = original; }
  assert.equal(fs.readFileSync(h.disk('index.json'), 'utf8'), edited); assert.ok(fs.existsSync(h.disk(old.file))); assert.ok(h.journal());
});
test('symlinked media and damaged indexes are preserved without migrating or deleting their contents', { skip: Needs.symlink }, async t => {
  const h = Fixture(t), old = h.add(), outside = path.join(h.root, 'outside.mp4'); fs.renameSync(h.disk(old.file), outside); fs.symlinkSync(outside, h.disk(old.file));
  await h.library.Organize(); assert.ok(fs.lstatSync(h.disk(old.file)).isSymbolicLink()); assert.ok(fs.existsSync(outside));
  fs.writeFileSync(h.disk('index.json'), '{broken'); const restarted = new OfflineLibrary(h.options); await restarted.Organize(); assert.equal(fs.readFileSync(h.disk('index.json'), 'utf8'), '{broken');
});
test('an unresolved migration record stops a new download before any network request or index replacement', async t => {
  const h = Fixture(t), old = h.add(), index = fs.readFileSync(h.disk('index.json'));
  fs.writeFileSync(h.disk('.layout-migration.json'), JSON.stringify({ version: 99 }));
  h.library.Start([ParseBilibili('av123')], { kind: 'video' }); await h.library.done;
  assert.equal(h.library.job.status, 'failed'); assert.match(h.library.job.message, /FP-DOWNLOAD-LAYOUT/); assert.deepEqual(fs.readFileSync(h.disk('index.json')), index); assert.ok(fs.existsSync(h.disk(old.file)));
});
