'use strict';
// 再生キュー・シャッフル・重み・並べ替え・ジャンプ・割り込み再生・IPC配線の統合テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Queue } = require('../src/core/queue.cjs');
const App = require('../src/core/library-app.cjs');
const Ledger = require('../src/core/play-ledger.cjs');
const { Store } = require('../src/core/store.cjs');
const { readMain, readApp } = require('./support-source.cjs');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const Entries = ids => ids.split('').map(id => ({ id }));
const E = id => ({ id, playlistId: 'p', title: id });
function RNG(seed = 17) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
function started(ids = ['a', 'b', 'c', 'd'], current = 'a') {
  const queue = new Queue(null, () => 1, () => 0);
  queue.Start('p', ids.map(E), current, false);
  return queue;
}

const mkId = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const mkEntry = n => ({
  id: mkId(2, n),
  mediaId: mkId(3, n),
  type: 'bilibili',
  title: `曲${n}`,
  addedAt: '2026-11-14T00:00:00.000Z',
  url: `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'a')}/`,
});
const sixEntries = [1, 2, 3, 4, 5, 6].map(mkEntry);
const sixScope = mkId(1, 1);
const sixLibraryText = JSON.stringify({
  version: 3,
  identityVersion: 2,
  videoAliases: [],
  activePlaylistId: sixScope,
  rootPlaylistIds: [sixScope],
  playlists: [{ id: sixScope, name: 'リスト', icon: '', entries: sixEntries, childIds: [], createdAt: '2026-11-14T00:00:00.000Z', lastAddedAt: '', includeInAll: true }],
});
const sixPlayable = sixEntries.map(e => e.id);
const fiveEntries = sixEntries.slice(0, 5);
const fivePlayable = fiveEntries.map(e => e.id);
const fiveLibraryText = JSON.stringify({
  version: 3,
  identityVersion: 2,
  videoAliases: [],
  activePlaylistId: sixScope,
  rootPlaylistIds: [sixScope],
  playlists: [{ id: sixScope, name: 'リスト', icon: '', entries: fiveEntries, childIds: [], createdAt: '2026-11-14T00:00:00.000Z', lastAddedAt: '', includeInAll: true }],
});

test('shuffle traversal preserves played history on edits, excludes last anchor per repeat round, and retraces prev/next', () => {
  const q1 = new Queue(RNG());
  q1.Start('p', Entries('abcdef'), 'c', true);
  const first = q1.ids.slice();
  assert.equal(first[0], 'c');
  const played = [first[0], q1.Move(1, 'off')];
  q1.Sync('p', Entries('fedcbag'), played.at(-1), true);
  assert.deepEqual(q1.ids.slice(0, 2), played);
  assert.equal(q1.ids.length, 7);
  let next;
  while ((next = q1.Move(1, 'off')) !== null) {
    assert.ok(!played.includes(next));
    played.push(next);
  }
  assert.equal(new Set(played).size, 7);
  assert.deepEqual([...played].sort(), 'abcdefg'.split(''));

  const q2 = new Queue(RNG(2));
  q2.Start('p', Entries('abcd'), 'a', true);
  const rounds = [q2.ids.slice()];
  for (let i = 1; i < 4; i++) q2.Move(1, 'all');
  let previousLast = rounds[0].at(-1);
  for (let round = 0; round < 30; round++) {
    const head = q2.Move(1, 'all');
    assert.notEqual(head, previousLast);
    const order = [head, q2.Move(1, 'all'), q2.Move(1, 'all')];
    assert.equal(new Set(order).size, 3);
    assert.ok(!order.includes(previousLast));
    assert.deepEqual([...order].sort(), 'abcd'.split('').filter(x => x !== previousLast));
    previousLast = order.at(-1);
    rounds.push(order);
  }
  assert.ok(q2.cycles.length <= 3);
  assert.ok(rounds.slice(2).some(order => order.includes(rounds[0].at(-1))));

  const q3 = new Queue(RNG(9));
  q3.Start('p', Entries('abc'), 'a', true);
  q3.Move(1, 'all');
  const anchor = q3.Move(1, 'all');
  const firstNew = q3.Move(1, 'all');
  const remaining = q3.ids.slice();
  q3.Sync('p', Entries('dcba'), firstNew, true);
  assert.ok(!q3.ids.includes(anchor));
  assert.ok(q3.ids.includes('d'));
  assert.equal(q3.Move(-1, 'all'), anchor);
  assert.equal(q3.Move(1, 'all'), firstNew);
  assert.deepEqual(q3.ids.filter(id => id !== 'd'), remaining);
});

