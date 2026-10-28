'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Store, ValidateLibrary } = require('../src/core/store.cjs');
const { PlanMediaIds, MEDIA_ID } = require('../src/core/library-identity.cjs');
function Setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory), root = store.data.activePlaylistId;
  store.Apply({ type: 'create', name: '子', parentId: root });
  const child = store.data.activePlaylistId;
  store.Apply({ type: 'add', destinationIds: [root, child], urls: 'av123' });
  return { directory, store, root, child };
}
function Legacy(h, version = 3) {
  const old = structuredClone(h.store.data); delete old.identityVersion; delete old.videoAliases;
  for (const p of old.playlists) for (const e of p.entries) delete e.mediaId;
  old.version = version;
  if (version < 3) { delete old.rootPlaylistIds; for (const p of old.playlists) delete p.childIds; }
  const bytes = Buffer.from(JSON.stringify(old)); fs.writeFileSync(h.store.file, bytes);
  return { old, bytes };
}

test('legacy hierarchy migrates once, keeps row IDs and raw bytes, and persists shared media IDs', t => {
  const h = Setup(t), { old, bytes } = Legacy(h), next = new Store(h.directory);
  assert.equal(next.data.version, 3); assert.equal(next.data.identityVersion, 2);
  const withoutIds = structuredClone(next.data); delete withoutIds.identityVersion; delete withoutIds.videoAliases;
  for (const p of withoutIds.playlists) for (const e of p.entries) delete e.mediaId;
  assert.deepEqual(withoutIds, old);
  const entries = next.data.playlists.flatMap(p => p.entries);
  assert.notEqual(entries[0].id, entries[1].id); assert.equal(entries[0].mediaId, entries[1].mediaId);
  assert.match(entries[0].mediaId, MEDIA_ID);
  const backups = fs.readdirSync(h.directory).filter(n => n.startsWith('library.pre-0.6.7-'));
  assert.equal(backups.length, 1); assert.deepEqual(fs.readFileSync(path.join(h.directory, backups[0])), bytes);
  assert.deepEqual(new Store(h.directory).data, next.data);
  assert.equal(fs.readdirSync(h.directory).filter(n => n.startsWith('library.pre-0.6.7-')).length, 1);
});

test('version 1 and 2 libraries acquire IDs while retaining the old migration backup', t => {
  for (const version of [1, 2]) {
    const h = Setup(t), { bytes } = Legacy(h, version), next = new Store(h.directory);
    assert.equal(next.data.identityVersion, 2);
    assert.ok(next.data.playlists.every(p => p.entries.every(e => MEDIA_ID.test(e.mediaId))));
    const backup = fs.readdirSync(h.directory).find(n => n.startsWith('library.pre-0.5.0-'));
    assert.deepEqual(fs.readFileSync(path.join(h.directory, backup)), bytes);
  }
});

test('copy, move, rename and reorder retain media identity while parts remain distinct', t => {
  const h = Setup(t), e = h.store.Playlist(h.root).entries[0], id = e.mediaId;
  h.store.Apply({ type: 'create', name: '移動先' }); const target = h.store.data.activePlaylistId;
  const result = h.store.Transfer({ playlistId: h.root, entryId: e.id, destinationIds: [target], mode: 'copy' });
  const copied = h.store.Entry(target, result.destinations[0].entryId);
  assert.notEqual(copied.id, e.id); assert.equal(copied.mediaId, id);
  h.store.Apply({ type: 'title', playlistId: target, entryId: copied.id, title: '変更後' });
  h.store.Apply({ type: 'rename', playlistId: target, name: '別名' });
  h.store.Apply({ type: 'add', playlistId: target, urls: 'https://www.bilibili.com/video/av123?p=2' });
  assert.notEqual(h.store.Playlist(target).entries[1].mediaId, id);
  h.store.TransferMany({ entries: [{ playlistId: target, entryId: copied.id }], destinationIds: [h.child] });
  assert.equal(h.store.Playlist(h.child).entries[0].mediaId, id);
  assert.equal(new Store(h.directory).Playlist(h.child).entries[0].mediaId, id);
});

test('local copies share their persistent ID without changing media filenames or bytes', async t => {
  const h = Setup(t), input = path.join(h.directory, 'source.mp3'); fs.writeFileSync(input, 'local bytes');
  await h.store.AddFiles([h.root, h.child], [input]);
  const local = h.store.data.playlists.flatMap(p => p.entries).filter(e => e.type === 'local');
  assert.equal(local[0].mediaId, local[1].mediaId); assert.equal(local[0].fileName, local[1].fileName);
  assert.equal(fs.readFileSync(path.join(h.store.media, local[0].fileName), 'utf8'), 'local bytes');
  const restored = new Store(h.directory).Playlist(h.root).entries.find(e => e.type === 'local');
  assert.equal(restored.mediaId, local[0].mediaId); assert.equal(restored.fileName, local[0].fileName);
  await h.store.AddFiles([h.root], [input]);
  assert.notEqual(h.store.Playlist(h.root).entries.at(-1).mediaId, local[0].mediaId);
});

