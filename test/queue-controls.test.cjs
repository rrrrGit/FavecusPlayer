'use strict';
// PC版：再生キューの並べ替え・ジャンプが、共通のQueueから、IPC・画面まで接続されていること。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { Queue } = require('../src/core/queue.cjs');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('queue controls are wired from the UI through the preload and IPC to the shared Queue', () => {
  const main = read('src/main.cjs'), preload = read('src/preloads/ui.cjs'), app = read('src/ui/app.js');
  assert.match(preload, /queueReorder: invoke\('queue:reorder'\)/);
  assert.match(preload, /queueJump: invoke\('queue:jump'\)/);
  assert.match(main, /Handle\('queue:reorder'/);
  assert.match(main, /Handle\('queue:jump'/);
  assert.match(main, /next\.Reorder\(/);
  assert.match(main, /next\.JumpTo\(/);
  assert.match(app, /api\.queueReorder\(/);
  assert.match(app, /api\.queueJump\(/);
});

test('reordering and jumping work on a cloned queue and leave the original untouched when refused', () => {
  const entries = ['a', 'b', 'c', 'd'].map(id => ({ id, playlistId: 'p' }));
  const queue = new Queue(null, () => 1, () => 0);
  queue.Start('p', entries, 'a', false);
  const copy = queue.Clone();
  assert.equal(copy.Reorder(0, 2), true);
  assert.deepEqual(copy.Upcoming(), ['c', 'd', 'b']);
  assert.deepEqual(queue.Upcoming(), ['b', 'c', 'd'], '元のキューは変わらない');
  assert.equal(queue.Clone().Reorder(0, 9), false);
  const jump = queue.Clone();
  assert.equal(jump.JumpTo('d'), 'd');
  assert.equal(jump.JumpTo('a'), null, '再生済みの曲へは移らない');
});

const E = id => ({ id, playlistId: 'p', title: id });
function started(ids = ['a', 'b', 'c', 'd'], current = 'a') {
  const queue = new Queue(null, () => 1, () => 0);
  queue.Start('p', ids.map(E), current, false);
  return queue;
}

test('play next puts the song right after the current one and add-to-end puts it last', () => {
  const queue = started();
  assert.equal(queue.PlayNext(E('d')), true);
  assert.deepEqual(queue.Upcoming(), ['d', 'b', 'c']);
  assert.equal(queue.AddToEnd(E('b')), true);
  assert.deepEqual(queue.Upcoming(), ['d', 'c', 'b']);
  assert.equal(queue.PlayNext(E('a')), false, '再生中の曲は、動かさない');
  assert.equal(queue.PlayNext({}), false);
  assert.equal(queue.Move(1, 'off'), 'd', '次に再生した曲が、次に鳴る');
});

test('a song already played moves behind the current one without breaking the position', () => {
  const queue = started(['a', 'b', 'c', 'd'], 'c');
  assert.equal(queue.PlayNext(E('a')), true);
  assert.equal(queue.ids[queue.index], 'c');
  assert.deepEqual(queue.Upcoming(), ['a', 'd']);
});

test('a song from another playlist can be queued and survives a sync of the playing list', () => {
  const queue = started();
  assert.equal(queue.PlayNext({ id: 'x', playlistId: 'other', title: 'x' }), true);
  assert.deepEqual(queue.Upcoming(), ['x', 'b', 'c', 'd']);
  queue.Sync('p', ['a', 'b', 'c', 'd'].map(E), 'a', false);
  assert.ok(queue.Upcoming().includes('x'), '再生範囲の同期のあとも、足した曲は残る');
  assert.equal(queue.ids[queue.index], 'a');
  assert.equal(queue.Move(1, 'off'), 'x');
  queue.Sync('p', ['a', 'b', 'c', 'd'].map(E), 'x', false); // 足した曲を再生中でも、止まらない
  assert.equal(queue.ids[queue.index], 'x');
});

test('inserting changes only a clone when the caller clones, and the shared entry point works', () => {
  const App = require('../src/core/library-app.cjs');
  assert.equal(typeof App.QueueInsert, 'function');
  const queue = started();
  const copy = queue.Clone();
  copy.PlayNext(E('c'));
  assert.deepEqual(queue.Upcoming(), ['b', 'c', 'd']);
  assert.deepEqual(copy.Upcoming(), ['c', 'b', 'd']);
});

test('play next and add-to-end are wired through the preload, IPC and the song menu, and stepping can reach songs from other lists', () => {
  const main = read('src/main.cjs'), preload = read('src/preloads/ui.cjs'), app = read('src/ui/app.js');
  assert.match(preload, /queueInsert: invoke\('queue:insert'\)/);
  assert.match(main, /Handle\('queue:insert'/);
  assert.match(main, /AddToEnd\(/);
  assert.match(main, /PlayNext\(/);
  assert.match(main, /nextQueue\.catalog\.get\(id\)/, '曲送りは、ほかのリストから足した曲も再生できる');
  assert.match(app, /api\.queueInsert\(/);
});