test('explicit shuffle redraws first row; normal order, repeat-one, single-entry, and empty playlists stay well-defined', () => {
  const q = new Queue(RNG());
  const starts = new Set();
  for (let i = 0; i < 50; i++) {
    const first = q.ShuffleStart('p', Entries('abcde'));
    starts.add(first);
    assert.equal(q.index, 0);
    assert.equal(q.cycles.length, 1);
    assert.deepEqual([...q.ids].sort(), 'abcde'.split(''));
    assert.equal(q.cycles[0].seen.size, 1);
    q.Move(1, 'all');
  }
  assert.equal(starts.size, 5);

  q.Start('p', Entries('abc'), 'b', false);
  assert.equal(q.Move(1, 'one', true), 'b');
  assert.equal(q.Move(1, 'off'), 'c');
  assert.equal(q.Move(1, 'all'), 'a');
  q.ShuffleStart('p', Entries('a'));
  for (let i = 0; i < 8; i++) assert.equal(q.Move(1, 'all'), 'a');
  q.Sync('p', [], 'a', true);
  assert.equal(q.Move(1, 'all'), null);
  assert.equal(q.ShuffleStart('p', []), null);
  q.Start('p', Entries('abcde'), 'a', true);
  const current = q.Move(1, 'off');
  const edited = q.ids.filter(id => id === 'a' || id === current).map(id => ({ id }));
  q.Sync('p', edited, current, true);
  assert.equal(q.Move(1, 'off'), null);
});

test('next-track previews are stable across reads and update cleanly after edits at round boundaries', () => {
  const q = new Queue(RNG(6));
  q.ShuffleStart('p', Entries('abcde'));
  for (let n = 0; n < 80; n++) {
    const current = q.ids[q.index];
    const seen = [...q.cycles[q.cycleIndex].seen];
    const peek = q.Peek('all');
    for (let i = 0; i < 10; i++) assert.equal(q.Peek('all'), peek);
    assert.equal(q.ids[q.index], current);
    assert.deepEqual([...q.cycles[q.cycleIndex].seen], seen);
    const copy = q.Clone();
    assert.equal(copy.Move(1, 'all'), peek);
    assert.equal(q.Move(1, 'all'), peek);
  }
  assert.equal(q.Peek('one'), q.ids[q.index]);

  const q2 = new Queue(RNG(4));
  q2.Start('p', Entries('abc'), 'a', true);
  q2.Move(1, 'all');
  const oldLast = q2.Move(1, 'all');
  q2.Peek('all');
  q2.Sync('p', Entries('abcd'), oldLast, true);
  assert.equal(q2.Peek('all'), 'd');
  assert.equal(q2.Move(1, 'all'), 'd');
  const next = q2.Peek('all');
  assert.notEqual(next, 'd');
  assert.equal(q2.Move(1, 'all'), next);
  assert.ok(!q2.ids.includes('d'));
  assert.equal(q2.ids.length, 3);
  const normal = new Queue();
  normal.Start('x', Entries('ab'), 'b', false);
  assert.equal(normal.Peek('off'), null);
  assert.equal(normal.Peek('all'), 'a');
});

test('reordering and jumping work on a cloned queue and leave the original untouched when refused', () => {
  const queue = started();
  const copy = queue.Clone();
  assert.equal(copy.Reorder(0, 2), true);
  assert.deepEqual(copy.Upcoming(), ['c', 'd', 'b']);
  assert.deepEqual(queue.Upcoming(), ['b', 'c', 'd'], '元のキューは変わらない');
  assert.equal(queue.Clone().Reorder(0, 9), false);
  const jump = queue.Clone();
  assert.equal(jump.JumpTo('d'), 'd');
  assert.equal(jump.JumpTo('a'), null, '再生済みの曲へは移らない');
});

