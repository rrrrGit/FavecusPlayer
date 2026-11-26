'use strict';
// キーボードのメディアキー：登録・連打抑止・競合耐性・設定保存・main配線のテスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MediaKeys = require('../src/core/media-keys.cjs');
const { Store } = require('../src/core/store.cjs');
const { readMain } = require('./support-source.cjs');

function FakeShortcuts(refuse = []) {
  const handlers = new Map();
  return {
    handlers,
    register: (key, callback) => { if (refuse.includes(key)) return false; handlers.set(key, callback); return true; },
    unregister: key => handlers.delete(key),
  };
}

test('media keys map to commands and debounce rapid duplicate presses of the same key', () => {
  const shortcuts = FakeShortcuts(), commands = [];
  let time = 0;
  const keys = MediaKeys.Register(shortcuts, command => commands.push(command), { now: () => time });
  assert.deepEqual(keys.registered.sort(), ['MediaNextTrack', 'MediaPlayPause', 'MediaPreviousTrack', 'MediaStop']);
  const press = key => shortcuts.handlers.get(key)();
  press('MediaPlayPause');
  time = 100;
  press('MediaPlayPause'); // suppressed
  press('MediaNextTrack');
  time = 100 + MediaKeys.REPEAT_MS;
  press('MediaPlayPause');
  time += MediaKeys.REPEAT_MS;
  press('MediaPreviousTrack');
  time += MediaKeys.REPEAT_MS;
  press('MediaStop');
  assert.deepEqual(commands, ['toggle', 'next', 'toggle', 'previous', 'stop']);
});

test('unavailable keys are skipped, handler errors never escape, and Dispose releases all keys', async () => {
  const shortcuts = FakeShortcuts(['MediaStop']);
  const keys = MediaKeys.Register(
    shortcuts,
    command => { if (command === 'next') throw new Error('boom'); return command === 'previous' ? Promise.reject(new Error('later')) : undefined; },
    { now: (() => { let t = 0; return () => (t += 1000); })() }
  );
  assert.equal(keys.registered.includes('MediaStop'), false);
  assert.doesNotThrow(() => shortcuts.handlers.get('MediaNextTrack')());
  assert.doesNotThrow(() => shortcuts.handlers.get('MediaPreviousTrack')());
  await new Promise(setImmediate);
  keys.Dispose();
  assert.equal(shortcuts.handlers.size, 0);
  assert.deepEqual(keys.registered, []);
  assert.deepEqual(MediaKeys.Register(undefined, () => {}).registered, []);
});

test('main wires media keys with HardwareMediaKeyHandling disabled and Store persists mediaKeysEnabled', t => {
  const main = readMain();
  assert.match(main, /function SyncMediaKeys\(\)/);
  assert.match(main, /MediaKeys\.Register\(globalShortcut, command => Command\(command\)\)/);
  assert.match(main, /mediaKeys\?\.Dispose\(\)/);
  assert.match(main, /appendSwitch\('disable-features', 'HardwareMediaKeyHandling'\)/);
  assert.match(main, /safeStorage, globalShortcut \} = require\('electron'\)/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-mediakey-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  assert.equal(store.data.settings.mediaKeysEnabled, true);
  store.Apply({ type: 'settings', settings: { mediaKeysEnabled: false } });
  assert.equal(new Store(dir).data.settings.mediaKeysEnabled, false);
});
