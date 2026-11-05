'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Store } = require('../src/core/store.cjs');
const Tree = require('../src/ui/library-tree.js');
const { LibraryArchive } = require('../src/core/library-archive.cjs');
const { OfflineLibrary } = require('../src/core/offline-library.cjs');
const { LiveEstimate } = require('../src/core/download-estimate.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');
const { DriveURL } = require('../src/core/releases.cjs');
function Temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-066-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function Branch(dir) {
  const store = new Store(path.join(dir, 'data')), root = store.data.activePlaylistId;
  store.Apply({ type: 'rename', playlistId: root, name: 'A' });
  const create = (name, parentId) => { store.Apply({ type: 'create', name, parentId }); return store.data.activePlaylistId; };
  const middle = create('B', root), leaf = create('C', middle), sibling = create('S', root);
  [root, middle, leaf, sibling].forEach((id, i) => store.Apply({ type: 'add', playlistId: id, urls: `av${700 + i}` }));
  return { store, root, middle, leaf, sibling };
}
async function Export(b, directory) { const file = path.join(directory, 'lists.zip'); await new LibraryArchive(b.store).Export(file); return file; }
function Destination(directory) { const store = new Store(path.join(directory, 'target')), id = store.data.activePlaylistId; store.Apply({ type: 'rename', playlistId: id, name: 'D' }); return { store, id }; }
test('066 descendant-only import retains empty ancestors below the destination and survives restart', async t => {
  const directory = Temp(t), b = Branch(directory), file = await Export(b, directory), d = Destination(directory), archive = new LibraryArchive(d.store), plan = await archive.Prepare(file);
  const result = await archive.Commit(plan.id, [b.leaf], { parentId: d.id }), lists = result.state.playlists, a = lists.find(p => p.name === 'A'), c = lists.find(p => p.name === 'C');
  assert.equal(result.imported, 3); assert.equal(result.ancestors, 2); assert.equal(a.entries.length, 0); assert.equal(lists.find(p => p.name === 'B').entries.length, 0); assert.equal(c.entries.length, 1); assert.equal(lists.some(p => p.name === 'S'), false);
  assert.deepEqual(Tree.Path(result.state, c.id).map(p => p.name), ['D', 'A', 'B', 'C']); assert.deepEqual(result.state.rootPlaylistIds, [d.id]); assert.equal(result.state.activePlaylistId, c.id);
  assert.deepEqual(new Store(d.store.directory).Snapshot().playlists, result.state.playlists);
});
test('066 parent and all-root imports include descendants and retain original sibling order', async t => {
  const directory = Temp(t), b = Branch(directory); b.store.Apply({ type: 'create', name: 'X' }); const file = await Export(b, directory), d = Destination(directory), archive = new LibraryArchive(d.store);
  let plan = await archive.Prepare(file), result = await archive.Commit(plan.id, [b.root], { parentId: d.id }); assert.equal(result.imported, 4); const a = result.state.playlists.find(p => p.name === 'A'); assert.deepEqual(a.childIds.map(id => result.state.playlists.find(p => p.id === id).name), ['B', 'S']);
  plan = await archive.Prepare(file); result = await archive.Commit(plan.id, plan.playlists.map(p => p.id)); assert.equal(result.imported, 5); assert.deepEqual(Tree.Roots(result.state).slice(-2).map(id => result.state.playlists.find(p => p.id === id).name), ['A（取り込み1）', 'X']);
});
test('066 offline media and artwork import under the chosen parent and complete retained hierarchy', async t => {
  const directory = Temp(t), b = Branch(directory), image = fs.readFileSync(path.join(__dirname, '../build/music.png'));
  const create = (dir, store) => new OfflineLibrary({ directory: path.join(dir, 'downloads'), settingsFile: path.join(dir, 'settings.json'), ffmpeg: process.execPath, libraryData: () => store.data,
    resolve: async (e, kind) => ({ url: e.url, kind, duration: 120, height: 720, streams: [{ size: 1000 }], thumbnailURL: 'https://i0.hdslb.com/cover.png' }),
    transfer: async (_f, _s, file, _u, _sig, progress) => { fs.writeFileSync(file, 'raw'); progress(3, 3); return 3; },
    assemble: async (_e, _p, _i, file) => { fs.writeFileSync(file, 'saved audio'); return 120; }, thumbnail: async () => `data:image/png;base64,${image.toString('base64')}` });
  const source = create(directory, b.store); source.Start(b.store.Playlist(b.leaf).entries, { kind: 'audio', playlistId: b.leaf, playlistName: 'C' }); await source.done; assert.equal(source.job.completed, 1);
  const file = path.join(directory, 'offline.zip'); await new LibraryArchive(b.store, source).Export(file);
  const d = Destination(directory), offline = create(path.join(directory, 'target-offline'), d.store), archive = new LibraryArchive(d.store, offline), plan = await archive.Prepare(file), result = await archive.Commit(plan.id, [b.leaf], { parentId: d.id });
  assert.equal(result.downloaded, 1); const record = [...offline.records.values()][0]; assert.equal(record.layout, 4); assert.match(record.file, /^media\/av702-p1\//);
  assert.deepEqual(Tree.Path(result.state, result.state.activePlaylistId).map(p => p.name), ['D', 'A', 'B', 'C']);
  assert.equal(fs.readFileSync(offline.File(record.token).path, 'utf8'), 'saved audio'); assert.deepEqual(fs.readFileSync(offline.ResolvePath(record.thumbnail.file)), image); assert.ok(offline.Cover(record.token));
});
test('066 invalid import parents and failed persistence leave the old graph untouched', async t => {
  const directory = Temp(t), b = Branch(directory), d = Destination(directory), file = await Export(b, directory), archive = new LibraryArchive(d.store), before = d.store.Snapshot();
  const plan = await archive.Prepare(file); await assert.rejects(archive.Commit(plan.id, [b.leaf], { parentId: 'missing' }), /見つか|存在/); assert.deepEqual(d.store.Snapshot(), before);
  d.store.Save = () => { throw new Error('disk full'); }; await assert.rejects(archive.Commit(plan.id, [b.leaf], { parentId: d.id }), /disk full/); assert.deepEqual(d.store.Snapshot(), before);
});
test('066 overlapping branch attachment and intermediate deletion keep descendants in their original position', t => {
  const b = Branch(Temp(t)); b.store.Apply({ type: 'create', name: 'D' }); const d = b.store.data.activePlaylistId;
  b.store.Apply({ type: 'playlist-attach', playlistId: d, ids: [b.root, b.leaf], removeOriginal: true }); assert.deepEqual(b.store.Playlist(d).childIds, [b.root]); assert.deepEqual(b.store.Playlist(b.middle).childIds, [b.leaf]);
  b.store.Apply({ type: 'delete', playlistId: b.middle }); assert.deepEqual(b.store.Playlist(b.root).childIds, [b.leaf, b.sibling]); assert.deepEqual(Tree.Path(b.store.data, b.leaf).map(p => p.name), ['D', 'A', 'C']);
});
test('066 home hides redundant child roots and keeps descendant search and sorting hierarchical', t => {
  const b = Branch(Temp(t)); b.store.data.rootPlaylistIds.push(b.leaf); assert.deepEqual(Tree.Roots(b.store.data), [b.root]); assert.deepEqual(Tree.Rows(b.store.data, '*').map(r => r.playlist.id), [b.root]);
  const rows = Tree.Rows(b.store.data, '*', new Set(), '702'); assert.ok(rows.some(r => r.entry?.playlistId === b.leaf)); assert.deepEqual(rows.filter(r => r.playlist).map(r => r.playlist.name), ['A', 'B', 'C']);
  b.store.data.settings.playlistSort = 'name'; assert.deepEqual(Tree.Ordered(b.store.data, b.store.Playlist(b.root).childIds), [b.middle, b.sibling]);
});
test('066 positional transfer inserts before and after, reuses a duplicate and rejects stale anchors atomically', t => {
  const b = Branch(Temp(t)), source = b.store.Playlist(b.root).entries[0], anchor = b.store.Playlist(b.leaf).entries[0];
  let result = b.store.Transfer({ playlistId: b.root, entryId: source.id, destinationIds: [b.leaf], mode: 'copy', targetId: anchor.id, after: false }); const copy = b.store.Playlist(b.leaf).entries[0]; assert.equal(result.added, 1); assert.deepEqual(b.store.Playlist(b.leaf).entries.map(e => e.id), [copy.id, anchor.id]);
  result = b.store.Transfer({ playlistId: b.root, entryId: source.id, destinationIds: [b.leaf], mode: 'move', targetId: anchor.id, after: true }); assert.equal(result.skipped, 1); assert.deepEqual(b.store.Playlist(b.leaf).entries.map(e => e.id), [anchor.id, copy.id]); assert.equal(b.store.Playlist(b.root).entries.length, 0);
  const before = b.store.Snapshot(); assert.throws(() => b.store.Transfer({ playlistId: b.leaf, entryId: copy.id, destinationIds: [b.root], mode: 'move', targetId: anchor.id }), /挿入/); assert.deepEqual(b.store.Snapshot(), before);
});
test('066 live estimates project unknown durations, skip existing media and exclude completed capacity', () => {
  const entries = [100, 200, 100].map((duration, i) => ({ ...ParseBilibili(`av${800 + i}`), duration })), estimate = new LiveEstimate(entries, { kind: 'audio', height: 360 }, '/downloads');
  assert.equal(estimate.Snapshot().projected, false); estimate.Observe(entries[0], { duration: 100, streams: [{ size: 1000000 }] }); let value = estimate.Snapshot(); assert.equal(value.checked, 1); assert.equal(value.projected, true); assert.equal(value.downloadBytes, 4000000 + 2 * 256 * 1024);
  estimate.Saved(entries[1], {}, true); estimate.Completed(entries[0], 900000, false); estimate.Failed(entries[2]); value = estimate.Snapshot(); assert.equal(value.skipped, 1); assert.equal(value.unknown, 1); assert.equal(value.downloadBytes, 900000); assert.equal(value.requiredBytes, 0);
  const covers = new LiveEstimate([entries[0]], { kind: 'audio' }, '/downloads'); covers.Saved(entries[0], {}, false); assert.equal(covers.Snapshot().requiredBytes, 3 * 1024 * 1024); covers.Finished(entries[0]); assert.equal(covers.Snapshot().requiredBytes, 0);
});
test('066 pending whole-list estimation is aborted and does not delay the first actual transfer', async t => {
  const directory = Temp(t), entries = [901, 902, 903, 904].map(n => ({ ...ParseBilibili(`av${n}`), duration: 10 })); let calls = 0, started, release;
  const first = new Promise(resolve => started = resolve), held = new Promise(resolve => release = resolve);
  const library = new OfflineLibrary({ directory: path.join(directory, 'downloads'), settingsFile: path.join(directory, 'settings.json'), ffmpeg: process.execPath,
    resolve: (entry, kind, signal, { height }) => ++calls === 1 ? new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) : Promise.resolve({ url: entry.url, kind, height, duration: 10, streams: [{ size: 1048576 }] }),
    transfer: async (_f, _s, file, _u, signal, progress) => { fs.writeFileSync(file, 'raw'); progress(3, 1048576); started(); await held; signal.throwIfAborted(); return 3; }, assemble: async (_e, _p, _f, file) => { fs.writeFileSync(file, 'saved'); return 10; } });
  const pending = library.Estimate(entries, { kind: 'audio', height: 360, playlistId: 'p' }), rejected = assert.rejects(pending, /abort/i); library.Start(entries, { kind: 'audio', height: 360, playlistId: 'p' }); await first; await rejected;
  assert.ok(calls < entries.length + 1); assert.ok(library.Snapshot().job.estimate.checked > 0); assert.equal(library.job.finished, 0); release(); await library.done; assert.equal(library.job.completed, 4); assert.equal(calls, 5);
});
test('066 Drive update URL validates HTTPS and host and settings survive restart', t => {
  const directory = Temp(t), store = new Store(directory), url = 'https://drive.google.com/drive/folders/test'; assert.equal(DriveURL(''), 'https://drive.google.com/drive/u/0/my-drive'); store.Apply({ type: 'settings', settings: { releaseDriveURL: url } }); assert.equal(new Store(directory).data.settings.releaseDriveURL, url);
  for (const bad of ['https://github.com/user/repo', 'http://drive.google.com/drive', 'https://drive.google.com.evil.test/folder', 'file:///tmp/a', 'https://user:pass@drive.google.com/folder']) assert.throws(() => DriveURL(bad), /Drive|drive/);
});
