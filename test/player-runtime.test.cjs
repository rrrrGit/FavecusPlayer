'use strict';
// 再生ランタイム（MediaChannel・PlayerRecovery・BackgroundMode・media preload）の統合テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { MediaChannel } = require('../src/core/media-channel.cjs');
const { PlayerRecovery } = require('../src/core/player-recovery.cjs');
const { BackgroundMode } = require('../src/core/background-mode.cjs');
const { ValidateSettings } = require('../src/core/store.cjs');

test('MediaChannel guards mainFrame access across lifecycle events and reports send errors safely', () => {
  const wc = new EventEmitter(), sent = [];
  let frameReads = 0, closed = false;
  wc.isDestroyed = () => closed;
  Object.defineProperty(wc, 'mainFrame', { get() { frameReads++; return {}; } });
  wc.send = (name, value) => { void wc.mainFrame; sent.push([name, value]); };
  const channel = new MediaChannel(wc);
  assert.equal(channel.Send('media:command', { type: 'volume' }), false);
  assert.equal(frameReads, 0);
  channel.Ready();
  assert.equal(channel.Send('media:command', { type: 'volume', value: 0.2 }), true);
  for (const event of [{ isMainFrame: false }, { isMainFrame: true, isSameDocument: true }]) {
    wc.emit('did-start-navigation', event);
    assert.equal(channel.ready, true);
  }
  wc.emit('did-start-navigation', {}, 'https://example.test/next', false, true);
  for (const name of ['media:command', 'media:shortcuts']) assert.equal(channel.Send(name, {}), false);
  assert.equal(frameReads, 1);
  channel.Ready();
  channel.Send('media:command', { type: 'pause' });
  wc.emit('render-process-gone');
  assert.equal(channel.Send('media:command', {}), false);
  channel.Ready();
  closed = true;
  wc.emit('destroyed');
  assert.equal(channel.Ready(), false);
  assert.equal(channel.Send('media:command', {}), false);
  assert.equal(frameReads, 2);
  assert.equal(sent.length, 2);

  const wc2 = new EventEmitter(), errors = [];
  wc2.isDestroyed = () => false;
  wc2.send = () => { throw new Error('renderer gone'); };
  const ch2 = new MediaChannel(wc2, { failed: error => errors.push(error.message) });
  ch2.Ready();
  assert.equal(ch2.Send('media:command', {}), false);
  ch2.Suspend();
  assert.equal(ch2.Send('media:command', {}), false);
  assert.deepEqual(errors, ['renderer gone']);
});

function recoveryHarness() {
  let now = 0, serial = 0;
  const tasks = new Map(), recovered = [];
  const recovery = new PlayerRecovery((...args) => recovered.push(args), {
    schedule: (fn, ms) => { const id = ++serial; tasks.set(id, { fn, at: now + ms }); return id; },
    cancel: id => tasks.delete(id),
  });
  return {
    recovery, recovered, tasks,
    async advance(ms) {
      now += ms;
      for (const [id, task] of tasks) if (task.at <= now) { tasks.delete(id); task.fn(); }
      await Promise.resolve();
    },
  };
}

test('PlayerRecovery triggers once on timeout or decode error and skips when disabled or ready', async () => {
  const h = recoveryHarness();
  h.recovery.Begin(1, true);
  await h.advance(19999);
  assert.equal(h.recovered.length, 0);
  await h.advance(1);
  assert.deepEqual(h.recovered, [[1, 'timeout']]);
  await h.advance(60000);
  assert.equal(h.recovered.length, 1);
  h.recovery.Begin(2, false);
  await h.advance(60000);
  assert.equal(h.recovered.length, 1);

  const h2 = recoveryHarness();
  h2.recovery.Begin(1, true);
  h2.recovery.Observe(1, { ready: true, errorCode: 0 });
  await h2.advance(60000);
  assert.equal(h2.recovered.length, 0);
  h2.recovery.Begin(2, true);
  h2.recovery.Observe(2, { ready: false, errorCode: 3 });
  await Promise.resolve();
  assert.deepEqual(h2.recovered, [[2, 'media-error']]);
});

