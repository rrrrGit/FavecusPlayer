'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { TaskbarPlayer, Packet } = require('../src/core/taskbar-player.cjs');
const { Store, ValidateSettings } = require('../src/core/store.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Attached = { event: 'status', code: 'attached', parent: 1234, width: 540, height: 60, dpi: 144, win32: 0, rendered: true, visible: true, hitCount: 3 };
const Tick = () => new Promise(resolve => setImmediate(resolve));
function Harness(t, options = {}) {
  const child = new EventEmitter(), writes = [], calls = [], statuses = [], failures = [];
  child.stdin = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.stdin.write = bytes => { writes.push(Buffer.from(bytes)); return !child.backpressure; };
  child.stdin.end = bytes => { writes.push(Buffer.from(bytes)); child.stdin.destroyed = true; };
  child.kill = () => { child.killed = true; };
  let state = { title: '刻下寺 🎵', artist: 'Bilibili', volume: .37, paused: false, canToggle: true, canStop: true, canStep: true };
  const settings = { taskbarWidth: 360, taskbarOffset: 0 };
  const player = new TaskbarPlayer('C:\\Favecus Player\\FavecusPlayerTaskbar.exe', () => state, () => settings,
    (...args) => calls.push(args), (...args) => statuses.push(args), error => failures.push(error.message), {
      exists: () => true,
      spawn(exe, args, config) { assert.match(exe, /FavecusPlayerTaskbar\.exe$/); assert.deepEqual(args, ['--parent-pid', String(process.pid)]); assert.equal(config.shell, false); assert.equal(config.windowsHide, false); return child; },
      ...options
    });
  const send = message => child.stdout.write(Buffer.from(JSON.stringify(message) + '\n'));
  t.after(() => { player.Stop(); child.exitCode = 0; child.emit('exit', 0, null); child.stdout.destroy(); child.stderr.destroy(); });
  return { player, child, writes, calls, statuses, failures, send, settings, setState: value => { state = { ...state, ...value }; } };
}
test('native packet preserves Japanese, Chinese and emoji, bounds numbers and terminates UTF-16 fields', () => {
  const p = Packet({ title: '日本語 中文 🎵\n曲名', artist: 'Bilibili', volume: .375, paused: true, canToggle: true, canStop: true, canStep: true }, { taskbarWidth: Infinity, taskbarOffset: 1500 });
  assert.equal(p.length, 1024); assert.equal(p.toString('ascii', 0, 4), 'FPB1');
  assert.equal(p.readUInt32LE(4), 1024); assert.equal(p.readUInt32LE(8), 1); assert.equal(p.readUInt32LE(12), 15);
  assert.equal(p.readUInt32LE(16), 38); assert.equal(p.readUInt32LE(20), 500); assert.equal(p.readUInt32LE(24), 1200);
  assert.equal(p.toString('utf16le', 32, 392).split('\0')[0], '日本語 中文 🎵 曲名');
  assert.equal(p.toString('utf16le', 392, 592).split('\0')[0], 'Bilibili · 一時停止');
  const long = Packet({ title: '中'.repeat(178) + '🎵', volume: -1 }, { taskbarWidth: 10, taskbarOffset: -5 });
  assert.equal(long.toString('utf16le', 32, 392).split('\0')[0], '中'.repeat(178));
  assert.equal(long.readUInt32LE(16), 0); assert.equal(long.readUInt32LE(20), 260); assert.equal(long.readUInt32LE(24), 0);
  assert.equal(Packet({}, {}, true).readUInt32LE(8), 2);
});
test('bridge waits for a verified attachment, parses fragmented output and accepts only supported controls', async t => {
  const h = Harness(t); const starting = h.player.Show();
  assert.equal(h.writes.length, 1); assert.equal(h.statuses.at(-1)[0], 'connecting');
  h.send({ event: 'command', command: 'next' }); await Tick(); assert.deepEqual(h.calls, []);
  const line = JSON.stringify(Attached) + '\n'; h.child.stdout.write(line.slice(0, 17));
  assert.equal(h.player.connection.ready, false); h.child.stdout.write(line.slice(17)); assert.equal(await starting, true);
  assert.equal(h.statuses.at(-1)[0], 'embedded');
  for (const command of ['previous', 'toggle', 'next', 'stop', 'restore', 'floating', 'open-url', 'exec']) h.send({ event: 'command', command });
  for (const value of [0, 37, 100, -1, 101, 37.5, '50']) h.send({ event: 'volume', value });
  await Tick(); assert.deepEqual(h.calls, [['previous'], ['toggle'], ['next'], ['stop'], ['restore'], ['floating'], ['volume', 0], ['volume', .37], ['volume', 1]]);
});
test('bridge coalesces state under backpressure and sends an explicit shutdown record', async t => {
  const h = Harness(t); h.child.backpressure = true; const starting = h.player.Show(); h.send(Attached); await starting;
  h.setState({ title: '中間' }); h.player.Update(); h.setState({ title: '最新の曲' }); h.settings.taskbarWidth = 300; h.player.Update();
  assert.equal(h.writes.length, 1); h.child.backpressure = false; h.child.stdin.emit('drain');
  assert.equal(h.writes.length, 2); assert.equal(h.writes[1].toString('utf16le', 32, 392).split('\0')[0], '最新の曲'); assert.equal(h.writes[1].readUInt32LE(20), 300);
  h.player.Update(); assert.equal(h.writes.length, 2);
  h.player.Stop(); assert.equal(h.writes.at(-1).readUInt32LE(8), 2); assert.equal(h.player.connection, null);
  h.send({ event: 'command', command: 'next' }); await Tick(); assert.deepEqual(h.calls, []); assert.deepEqual(h.failures, []);
});
test('invalid parent, malformed protocol and failed attachment reject without claiming embedding', async t => {
  for (const message of [{ ...Attached, parent: 0 }, { ...Attached, rendered: false }, { ...Attached, visible: false }, { ...Attached, hitCount: 2 }, { ...Attached, rendered: undefined, visible: undefined, hitCount: undefined }, { event: 'status', code: 'parent-error', win32: 5 }, { event: 'status', code: 'render-error' }, { event: 'status', code: 'occluded' }, null, []]) {
    const h = Harness(t); const rejected = assert.rejects(h.player.Show()); h.send(message); await rejected;
    assert.equal(h.player.connection, null); assert.ok(!h.statuses.some(s => s[0] === 'embedded')); assert.deepEqual(h.failures, []);
  }
  for (const bytes of ['{invalid}\n', 'x'.repeat(8193)]) {
    const h = Harness(t); const rejected = assert.rejects(h.player.Show()); h.child.stdout.write(bytes); await rejected;
    assert.equal(h.player.connection, null);
  }
});
test('startup timeout and cancellation reject the pending show; helper exit after attach triggers recovery', async t => {
  const timeout = Harness(t, { timeout: 5 }); const rejected = assert.rejects(timeout.player.Show(), /時間内/);
  await new Promise(resolve => setTimeout(resolve, 15)); await rejected;
  const cancelled = Harness(t); const cancelledStart = assert.rejects(cancelled.player.Show(), /閉じました/); cancelled.player.Stop(); await cancelledStart;
  cancelled.send(Attached); assert.ok(!cancelled.statuses.some(s => s[0] === 'embedded'));
  const h = Harness(t); const starting = h.player.Show(); h.send(Attached); await starting;
  h.send({ event: 'status', code: 'waiting-taskbar' }); assert.equal(h.statuses.at(-1)[0], 'connecting');
  h.send(Attached); assert.equal(h.statuses.at(-1)[0], 'embedded');
  h.child.exitCode = 1; h.child.emit('exit', 1, null); assert.equal(h.player.connection, null); assert.equal(h.failures.length, 1);
});
test('missing helper and spawn/pipe errors surface a recoverable failure', async t => {
  const missing = Harness(t, { exists: () => false }); await assert.rejects(missing.player.Show(), /ファイルがありません/);
  const spawn = Harness(t); const rejected = assert.rejects(spawn.player.Show(), /ENOENT/); spawn.child.emit('error', new Error('ENOENT')); await rejected;
  const pipe = Harness(t); const starting = pipe.player.Show(); pipe.send(Attached); await starting;
  pipe.child.stdin.emit('error', new Error('EPIPE')); assert.equal(pipe.failures.length, 1); assert.equal(pipe.player.connection, null);
});
test('taskbar defaults migrate into existing settings and survive saving without changing playlists', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-taskbar-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root), before = store.Snapshot();
  delete before.settings.taskbarEmbed; delete before.settings.taskbarWidth; delete before.settings.taskbarOffset;
  fs.writeFileSync(store.file, JSON.stringify(before)); const migrated = new Store(root);
  assert.equal(migrated.data.settings.taskbarEmbed, true); assert.equal(migrated.data.settings.taskbarWidth, 500);
  migrated.Apply({ type: 'settings', settings: { taskbarEmbed: false, taskbarWidth: 400, taskbarOffset: 60 } });
  const reopened = new Store(root); assert.equal(reopened.data.settings.taskbarEmbed, false); assert.equal(reopened.data.settings.taskbarWidth, 400); assert.equal(reopened.data.settings.taskbarOffset, 60);
  assert.deepEqual(reopened.data.playlists, before.playlists);
  reopened.Apply({ type: 'settings', settings: { taskbarWidth: 360 } }); assert.equal(new Store(root).data.settings.taskbarWidth, 360);
  const invalid = ValidateSettings({ taskbarEmbed: 'true', taskbarWidth: 2000, taskbarOffset: -20 }); assert.equal(invalid.taskbarEmbed, true); assert.equal(invalid.taskbarWidth, 520); assert.equal(invalid.taskbarOffset, 0);
});
test('covered surface remains connecting until visible and later occlusion triggers fallback', async t => {
  const h = Harness(t); const starting = h.player.Show();
  h.send({ event: 'status', code: 'waiting-visible', rendered: true, visible: true, hitCount: 0 });
  assert.equal(h.player.connection.ready, false); assert.equal(h.statuses.at(-1)[0], 'connecting');
  h.send(Attached); assert.equal(await starting, true);
  h.send({ event: 'status', code: 'waiting-visible' });
  h.send({ event: 'status', code: 'occluded', hitCount: 0 });
  assert.equal(h.player.connection, null); assert.equal(h.failures.length, 1); assert.match(h.failures[0], /隠れ/);
});
