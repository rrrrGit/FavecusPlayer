'use strict';
// 音声の出力デバイス（PC版。ローカル/保存済み再生専用）：名前解決・保存・配線テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Resolve, Clean, OutputDeviceStore, MAX_LABEL } = require('../src/core/output-device.cjs');
const { readMain } = require('./support-source.cjs');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('Resolve matches by cleaned device label and falls back to default on missing or invalid inputs', () => {
  const devices = [{ deviceId: 'abc', label: 'スピーカー (Realtek)' }, { deviceId: 'def', label: 'ヘッドホン (USB)' }];
  assert.equal(Resolve('ヘッドホン (USB)', devices), 'def');
  assert.equal(Resolve('', devices), 'default');
  assert.equal(Resolve('つながっていないデバイス', devices), 'default');
  assert.equal(Resolve('ヘッドホン (USB)', null), 'default');
  assert.equal(Resolve('x', [null, { label: 'x' }]), 'default');

  assert.equal(Clean('  a\u0000b\n '), 'ab');
  assert.equal(Clean(undefined), '');
  assert.equal(Clean('x'.repeat(500)).length, MAX_LABEL);
});

test('OutputDeviceStore saves atomically, restores, and resets on broken or unknown files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-out-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'n', 'output-device.json'), store = new OutputDeviceStore(file);
  assert.equal(store.Get(), '');
  assert.equal(store.Set(' ヘッドホン (USB) '), 'ヘッドホン (USB)');
  assert.equal(new OutputDeviceStore(file).Get(), 'ヘッドホン (USB)');
  assert.equal(store.Set(''), '');
  assert.equal(new OutputDeviceStore(file).Get(), '');
  assert.equal(fs.existsSync(file + '.tmp'), false);
  fs.writeFileSync(file, '{ broken');
  assert.equal(new OutputDeviceStore(file).Get(), '');
  fs.writeFileSync(file, JSON.stringify({ version: 9, label: 'x' }));
  assert.equal(new OutputDeviceStore(file).Get(), '');
});

test('output device wiring restricts sink selection to local player and denies getUserMedia requests', () => {
  const main = readMain(), media = read('src/preloads/media.cjs');
  assert.match(main, /Handle\('output:set'/);
  assert.match(main, /startsWith\('favecus:\/\/app\/local\.html'\)/);
  assert.match(main, /permission === 'media' && origin === 'favecus:\/\/app'/);
  assert.doesNotMatch(main, /setPermissionRequestHandler\([^)]*'media'[^)]*\)/);
  assert.match(media, /command\.type === 'sink'/);
  assert.match(media, /location\.protocol !== 'favecus:'/);
  assert.match(media, /d\.label === masterSink/);
  assert.match(read('src/ui/app/04-settings.js'), /\['出力デバイス', OutputSettings\]/);
});
