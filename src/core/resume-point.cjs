'use strict';
// 前回の続きから再生（v0.7.3 F2）。最後に再生していた曲・再生範囲・位置を、この端末にだけ保存する（同期しない）。
// ・位置は、約10秒ごと（一時停止にした瞬間は、すぐ）に保存する。
// ・再開の位置：5秒未満、または終わりの5秒以内なら、曲の頭から。
// 保存できなくても、再生は妨げない。読めない・形式が違う保存ファイルは、使わない（上書きは、次の保存で行う）。
const { ReadJson, WriteJsonAtomic, RemoveFile } = require('./json-file.cjs');

const EDGE_SECONDS = 5;
const INTERVAL_MS = 10000;

function ResumePosition(position, duration) {
  const p = Number(position), d = Number(duration);
  if (!Number.isFinite(p) || p < EDGE_SECONDS) return 0;
  if (Number.isFinite(d) && d > 0 && p > d - EDGE_SECONDS) return 0;
  return Math.floor(p);
}

const Text = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
function Clean(value) {
  if (!value || typeof value !== 'object' || !Text(value.entryId) || !Text(value.playlistId) || !Text(value.scope)) return null;
  const position = Number(value.position), duration = Number(value.duration);
  if (!Number.isFinite(position) || position < 0 || !Number.isFinite(duration) || duration < 0) return null;
  return { entryId: value.entryId, playlistId: value.playlistId, scope: value.scope, position: Math.floor(position), duration: Math.floor(duration), savedAt: Number(value.savedAt) || 0 };
}

class ResumeStore {
  constructor(file, now = Date.now) {
    this.file = file; this.now = now; this.pending = null; this.lastWrite = 0; this.lastPaused = true;
    this.value = Clean(ReadJson(file));
  }
  // sample：{ entryId, playlistId, scope, position, duration }。paused：一時停止中か。
  Observe(sample, paused = false) {
    const clean = Clean({ ...sample, savedAt: this.now() });
    if (!clean) return;
    this.pending = clean;
    const becamePaused = paused && !this.lastPaused;
    this.lastPaused = paused;
    if (becamePaused || this.now() - this.lastWrite >= INTERVAL_MS) this.Flush();
  }
  Flush() {
    if (!this.pending) return;
    const value = this.pending; this.pending = null; this.lastWrite = this.now(); this.value = value;
    if (!WriteJsonAtomic(this.file, { version: 1, ...value })) this.pending = value;
  }
  // 保存済みの内容（書き込み前の最新を含む）。再開の位置は、規則で補正して返す。
  Get() {
    const value = this.pending || this.value;
    return value ? { ...value, position: ResumePosition(value.position, value.duration) } : null;
  }
  Clear() {
    this.pending = null; this.value = null;
    RemoveFile(this.file);
  }
}

module.exports = { ResumeStore, ResumePosition, EDGE_SECONDS, INTERVAL_MS };
