'use strict';
// v0.7.3 F5：PC版のつなぎ（音量の計算・設定・既定）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('PC: the song gain multiplies the media volume together with the sleep-timer fade, and only saved and local songs are measured', () => {
  const main = read('src/main.cjs');
  assert.match(main, /store\.data\.settings\.volume \* factor \* \(store\.data\.settings\.volumeLeveling === false \? 1 : songGain\)/);
  assert.match(main, /void LevelCurrent\(request, saved \? offline\.ResolvePath\(saved\.file\) : entry\.type === 'local'/, '保存済み・ローカルの曲だけ（オンラインは対象外）');
  assert.match(read('src/ui/app.js'), /volumeLeveling: \$\('volume-leveling'\)\.checked/);
});

test('PC: the setting defaults to on, is saved, and a new store keeps it', t => {
  const { Store } = require('../src/core/store.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-level-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  assert.equal(store.data.settings.volumeLeveling, true, '既定はオン');
  store.Apply({ type: 'settings', settings: { volumeLeveling: false } });
  assert.equal(new Store(dir).data.settings.volumeLeveling, false, '保存される');
});
