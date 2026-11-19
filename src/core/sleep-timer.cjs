'use strict';
// おやすみタイマー（v0.7.3 F1）。PC版・iPhone版で同じ規則：
// ・時間（15・30・45・60・90分）、または「いま再生中の曲の終わりまで」。
// ・時間は、現在時刻の期限（deadline）で判定する（画面ロック・スリープで間隔が遅れても、期限を過ぎれば止める）。
// ・期限の直前の FADE_MS は、音量を下げていき（1→0）、期限で一時停止して、音量を元に戻す。
// 端末内の一時的な状態で、保存・同期はしない（アプリを終了すると解除）。
const MINUTES = [15, 30, 45, 60, 90];
const FADE_MS = 8000;
const TICK_MS = 1000;

class SleepTimer {
  // onFade(factor)：音量の倍率（1＝元の音量）。onExpire()：一時停止。onChange(state)：状態の変更。
  constructor({ now = Date.now, timers = { set: setInterval, clear: clearInterval }, onFade = () => {}, onExpire = () => {}, onChange = () => {} } = {}) {
    this.now = now; this.timers = timers; this.onFade = onFade; this.onExpire = onExpire; this.onChange = onChange;
    this.mode = 'off'; this.minutes = 0; this.deadline = 0; this.handle = null;
  }
  State() {
    return { mode: this.mode, minutes: this.minutes, deadline: this.mode === 'minutes' ? this.deadline : 0, remainingMs: this.mode === 'minutes' ? Math.max(0, this.deadline - this.now()) : 0 };
  }
  Start(minutes) {
    if (!MINUTES.includes(minutes)) throw new Error('おやすみタイマーの時間が正しくありません。');
    this.Reset(); this.mode = 'minutes'; this.minutes = minutes; this.deadline = this.now() + minutes * 60 * 1000;
    this.handle = this.timers.set(() => this.Tick(), TICK_MS); this.handle?.unref?.();
    this.onChange(this.State());
  }
  StartEndOfSong() { this.Reset(); this.mode = 'song'; this.onChange(this.State()); }
  Cancel() { const wasOn = this.mode !== 'off'; this.Reset(); if (wasOn) { this.onFade(1); this.onChange(this.State()); } }
  Reset() { if (this.handle) { this.timers.clear(this.handle); this.handle = null; } this.mode = 'off'; this.minutes = 0; this.deadline = 0; }
  Tick() {
    if (this.mode !== 'minutes') return;
    const remaining = this.deadline - this.now();
    if (remaining <= 0) { this.Reset(); this.onExpire(); this.onFade(1); this.onChange(this.State()); return; }
    if (remaining <= FADE_MS) this.onFade(remaining / FADE_MS);
  }
  // 曲の終わりに届いたとき：「曲の終わりまで」なら、次の曲へ進まずに止める（trueを返す）。
  ConsumeEndOfSong() {
    if (this.mode !== 'song') return false;
    this.Reset(); this.onChange(this.State()); return true;
  }
  // 画面のボタン用：オフ→15→…→90→曲の終わりまで→オフ の順に、次の指定を返す。
  static NextCommand(state) {
    const steps = [...MINUTES.map(minutes => ({ minutes })), { song: true }, { cancel: true }];
    const index = state?.mode === 'minutes' ? MINUTES.indexOf(state.minutes) : state?.mode === 'song' ? MINUTES.length : steps.length - 1;
    return steps[(index + 1) % steps.length];
  }
}
module.exports = { SleepTimer, MINUTES, FADE_MS, TICK_MS };
