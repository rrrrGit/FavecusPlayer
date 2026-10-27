'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const Tree = require('../src/ui/library-tree.js');
function Setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-tree-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Store(dir), a = s.data.activePlaylistId;
  const create = (name, parentId) => { s.Apply({ type: 'create', name, parentId }); return s.data.activePlaylistId; };
  const b = create('子', a), c = create('孫', b), d = create('別の最上位');
  for (const [id, urls] of [[a, 'av1\nav2'], [b, 'av3'], [c, 'av4'], [d, 'av5\nav1']]) s.Apply({ type: 'add', playlistId: id, urls });
  return { dir, s, a, b, c, d };
}
test('hierarchy flattens own rows then ordered descendants and all-library playback deduplicates references and URLs', t => {
  const { s, a, b, c, d, dir } = Setup(t);
  assert.deepEqual(s.Entries(a).map(e => e.videoId), ['av1', 'av2', 'av3', 'av4']);
  s.Apply({ type: 'playlist-attach', playlistId: d, ids: [b], removeOriginal: false });
  assert.deepEqual(s.Entries('*').map(e => e.videoId), ['av1', 'av2', 'av3', 'av4', 'av5']);
  assert.deepEqual(s.data.rootPlaylistIds, [a, d]);
  const reloaded = new Store(dir); assert.deepEqual(reloaded.Playlist(b).childIds, [c]); assert.deepEqual(reloaded.Playlist(d).childIds, [b]);
});
test('moving, referencing, sibling order and delete retain reachable descendants and reject cycles atomically', t => {
  const { s, a, b, c, d } = Setup(t), before = s.Snapshot();
  for (const parentId of [a, b, c]) assert.throws(() => s.Apply({ type: 'playlist-move', playlistId: a, parentId }), /子孫/);
  assert.deepEqual(s.Snapshot(), before);
  assert.throws(() => s.Apply({ type: 'playlist-attach', playlistId: c, ids: [d, a], removeOriginal: true }), /子孫/);
  assert.deepEqual(s.Snapshot(), before);
  s.Apply({ type: 'playlist-reorder', playlistId: d, targetId: a }); assert.deepEqual(s.data.rootPlaylistIds, [d, a]);
  s.Apply({ type: 'playlist-attach', playlistId: d, ids: [b], removeOriginal: false });
  s.Apply({ type: 'playlist-move', playlistId: b, parentId: null });
  assert.deepEqual(s.Playlist(a).childIds, []); assert.deepEqual(s.Playlist(d).childIds, []); assert.ok(s.data.rootPlaylistIds.includes(b));
  s.Apply({ type: 'delete', playlistId: b }); assert.ok(s.data.rootPlaylistIds.includes(c)); Tree.ValidateGraph(s.data.playlists, s.data.rootPlaylistIds);
});
test('0.4.x data migrates without changing row IDs, settings, titles or raw backup bytes', t => {
  const { s, dir } = Setup(t), old = s.Snapshot(); old.version = 2; delete old.rootPlaylistIds; for (const p of old.playlists) delete p.childIds;
  const raw = Buffer.from(JSON.stringify(old)); fs.writeFileSync(s.file, raw); const next = new Store(dir);
  assert.equal(next.data.version, 3); assert.deepEqual(next.data.rootPlaylistIds, old.playlists.map(p => p.id));
  assert.deepEqual(next.data.playlists.flatMap(p => p.entries), old.playlists.flatMap(p => p.entries)); assert.deepEqual(next.data.settings, old.settings);
  const backups = fs.readdirSync(dir).filter(n => n.startsWith('library.pre-0.5.0-')); assert.equal(backups.length, 1); assert.deepEqual(fs.readFileSync(path.join(dir, backups[0])), raw);
  new Store(dir); assert.equal(fs.readdirSync(dir).filter(n => n.startsWith('library.pre-0.5.0-')).length, 1);
});
test('multi-track move is atomic, retains duration, shares media and does not erase tracks on a failed save', t => {
  const { s, a, b, d } = Setup(t), entries = s.Playlist(a).entries.map(e => ({ playlistId: a, entryId: e.id }));
  s.Playlist(a).entries[0].duration = 222;
  const before = s.Snapshot(), save = s.Save; s.Save = () => { throw new Error('disk full'); };
  assert.throws(() => s.TransferMany({ entries, destinationIds: [b, d] }), /disk full/); assert.deepEqual(s.Snapshot(), before); s.Save = save;
  const result = s.TransferMany({ entries, destinationIds: [b, d] }); assert.equal(result.moved, 2); assert.equal(s.Playlist(a).entries.length, 0); assert.equal(s.Playlist(b).entries.find(e => e.videoId === 'av1').duration, 222);
});
test('multi-track move keeps final destinations valid when selected sources are also destinations', t => {
  const { s, a, d, dir } = Setup(t);
  const entries = [a, d].map(playlistId => ({ playlistId, entryId: s.Playlist(playlistId).entries.find(e => e.videoId === 'av1').id }));
  const result = s.TransferMany({ entries, destinationIds: [a, d] });
  for (const id of [a, d]) assert.equal(s.Playlist(id).entries.filter(e => e.videoId === 'av1').length, 1);
  const reloaded = new Store(dir);
  for (const mapping of result.mappings) for (const target of mapping.destinations) assert.equal(reloaded.Entry(target.playlistId, target.entryId).videoId, 'av1');
  assert.deepEqual(s.Playlist(a).entries.map(e => e.videoId), ['av2', 'av1']);
  assert.deepEqual(s.Playlist(d).entries.map(e => e.videoId), ['av5', 'av1']);
});
test('playlist paths preserve real roots and resolve shared children through the playing scope', t => {
  const { s, a, b, c, d } = Setup(t), ids = (target, scope) => Tree.Path(s.data, target, scope).map(p => p.id);
  assert.deepEqual(ids(c), [a, b, c]); assert.deepEqual(ids(a), [a]); assert.deepEqual(ids('missing'), []);
  s.Apply({ type: 'playlist-attach', playlistId: d, ids: [b], removeOriginal: false });
  assert.deepEqual(ids(c, d), [d, b, c]); assert.deepEqual(ids(c, '*'), [a, b, c]); assert.deepEqual(ids(c, b), [a, b, c]);
  assert.deepEqual(ids(a, d), [a]); assert.deepEqual(ids(c, 'removed'), [a, b, c]);
  s.Apply({ type: 'playlist-move', playlistId: b, parentId: d }); assert.deepEqual(ids(c, a), [d, b, c]);
});
