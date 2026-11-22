'use strict';
// 再生履歴のファイル保存（PC版。規則は play-history.cjs＝共通JS）。原子的に書く。ローカル曲は端末内のみ、Bilibili曲・削除時刻は同期する（v0.7.5）。
const { ReadJson, WriteJsonAtomic } = require('./json-file.cjs');
const History = require('./play-history.cjs');

class HistoryStore {
  constructor(file, options = {}) {
    this.file = file;
    this.now = options.now || (() => Date.now());
    this.onChange = null;
    this.dirty = new Set(); this.dirtyCleared = false;
    this.inFlight = new Set(); this.inFlightCleared = false;
    this.touched = new Set(); this.touchedCleared = false;
    this.pushedOnce = false;
    this.state = History.CleanState(ReadJson(file));
  }
  get items() { return this.state.items; }
  Add(key, atMs) {
    const res = History.AddState(this.state, key, atMs);
    this.state = res.state;
    WriteJsonAtomic(this.file, this.state);
    if (res.syncable) { this.dirty.add(key); if (this.inFlight.has(key)) this.touched.add(key); }
    this.onChange?.({ key, syncable: res.syncable });
  }
  Keys(limit) { return History.RecentKeys(this.state.items, limit); }
  Clear() {
    this.state = History.ClearState(this.state, this.now());
    WriteJsonAtomic(this.file, this.state);
    this.dirty.clear(); this.touched.clear();
    this.dirtyCleared = true; if (this.inFlightCleared) this.touchedCleared = true;
    this.onChange?.({ cleared: true });
  }
  SyncRead(deviceId) {
    const rows = History.SyncRows(this.state, this.pushedOnce ? this.dirty : null);
    this.inFlight = new Set(rows.map(row => row.key)); this.touched = new Set();
    this.inFlightCleared = this.dirtyCleared; this.touchedCleared = false;
    return { deviceId, cursor: this.state.syncCursor || 0, clearedAt: this.state.clearedAt || 0, rows };
  }
  SyncApply({ rows = [], clearedAt = 0, cursor = 0 } = {}) {
    const res = History.MergeState(this.state, { rows, clearedAt, cursor }, this.now());
    if (res.changed || res.moved) { this.state = res.state; WriteJsonAtomic(this.file, this.state); }
    return res.changed ? 1 : 0;
  }
  SyncPushed() {
    for (const key of this.inFlight) if (!this.touched.has(key)) this.dirty.delete(key);
    if (this.inFlightCleared && !this.touchedCleared) this.dirtyCleared = false;
    this.inFlight = new Set(); this.touched = new Set();
    this.inFlightCleared = false; this.touchedCleared = false; this.pushedOnce = true;
  }
  ResetSync() {
    this.state = { ...this.state, syncCursor: 0 };
    this.dirty.clear(); this.dirtyCleared = false;
    this.inFlight.clear(); this.inFlightCleared = false;
    this.touched.clear(); this.touchedCleared = false;
    this.pushedOnce = false;
    WriteJsonAtomic(this.file, this.state);
  }
}

module.exports = { HistoryStore };
