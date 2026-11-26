'use strict';
// おやすみタイマーの規則と配線テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readMain } = require('./support-source.cjs');
const { SleepTimer, FADE_MS } = require('../src/core/sleep-timer.cjs');

function Make() {
  const clock = { t: 1_000_000 }, log = { fades: [], expired: 0, changes: [] };
  let tick = null;
  const timers = { set: fn => { tick = fn; return { unref() {} }; }, clear: () => { tick = null; } };
  const timer = new SleepTimer({ now: () => clock.t, timers, onFade: f => log.fades.push(f), onExpire: () => { log.expired++; }, onChange: s => log.changes.push(s.mode) });
  return { timer, clock, log, advance: ms => { clock.t += ms; tick?.(); }, hasTick: () => tick !== null };
}

test('listed durations fade only in the final seconds, expire once, restore volume, and handle late wake ticks', () => {
  const { timer, clock } = Make();
  assert.throws(() => timer.Start(20));
  timer.Start(30);
  assert.deepEqual(timer.State(), { mode: 'minutes', minutes: 30, deadline: clock.t + 30 * 60000, remainingMs: 30 * 60000 });

  const h = Make();
  h.timer.Start(15);
  h.advance(15 * 60000 - FADE_MS - 1000);
  assert.equal(h.log.fades.length, 0);
  h.advance(1000 + FADE_MS / 2);
  assert.ok(h.log.fades.at(-1) > 0 && h.log.fades.at(-1) <= 0.5 + 1e-9);
  h.advance(FADE_MS / 2);
  assert.equal(h.log.expired, 1);
  assert.equal(h.log.fades.at(-1), 1);
  assert.equal(h.timer.State().mode, 'off');
  h.advance(60000);
  assert.equal(h.log.expired, 1);

  const late = Make();
  late.timer.Start(45);
  late.advance(3 * 60 * 60 * 1000);
  assert.equal(late.log.expired, 1);
});

test('cancel restores volume, restart replaces timer, and end-of-song stops once without ticking', () => {
  const { timer, log, advance, hasTick } = Make();
  timer.Start(60);
  advance(60 * 60000 - 3000);
  assert.ok(log.fades.length > 0);
  timer.Cancel();
  assert.equal(log.fades.at(-1), 1);
  assert.equal(hasTick(), false);
  advance(10 * 60000);
  assert.equal(log.expired, 0);
  timer.Start(15);
  timer.Start(90);
  assert.equal(timer.State().minutes, 90);

  const eos = Make();
  eos.timer.StartEndOfSong();
  assert.equal(eos.hasTick(), false);
  assert.equal(eos.timer.State().mode, 'song');
  assert.equal(eos.timer.ConsumeEndOfSong(), true);
  assert.equal(eos.timer.ConsumeEndOfSong(), false);
  assert.equal(eos.timer.State().mode, 'off');
  eos.timer.Start(15);
  assert.equal(eos.timer.ConsumeEndOfSong(), false);
});

test('NextCommand cycles through off → 15..90 → song → off, and preload/main are wired', () => {
  const order = [];
  let state = { mode: 'off' };
  for (let i = 0; i < 8; i++) {
    const next = SleepTimer.NextCommand(state);
    order.push(next.cancel ? 'off' : next.song ? 'song' : next.minutes);
    state = next.cancel ? { mode: 'off' } : next.song ? { mode: 'song' } : { mode: 'minutes', minutes: next.minutes };
  }
  assert.deepEqual(order, [15, 30, 45, 60, 90, 'song', 'off', 15]);

  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(read('src/ui/index.html'), /id="sleep"/);
  assert.match(read('src/preloads/ui.cjs'), /sleepTimer: invoke\('player:sleep'\)/);
  const main = readMain();
  assert.match(main, /Handle\('player:sleep'/);
  assert.match(main, /ConsumeEndOfSong\(\)/);
  assert.match(main, /function SetVolume\(factor = 1\)/);
});
