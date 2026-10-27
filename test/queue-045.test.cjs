'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Queue } = require('../src/core/queue.cjs');
const Entries = ids => ids.split('').map(id => ({ id }));
function RNG(seed = 17) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
test('shuffle starts from the selected row, never redraws within that traversal, and edits preserve played history', () => {
  const q = new Queue(RNG()); q.Start('p', Entries('abcdef'), 'c', true);
  const first = q.ids.slice(); assert.equal(first[0], 'c'); const played = [first[0], q.Move(1, 'off')];
  q.Sync('p', Entries('fedcbag'), played.at(-1), true);
  assert.deepEqual(q.ids.slice(0, 2), played); assert.equal(q.ids.length, 7);
  let next; while ((next = q.Move(1, 'off')) !== null) { assert.ok(!played.includes(next)); played.push(next); }
  assert.equal(new Set(played).size, 7); assert.deepEqual([...played].sort(), 'abcdefg'.split(''));
});
test('each repeat excludes the last played row for that round and it can return in a later round', () => {
  const q = new Queue(RNG(2)); q.Start('p', Entries('abcd'), 'a', true);
  const rounds = [q.ids.slice()]; for (let i = 1; i < 4; i++) q.Move(1, 'all');
  let previousLast = rounds[0].at(-1);
  for (let round = 0; round < 30; round++) {
    const first = q.Move(1, 'all'); assert.notEqual(first, previousLast);
    const order = [first, q.Move(1, 'all'), q.Move(1, 'all')];
    assert.equal(new Set(order).size, 3); assert.ok(!order.includes(previousLast));
    assert.deepEqual([...order].sort(), 'abcd'.split('').filter(x => x !== previousLast));
    previousLast = order.at(-1); rounds.push(order);
  }
  assert.ok(q.cycles.length <= 3); assert.ok(rounds.slice(2).some(order => order.includes(rounds[0].at(-1))));
});
test('editing a new repeat cycle cannot reinsert its excluded anchor, and previous/next retrace the chosen order', () => {
  const q = new Queue(RNG(9)); q.Start('p', Entries('abc'), 'a', true);
  q.Move(1, 'all'); const anchor = q.Move(1, 'all'), first = q.Move(1, 'all');
  const remaining = q.ids.slice();
  q.Sync('p', Entries('dcba'), first, true); assert.ok(!q.ids.includes(anchor)); assert.ok(q.ids.includes('d'));
  assert.equal(q.Move(-1, 'all'), anchor); assert.equal(q.Move(1, 'all'), first);
  assert.deepEqual(q.ids.filter(id => id !== 'd'), remaining);
});
test('the explicit shuffle button redraws the first row and clears history every time', () => {
  const q = new Queue(RNG()), starts = new Set();
  for (let i = 0; i < 50; i++) {
    const first = q.ShuffleStart('p', Entries('abcde')); starts.add(first);
    assert.equal(q.index, 0); assert.equal(q.cycles.length, 1); assert.deepEqual([...q.ids].sort(), 'abcde'.split('')); assert.equal(q.cycles[0].seen.size, 1);
    q.Move(1, 'all');
  }
  assert.equal(starts.size, 5);
});
test('normal order, one-track repeat, one-entry playlists and removal retain defined behavior', () => {
  const q = new Queue(RNG()); q.Start('p', Entries('abc'), 'b', false);
  assert.equal(q.Move(1, 'one', true), 'b'); assert.equal(q.Move(1, 'off'), 'c'); assert.equal(q.Move(1, 'all'), 'a');
  q.ShuffleStart('p', Entries('a')); for (let i = 0; i < 8; i++) assert.equal(q.Move(1, 'all'), 'a');
  q.Sync('p', [], 'a', true); assert.equal(q.Move(1, 'all'), null); assert.equal(q.ShuffleStart('p', []), null);
  q.Start('p', Entries('abcde'), 'a', true); const current = q.Move(1, 'off');
  const edited = q.ids.filter(id => id === 'a' || id === current).map(id => ({ id }));
  q.Sync('p', edited, current, true); assert.equal(q.Move(1, 'off'), null);
});
test('next-track previews are stable across repeated reads and agree with playback at every round boundary', () => {
  const q = new Queue(RNG(6)); q.ShuffleStart('p', Entries('abcde'));
  for (let n = 0; n < 80; n++) {
    const current = q.ids[q.index], seen = [...q.cycles[q.cycleIndex].seen];
    const peek = q.Peek('all'); for (let i = 0; i < 10; i++) assert.equal(q.Peek('all'), peek);
    assert.equal(q.ids[q.index], current); assert.deepEqual([...q.cycles[q.cycleIndex].seen], seen);
    const copy = q.Clone(); assert.equal(copy.Move(1, 'all'), peek); assert.equal(q.Move(1, 'all'), peek);
  }
  assert.equal(q.Peek('one'), q.ids[q.index]);
});
test('editing after the preview reserves a fresh next round with the new last row excluded', () => {
  const q = new Queue(RNG(4)); q.Start('p', Entries('abc'), 'a', true);
  q.Move(1, 'all'); const oldLast = q.Move(1, 'all'); q.Peek('all');
  q.Sync('p', Entries('abcd'), oldLast, true); assert.equal(q.Peek('all'), 'd');
  assert.equal(q.Move(1, 'all'), 'd'); const next = q.Peek('all'); assert.notEqual(next, 'd');
  assert.equal(q.Move(1, 'all'), next); assert.ok(!q.ids.includes('d')); assert.equal(q.ids.length, 3);
  const normal = new Queue(); normal.Start('x', Entries('ab'), 'b', false); assert.equal(normal.Peek('off'), null); assert.equal(normal.Peek('all'), 'a');
});
