'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const PlayTime = require('../src/core/play-time.cjs');
const { PlayTimeStore } = require('../src/core/play-time-store.cjs');
const { readMain, readApp } = require('./support-source.cjs');

test('PlayTimeTracker counts normal playback and throttled background updates while excluding pauses, seeks and oversized gaps', () => {
  const tracker = new PlayTime.PlayTimeTracker();
  tracker.Begin(0);
  assert.equal(tracker.Observe({ position: 0, paused: false, playbackRate: 1 }, 0), 0);
  assert.equal(tracker.Observe({ position: 5, paused: false, playbackRate: 1 }, 5000), 5);
  // バックグラウンド再生で 30 秒間タイマーが間引かれた場合も上限 60 秒以内なら加算する
  assert.equal(tracker.Observe({ position: 35, paused: false, playbackRate: 1 }, 35000), 30);
  // シークで大きく飛んだ分は加算しない
  assert.equal(tracker.Observe({ position: 150, paused: false, playbackRate: 1 }, 36000), 0);
  // 一時停止した瞬間の最後の区間（+5秒）は加算し、停止状態の継続中（a.playing=false）と再開直後は加算しない
  assert.equal(tracker.Observe({ position: 155, paused: true, playbackRate: 1 }, 41000), 5);
  assert.equal(tracker.Observe({ position: 157, paused: true, playbackRate: 1 }, 43000), 0);
  assert.equal(tracker.Observe({ position: 158, paused: false, playbackRate: 1 }, 44000), 0);
  // 倍速再生（2x）では実時間経過分（4秒）を超えない範囲で加算する
  assert.equal(tracker.Observe({ position: 166, paused: false, playbackRate: 2 }, 48000), 4);
  // 60 秒超の極端な空白（スリープ復帰など）は加算しない
  assert.equal(tracker.Observe({ position: 230, paused: false, playbackRate: 1 }, 115000), 0);
  // ended: true が paused: false のまま届いた場合も最終区間を加算したうえで停止状態（a.playing=false）にする
  assert.equal(tracker.Observe({ position: 234, paused: false, ended: true, playbackRate: 1 }, 119000), 4);
  assert.equal(tracker.Observe({ position: 236, paused: false, playbackRate: 1 }, 121000), 0);
});

test('MonthOf uses JST and MonthlySeries returns ordered months including zeros', () => {
  const jstMidnightUtc = Date.UTC(2026, 10, 30, 15, 0, 0); // 2026-12-01 00:00:00 JST
  assert.equal(PlayTime.MonthOf(jstMidnightUtc - 1000), '2026-11');
  assert.equal(PlayTime.MonthOf(jstMidnightUtc), '2026-12');
  const series = PlayTime.MonthlySeries({ '2026-10': 125, '2026-12': 3665 }, { months: 3, nowMs: jstMidnightUtc });
  assert.equal(series.totalSeconds, 3790);
  assert.deepEqual(series.months, [
    { month: '2026-10', seconds: 125 },
    { month: '2026-11', seconds: 0 },
    { month: '2026-12', seconds: 3665 }
  ]);
  assert.equal(PlayTime.FormatDuration(0), '0分');
  assert.equal(PlayTime.FormatDuration(45), '45秒');
  assert.equal(PlayTime.FormatDuration(125), '2分');
  assert.equal(PlayTime.FormatDuration(3600), '1時間');
  assert.equal(PlayTime.FormatDuration(3725), '1時間2分');
});

test('PlayTimeStore persists across restarts, ignores corrupt files, and main/UI wiring exists', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-playtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'play-time.json');
  let nowMs = Date.UTC(2026, 10, 21, 10, 0, 0);
  const store = new PlayTimeStore(file, () => nowMs);
  store.Begin();
  store.Observe({ position: 0, paused: false, playbackRate: 1 });
  nowMs += 12000;
  store.Observe({ position: 12, paused: false, playbackRate: 1 });
  nowMs += 3000;
  store.Observe({ position: 15, paused: true, playbackRate: 1 });

  const reloaded = new PlayTimeStore(file, () => nowMs);
  const stats = reloaded.Stats({ months: 1 });
  assert.equal(stats.totalSeconds, 15);
  assert.equal(stats.months[0].seconds, 15);

  fs.writeFileSync(file, '{ broken json');
  assert.equal(new PlayTimeStore(file, () => nowMs).Stats({ months: 1 }).totalSeconds, 0);

  const main = readMain(), app = readApp();
  assert.match(main, /PlayTimeStore/);
  assert.match(main, /playTimeStore\?\.Observe\(data\)/);
  assert.match(main, /totalSeconds: time\.totalSeconds/);
  assert.match(app, /月ごとの再生時間（最近12か月）/);
  assert.match(app, /バックグラウンド再生を含みます/);
});

test('PlayTimeStore.Flush keeps dirty = true when atomic write fails and clears it after recovery', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-pt-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'play-time.json');
  let nowMs = Date.UTC(2026, 10, 22, 12, 0, 0);
  const store = new PlayTimeStore(target, () => nowMs);
  store.Begin();
  store.Observe({ position: 0, paused: false, playbackRate: 1 });
  nowMs += 1000;
  store.Observe({ position: 1, paused: false, playbackRate: 1 });
  assert.equal(store.dirty, false);

  nowMs += 4000;
  store.Observe({ position: 5, paused: false, playbackRate: 1 });
  assert.equal(store.dirty, true);

  fs.rmSync(target, { force: true });
  fs.mkdirSync(target, { recursive: true });
  assert.equal(store.Flush(), false);
  assert.equal(store.dirty, true);

  fs.rmdirSync(target);
  assert.equal(store.Flush(), true);
  assert.equal(store.dirty, false);
  assert.equal(new PlayTimeStore(target, () => nowMs).Stats({ months: 1 }).totalSeconds, 5);
});
