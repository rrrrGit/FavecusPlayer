'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Store } = require('../src/core/store.cjs');
const { LibraryArchive } = require('../src/core/library-archive.cjs');
const { PlanImportIdentity } = require('../src/core/import-identity.cjs');
const { randomUUID, randomBytes, createCipheriv } = require('node:crypto');
const { WriteZip } = require('../src/core/zip.cjs');
function Setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-share-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = new Store(path.join(dir, 'source')), target = new Store(path.join(dir, 'target'));
  const root = source.data.activePlaylistId;
  source.Apply({ type: 'add', playlistId: root, urls: 'av123' });
  source.Apply({ type: 'create', name: '子', parentId: root }); const child = source.data.activePlaylistId;
  source.Apply({ type: 'add', playlistId: child, urls: 'av456' });
  return { dir, source, target, root, child };
}
const rows = s => s.data.playlists.flatMap(p => p.entries);
async function File(h, format) {
  if (format === 'json') return path.join((await h.source.Export(h.dir)).folder, 'favecus-player-library.json');
  const file = path.join(h.dir, 'share.zip'); await new LibraryArchive(h.source).Export(file); return file;
}
test('JSON and ZIP preserve unused playlist, registration and media IDs with their hierarchy', async t => {
  for (const format of ['json', 'zip']) {
    const h = Setup(t), file = await File(h, format);
    if (format === 'json') {
      const data = JSON.parse(fs.readFileSync(file)); assert.equal(data.identityVersion, 2);
      assert.equal(Object.hasOwn(data, 'settings'), false);
      await h.target.Import(file);
    } else {
      const archive = new LibraryArchive(h.target), plan = await archive.Prepare(file);
      await archive.Commit(plan.id, [h.child]);
    }
    assert.deepEqual(h.target.Playlist(h.root).childIds, [h.child]);
    const incoming = h.source.Playlist(h.child).entries[0], imported = h.target.Playlist(h.child).entries[0];
    assert.equal(imported.id, incoming.id); assert.equal(imported.mediaId, incoming.mediaId);
    assert.deepEqual(new Store(h.target.directory).data, h.target.data);
  }
});
test('repeated imports remap colliding row IDs without overwriting titles or duplicating media identity', async t => {
  const h = Setup(t), file = await File(h, 'json');
  await h.target.Import(file); h.target.Apply({ type: 'rename', playlistId: h.root, name: '変更を保持' });
  const mediaId = h.target.Playlist(h.root).entries[0].mediaId;
  await h.target.Import(file);
  assert.equal(h.target.Playlist(h.root).name, '変更を保持');
  const ids = h.target.data.playlists.flatMap(p => [p.id, ...p.entries.map(e => e.id)]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(rows(h.target).filter(e => e.videoId === 'av123').every(e => e.mediaId === mediaId));
  assert.equal(h.target.data.playlists.filter(p => p.childIds.length === 1).length, 2);
});
test('a known destination media key takes precedence over a foreign media ID', async t => {
  const h = Setup(t); h.target.Apply({ type: 'add', playlistId: h.target.data.activePlaylistId, urls: 'av123' });
  const id = rows(h.target)[0].mediaId, foreign = rows(h.source)[0].mediaId;
  assert.notEqual(id, foreign); await h.target.Import(await File(h, 'json'));
  assert.equal(h.target.Playlist(h.root).entries[0].mediaId, id);
});
test('a foreign media ID bound to another destination video is remapped, not merged', async t => {
  const h = Setup(t); h.target.Apply({ type: 'add', playlistId: h.target.data.activePlaylistId, urls: 'av999' });
  const id = rows(h.target)[0].mediaId; rows(h.source)[0].mediaId = id; h.source.Save();
  await h.target.Import(await File(h, 'json'));
  assert.equal(rows(h.target).find(e => e.videoId === 'av999').mediaId, id);
  assert.notEqual(h.target.Playlist(h.root).entries[0].mediaId, id);
});
test('local filename and media ID collisions preserve existing bytes for both import formats', async t => {
  for (const format of ['json', 'zip']) {
    const h = Setup(t), input = path.join(h.dir, 'track.mp3'); fs.writeFileSync(input, 'source audio');
    await h.source.AddFiles([h.root, h.child], [input]);
    const local = rows(h.source).find(e => e.type === 'local');
    h.target.Playlist(h.target.data.activePlaylistId).entries.push({ ...local, id: randomUUID(), title: '既存' });
    fs.writeFileSync(path.join(h.target.media, local.fileName), 'existing audio'); h.target.Save();
    const file = await File(h, format), archive = new LibraryArchive(h.target), plan = await archive.Prepare(file);
    await archive.Commit(plan.id, [h.root]);
    const imported = h.target.Playlist(h.root).entries.find(e => e.type === 'local');
    assert.notEqual(imported.fileName, local.fileName); assert.notEqual(imported.mediaId, local.mediaId);
    assert.equal(fs.readFileSync(path.join(h.target.media, local.fileName), 'utf8'), 'existing audio');
    assert.equal(fs.readFileSync(path.join(h.target.media, imported.fileName), 'utf8'), 'source audio');
    assert.equal(imported.mediaId, h.target.Playlist(h.child).entries.find(e => e.type === 'local').mediaId);
  }
});
test('foreign alias claims are validated as source data but cannot merge destination videos', async t => {
  const h = Setup(t), pair = { aid: 123, bvid: 'BV1Q541167Qg' };
  h.source.Apply({ type: 'add', playlistId: h.child, urls: pair.bvid }); h.source.RememberVideo('av123', pair);
  await h.target.Import(await File(h, 'json'));
  const av = rows(h.target).find(e => e.videoId === 'av123'), bv = rows(h.target).find(e => e.videoId === pair.bvid);
  assert.notEqual(av.mediaId, bv.mediaId); assert.deepEqual(h.target.data.videoAliases, []);
  h.target.RememberVideo('av123', pair);
  assert.equal(rows(h.target).find(e => e.videoId === pair.bvid).mediaId, av.mediaId);
});
test('JSON and ZIP persistence failures roll back copied media and all destination state', async t => {
  for (const format of ['json', 'zip']) {
    const h = Setup(t), input = path.join(h.dir, 'track.mp3'); fs.writeFileSync(input, 'audio'); await h.source.AddFiles([h.root], [input]);
    const file = await File(h, format), before = h.target.Snapshot(), bytes = fs.readFileSync(h.target.file), names = fs.readdirSync(h.target.media);
    h.target.Save = () => { throw new Error('disk full'); };
    if (format === 'json') await assert.rejects(h.target.Import(file), /disk full/);
    else { const archive = new LibraryArchive(h.target), plan = await archive.Prepare(file); await assert.rejects(archive.Commit(plan.id, [h.root]), /disk full/); }
    assert.deepEqual(h.target.Snapshot(), before); assert.deepEqual(fs.readFileSync(h.target.file), bytes); assert.deepEqual(fs.readdirSync(h.target.media), names);
  }
});
test('identity planning preserves input objects and rejects generators that keep colliding', t => {
  const h = Setup(t), playlists = structuredClone(h.source.data.playlists), snapshot = structuredClone(playlists);
  const result = PlanImportIdentity(h.target.data.playlists, playlists, [h.root], { keyOf: h.target.IdentityKey(), createId: randomUUID });
  assert.equal(result.playlists[0].id, h.root); assert.deepEqual(playlists, snapshot);
  assert.throws(() => PlanImportIdentity(playlists, playlists, [h.root], { keyOf: h.source.IdentityKey(), createId: () => h.root }), /ID/);
});
test('legacy ZIPs without identity metadata remain readable and keep their hierarchy', async t => {
  const h = Setup(t), inner = path.join(h.dir, 'old-inner.zip');
  await WriteZip(inner, h.source.data.playlists.map(p => ({ name: `playlists/${p.id}.json`, data: Buffer.from(JSON.stringify({ version: 3, playlist: p, rootIndex: h.source.data.rootPlaylistIds.indexOf(p.id) })) })));
  const key = randomBytes(32), nonce = randomBytes(12), header = Buffer.concat([Buffer.from('FVPA0002'), key, nonce]);
  const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(header);
  const encrypted = Buffer.concat([cipher.update(fs.readFileSync(inner)), cipher.final()]), file = path.join(h.dir, 'legacy.zip');
  await WriteZip(file, [{ name: 'playlists.fvpa', data: Buffer.concat([header, cipher.getAuthTag(), encrypted]) }]);
  const archive = new LibraryArchive(h.target), plan = await archive.Prepare(file); await archive.Commit(plan.id, [h.root]);
  assert.ok(!h.target.data.playlists.some(p => p.id === h.root));
  const imported = h.target.data.playlists.find(p => p.childIds.length); assert.ok(imported);
  assert.equal(h.target.Playlist(imported.childIds[0]).entries[0].videoId, 'av456');
});
test('malformed shared IDs and unknown formats are rejected before any destination changes', async t => {
  const h = Setup(t), file = await File(h, 'json'), initial = fs.readFileSync(file, 'utf8'), before = h.target.Snapshot();
  for (const mode of ['duplicate-registration', 'conflicting-media', 'future']) {
    const data = JSON.parse(initial);
    if (mode === 'duplicate-registration') data.playlists[1].id = data.playlists[0].id;
    if (mode === 'conflicting-media') data.playlists[1].entries[0].mediaId = data.playlists[0].entries[0].mediaId;
    if (mode === 'future') data.identityVersion = 999;
    fs.writeFileSync(file, JSON.stringify(data)); await assert.rejects(h.target.Import(file));
    assert.deepEqual(h.target.Snapshot(), before); assert.deepEqual(fs.readdirSync(h.target.media), []);
  }
});
test('an edit made while an import yields is retained when the stale import is stopped', async t => {
  const h = Setup(t), file = await File(h, 'json'), archive = new LibraryArchive(h.target), plan = await archive.Prepare(file);
  const original = h.target.IdentityKey, destination = h.target.data.activePlaylistId;
  h.target.IdentityKey = function () {
    const key = original.call(this);
    queueMicrotask(() => { this.IdentityKey = original; this.Apply({ type: 'rename', playlistId: destination, name: '並行した編集' }); });
    return key;
  };
  await assert.rejects(archive.Commit(plan.id, [h.root]), /取り込み中/);
  assert.equal(h.target.Playlist(destination).name, '並行した編集'); assert.equal(h.target.data.playlists.length, 1);
  assert.equal(new Store(h.target.directory).Playlist(destination).name, '並行した編集');
});
test('a media destination that appears during copying is never removed as an import-owned file', async t => {
  const h = Setup(t), input = path.join(h.dir, 'sound.mp3'); fs.writeFileSync(input, 'source'); await h.source.AddFiles([h.root], [input]);
  const file = await File(h, 'json'), before = h.target.Snapshot(); let concurrent;
  const mock = t.mock.method(fs.promises, 'link', async (_from, to) => {
    concurrent = to; fs.writeFileSync(to, 'concurrent file'); throw Object.assign(new Error('exists'), { code: 'EEXIST' });
  });
  try { await assert.rejects(h.target.Import(file), /exists/); } finally { mock.mock.restore(); }
  assert.equal(fs.readFileSync(concurrent, 'utf8'), 'concurrent file'); assert.deepEqual(h.target.Snapshot(), before);
  assert.ok(!fs.readdirSync(h.target.media).some(n => n.startsWith('.import-')));
});
