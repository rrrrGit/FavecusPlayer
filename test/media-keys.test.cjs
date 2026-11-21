'use strict';
// キーボードのメディアキー：登録・二重の通知の抑制・登録できないキーの扱い・main への接続。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const MediaKeys = require('../src/core/media-keys.cjs');
const { readMain } = require('./support-source.cjs');

function FakeShortcuts(refuse = []) {
  const handlers = new Map();
  return { handlers, register: (key, callback) => { if (refuse.includes(key)) return false; handlers.set(key, callback); return true; }, unregister: key => handlers.delete(key) };
}

test('the four media keys map to toggle, next, previous and stop', () => {
  const shortcuts = FakeShortcuts(), commands = [];
  const keys = MediaKeys.Register(shortcuts, command => commands.push(command), { now: (() => { let t = 0; return () => (t += 1000); })() });
  assert.deepEqual(keys.registered.sort(), ['MediaNextTrack', 'MediaPlayPause', 'MediaPreviousTrack', 'MediaStop']);
  for (const key of ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop']) shortcuts.handlers.get(key)();
  assert.deepEqual(commands, ['toggle', 'next', 'previous', 'stop']);
});

test('a repeated notification of the same key within a short time counts once, but another key or a later press does not', () => {
  const shortcuts = FakeShortcuts(), commands = []; let time = 0;
  MediaKeys.Register(shortcuts, command => commands.push(command), { now: () => time });
  const press = key => shortcuts.handlers.get(key)();
  press('MediaPlayPause'); time = 100; press('MediaPlayPause'); press('MediaNextTrack');
  time = 100 + MediaKeys.REPEAT_MS; press('MediaPlayPause');
  assert.deepEqual(commands, ['toggle', 'next', 'toggle']);
});

test('keys another app already owns are skipped, failures in the handler never escape, and Dispose releases the keys', async () => {
  const shortcuts = FakeShortcuts(['MediaStop']);
  const keys = MediaKeys.Register(shortcuts, command => { if (command === 'next') throw new Error('boom'); return command === 'previous' ? Promise.reject(new Error('later')) : undefined; }, { now: (() => { let t = 0; return () => (t += 1000); })() });
  assert.equal(keys.registered.includes('MediaStop'), false);
  assert.doesNotThrow(() => shortcuts.handlers.get('MediaNextTrack')());
  assert.doesNotThrow(() => shortcuts.handlers.get('MediaPreviousTrack')());
  await new Promise(setImmediate);
  keys.Dispose();
  assert.equal(shortcuts.handlers.size, 0);
  assert.deepEqual(keys.registered, []);
  assert.deepEqual(MediaKeys.Register(undefined, () => {}).registered, [], 'globalShortcut がなくても、止まらない');
});

test('main registers the media keys, releases them on quit, and turns off the duplicate Chromium handling', () => {
  const main = readMain();
  assert.match(main, /mediaKeys = MediaKeys\.Register\(globalShortcut, command => Command\(command\)\)/);
  assert.match(main, /mediaKeys\?\.Dispose\(\)/);
  assert.match(main, /appendSwitch\('disable-features', 'HardwareMediaKeyHandling'\)/);
  assert.match(main, /safeStorage, globalShortcut \} = require\('electron'\)/);
});
