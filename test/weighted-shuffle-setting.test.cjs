'use strict';
// v0.7.1 Step4：「再生回数が少ない曲を優先する」設定の変更時刻（同期で、新しい変更が勝つ）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store } = require('../src/core/store.cjs');

function Temp(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-setting-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }

test('changing the preference stamps the time; other settings and unchanged values do not', t => {
  const store = new Store(Temp(t), {});
  assert.equal(store.data.settings.weightedShuffleAt, undefined);
  store.Apply({ type: 'settings', settings: { shuffle: true } });
  assert.equal(store.data.settings.weightedShuffleAt, undefined, '別の設定では、時刻を付けない');
  store.Apply({ type: 'settings', settings: { weightedShuffle: true } });
  assert.equal(store.data.settings.weightedShuffleAt, undefined, '値が変わらなければ、時刻を付けない');
  const before = Date.now();
  store.Apply({ type: 'settings', settings: { weightedShuffle: false } });
  assert.equal(store.data.settings.weightedShuffle, false);
  assert.ok(store.data.settings.weightedShuffleAt >= before);
});

test('a value applied from sync keeps the time it came with', t => {
  const store = new Store(Temp(t), {});
  store.Apply({ type: 'settings', settings: { weightedShuffle: false, weightedShuffleAt: 12345 } });
  assert.deepEqual([store.data.settings.weightedShuffle, store.data.settings.weightedShuffleAt], [false, 12345]);
  store.Apply({ type: 'settings', settings: { shuffle: true } }); // 別の設定を変えても、時刻は保たれる
  assert.deepEqual([store.data.settings.weightedShuffle, store.data.settings.weightedShuffleAt], [false, 12345]);
});
  assert.deepEqual([store.data.settings.weightedShuffle, store.data.settings.weightedShuffleAt], [false, 12345], '不正な値は無視する');
});
