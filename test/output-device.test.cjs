'use strict';
// 音声の出力デバイス（v0.7.4。PC版。保存済み・ローカルの曲の再生だけ）：名前での選択・保存・接続。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Resolve, Clean, OutputDeviceStore, MAX_LABEL } = require('../src/core/output-device.cjs');
const { readMain } = require('./support-source.cjs');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

const devices = [{ deviceId: 'abc', label: 'スピーカー (Realtek)' }, { deviceId: 'def', label: 'ヘッドホン (USB)' }];

test('a device is found by its name; an empty name, an unknown name or bad input means the default device', () => {
  assert.equal(Resolve('ヘッドホン (USB)', devices), 'def');
  assert.equal(Resolve('', devices), 'default');
  assert.equal(Resolve('つながっていないデバイス', devices), 'default');
  assert.equal(Resolve('ヘッドホン (USB)', null), 'default');
  assert.equal(Resolve('x', [null, { label: 'x' }]), 'default', 'IDのないものは使わない');
});

test('names are cleaned and limited', () => {
  assert.equal(Clean('  a\u0000b\n '), 'ab');
  assert.equal(Clean(undefined), '');
  assert.equal(Clean('x'.repeat(500)).length, MAX_LABEL);
});

test('the choice is saved atomically, restored, and a broken or unknown file means the default', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-out-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'n', 'output-device.json'), store = new OutputDeviceStore(file);
  assert.equal(store.Get(), '');
  assert.equal(store.Set(' ヘッドホン (USB) '), 'ヘッドホン (USB)');
  assert.equal(new OutputDeviceStore(file).Get(), 'ヘッドホン (USB)');
  assert.equal(store.Set(''), '');
  assert.equal(new OutputDeviceStore(file).Get(), '');
  assert.equal(fs.existsSync(file + '.tmp'), false);
  fs.writeFileSync(file, '{ broken'); assert.equal(new OutputDeviceStore(file).Get(), '');
  fs.writeFileSync(file, JSON.stringify({ version: 9, label: 'x' })); assert.equal(new OutputDeviceStore(file).Get(), '');
});

test('wiring: only the local player page is told the device, only the check of media permission is allowed for our own page, and the player applies it by name', () => {
  const main = readMain(), media = read('src/preloads/media.cjs');
  assert.match(main, /Handle\('output:set'/);
  assert.match(main, /startsWith\('favecus:\/\/app\/local\.html'\)/, '保存済み・ローカルの再生画面だけ');
  assert.match(main, /permission === 'media' && origin === 'favecus:\/\/app'/);
  assert.doesNotMatch(main, /setPermissionRequestHandler\([^)]*'media'[^)]*\)/, '要求（getUserMedia）は、許可しない');
  assert.match(media, /command\.type === 'sink'/);
  assert.match(media, /location\.protocol !== 'favecus:'/, 'Bilibiliなどの外部ページでは、何もしない');
  assert.match(media, /d\.label === masterSink/);
  assert.match(read('src/ui/app/04-settings.js'), /\['出力デバイス', OutputSettings\]/);
});
