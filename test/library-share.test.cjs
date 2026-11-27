'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Store } = require('../src/core/store.cjs');
const { LibraryArchive } = require('../src/core/library-archive.cjs');
const { OfflineLibrary, Key } = require('../src/core/offline-library.cjs');
const { ZipReader, WriteZip } = require('../src/core/zip.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');
const image = fs.readFileSync(path.join(__dirname, '../build/music.png'));
const entries = store => store.data.playlists.flatMap(p => p.entries);
const files = directory => fs.existsSync(directory) ? fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.relative(directory, path.join(e.parentPath, e.name))).sort() : [];
async function Fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-share-modes-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = new Store(path.join(root, 'source')), target = new Store(path.join(root, 'target')), first = source.data.activePlaylistId;
  source.Apply({ type: 'rename', playlistId: first, name: '親' }); source.Apply({ type: 'add', playlistId: first, urls: 'av123' });
  source.Apply({ type: 'create', parentId: first, name: '子' }); const child = source.data.activePlaylistId;
  source.Apply({ type: 'add', playlistId: child, urls: 'av456' });
  const local = path.join(root, '曲.mp3'); fs.writeFileSync(local, 'local audio'); await source.AddFiles([first, child], [local]);
  const offline = store => new OfflineLibrary({ directory: path.join(store.directory, 'downloads'), settingsFile: path.join(store.directory, 'download-settings.json'), ffmpeg: process.execPath, libraryData: () => store.data });
  const sourceOffline = offline(source), targetOffline = offline(target);
  return { root, source, target, first, child, sourceOffline, targetOffline, exporter: new LibraryArchive(source, sourceOffline), importer: new LibraryArchive(target, targetOffline) };
}
function Seed(library, id = 'av123', kind = 'video', part = 1, text = 'saved media') {
  const entry = ParseBilibili(`https://www.bilibili.com/video/${id}?p=${part}`), ext = kind === 'video' ? 'mp4' : 'm4a';
  const file = `media/${id}-p${part}/${kind}-${randomUUID()}.${ext}`, cover = `media/${id}-p${part}/cover-${randomUUID()}.png`;
  fs.mkdirSync(path.dirname(library.ResolvePath(file)), { recursive: true }); fs.writeFileSync(library.ResolvePath(file), text); fs.writeFileSync(library.ResolvePath(cover), image);
  const record = { token: `${Key(entry.url, kind)}.${ext}`, url: entry.url, aliases: [entry.url], file, layout: 4, kind, bytes: Buffer.byteLength(text), height: 720, requestedHeight: 720, duration: 100, thumbnail: { file: cover, bytes: image.length } };
  library.CommitRecord(record); return record;
}
async function Export(h, mode = 'media', extension = 'zip') {
  const file = path.join(h.root, `${mode}-${randomUUID()}.${extension}`); const result = await h.exporter.Export(file, undefined, { mode }); return { file, result };
}
test('information JSON contains portable structure only and does not inspect local or downloaded media', async t => {
  const h = await Fixture(t); Seed(h.sourceOffline); const before = structuredClone(h.source.data);
  h.source.data.settings.cookie = 'private-credential'; h.source.data.playlists[0].privatePath = 'C:/private/device'; entries(h.source)[0].session = 'private-session';
  h.sourceOffline.Find = () => assert.fail('information export inspected downloads'); h.sourceOffline.indexError = 'damaged catalog';
  const local = entries(h.source).find(e => e.type === 'local'); fs.unlinkSync(path.join(h.source.media, local.fileName));
  const mock = t.mock.method(fs.promises, 'lstat', async () => assert.fail('information export inspected a local file'));
  let output; try { output = await Export(h, 'information', 'json'); } finally { mock.mock.restore(); }
  const data = JSON.parse(fs.readFileSync(output.file)), raw = fs.readFileSync(output.file, 'utf8');
  assert.equal(data.shareVersion, 1); assert.equal(data.exportMode, 'information'); assert.equal(data.identityVersion, 2);
  assert.doesNotMatch(raw, /private-credential|private-session|privatePath|C:\/private|settings/);
  assert.deepEqual(data.playlists[0].childIds, [h.child]); assert.deepEqual(data.rootPlaylistIds, [h.first]);
  assert.deepEqual(data.playlists[0].entries.map(e => e.id), before.playlists[0].entries.map(e => e.id));
  assert.ok(data.playlists.flatMap(p => p.entries).filter(e => e.type === 'local').every(e => e.mediaIncluded === false));
  assert.equal(output.result.omitted, 1); assert.equal(output.result.missing, 0); assert.equal(output.result.downloaded, 0);
  assert.equal(Object.hasOwn(entries(h.source).find(e => e.type === 'local'), 'mediaIncluded'), false);
});
test('information ZIP has no payload files and restores selected hierarchy with missing local references', async t => {
  const h = await Fixture(t), { file } = await Export(h, 'information'), zip = await new ZipReader().Open(file);
  assert.deepEqual([...zip.entries.keys()], ['playlists.fvpa']); await zip.Close();
  const plan = await h.importer.Prepare(file); assert.equal(plan.mode, 'information');
  const result = await h.importer.Commit(plan.id, [h.child]);
  assert.equal(result.ancestors, 1); assert.equal(result.omitted, 1); assert.equal(result.missing, 0); assert.equal(result.downloaded, 0);
  assert.equal(h.target.Playlist(h.first).entries.length, 0); assert.deepEqual(h.target.Playlist(h.first).childIds, [h.child]);
  const local = h.target.Playlist(h.child).entries.find(e => e.type === 'local');
  assert.equal(local.mediaId, h.source.Playlist(h.child).entries.find(e => e.type === 'local').mediaId);
  assert.equal(h.target.Snapshot().playlists.find(p => p.id === h.child).entries.find(e => e.id === local.id).missing, true);
  assert.deepEqual(files(h.target.media), []); assert.deepEqual(new Store(h.target.directory).data, h.target.data);
});
test('information JSON never attaches a sidecar or an existing destination file with the original name', async t => {
  const h = await Fixture(t), local = entries(h.source).find(e => e.type === 'local'), { file } = await Export(h, 'information', 'json');
  fs.mkdirSync(path.join(h.root, 'media')); fs.writeFileSync(path.join(h.root, 'media', local.fileName), 'unrelated sidecar'); fs.writeFileSync(path.join(h.target.media, local.fileName), 'existing target');
  const plan = await h.importer.Prepare(file); await h.importer.Commit(plan.id, [h.first]);
  const incoming = h.target.Playlist(h.first).entries.find(e => e.type === 'local');
  assert.notEqual(incoming.fileName, local.fileName); assert.equal(fs.existsSync(path.join(h.target.media, incoming.fileName)), false);
  assert.equal(fs.readFileSync(path.join(h.target.media, local.fileName), 'utf8'), 'existing target');
});
test('directory JSON exports support explicit omission and retain legacy sidecar import compatibility', async t => {
  const h = await Fixture(t), result = await h.source.Export(h.root, { mode: 'information' });
  assert.deepEqual(fs.readdirSync(result.folder), ['favecus-player-library.json']); assert.equal(result.omitted, 1);
  const old = await h.source.Export(h.root), file = path.join(old.folder, 'favecus-player-library.json'), data = JSON.parse(fs.readFileSync(file));
  delete data.shareVersion; delete data.exportMode; fs.writeFileSync(file, JSON.stringify(data));
  const imported = await h.target.Import(file); assert.equal(imported.missing, 0);
  assert.equal(fs.readFileSync(path.join(h.target.media, h.target.Playlist(h.first).entries.find(e => e.type === 'local').fileName), 'utf8'), 'local audio');
});
test('media archives exclude device fields and restore video, audio and a shared cover without changing IDs or order', async t => {
  const h = await Fixture(t), video = Seed(h.sourceOffline), audio = Seed(h.sourceOffline, 'av123', 'audio');
  h.sourceOffline.CommitRecord({ ...video, privatePath: 'C:/private/device', secret: 'private-cookie', thumbnailURL: 'https://i0.hdslb.com/a.png?access_key=private-query' });
  const { file, result } = await Export(h); assert.equal(result.downloaded, 2);
  const zip = await new ZipReader().Open(file), catalog = (await zip.Content('downloads/catalog.json')).toString();
  assert.doesNotMatch(catalog, /private|thumbnailURL|playlistId|layout|savedAt/); assert.ok(zip.entries.has(`downloads/media/${audio.token}`)); await zip.Close();
  const plan = await h.importer.Prepare(file), imported = await h.importer.Commit(plan.id, [h.first]);
  assert.equal(imported.downloaded, 2); assert.equal(imported.missing, 0);
  const v = h.targetOffline.Find(ParseBilibili('av123'), 'video', true), a = h.targetOffline.Find(ParseBilibili('av123'), 'audio', true);
  assert.match(v.file, /^media\/av123-p1\//); assert.equal(path.dirname(v.file), path.dirname(a.file)); assert.equal(v.thumbnail.file, a.thumbnail.file);
  assert.deepEqual(h.target.Playlist(h.first).entries.map(e => e.id), h.source.Playlist(h.first).entries.map(e => e.id));
  assert.deepEqual(h.target.Playlist(h.first).childIds, [h.child]); assert.ok(h.targetOffline.Cover(v.token));
  const restarted = new OfflineLibrary({ directory: path.join(h.target.directory, 'downloads'), settingsFile: path.join(h.target.directory, 'download-settings.json'), ffmpeg: process.execPath, libraryData: () => h.target.data });
  assert.equal(restarted.Find(ParseBilibili('av123'), 'audio', true).kind, 'audio'); assert.ok(restarted.Cover(v.token));
  const again = await h.importer.Prepare(file); assert.equal((await h.importer.Commit(again.id, [h.first])).downloaded, 0);
});
test('known destination aliases reuse existing quality and cover and attach only a missing format to its folder', async t => {
  const h = await Fixture(t), pair = { aid: '123', bvid: 'BV1xx411c7mD' };
  h.source.Apply({ type: 'add', playlistId: h.first, urls: pair.bvid }); h.source.RememberVideo('av123', pair);
  Seed(h.sourceOffline, pair.bvid); Seed(h.sourceOffline, pair.bvid, 'audio');
  h.target.RememberVideo('av123', pair); const existing = Seed(h.targetOffline, 'av123', 'video', 1, 'keep existing quality');
  const { file } = await Export(h), plan = await h.importer.Prepare(file), result = await h.importer.Commit(plan.id, [h.first]);
  assert.equal(result.downloaded, 1); assert.equal(h.targetOffline.File(existing.token).file, existing.file); assert.equal(fs.readFileSync(h.targetOffline.File(existing.token).path, 'utf8'), 'keep existing quality');
  const audio = h.targetOffline.Find(ParseBilibili(pair.bvid), 'audio', true); assert.equal(path.dirname(audio.file), path.dirname(existing.file)); assert.equal(audio.thumbnail.file, existing.thumbnail.file);
});
test('foreign aliases supply selected bytes without registering their claims or merging destination identities', async t => {
  const h = await Fixture(t), pair = { aid: '123', bvid: 'BV1xx411c7mD' };
  h.source.Apply({ type: 'add', playlistId: h.first, urls: pair.bvid }); h.source.RememberVideo('av123', pair); Seed(h.sourceOffline, pair.bvid);
  const { file } = await Export(h), plan = await h.importer.Prepare(file), result = await h.importer.Commit(plan.id, [h.first]);
  assert.equal(result.downloaded, 2); assert.deepEqual(h.target.data.videoAliases, []);
  const av = h.target.Playlist(h.first).entries.find(e => e.videoId === 'av123'), bv = h.target.Playlist(h.first).entries.find(e => e.videoId === pair.bvid);
  assert.notEqual(av.mediaId, bv.mediaId);
  assert.notEqual(h.targetOffline.Find(av).file, h.targetOffline.Find(bv).file);
  assert.deepEqual(h.targetOffline.Find(av).aliases, [av.url]); assert.deepEqual(h.targetOffline.Find(bv).aliases, [bv.url]);
});
test('missing local media is explicitly declared and stays missing across media export, import and restart', async t => {
  const h = await Fixture(t), local = entries(h.source).find(e => e.type === 'local'); fs.unlinkSync(path.join(h.source.media, local.fileName));
  const { file, result } = await Export(h); assert.equal(result.missing, 1);
  const plan = await h.importer.Prepare(file), imported = await h.importer.Commit(plan.id, [h.first]); assert.equal(imported.missing, 1); assert.equal(imported.omitted, 0);
  const restarted = new Store(h.target.directory); assert.ok(restarted.Snapshot().playlists.find(p => p.id === h.first).entries.find(e => e.type === 'local').missing);
});
test('unknown sharing versions and contradictory local declarations fail before any destination changes', async t => {
  const h = await Fixture(t), { file } = await Export(h, 'information', 'json'), initial = JSON.parse(fs.readFileSync(file)), before = h.target.Snapshot();
  for (const options of [null, [], { mode: '' }, { mode: 'unknown' }, { playlistIds: [h.first] }]) await assert.rejects(h.exporter.Export(path.join(h.root, 'invalid.zip'), undefined, options), /出力方式/);
  for (const kind of ['future', 'mode', 'included', 'missing-flag', 'partial']) {
    const data = structuredClone(initial), local = data.playlists[0].entries.find(e => e.type === 'local');
    if (kind === 'future') data.shareVersion = 99;
    if (kind === 'mode') data.exportMode = 'unknown';
    if (kind === 'included') local.mediaIncluded = true;
    if (kind === 'missing-flag') delete local.mediaIncluded;
    if (kind === 'partial') delete data.shareVersion;
    fs.writeFileSync(file, JSON.stringify(data)); await assert.rejects(h.importer.Prepare(file)); assert.deepEqual(h.target.Snapshot(), before);
  }
});
test('information archives reject hidden payloads and media archives reject missing declared local payloads', async t => {
  const h = await Fixture(t);
  for (const mode of ['information', 'media']) {
    const { file } = await Export(h, mode), zip = await new ZipReader().Open(file), payload = await zip.Content('playlists.fvpa'); await zip.Close();
    const bad = path.join(h.root, `${mode}-bad.zip`), items = [{ name: 'playlists.fvpa', data: payload }];
    if (mode === 'information') items.push({ name: 'media/hidden.mp3', data: Buffer.from('hidden') });
    await WriteZip(bad, items); await assert.rejects(h.importer.Prepare(bad), /同梱|メディア/);
  }
});
test('CRC failures and failed persistence roll back new media and download records', async t => {
  for (const failure of ['crc', 'save']) {
    const h = await Fixture(t); Seed(h.sourceOffline); const { file } = await Export(h), plan = await h.importer.Prepare(file), before = h.target.Snapshot(), index = files(h.targetOffline.directory);
    if (failure === 'save') h.target.Save = () => { throw new Error('save failed'); };
    else {
      const zip = h.importer.plans.get(plan.id).zip, content = zip.Content.bind(zip);
      zip.Content = async (...args) => { const result = await content(...args); if (args[0].startsWith('downloads/media/')) throw new Error('CRC failed'); return result; };
    }
    await assert.rejects(h.importer.Commit(plan.id, [h.first]), /failed/); assert.deepEqual(h.target.Snapshot(), before); assert.deepEqual(files(h.targetOffline.directory), index); assert.deepEqual(files(h.target.media), []);
  }
});

test('media extraction rejects declared sizes above 16GiB while keeping the ZIP64 range above 4GiB', async t => {
  const { MAX_MEDIA_BYTES } = require('../src/core/offline-archive.cjs');
  assert.ok(MAX_MEDIA_BYTES > 4 * 1024 ** 3);
  for (const prefix of ['media/', 'downloads/media/']) {
    const h = await Fixture(t); Seed(h.sourceOffline);
    const { file } = await Export(h), plan = await h.importer.Prepare(file), prepared = h.importer.plans.get(plan.id);
    const payload = [...prepared.zip.entries.values()].find(item => item.name.startsWith(prefix));
    payload.bytes = MAX_MEDIA_BYTES + 1;
    const before = h.target.Snapshot();
    await assert.rejects(h.importer.Commit(plan.id, [h.first]), /大きすぎ/);
    assert.deepEqual(h.target.Snapshot(), before);
    assert.deepEqual(files(h.target.media), []);
    assert.deepEqual(files(h.targetOffline.directory), []);
  }
});

test('a failed download rollback still removes copied local media and preserves the save error', async t => {
  const h = await Fixture(t); Seed(h.sourceOffline);
  const { file } = await Export(h), plan = await h.importer.Prepare(file), before = h.target.Snapshot();
  const commit = h.targetOffline.CommitRecords.bind(h.targetOffline); let calls = 0;
  h.targetOffline.CommitRecords = (...args) => { if (++calls > 1) throw new Error('rollback failed'); return commit(...args); };
  h.target.Save = () => { throw new Error('original save failure'); };
  await assert.rejects(h.importer.Commit(plan.id, [h.first]), /original save failure/);
  assert.deepEqual(h.target.Snapshot(), before);
  assert.deepEqual(files(h.target.media), []);
});
test('exclusive media and cover placement failures preserve files created by another writer', async t => {
  for (const phase of ['media', 'cover']) {
    const h = await Fixture(t); Seed(h.sourceOffline); const { file } = await Export(h), plan = await h.importer.Prepare(file), before = h.target.Snapshot(); let collision;
    const original = fs.promises.link, mock = t.mock.method(fs.promises, 'link', async (from, to) => {
      if (from.endsWith(`.${phase}`)) { collision = to; fs.writeFileSync(to, 'foreign bytes'); throw Object.assign(new Error('exists'), { code: 'EEXIST' }); }
      return original(from, to);
    });
    try { await assert.rejects(h.importer.Commit(plan.id, [h.first]), /exists/); } finally { mock.mock.restore(); }
    assert.ok(collision); assert.equal(fs.readFileSync(collision, 'utf8'), 'foreign bytes'); assert.deepEqual(h.target.Snapshot(), before); assert.equal(h.targetOffline.records.size, 0);
    assert.ok(!fs.readdirSync(h.targetOffline.directory).some(n => n.startsWith('.import-')));
  }
});
test('a concurrent download catalog change stops staged import and preserves the newer catalog', async t => {
  const h = await Fixture(t); Seed(h.sourceOffline); const { file } = await Export(h), plan = await h.importer.Prepare(file), before = h.target.Snapshot();
  const zip = h.importer.plans.get(plan.id).zip, content = zip.Content.bind(zip); let concurrent;
  zip.Content = async (...args) => { const result = await content(...args); if (!concurrent && args[0].startsWith('downloads/media/')) concurrent = Seed(h.targetOffline, 'av999'); return result; };
  await assert.rejects(h.importer.Commit(plan.id, [h.first]), /保存一覧/); assert.deepEqual(h.target.Snapshot(), before); assert.ok(h.targetOffline.File(concurrent.token)); assert.equal(h.targetOffline.records.size, 1);
});
test('a failure reported after the download index was written is read back and rolled back safely', async t => {
  const h = await Fixture(t); Seed(h.sourceOffline); const { file } = await Export(h), plan = await h.importer.Prepare(file), before = h.target.Snapshot();
  const commit = h.targetOffline.CommitRecords.bind(h.targetOffline); let first = true;
  h.targetOffline.CommitRecords = records => { commit(records); if (first) { first = false; throw new Error('reported after write'); } };
  await assert.rejects(h.importer.Commit(plan.id, [h.first]), /reported after write/);
  assert.deepEqual(h.target.Snapshot(), before); assert.equal(h.targetOffline.records.size, 0); assert.deepEqual(files(h.targetOffline.directory), []); assert.deepEqual(files(h.target.media), []);
});
test('hard-link fallback succeeds and capacity failure preserves existing media and releases import locks', async t => {
  for (const noSpace of [false, true]) {
    const h = await Fixture(t); Seed(h.sourceOffline); const { file } = await Export(h), plan = await h.importer.Prepare(file), before = h.target.Snapshot();
    const link = fs.promises.link, copy = fs.promises.copyFile;
    const links = t.mock.method(fs.promises, 'link', async (from, to) => { if (from.endsWith('.media')) throw Object.assign(new Error('link denied'), { code: 'EPERM' }); return link(from, to); });
    const copies = t.mock.method(fs.promises, 'copyFile', async (...args) => { if (noSpace && args[0].endsWith('.media')) throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); return copy(...args); });
    try {
      if (noSpace) { await assert.rejects(h.importer.Commit(plan.id, [h.first]), /no space/); assert.deepEqual(h.target.Snapshot(), before); assert.deepEqual(files(h.targetOffline.directory), []); }
      else assert.equal((await h.importer.Commit(plan.id, [h.first])).downloaded, 1);
    } finally { links.mock.restore(); copies.mock.restore(); }
    assert.equal(h.target.sharingBusy, false); assert.equal(h.targetOffline.importing, false);
  }
});
test('part numbers remain distinct and payload-less re-export preserves missing local metadata', async t => {
  const h = await Fixture(t); h.source.Apply({ type: 'add', playlistId: h.first, urls: 'https://www.bilibili.com/video/av123?p=2' });
  Seed(h.sourceOffline); Seed(h.sourceOffline, 'av123', 'video', 2, 'second part');
  const { file } = await Export(h), plan = await h.importer.Prepare(file), imported = await h.importer.Commit(plan.id, [h.first]); assert.equal(imported.downloaded, 2);
  const parts = h.target.Playlist(h.first).entries.filter(e => e.videoId === 'av123'); assert.deepEqual(parts.map(e => e.part), [1, 2]);
  assert.notEqual(path.dirname(h.targetOffline.Find(parts[0]).file), path.dirname(h.targetOffline.Find(parts[1]).file));
  const json = path.join(h.root, 'second-device.json'); await new LibraryArchive(h.target, h.targetOffline).Export(json, undefined, { mode: 'information' });
  const third = new Store(path.join(h.root, 'third')); await third.Import(json);
  assert.deepEqual(third.Playlist(h.first).entries.map(e => e.title), h.target.Playlist(h.first).entries.map(e => e.title)); assert.ok(third.Snapshot().playlists.find(p => p.id === h.first).entries.find(e => e.type === 'local').missing);
});
test('export locks across archive instances before yielding and releases after failed output without replacing the target', async t => {
  const h = await Fixture(t), file = path.join(h.root, 'existing.json'); fs.writeFileSync(file, 'keep original');
  let release, entered; const gate = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve), mkdir = fs.promises.mkdtemp;
  const hold = t.mock.method(fs.promises, 'mkdtemp', async prefix => { if (prefix.includes('.favecus-export-')) { entered(); await gate; } return mkdir(prefix); });
  const rename = t.mock.method(fs.promises, 'rename', async () => { throw new Error('rename failed'); });
  const exporting = h.exporter.Export(file, undefined, { mode: 'information' });
  try {
    await started; await assert.rejects(new LibraryArchive(h.source).Export(path.join(h.root, 'second.zip')), /完了後/); await assert.rejects(h.source.Export(h.root), /完了後/);
    release(); await assert.rejects(exporting, /rename failed/);
  } finally { release(); hold.mock.restore(); rename.mock.restore(); }
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep original'); assert.equal(h.source.sharingBusy, false); assert.equal(h.sourceOffline.importing, false);
  assert.ok(!fs.readdirSync(h.root).some(n => n.startsWith('.favecus-export-'))); await h.exporter.Export(file, undefined, { mode: 'information' });
  assert.equal(JSON.parse(fs.readFileSync(file)).exportMode, 'information');
});
