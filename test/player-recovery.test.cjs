'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PlayerRecovery } = require('../src/core/player-recovery.cjs');
function Harness() {
  let now = 0, serial = 0; const tasks = new Map(), recovered = [];
  const recovery = new PlayerRecovery((...args) => recovered.push(args), { schedule: (fn, ms) => { const id = ++serial; tasks.set(id, { fn, at: now + ms }); return id; }, cancel: id => tasks.delete(id) });
  return { recovery, recovered, async advance(ms) { now += ms; for (const [id, task] of tasks) if (task.at <= now) { tasks.delete(id); task.fn(); } await Promise.resolve(); }, tasks };
}
test('embedded playback preparation timeout attempts recovery once, while disabled recovery does not loop', async () => {
  const h = Harness(); h.recovery.Begin(1, true); await h.advance(19999); assert.equal(h.recovered.length, 0);
  await h.advance(1); assert.deepEqual(h.recovered, [[1, 'timeout']]); await h.advance(60000); assert.equal(h.recovered.length, 1);
  h.recovery.Begin(2, false); await h.advance(60000); assert.equal(h.recovered.length, 1);
});
test('ready paused media does not trigger fallback, while decode failure can recover without waiting', async () => {
  const h = Harness(); h.recovery.Begin(1, true); h.recovery.Observe(1, { ready: true, errorCode: 0 }); await h.advance(60000); assert.equal(h.recovered.length, 0);
  h.recovery.Begin(2, true); h.recovery.Observe(2, { ready: false, errorCode: 3 }); await Promise.resolve(); assert.deepEqual(h.recovered, [[2, 'media-error']]);
});
test('stopping or selecting another track cancels both a pending timer and a queued fallback', async () => {
  const h = Harness(); h.recovery.Begin(1, true); const stale = [...h.tasks.values()][0].fn;
  h.recovery.Begin(2, true); stale(); h.recovery.Observe(1, { ready: true });
  h.recovery.Observe(2, { ready: false, errorCode: 4 }); h.recovery.Cancel(); await Promise.resolve(); assert.equal(h.recovered.length, 0);
  await h.advance(60000); assert.equal(h.recovered.length, 0);
});
