'use strict';
// v0.7.0 Step9：iPhone版が使う再生順の入口（library-app.cjs）。順番そのものの規則は共通テストデータ（queue: …）で確認する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const App = require('../src/core/library-app.cjs');

const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pid = n => id(1, n), eid = n => id(2, n);
const local = n => ({ id: eid(n), mediaId: id(3, n), type: 'local', title: `曲${n}`, addedAt: '', fileName: `${id(4, n)}.mp3` });
const library = { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: pid(1), rootPlaylistIds: [pid(1)], playlists: [{ id: pid(1), name: 'L', icon: '', entries: [local(1), local(2), local(3)], childIds: [], createdAt: '', lastAddedAt: '', includeInAll: true }] };
const text = JSON.stringify(library), playable = [eid(1), eid(2), eid(3)];

test('a failed start leaves the queue that is already playing untouched', () => {
  assert.equal(App.QueueStart({ text, scope: pid(1), entryId: eid(1), shuffle: false, playable }).id, eid(1));
  const failed = App.QueueStart({ text, scope: pid(1), entryId: eid(2), shuffle: false, playable: [eid(1), eid(3)] });
  assert.equal(failed.id, null);
  assert.equal(App.QueueMove({ direction: 1, repeat: 'off' }).id, eid(2), 'いまの順番が続く');
});

test('QueueSync reports a stopped queue only when the current entry is gone, and QueuePeek never throws', () => {
  App.QueueStart({ text, scope: pid(1), entryId: eid(2), shuffle: false, playable });
  assert.equal(App.QueueSync({ text, scope: pid(1), entryId: eid(2), shuffle: false, playable, ownScope: pid(1) }).stopped, false);
  assert.equal(App.QueueSync({ text, scope: pid(1), entryId: eid(2), shuffle: false, playable: [eid(1), eid(3)], ownScope: pid(1) }).stopped, true);
  assert.equal(App.QueueMove({ direction: 1, repeat: 'off' }).id, null);
  assert.doesNotThrow(() => App.QueuePeek(undefined));
});
