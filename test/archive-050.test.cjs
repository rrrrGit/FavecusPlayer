'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { LibraryArchive } = require('../src/core/library-archive.cjs');
const { ZipReader, WriteZip } = require('../src/core/zip.cjs');
function Setup(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-archive-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return { dir, store: new Store(path.join(dir, 'data')) }; }
test('encrypted per-playlist archive imports selected hierarchy only and restores shared local bytes', async t => {
  const { dir, store } = Setup(t), root = store.data.activePlaylistId;
  store.Apply({ type: 'create', name: '子', parentId: root }); const child = store.data.activePlaylistId;
  const media = path.join(dir, 'audio.mp3'); fs.writeFileSync(media, Buffer.from('test media'));
  await store.AddFiles([root, child], [media]); store.Apply({ type: 'add-videos', playlistId: child, videos: [{ url: 'av123', title: '音楽', duration: 223 }] });
  const archive = new LibraryArchive(store), file = path.join(dir, 'export.zip'); await archive.Export(file, 'test-password');
  const zip = await new ZipReader().Open(file); assert.ok(zip.entries.has('playlists.fvpa')); assert.equal([...zip.entries.keys()].filter(n => n.startsWith('media/')).length, 1);
  assert.equal((await zip.Content('playlists.fvpa')).includes(Buffer.from('音楽')), false); await zip.Close();
  const plan = await archive.Prepare(file, 'test-password'); assert.equal(plan.playlists.length, 2);
  const result = await archive.Commit(plan.id, [root, child]); assert.equal(result.imported, 2);
  const parent = result.state.playlists.find(p => p.name === 'お気に入り（取り込み1）'), nested = result.state.playlists.find(p => p.name === '子（取り込み1）');
  assert.deepEqual(parent.childIds, [nested.id]); assert.equal(parent.entries[0].fileName, nested.entries[0].fileName); assert.equal(nested.entries[1].duration, 223);
  assert.deepEqual(fs.readFileSync(path.join(store.media, parent.entries[0].fileName)), Buffer.from('test media'));
  const partial = await archive.Prepare(file, 'test-password'); const only = await archive.Commit(partial.id, [child]); const newChild = only.state.playlists.at(-1); assert.equal(only.imported, 2); assert.equal(only.state.rootPlaylistIds.includes(newChild.id), false); assert.equal(only.state.playlists.at(-2).entries.length, 0); assert.deepEqual(only.state.playlists.at(-2).childIds, [newChild.id]);
  const parentOnly = await archive.Prepare(file, 'test-password'); const last = await archive.Commit(parentOnly.id, [root]); assert.equal(last.imported, 2); assert.deepEqual(last.state.playlists.at(-2).childIds, [last.state.playlists.at(-1).id]);
});
test('wrong password, authenticated tamper, invalid ZIP and empty selection leave user data untouched', async t => {
  const { dir, store } = Setup(t), archive = new LibraryArchive(store), file = path.join(dir, 'export.zip'), before = store.Snapshot();
  await archive.Export(file, 'test-password'); await assert.rejects(archive.Prepare(file, 'wrong-password'), /パスワード/); assert.deepEqual(store.Snapshot(), before);
  const zip = await new ZipReader().Open(file), encrypted = await zip.Content('playlists.fvpa'); await zip.Close(); encrypted[encrypted.length - 1] ^= 1;
  const tampered = path.join(dir, 'bad.zip'); await WriteZip(tampered, [{ name: 'playlists.fvpa', data: encrypted }]); await assert.rejects(archive.Prepare(tampered, 'test-password'), /破損/);
  const plan = await archive.Prepare(file, 'test-password'); await assert.rejects(archive.Commit(plan.id, []), /選んで/); await archive.Cancel(plan.id); assert.deepEqual(store.Snapshot(), before);
});
test('archive save failure rolls back newly copied media and keeps the previous library', async t => {
  const { dir, store } = Setup(t), archive = new LibraryArchive(store), file = path.join(dir, 'export.zip');
  const media = path.join(dir, 'sound.mp3'); fs.writeFileSync(media, 'audio'); await store.AddFiles([store.data.activePlaylistId], [media]);
  await archive.Export(file, 'test-password'); const plan = await archive.Prepare(file, 'test-password'), before = store.Snapshot(), files = fs.readdirSync(store.media);
  store.Save = () => { throw new Error('disk full'); }; await assert.rejects(archive.Commit(plan.id, plan.playlists.map(p => p.id)), /disk full/);
  assert.deepEqual(store.Snapshot(), before); assert.deepEqual(fs.readdirSync(store.media), files);
});
test('0.5.1 export and selective import need no password and reject altered metadata', async t => {
  const { dir, store } = Setup(t), archive = new LibraryArchive(store), file = path.join(dir, 'automatic.zip');
  store.Apply({ type: 'add', playlistId: store.data.activePlaylistId, urls: 'av123' });
  await archive.Export(file); const plan = await archive.Prepare(file);
  const result = await archive.Commit(plan.id, plan.playlists.map(p => p.id)); assert.equal(result.imported, 1);
  const zip = await new ZipReader().Open(file), bytes = await zip.Content('playlists.fvpa'); await zip.Close();
  assert.equal(bytes.subarray(0, 8).toString(), 'FVPA0002'); bytes[bytes.length - 1] ^= 1;
  const bad = path.join(dir, 'bad-automatic.zip'); await WriteZip(bad, [{ name: 'playlists.fvpa', data: bytes }]);
  const before = store.Snapshot(); await assert.rejects(archive.Prepare(bad), /破損/); assert.deepEqual(store.Snapshot(), before);
  const legacy = path.join(dir, 'legacy.zip'); await archive.Export(legacy, 'legacy-password');
  await assert.rejects(archive.Prepare(legacy), /自動で復号できません/); assert.equal(archive.plans.size, 0);
});