test('PlayerRecovery cancels pending timers and queued fallbacks on track change or stop', async () => {
  const h = recoveryHarness();
  h.recovery.Begin(1, true);
  const stale = [...h.tasks.values()][0].fn;
  h.recovery.Begin(2, true);
  stale();
  h.recovery.Observe(1, { ready: true });
  h.recovery.Observe(2, { ready: false, errorCode: 4 });
  h.recovery.Cancel();
  await Promise.resolve();
  assert.equal(h.recovered.length, 0);
  await h.advance(60000);
  assert.equal(h.recovered.length, 0);
});

function clockHarness() {
  let now = 0, serial = 0;
  const tasks = new Map();
  return {
    now: () => now,
    schedule: (fn, delay) => { const id = ++serial; tasks.set(id, { fn, at: now + delay }); return id; },
    cancel: id => tasks.delete(id),
    advance(ms) {
      const until = now + ms;
      let next;
      while ((next = [...tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0]) && next[1].at <= until) {
        now = next[1].at;
        tasks.delete(next[0]);
        next[1].fn();
      }
      now = until;
    },
    tasks,
  };
}

test('BackgroundMode starts on blur, ignores repeated hide, resets on foreground, and tracks elapsed delay changes', () => {
  const clock = clockHarness(), settings = { autoThumbnailEnabled: true, autoThumbnailMinutes: 5 };
  let switched = 0;
  const mode = new BackgroundMode(() => settings, () => true, () => switched++, clock);
  mode.SetForeground(true);
  clock.advance(600000);
  assert.equal(switched, 0);
  mode.SetForeground(false);
  clock.advance(240000);
  mode.SetForeground(false);
  clock.advance(59999);
  assert.equal(switched, 0);
  clock.advance(1);
  assert.equal(switched, 1);
  mode.SetForeground(true);
  mode.SetForeground(false);
  clock.advance(299999);
  assert.equal(switched, 1);
  mode.SetForeground(true);
  clock.advance(300000);
  assert.equal(switched, 1);
  assert.equal(clock.tasks.size, 0);

  const clock2 = clockHarness(), settings2 = { autoThumbnailEnabled: true, autoThumbnailMinutes: 5 };
  let playable = false, switched2 = 0;
  const mode2 = new BackgroundMode(() => settings2, () => playable, () => { playable = false; switched2++; }, clock2);
  mode2.SetForeground(false);
  clock2.advance(60000);
  playable = true;
  mode2.Refresh();
  settings2.autoThumbnailEnabled = false;
  mode2.Refresh();
  clock2.advance(300000);
  assert.equal(switched2, 0);
  settings2.autoThumbnailEnabled = true;
  mode2.Refresh();
  clock2.advance(0);
  assert.equal(switched2, 1);
  mode2.SetForeground(true);
  playable = true;
  mode2.SetForeground(false);
  clock2.advance(60000);
  settings2.autoThumbnailMinutes = 2;
  mode2.Refresh();
  clock2.advance(60000);
  assert.equal(switched2, 2);
  mode2.SetForeground(true);
  playable = true;
  mode2.SetForeground(false);
  mode2.Dispose();
  clock2.advance(600000);
  assert.equal(switched2, 2);
  assert.equal(clock2.tasks.size, 0);
});

test('BackgroundMode ignores cancelled callbacks, reports save failures, and clamps autoThumbnailMinutes', () => {
  const clock = clockHarness(), errors = [];
  let switched = 0;
  const mode = new BackgroundMode(
    () => ({ autoThumbnailEnabled: true, autoThumbnailMinutes: 1 }),
    () => true,
    () => { switched++; throw new Error('save failed'); },
    { ...clock, onError: e => errors.push(e.message) }
  );
  mode.SetForeground(false);
  const stale = [...clock.tasks.values()][0].fn;
  mode.SetForeground(true);
  stale();
  assert.equal(switched, 0);
  mode.SetForeground(false);
  clock.advance(60000);
  assert.equal(switched, 1);
  assert.deepEqual(errors, ['save failed']);
  assert.equal(ValidateSettings({}).autoThumbnailMinutes, 5);
  assert.equal(ValidateSettings({ autoThumbnailMinutes: 0 }).autoThumbnailMinutes, 1);
  assert.equal(ValidateSettings({ autoThumbnailMinutes: 500 }).autoThumbnailMinutes, 120);
});

