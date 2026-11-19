'use strict';
// v0.7.3 F1：おやすみタイマーの規則（時刻は偽の時計で進める）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SleepTimer, FADE_MS } = require('../src/core/sleep-timer.cjs');

function Make() {
  const clock = { t: 1_000_000 }, log = { fades: [], expired: 0, changes: [] };
  let tick = null;
  const timers = { set: fn => { tick = fn; return { unref() {} }; }, clear: () => { tick = null; } };
  const timer = new SleepTimer({ now: () => clock.t, timers, onFade: f => log.fades.push(f), onExpire: () => { log.expired++; }, onChange: s => log.changes.push(s.mode) });
  return { timer, clock, log, advance: ms => { clock.t += ms; tick?.(); }, hasTick: () => tick !== null };
}

test('only the listed durations are accepted, and the deadline is a wall-clock time', () => {
  const { timer, clock } = Make();
  assert.throws(() => timer.Start(20));
  timer.Start(30);
  assert.deepEqual(timer.State(), { mode: 'minutes', minutes: 30, deadline: clock.t + 30 * 60000, remainingMs: 30 * 60000 });
});

test('the volume fades only in the last seconds, then pauses once and restores the volume', () => {
  const { timer, log, advance } = Make();
  timer.Start(15);
  advance(15 * 60000 - FADE_MS - 1000);
  assert.equal(log.fades.length, 0, 'フェードの前は音量を触らない');
  advance(1000 + FADE_MS / 2); // 残り FADE_MS/2 を過ぎる直前の時刻
  assert.ok(log.fades.at(-1) > 0 && log.fades.at(-1) <= 0.5 + 1e-9, 'フェードの途中は 0〜1 の倍率');
  advance(FADE_MS / 2);
  assert.equal(log.expired, 1);
  assert.equal(log.fades.at(-1), 1, '一時停止のあと、音量を元に戻す');
  assert.equal(timer.State().mode, 'off');
  advance(60000);
  assert.equal(log.expired, 1, '期限のあとは、もう動かない');
});

test('a tick that arrives late (device was asleep) still stops at once', () => {
  const { timer, log, advance } = Make();
  timer.Start(45);
  advance(3 * 60 * 60 * 1000);
  assert.equal(log.expired, 1);
});

test('cancel restores the volume and stops ticking; restarting replaces the old timer', () => {
  const { timer, log, advance, hasTick } = Make();
  timer.Start(60);
  advance(60 * 60000 - 3000);
  assert.ok(log.fades.length > 0);
  timer.Cancel();
  assert.equal(log.fades.at(-1), 1);
  assert.equal(hasTick(), false);
  advance(10 * 60000);
  assert.equal(log.expired, 0);
  timer.Start(15); timer.Start(90);
  assert.equal(timer.State().minutes, 90);
});

test('"end of this song" stops once at the song end and does not tick', () => {
  const { timer, hasTick } = Make();
  timer.StartEndOfSong();
  assert.equal(hasTick(), false);
  assert.equal(timer.State().mode, 'song');
  assert.equal(timer.ConsumeEndOfSong(), true);
  assert.equal(timer.ConsumeEndOfSong(), false, '1回だけ');
  assert.equal(timer.State().mode, 'off');
  timer.Start(15);
  assert.equal(timer.ConsumeEndOfSong(), false, '時間のタイマーは、曲の終わりでは止まらない');
});

test('the button cycles off → 15 → 30 → 45 → 60 → 90 → end of song → off', () => {
  const order = [];
  let state = { mode: 'off' };
  for (let i = 0; i < 8; i++) {
    const next = SleepTimer.NextCommand(state);
    order.push(next.cancel ? 'off' : next.song ? 'song' : next.minutes);
    state = next.cancel ? { mode: 'off' } : next.song ? { mode: 'song' } : { mode: 'minutes', minutes: next.minutes };
  }
  assert.deepEqual(order, [15, 30, 45, 60, 90, 'song', 'off', 15]);
});

test('the player bar, preload and main process are wired to the timer', () => {
  const fs = require('node:fs'), path = require('node:path');
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(read('src/ui/index.html'), /id="sleep"/);
  assert.match(read('src/preloads/ui.cjs'), /sleepTimer: invoke\('player:sleep'\)/);
  const main = read('src/main.cjs');
  assert.match(main, /Handle\('player:sleep'/);
  assert.match(main, /ConsumeEndOfSong\(\)/, '曲の終わりまで：次の曲へ進まない');
  assert.match(main, /function SetVolume\(factor = 1\)/, 'フェードは設定の音量を変えない');
});