test('moving a registration keeps its ID once, while additional destinations receive new registration IDs', t => {
  const h = Setup(t), source = h.store.Playlist(h.root).entries[0];
  const targets = [];
  for (const name of ['先1', '先2']) { h.store.Apply({ type: 'create', name }); targets.push(h.store.data.activePlaylistId); }
  const result = h.store.Transfer({ playlistId: h.root, entryId: source.id, destinationIds: targets, mode: 'move' });
  assert.equal(result.destinations[0].entryId, source.id);
  assert.notEqual(result.destinations[1].entryId, source.id);
  h.store.TransferMany({ entries: [{ playlistId: targets[0], entryId: source.id }], destinationIds: [h.root] });
  assert.equal(h.store.Playlist(h.root).entries[0].id, source.id);
  assert.equal(h.store.Playlist(h.root).entries[0].mediaId, source.mediaId);
  const all = new Store(h.directory).data.playlists.flatMap(p => p.entries);
  assert.equal(new Set(all.map(e => e.id)).size, all.length);
});

test('failed migration backup or final rename leaves original bytes available for retry', t => {
  for (const phase of ['backup', 'rename']) {
    const h = Setup(t), { bytes } = Legacy(h);
    const method = phase === 'backup' ? 'copyFileSync' : 'renameSync', original = fs[method];
    const mock = t.mock.method(fs, method, (...args) => {
      if (phase === 'rename' || String(args[1]).includes('pre-0.6.7-')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return original(...args);
    });
    try { assert.throws(() => new Store(h.directory)); } finally { mock.mock.restore(); }
    assert.deepEqual(fs.readFileSync(h.store.file), bytes);
    assert.ok(!fs.readdirSync(h.directory).some(n => n.endsWith('.tmp')));
    const next = new Store(h.directory); assert.equal(next.data.identityVersion, 2);
  }
});

test('failed add rolls back IDs and memory, then a retry and restart share the saved ID', t => {
  const h = Setup(t), before = h.store.Snapshot(), bytes = fs.readFileSync(h.store.file);
  const mock = t.mock.method(fs, 'renameSync', () => { throw new Error('no permission'); });
  try { assert.throws(() => h.store.Apply({ type: 'add', destinationIds: [h.root, h.child], urls: 'av456' })); }
  finally { mock.mock.restore(); }
  assert.deepEqual(h.store.Snapshot(), before); assert.deepEqual(fs.readFileSync(h.store.file), bytes);
  h.store.Apply({ type: 'add', destinationIds: [h.root, h.child], urls: 'av456' });
  const ids = new Store(h.directory).data.playlists.flatMap(p => p.entries).filter(e => e.videoId === 'av456').map(e => e.mediaId);
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
});

test('unsupported schema and conflicting IDs stop without falling back to an older backup', t => {
  for (const mode of ['future', 'future-library', 'missing', 'different-media', 'same-media']) {
    const h = Setup(t), value = structuredClone(h.store.data);
    if (mode === 'future') value.identityVersion = 3;
    if (mode === 'future-library') { value.version = 4; value.identityVersion = 3; }
    if (mode === 'missing') delete value.playlists[0].entries[0].mediaId;
    if (mode === 'different-media') value.playlists[1].entries[0].url = 'av456';
    if (mode === 'same-media') value.playlists[1].entries[0].mediaId = randomUUID();
    const bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(h.store.file, bytes);
    const bak = fs.readFileSync(h.store.file + '.bak');
    assert.throws(() => new Store(h.directory), e => e.identityDataInvalid === true);
    assert.deepEqual(fs.readFileSync(h.store.file), bytes); assert.deepEqual(fs.readFileSync(h.store.file + '.bak'), bak);
  }
});

test('identity planning is pure and legacy import IDs are safely discarded pending the new import protocol', t => {
  const h = Setup(t), original = structuredClone(h.store.data);
  assert.equal(PlanMediaIds(h.store.data.playlists, () => assert.fail('existing IDs must be reused')).size, 2);
  assert.deepEqual(h.store.data, original);
  const lists = ValidateLibrary(h.store.data, true);
  assert.ok(lists.every(p => p.entries.every(e => !Object.hasOwn(e, 'mediaId'))));
  assert.notEqual(lists[0].id, h.root);
});
