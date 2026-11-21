'use strict';
// 再生時間（バックグラウンド再生を含む）の集計・整形（PC版・iPhone版と同規則）。端末内の play-time.json にだけ保存し、同期しない。
const TZ_OFFSET_MS = 9 * 3600 * 1000; // 月の区切りは日本標準時（play-ledger.cjs と揃える）
const MAX_ELAPSED_SECONDS = 60;       // バックグラウンドでのタイマー間引きを吸収する上限
const MAX_MONTHS = 120;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;

const MonthOf = ms => new Date(Math.floor(ms) + TZ_OFFSET_MS).toISOString().slice(0, 7);

// 再生位置の進み方と実時間の経過を照合し、シークで飛んだ分・停止中を除いて実再生秒を返す。
class PlayTimeTracker {
  constructor() { this.active = null; }
  Begin(nowMs = Date.now()) { this.active = { position: null, at: nowMs, playing: false }; }
  Stop() { this.active = null; }
  Observe(media, nowMs = Date.now()) {
    if (!media || typeof media.position !== 'number' || !Number.isFinite(media.position)) return 0;
    if (!this.active) this.Begin(nowMs);
    const a = this.active, elapsed = (nowMs - a.at) / 1000, delta = media.position - (a.position ?? media.position);
    let added = 0;
    if (a.playing && elapsed > 0 && elapsed <= MAX_ELAPSED_SECONDS && delta > 0 && delta <= elapsed * Math.max(1, media.playbackRate || 1) + 2.0) {
      added = Math.min(delta, elapsed);
    }
    a.position = media.position; a.at = nowMs; a.playing = !media.paused && !media.ended;
    return added;
  }
}

function CleanMonths(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const valid = Object.entries(raw).filter(([month, seconds]) => MONTH.test(month) && typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0);
  valid.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return Object.fromEntries(valid.slice(-MAX_MONTHS));
}

function AddSeconds(months, seconds, nowMs = Date.now()) {
  if (!Number.isFinite(seconds) || seconds <= 0) return months;
  const key = MonthOf(nowMs);
  const next = { ...months, [key]: (months[key] || 0) + seconds };
  return Object.keys(next).length > MAX_MONTHS ? CleanMonths(next) : next;
}

function MonthlySeries(months, { months: count = 12, nowMs = Date.now() } = {}) {
  let total = 0;
  for (const value of Object.values(months || {})) if (Number.isFinite(value) && value > 0) total += value;
  const span = Math.max(1, Math.min(60, Math.floor(count) || 12)), series = [];
  const [year, month] = MonthOf(nowMs).split('-').map(Number);
  for (let back = span - 1; back >= 0; back--) {
    const index = year * 12 + (month - 1) - back;
    const y = Math.floor(index / 12), m = ((index % 12) + 12) % 12 + 1;
    const label = `${y}-${String(m).padStart(2, '0')}`;
    series.push({ month: label, seconds: Math.round((months && months[label]) || 0) });
  }
  return { totalSeconds: Math.round(total), months: series };
}

function FormatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  if (s === 0) return '0分';
  if (s < 60) return `${s}秒`;
  const minutes = Math.floor(s / 60), hours = Math.floor(minutes / 60), rem = minutes % 60;
  if (hours === 0) return `${minutes}分`;
  return rem > 0 ? `${hours}時間${rem}分` : `${hours}時間`;
}

module.exports = { TZ_OFFSET_MS, MAX_ELAPSED_SECONDS, MAX_MONTHS, MonthOf, PlayTimeTracker, CleanMonths, AddSeconds, MonthlySeries, FormatDuration };
