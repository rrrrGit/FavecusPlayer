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
