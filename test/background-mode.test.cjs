'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BackgroundMode } = require('../src/core/background-mode.cjs');
const { ValidateSettings } = require('../src/core/store.cjs');
function Clock() {
  let now = 0, serial = 0; const tasks = new Map();
  return { now: () => now, schedule: (fn, delay) => { const id = ++serial; tasks.set(id, { fn, at: now + delay }); return id; }, cancel: id => tasks.delete(id),
    advance(ms) { const until = now + ms; let next; while ((next = [...tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0]) && next[1].at <= until) { now = next[1].at; tasks.delete(next[0]); next[1].fn(); } now = until; }, tasks };
}
test('background delay starts on blur, repeated hide/minimize do not postpone it, and foreground resets the wait', () => {
  const clock = Clock(), settings = { autoThumbnailEnabled: true, autoThumbnailMinutes: 5 }; let switched = 0;
  const mode = new BackgroundMode(() => settings, () => true, () => switched++, clock);
  mode.SetForeground(true); clock.advance(600000); assert.equal(switched, 0);
  mode.SetForeground(false); clock.advance(240000); mode.SetForeground(false); clock.advance(59999); assert.equal(switched, 0);
  clock.advance(1); assert.equal(switched, 1);
  mode.SetForeground(true); mode.SetForeground(false); clock.advance(299999); assert.equal(switched, 1);
  mode.SetForeground(true); clock.advance(300000); assert.equal(switched, 1); assert.equal(clock.tasks.size, 0);
});
test('disabled, stopped and disposed states cancel switching; changed delay and newly loaded media use elapsed background time', () => {
  const clock = Clock(), settings = { autoThumbnailEnabled: true, autoThumbnailMinutes: 5 }; let playable = false, switched = 0;
  const mode = new BackgroundMode(() => settings, () => playable, () => { playable = false; switched++; }, clock);
  mode.SetForeground(false); clock.advance(60000); playable = true; mode.Refresh();
  settings.autoThumbnailEnabled = false; mode.Refresh(); clock.advance(300000); assert.equal(switched, 0);
  settings.autoThumbnailEnabled = true; mode.Refresh(); clock.advance(0); assert.equal(switched, 1);
  mode.SetForeground(true); playable = true; mode.SetForeground(false); clock.advance(60000);
  settings.autoThumbnailMinutes = 2; mode.Refresh(); clock.advance(60000); assert.equal(switched, 2);
  mode.SetForeground(true); playable = true; mode.SetForeground(false); mode.Dispose(); clock.advance(600000); assert.equal(switched, 2);
  assert.equal(clock.tasks.size, 0);
});
test('a cancelled callback cannot switch later and save failures are reported without an uncaught timer error', () => {
  const clock = Clock(), errors = []; let switched = 0;
  const mode = new BackgroundMode(() => ({ autoThumbnailEnabled: true, autoThumbnailMinutes: 1 }), () => true, () => { switched++; throw new Error('save failed'); }, { ...clock, onError: e => errors.push(e.message) });
  mode.SetForeground(false); const stale = [...clock.tasks.values()][0].fn; mode.SetForeground(true); stale(); assert.equal(switched, 0);
  mode.SetForeground(false); clock.advance(60000); assert.equal(switched, 1); assert.deepEqual(errors, ['save failed']);
  assert.equal(ValidateSettings({}).autoThumbnailMinutes, 5); assert.equal(ValidateSettings({ autoThumbnailMinutes: 0 }).autoThumbnailMinutes, 1);
  assert.equal(ValidateSettings({ autoThumbnailMinutes: 500 }).autoThumbnailMinutes, 120);
});