test('PlayNext and AddToEnd arrange upcoming songs, move played songs, survive cross-playlist Sync, and preserve clones', () => {
  const queue = started();
  assert.equal(queue.PlayNext(E('d')), true);
  assert.deepEqual(queue.Upcoming(), ['d', 'b', 'c']);
  assert.equal(queue.AddToEnd(E('b')), true);
  assert.deepEqual(queue.Upcoming(), ['d', 'c', 'b']);
  assert.equal(queue.PlayNext(E('a')), false, '再生中の曲は動かさない');
  assert.equal(queue.PlayNext({}), false);
  assert.equal(queue.Move(1, 'off'), 'd');

  const played = started(['a', 'b', 'c', 'd'], 'c');
  assert.equal(played.PlayNext(E('a')), true);
  assert.equal(played.ids[played.index], 'c');
  assert.deepEqual(played.Upcoming(), ['a', 'd']);

  const cross = started();
  assert.equal(cross.PlayNext({ id: 'x', playlistId: 'other', title: 'x' }), true);
  assert.deepEqual(cross.Upcoming(), ['x', 'b', 'c', 'd']);
  cross.Sync('p', ['a', 'b', 'c', 'd'].map(E), 'a', false);
  assert.ok(cross.Upcoming().includes('x'));
  assert.equal(cross.ids[cross.index], 'a');
  assert.equal(cross.Move(1, 'off'), 'x');
  cross.Sync('p', ['a', 'b', 'c', 'd'].map(E), 'x', false);
  assert.equal(cross.ids[cross.index], 'x');

  assert.equal(typeof App.QueueInsert, 'function');
  const orig = started();
  const copy = orig.Clone();
  copy.PlayNext(E('c'));
  assert.deepEqual(orig.Upcoming(), ['b', 'c', 'd']);
  assert.deepEqual(copy.Upcoming(), ['c', 'b', 'd']);
});

