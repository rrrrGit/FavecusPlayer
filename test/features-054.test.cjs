'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store, ValidateLibrary, ValidateSettings } = require('../src/core/store.cjs');
const Tree = require('../src/ui/library-tree.js'), Keys = require('../src/ui/keybindings.js');
const { Queue } = require('../src/core/queue.cjs');
function Library(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-054-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, store: new Store(root) }; }
test('playlist sorting handles natural numbers, Latin, kana, descendant counts, activity and creation dates without mutating manual order', t => {
  const { store: s } = Library(t), ids = [];
  for (const name of ['10曲', '2曲', 'Zoo', 'apple', 'かき', 'アオ']) { s.Apply({ type: 'create', name }); ids.push(s.data.activePlaylistId); }
  const manual = [...s.data.rootPlaylistIds]; assert.deepEqual(Tree.Ordered(s.data, ids, 'name').map(id => s.Playlist(id).name), ['2曲', '10曲', 'apple', 'Zoo', 'アオ', 'かき']);
  s.Apply({ type: 'create', name: '子', parentId: ids[3] }); const child = s.data.activePlaylistId; s.Apply({ type: 'add', playlistId: child, urls: 'av123\nav456' });
  assert.equal(Tree.Ordered(s.data, ids, 'count-desc')[0], ids[3]); assert.equal(Tree.Ordered(s.data, ids, 'added')[0], ids[3]);
  ids.forEach((id, index) => s.Playlist(id).createdAt = `2026-09-${String(10 + index).padStart(2, '0')}T00:00:00Z`);
  assert.equal(Tree.Ordered(s.data, ids, 'created-desc')[0], ids.at(-1)); assert.equal(Tree.Ordered(s.data, ids, 'created-asc')[0], ids[0]); assert.deepEqual(s.data.rootPlaylistIds, manual);
  s.Apply({ type: 'settings', settings: { playlistSort: 'name' } }); assert.deepEqual(Tree.Walk(s.data).filter(p => ids.includes(p.id)).map(p => p.name), ['2曲', '10曲', 'apple', 'Zoo', 'アオ', 'かき']);
});
test('participation excludes a branch only from global playback, permits another enabled shared path and survives reload', t => {
  const { store: s, root } = Library(t), parent = s.data.activePlaylistId;
  s.Apply({ type: 'create', name: '子', parentId: parent }); const child = s.data.activePlaylistId; s.Apply({ type: 'add', playlistId: child, urls: 'av123' });
  s.Apply({ type: 'playlist-properties', playlistId: parent, includeInAll: false }); assert.equal(s.Entries('*').length, 0); assert.equal(s.Entries(parent).length, 1);
  s.Apply({ type: 'create', name: '別の親' }); const other = s.data.activePlaylistId; s.Apply({ type: 'playlist-attach', playlistId: other, ids: [child], removeOriginal: false }); assert.equal(s.Entries('*').length, 1);
  s.Apply({ type: 'playlist-properties', playlistId: child, includeInAll: false }); assert.equal(s.Entries('*').length, 0); assert.equal(s.Entries(child).length, 1);
  assert.equal(new Store(root).Playlist(child).includeInAll, false);
});
test('legacy playlists retain unknown creation dates and order while imports preserve new properties', t => {
  const { store: s, root } = Library(t); const original = s.Snapshot();
  delete original.playlists[0].createdAt; delete original.playlists[0].includeInAll; fs.writeFileSync(s.file, JSON.stringify(original));
  const old = new Store(root); assert.equal(old.data.playlists[0].createdAt, ''); assert.equal(old.data.playlists[0].includeInAll, true); assert.equal(old.data.playlists[0].id, original.playlists[0].id);
  old.Apply({ type: 'playlist-properties', playlistId: original.playlists[0].id, includeInAll: false }); const imported = ValidateLibrary(old.Snapshot(), true); assert.equal(imported[0].includeInAll, false); assert.equal(imported[0].createdAt, '');
});
test('keybindings validate duplicates, support modified keys and repeat only continuous actions', () => {
  const bindings = Keys.Validate(); assert.equal(Keys.Action(bindings, { code: 'ArrowRight' }), 'forward'); assert.equal(Keys.Action(bindings, { code: 'ArrowLeft', shiftKey: true }), 'previous');
  assert.equal(Keys.Action(bindings, { code: 'ArrowUp', repeat: true }), 'volumeUp'); assert.equal(Keys.Action(bindings, { code: 'Space', repeat: true }), null);
  assert.equal(Keys.Action(bindings, { code: 'ArrowUp', isComposing: true }), null); assert.equal(Keys.Action(bindings, { code: 'ArrowRight', ctrlKey: true }), null);
  assert.throws(() => Keys.Validate({ next: 'ArrowRight' }), /同じキー/); assert.throws(() => Keys.Validate({ next: 'not a key' }));
  const custom = ValidateSettings({ keybindings: { toggle: 'Ctrl+KeyP', next: '' } }).keybindings; assert.equal(Keys.Action(custom, { code: 'KeyP', ctrlKey: true }), 'toggle'); assert.equal(Keys.Action(custom, { code: 'ArrowRight', shiftKey: true }), null);
});
test('preview plans real next tracks across shuffle cycles and remains stable when repeatedly opened', () => {
  for (const size of [1, 2, 6]) {
    const q = new Queue(() => .5), entries = Array.from({ length: size }, (_, i) => ({ id: String(i), title: `曲${i}` })); q.ShuffleStart('p', entries);
    for (let turn = 0; turn < 8; turn++) {
      const future = q.Timeline('all').upcoming.slice(0, 3); assert.equal(future.length, 3); assert.deepEqual(q.Timeline('all').upcoming.slice(0, 3), future);
      const copy = q.Clone(); assert.deepEqual(Array.from({ length: 3 }, () => copy.Move(1, 'all')), future);
      const old = q.ids[q.index]; q.Move(1, 'all'); assert.equal(q.Timeline('all').history.at(-1), old);
    }
  }
});
test('history contains only visited tracks and read-only queue preview does not move the playhead', () => {
  const q = new Queue(), entries = 'abcd'.split('').map(id => ({ id, title: id })); q.Start('p', entries, 'c', false);
  assert.deepEqual(q.Timeline('off'), { history: [], current: 'c', upcoming: ['d'] }); q.Move(-1, 'off'); assert.deepEqual(q.Timeline('off').history, ['c']);
  assert.deepEqual(q.Timeline('one').upcoming, ['b', 'b', 'b']); assert.equal(q.ids[q.index], 'b');
  q.Start('p', entries, 'a', false); assert.deepEqual(q.history, []);
});
