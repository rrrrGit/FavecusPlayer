'use strict';
// 月ごとの再生時間（バックグラウンド再生を含む）のファイル保存（PC版。端末内のみ・原子的に書く）。
const { ReadJson, WriteJsonAtomic } = require('./json-file.cjs');
const PlayTime = require('./play-time.cjs');

const FLUSH_INTERVAL_MS = 10000;

class PlayTimeStore {
  constructor(file, now = Date.now) {
    this.file = file; this.now = now; this.tracker = new PlayTime.PlayTimeTracker();
    this.dirty = false; this.lastFlush = 0; this.months = {};
    const data = ReadJson(file);
    if (data?.version === 1) this.months = PlayTime.CleanMonths(data.months);
  }
  Begin() { this.tracker.Begin(this.now()); }
  Stop() { this.Flush(); this.tracker.Stop(); }
  Observe(media) {
    const nowMs = this.now(), wasPlaying = !!this.tracker.active?.playing;
    const added = this.tracker.Observe(media, nowMs);
    if (added > 0) { this.months = PlayTime.AddSeconds(this.months, added, nowMs); this.dirty = true; }
    const becameStopped = (media?.paused || media?.ended) && wasPlaying;
    if (this.dirty && (becameStopped || nowMs - this.lastFlush >= FLUSH_INTERVAL_MS)) this.Flush();
  }
  Flush() {
    if (!this.dirty) return false;
    if (!WriteJsonAtomic(this.file, { version: 1, months: this.months })) return false;
    this.dirty = false; this.lastFlush = this.now();
    return true;
  }
  Stats(options = {}) { return PlayTime.MonthlySeries(this.months, { nowMs: this.now(), ...options }); }
}

module.exports = { PlayTimeStore, FLUSH_INTERVAL_MS };