test('queue controls (reorder, jump, insert) are wired from UI through preload and IPC to shared Queue', () => {
  const main = readMain();
  const preload = read('src/preloads/ui.cjs');
  const app = readApp();
  assert.match(preload, /queueReorder: invoke\('queue:reorder'\)/);
  assert.match(preload, /queueJump: invoke\('queue:jump'\)/);
  assert.match(preload, /queueInsert: invoke\('queue:insert'\)/);
  assert.match(main, /Handle\('queue:reorder'/);
  assert.match(main, /Handle\('queue:jump'/);
  assert.match(main, /Handle\('queue:insert'/);
  assert.match(main, /next\.Reorder\(/);
  assert.match(main, /next\.JumpTo\(/);
  assert.match(main, /AddToEnd\(/);
  assert.match(main, /PlayNext\(/);
  assert.match(main, /nextQueue\.catalog\.get\(id\)/);
  assert.match(app, /api\.queueReorder\(/);
  assert.match(app, /api\.queueJump\(/);
  assert.match(app, /api\.queueInsert\(/);
});

test('library-app QueueStart/QueueSync/QueuePeek guard failed starts and report stopped only when current disappears', () => {
  const pid = mkId(1, 1);
  const eid = n => mkId(2, n);
  const local = n => ({ id: eid(n), mediaId: mkId(3, n), type: 'local', title: `曲${n}`, addedAt: '', fileName: `${mkId(4, n)}.mp3` });
  const text = JSON.stringify({
    version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: pid, rootPlaylistIds: [pid],
    playlists: [{ id: pid, name: 'L', icon: '', entries: [local(1), local(2), local(3)], childIds: [], createdAt: '', lastAddedAt: '', includeInAll: true }],
  });
  const playable = [eid(1), eid(2), eid(3)];
  assert.equal(App.QueueStart({ text, scope: pid, entryId: eid(1), shuffle: false, playable }).id, eid(1));
  assert.equal(App.QueueStart({ text, scope: pid, entryId: eid(2), shuffle: false, playable: [eid(1), eid(3)] }).id, null);
  assert.equal(App.QueueMove({ direction: 1, repeat: 'off' }).id, eid(2));

  App.QueueStart({ text, scope: pid, entryId: eid(2), shuffle: false, playable });
  assert.equal(App.QueueSync({ text, scope: pid, entryId: eid(2), shuffle: false, playable, ownScope: pid }).stopped, false);
  assert.equal(App.QueueSync({ text, scope: pid, entryId: eid(2), shuffle: false, playable: [eid(1), eid(3)], ownScope: pid }).stopped, true);
  assert.equal(App.QueueMove({ direction: 1, repeat: 'off' }).id, null);
  assert.doesNotThrow(() => App.QueuePeek(undefined));
});

test('library-app QueueList, QueueReorder, and QueueJump preserve custom order across Sync and shuffle mode', () => {
  const ids = n => fiveEntries[n - 1].id;
  const start = (extra = {}) => App.QueueStart({ text: fiveLibraryText, scope: sixScope, entryId: ids(1), shuffle: false, playable: fivePlayable, ...extra });

  start();
  assert.equal(App.QueueList().current, ids(1));
  assert.deepEqual(App.QueueList().upcoming, [ids(2), ids(3), ids(4), ids(5)]);

  assert.equal(App.QueueReorder({ from: 3, to: 0 }).ok, true);
  assert.deepEqual(App.QueueList().upcoming, [ids(5), ids(2), ids(3), ids(4)]);
  assert.equal(App.QueueMove({ direction: 1, repeat: 'off' }).id, ids(5));
  assert.equal(App.QueueReorder({ from: 9, to: 0 }).ok, false);
  assert.equal(App.QueueReorder({ from: 0, to: -1 }).ok, false);
  assert.deepEqual(App.QueueList().upcoming, [ids(2), ids(3), ids(4)]);

  start();
  App.QueueReorder({ from: 2, to: 0 });
  const sync = { text: fiveLibraryText, scope: sixScope, entryId: ids(1), ownScope: sixScope, shuffle: false, playable: fivePlayable };
  assert.equal(App.QueueMove({ direction: 1, repeat: 'off', sync }).id, ids(4));
  assert.deepEqual(App.QueueList().upcoming, [ids(2), ids(3), ids(5)]);

  start();
  const jumped = App.QueueJump({ id: ids(4) });
  assert.equal(jumped.id, ids(4));
  assert.equal(jumped.playlistId, sixScope);
  assert.equal(App.QueueList().current, ids(4));
  assert.deepEqual(App.QueueList().upcoming, [ids(5)]);
  assert.equal(App.QueueJump({ id: ids(2) }).id, null);

  start({ shuffle: true, seed: 7 });
  const before = App.QueueList().upcoming;
  assert.equal(App.QueueReorder({ from: 0, to: before.length - 1 }).ok, true);
  const after = App.QueueList().upcoming;
  assert.deepEqual([...after].sort(), [...before].sort());
  assert.equal(after.at(-1), before[0]);
});

test('weighted shuffle favors rarely played songs, falls back to 1 for unknown weights, and covers every song once', () => {
  function firstCounts(weights, rounds = 400) {
    const firsts = new Map();
    for (let seed = 1; seed <= rounds; seed++) {
      const result = App.QueueStart({ text: sixLibraryText, scope: '*', entryId: sixEntries[5].id, shuffle: true, playable: sixPlayable, weights, seed });
      const next = App.QueueMove({ direction: 1, repeat: 'off', automatic: false });
      assert.ok(result.id && next.id);
      firsts.set(next.id, (firsts.get(next.id) || 0) + 1);
    }
    return firsts;
  }
  const uniform = firstCounts(undefined);
  for (const e of sixEntries.slice(0, 5)) assert.ok((uniform.get(e.id) || 0) > 40);
  const weights = {};
  for (const e of sixEntries) weights[e.id] = Ledger.Weight(e.id === sixEntries[0].id ? 50 : 0);
  const weighted = firstCounts(weights);
  assert.ok((weighted.get(sixEntries[0].id) || 0) < (uniform.get(sixEntries[0].id) || 0) / 3);

  App.QueueStart({ text: sixLibraryText, scope: '*', entryId: sixEntries[0].id, shuffle: true, playable: sixPlayable, weights: { [sixEntries[1].id]: 0.01 }, seed: 3 });
  const seen = new Set([sixEntries[0].id]);
  for (let i = 0; i < 5; i++) seen.add(App.QueueMove({ direction: 1, repeat: 'off', automatic: false }).id);
  assert.equal(seen.size, 6);
});

test('randomStart picks every song across seeds, respects weights, and leaves explicit entryId unchanged', () => {
  const firsts = new Map();
  for (let seed = 1; seed <= 300; seed++) {
    const result = App.QueueStart({ text: sixLibraryText, scope: sixScope, shuffle: true, randomStart: true, playable: sixPlayable, seed });
    assert.ok(result.id && result.playlistId);
    firsts.set(result.id, (firsts.get(result.id) || 0) + 1);
  }
  for (const e of sixEntries) assert.ok((firsts.get(e.id) || 0) > 20);

  const first = App.QueueStart({ text: sixLibraryText, scope: sixScope, shuffle: true, randomStart: true, playable: sixPlayable, seed: 5 });
  const seen = new Set([first.id]);
  for (let i = 0; i < 5; i++) seen.add(App.QueueMove({ direction: 1, repeat: 'off', automatic: false }).id);
  assert.equal(seen.size, 6);

  const weights = {};
  for (const e of sixEntries) weights[e.id] = Ledger.Weight(e.id === sixEntries[0].id ? 50 : 0);
  let heavy = 0;
  for (let seed = 1; seed <= 300; seed++) {
    if (App.QueueStart({ text: sixLibraryText, scope: sixScope, shuffle: true, randomStart: true, playable: sixPlayable, weights, seed }).id === sixEntries[0].id) heavy++;
  }
  assert.ok(heavy < 15);

  assert.equal(App.QueueStart({ text: sixLibraryText, scope: sixScope, entryId: sixEntries[2].id, shuffle: true, playable: sixPlayable, seed: 1 }).id, sixEntries[2].id);
});

test('library-app QueueSync updates weights when provided and clears on null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-qsync-w-'));
  try {
    const store = new Store(dir);
    const pid = store.data.activePlaylistId;
    store.Apply({ type: 'add', playlistId: pid, urls: 'av1\nav2\nav3\nav4' });
    const entries = store.data.playlists[0].entries;
    const text = JSON.stringify(store.Snapshot());
    const playable = entries.map(e => e.id);

    const start = App.QueueStart({ text, scope: pid, entryId: entries[0].id, shuffle: false, playable, seed: 42 });
    assert.equal(start.id, entries[0].id);

    const favTarget = entries[3].id;
    const weights = { [entries[1].id]: 0.001, [entries[2].id]: 0.001, [favTarget]: 10000 };
    const synced = App.QueueSync({ text, scope: pid, entryId: entries[0].id, ownScope: pid, shuffle: true, playable, weights });
    assert.equal(synced.stopped, false);
    assert.equal(App.QueueList().upcoming[0], favTarget);

    const cleared = App.QueueSync({ text, scope: pid, entryId: entries[0].id, ownScope: pid, shuffle: false, playable, weights: null });
    assert.equal(cleared.stopped, false);
    assert.deepEqual(App.QueueList().upcoming, [entries[1].id, entries[2].id, entries[3].id]);

    let sawNonFavFirst = false;
    for (let i = 0; i < 20; i++) {
      App.QueueSync({ text, scope: pid, entryId: entries[0].id, ownScope: pid, shuffle: false, playable });
      App.QueueSync({ text, scope: pid, entryId: entries[0].id, ownScope: pid, shuffle: true, playable });
      if (App.QueueList().upcoming[0] !== favTarget) { sawNonFavFirst = true; break; }
    }
    assert.equal(sawNonFavFirst, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