function mediaPreloadHarness(argv = ['--favecus-quality-360p']) {
  let now = 0, items = [], clicked = 0, style;
  const windowEvents = {}, events = {}, commands = {}, messages = [], intervals = [];
  const media = { readyState: 2, duration: 200, currentTime: 20, paused: true, ended: false, volume: 1, playbackRate: 1, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; } };
  const item = { textContent: '流畅 360P', getAttribute: () => null, classList: { contains: () => false }, click() { clicked++; } };
  const player = { classList: { add() {} }, querySelector: () => media };
  const context = {
    process: { argv },
    require: () => ({ ipcRenderer: { on: (k, f) => { commands[k] = f; }, send: (...a) => messages.push(a) } }),
    location: { protocol: 'https:', href: 'https://www.bilibili.com/video/av123/?p=2' },
    document: {
      querySelectorAll: q => q === 'video, audio' ? [media] : items,
      querySelector: q => q === '#bilibili-player' ? player : null,
      getElementById: () => style,
      createElement: () => ({}),
      head: { append: v => { style = v; } },
      addEventListener: (k, f) => { events[k] = f; },
      title: '曲',
    },
    window: { addEventListener: (k, f) => { windowEvents[k] = f; } },
    Date: { now: () => now },
    setInterval: f => intervals.push(f),
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/preloads/media.cjs'), 'utf8'), context);
  windowEvents.DOMContentLoaded();
  return {
    media, messages, events, windowEvents, item,
    clicked: () => clicked,
    style: () => style,
    items: v => { items = v; },
    tick: ms => { now = ms; intervals.forEach(f => f()); },
    command: v => commands['media:command']({}, v),
    keys: v => commands['media:shortcuts']({}, v),
  };
}

test('media preload selects 360p once without overriding user/account choices and captures only trusted shortcuts', () => {
  const h = mediaPreloadHarness();
  assert.equal(h.clicked(), 0);
  h.items([h.item]);
  h.tick(1000);
  assert.equal(h.clicked(), 1);
  h.tick(2000);
  assert.equal(h.clicked(), 1);
  const manual = mediaPreloadHarness();
  manual.events.pointerdown({ isTrusted: true, target: { closest: () => true } });
  manual.items([manual.item]);
  manual.tick(1000);
  assert.equal(manual.clicked(), 0);
  const account = mediaPreloadHarness([]);
  account.items([account.item]);
  account.tick(1000);
  assert.equal(account.clicked(), 0);
  const late = mediaPreloadHarness();
  late.items([late.item]);
  late.tick(21000);
  assert.equal(late.clicked(), 0);

  const sk = mediaPreloadHarness();
  sk.keys({ enabled: true, bindings: { toggle: 'Space', forward: 'ArrowRight' } });
  const press = extra => {
    const e = { code: 'Space', isTrusted: true, target: { closest: () => false }, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {}, ...extra };
    sk.windowEvents.keydown(e);
    return e;
  };
  press();
  assert.equal(sk.messages.filter(m => m[0] === 'media:shortcut').length, 1);
  assert.equal(press({ repeat: true }).prevented, true);
  press({ isTrusted: false });
  press({ target: { closest: () => true } });
  sk.keys({ enabled: false });
  press();
  assert.equal(sk.messages.filter(m => m[0] === 'media:shortcut').length, 1);
});

test('media preload fits internal official player and restores paused/playing positions after late metadata', () => {
  const h = mediaPreloadHarness(['--favecus-start-at-zero', '--favecus-official-player']);
  assert.match(h.style().textContent, /width:100vw/);
  h.media.readyState = 0;
  h.command({ type: 'restore', position: 72, paused: false });
  h.tick(1000);
  h.media.readyState = 2;
  h.tick(2000);
  assert.equal(h.media.currentTime, 72);
  assert.equal(h.media.paused, false);
  h.tick(4000);
  assert.equal(h.media.currentTime, 72);
  h.command({ type: 'restore', position: 99, paused: true });
  assert.equal(h.media.currentTime, 99);
  assert.equal(h.media.paused, true);
});
