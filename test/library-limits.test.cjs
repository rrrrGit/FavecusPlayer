'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Store, MAX_PLAYLISTS, ValidateLibrary } = require('../src/core/store.cjs');
const { LibraryArchive } = require('../src/core/library-archive.cjs');
const { AdditionReview } = require('../src/core/addition-review.cjs');
const { OfflineLibrary, Key } = require('../src/core/offline-library.cjs');
function Setup(t, count = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-limits-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, 'data')), first = store.data.playlists[0];
  const others = Array.from({ length: count - 1 }, (_, n) => ({ ...first, id: randomUUID(), name: `子${n + 1}`, entries: [], childIds: [] }));
  first.childIds = others.map(p => p.id); store.data.playlists = [first, ...others]; store.Save();
  return { dir, store, ids: store.data.playlists.map(p => p.id) };
}
function Offline(dir) { return new OfflineLibrary({ directory: path.join(dir, 'downloads'), settingsFile: path.join(dir, 'download-settings.json'), ffmpeg: process.execPath, fetch: () => assert.fail('no network') }); }
function Seed(offline, entry) {
  const file = `media/${entry.videoId}-p${entry.part}/video-${randomUUID()}.mp4`, token = Key(entry.url, 'video') + '.mp4';
  fs.mkdirSync(path.dirname(offline.ResolvePath(file)), { recursive: true }); fs.writeFileSync(offline.ResolvePath(file), 'saved');
  offline.CommitRecord({ token, file, kind: 'video', layout: 4, aliases: [entry.url], url: entry.url, bytes: 5, height: 720 }); return token;
}
test('067 the 999th playlist survives restart with hierarchy, identities, settings and saved media, and the 1000th leaves files unchanged', async t => {
  const h = Setup(t, 998), s = h.store, root = h.ids[0]; assert.equal(MAX_PLAYLISTS, 999);
  s.Apply({ type: 'add', playlistId: root, urls: 'https://www.bilibili.com/video/av123/?p=2' });
  const local = path.join(h.dir, 'music.mp3'); fs.writeFileSync(local, 'local'); await s.AddFiles([h.ids.at(-1)], [local]);
  s.Apply({ type: 'settings', settings: { volume: .37, shuffle: true } }); s.Apply({ type: 'create', name: '999個目', parentId: h.ids.at(-1) });
  const offline = Offline(h.dir), entry = s.Playlist(root).entries[0], token = Seed(offline, entry), before = s.Snapshot(), bytes = fs.readFileSync(s.file), cache = fs.readFileSync(path.join(offline.directory, 'index.json'));
  assert.equal(before.playlists.length, 999); assert.throws(() => s.Apply({ type: 'create', name: '1000個目' }), /999個/); assert.deepEqual(s.Snapshot(), before); assert.deepEqual(fs.readFileSync(s.file), bytes); assert.deepEqual(fs.readFileSync(path.join(offline.directory, 'index.json')), cache);
  const restarted = new Store(s.directory); assert.deepEqual(restarted.Snapshot(), before); assert.equal(restarted.warning, ''); const saved = Offline(h.dir).Find(entry, 'video'); assert.equal(saved.token, token); assert.equal(fs.readFileSync(saved.path, 'utf8'), 'saved');
});
test('067 over-limit saves and startup data are rejected without replacing the library or its backup', t => {
  const h = Setup(t, 999), s = h.store, before = fs.readFileSync(s.file), backup = fs.readFileSync(s.file + '.bak');
  s.data.playlists.push({ ...s.data.playlists[1], id: randomUUID(), entries: [], childIds: [] }); s.data.rootPlaylistIds.push(s.data.playlists.at(-1).id);
  assert.throws(() => s.Save(), /999個/); assert.deepEqual(fs.readFileSync(s.file), before);
  fs.writeFileSync(s.file, JSON.stringify(s.data)); const oversized = fs.readFileSync(s.file), files = fs.readdirSync(s.directory).sort();
  assert.throws(() => new Store(s.directory), /999個/); assert.deepEqual(fs.readFileSync(s.file), oversized); assert.deepEqual(fs.readFileSync(s.file + '.bak'), backup); assert.deepEqual(fs.readdirSync(s.directory).sort(), files);
});
test('067 999 destinations, 998 single-track destinations and large list attachment keep URL and track limits separate', async t => {
  const h = Setup(t, 999), s = h.store, [root, ...others] = h.ids, review = new AdditionReview(s);
  const plan = await review.Prepare({ type: 'add', destinationIds: h.ids, urls: 'av123' }); await review.Commit(plan.id, []); assert.ok(s.data.playlists.every(p => p.entries.length === 1)); assert.equal(s.Targets(h.ids).length, 999);
  s.Apply({ type: 'add', playlistId: root, urls: 'av456' }); const entry = s.Playlist(root).entries.at(-1);
  const transfer = s.Transfer({ playlistId: root, entryId: entry.id, destinationIds: others, mode: 'copy' }); assert.equal(transfer.destinations.length, 998); assert.equal(s.Playlist(others.at(-1)).entries.at(-1).mediaId, entry.mediaId);
  s.Apply({ type: 'add', playlistId: root, urls: 'av789' }); const move = s.Playlist(root).entries.at(-1); s.TransferMany({ entries: [{ playlistId: root, entryId: move.id }], destinationIds: others }); assert.equal(s.Playlist(root).entries.some(e => e.id === move.id), false); assert.equal(s.Playlist(others.at(-1)).entries.at(-1).url, move.url);
  s.Apply({ type: 'playlist-attach', playlistId: root, ids: others, removeOriginal: true }); assert.equal(s.Playlist(root).childIds.length, 998); assert.equal(s.data.playlists.length, 999);
  const before = s.Snapshot(); assert.throws(() => s.Targets([...h.ids, root])); assert.throws(() => s.Transfer({ playlistId: root, entryId: entry.id, destinationIds: [...others, others[0]], mode: 'copy' })); assert.throws(() => s.Apply({ type: 'playlist-attach', playlistId: root, ids: Array(1000).fill(others[0]) }));
  assert.throws(() => s.InputItems({ type: 'add', urls: Array.from({ length: 101 }, (_, i) => `av${i + 1}`).join('\n') }), /100件/);
  await assert.rejects(review.Prepare({ type: 'add', destinationIds: h.ids, urls: Array.from({ length: 11 }, (_, i) => `av${i + 1000}`).join('\n') }), /10000/);
  assert.throws(() => ValidateLibrary({ ...s.data, playlists: [{ ...s.Playlist(root), entries: Array(10001).fill(entry), childIds: [] }], rootPlaylistIds: [root] })); assert.deepEqual(s.Snapshot(), before);
});
for (const [mode, extension] of [['information', 'json'], ['information', 'zip'], ['media', 'zip']]) test(`067 ${mode} ${extension} accepts 999 source lists and retries a 1000-total import with 998 lists including ancestors`, async t => {
  const source = Setup(t, 999), target = Setup(t), [root, first, ...rest] = source.ids;
  source.store.Apply({ type: 'add', playlistId: root, urls: 'av900' }); source.store.Apply({ type: 'add', playlistId: first, urls: 'https://www.bilibili.com/video/av123/?p=2' });
  const local = path.join(source.dir, 'music.mp3'); fs.writeFileSync(local, 'local'); await source.store.AddFiles([first], [local]);
  const sourceOffline = Offline(source.dir), targetOffline = Offline(target.dir); Seed(sourceOffline, source.store.Playlist(first).entries[0]);
  const file = path.join(source.dir, `shared.${extension}`); await new LibraryArchive(source.store, sourceOffline).Export(file, undefined, { mode });
  const archive = new LibraryArchive(target.store, targetOffline), plan = await archive.Prepare(file), before = target.store.Snapshot(), bytes = fs.readFileSync(target.store.file); assert.equal(plan.playlists.length, 999);
  await assert.rejects(archive.Commit(plan.id, source.ids), /999個/); assert.deepEqual(target.store.Snapshot(), before); assert.deepEqual(fs.readFileSync(target.store.file), bytes); assert.equal(targetOffline.records.size, 0);
  const selection = [first, ...rest.slice(0, -1)], result = await archive.Commit(plan.id, selection, { parentId: target.ids[0] }); assert.equal(selection.length, 997); assert.equal(result.imported, 998); assert.equal(result.ancestors, 1); assert.equal(result.state.playlists.length, 999);
  const parent = target.store.Playlist(root), child = target.store.Playlist(first); assert.equal(parent.entries.length, 0); assert.equal(parent.childIds.length, 997); assert.ok(target.store.Playlist(target.ids[0]).childIds.includes(root)); assert.equal(child.entries[0].part, 2); assert.equal(child.entries[1].missing, undefined); assert.equal(target.store.Snapshot().playlists.find(p => p.id === first).entries[1].missing, mode === 'information'); assert.equal(targetOffline.records.size, mode === 'media' ? 1 : 0);
  const restarted = new Store(target.store.directory); assert.deepEqual(restarted.Snapshot(), target.store.Snapshot()); assert.ok(fs.existsSync(path.join(restarted.media, child.entries[1].fileName)) === (mode === 'media'));
  await archive.Cancel(plan.id);
});
test('067 legacy JSON imports more than 100 lists through the compatibility entry point', async t => {
  const source = Setup(t, 998), target = Setup(t), file = path.join(source.dir, 'legacy.json');
  const data = source.store.Snapshot(); data.version = 1; delete data.identityVersion; delete data.videoAliases; fs.writeFileSync(file, JSON.stringify(data));
  await target.store.Import(file); assert.equal(target.store.data.playlists.length, 999); assert.equal(new Store(target.store.directory).data.playlists.length, 999);
});
