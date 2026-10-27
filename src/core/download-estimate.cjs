'use strict';
const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { DownloadDiagnostic } = require('./download-errors.cjs');
const { ParseBilibili } = require('./urls.cjs');
function DownloadSelection(entries, { kind, height = 720 }) {
  if (!['video', 'audio'].includes(kind) || ![360, 720, 1080].includes(height)) throw new Error('保存形式・画質の指定が正しくありません。');
  const unique = new Map(); for (const entry of entries) if (entry.type === 'bilibili') unique.set(ParseBilibili(entry.url).url, structuredClone(entry));
  if (!unique.size) throw new Error('保存対象のBilibili動画がありません。');
  if (unique.size > 10000) throw new Error('一度に保存できる動画は10000件までです。');
  return [...unique.values()];
}
function EstimateKey(entries, options, directory) { return createHash('sha256').update(JSON.stringify([directory, options.kind, options.height || 720, entries.map(e => ParseBilibili(e.url).url)])).digest('hex'); }
function PlanBytes(plan) {
  let bytes = 0;
  if (!plan.streams?.length) return null;
  for (const stream of plan.streams) {
    const size = stream.size > 0 ? stream.size : stream.bandwidth > 0 && plan.duration > 0 ? Math.ceil(stream.bandwidth * plan.duration / 8) : null;
    if (!Number.isSafeInteger(size) || size <= 0) return null; bytes += size;
  }
  return Number.isSafeInteger(bytes) ? bytes : null;
}
async function AvailableBytes(directory) {
  try { while (!fs.existsSync(directory) && path.dirname(directory) !== directory) directory = path.dirname(directory); const stat = await fs.promises.statfs(directory, { bigint: true }); return Number(stat.bavail * stat.bsize); } catch { return null; }
}
function CapacityEstimate({ total, skipped, unknown, mediaBytes, images, largest, freeBytes }) {
  const downloadBytes = mediaBytes + images * 256 * 1024, fileBytes = Math.ceil(mediaBytes * 1.03) + images * 3 * 1024 * 1024;
  return { total, skipped, unknown, downloadBytes, fileBytes,
    requiredBytes: fileBytes + Math.ceil(largest.reduce((sum, bytes) => sum + bytes, 0) * 2.03), freeBytes,
    secondsMin: unknown ? null : Math.ceil(downloadBytes * 8 / 100000000 + (total - skipped) * 3 + images),
    secondsMax: unknown ? null : Math.ceil(downloadBytes * 8 / 10000000 + (total - skipped) * 3 + images) };
}
class LiveEstimate {
  constructor(entries, options, directory) { this.entries = entries; this.options = options; this.directory = directory; this.results = new Map(); this.freeBytes = null; }
  Observe(entry, plan) { this.results.set(entry.url, { bytes: PlanBytes(plan), duration: plan.duration || entry.duration || 0, image: !!plan.thumbnailURL }); }
  Saved(entry, record, hasCover) { this.results.set(entry.url, { bytes: 0, skipped: true, image: !hasCover }); }
  Completed(entry, bytes, hasCover) { const previous = this.results.get(entry.url) || {}; this.results.set(entry.url, { ...previous, bytes, image: hasCover, completed: true }); }
  Finished(entry) { const value = this.results.get(entry.url); if (value) value.completed = true; }
  Failed(entry) { this.results.set(entry.url, { bytes: null, failed: true, image: false }); }
  Snapshot() {
    const samples = [...this.results.values()].filter(r => !r.skipped && !r.failed && r.bytes > 0), skipped = [...this.results.values()].filter(r => r.skipped).length;
    const mediaBytes = samples.reduce((n, r) => n + r.bytes, 0), duration = samples.reduce((n, r) => n + r.duration, 0);
    const average = samples.length ? mediaBytes / samples.length : 0, rate = duration > 0 && samples.every(r => r.duration > 0) ? mediaBytes / duration : 0;
    const unknownEntries = this.entries.filter(e => !this.results.has(e.url) || this.results.get(e.url).bytes === null);
    const pending = unknownEntries.filter(e => !this.results.get(e.url)?.failed);
    // 保存ワーカーが取得した情報だけで推計する。見積もり専用のAPI照会は増やさない。
    const predicted = Math.ceil(pending.reduce((n, e) => n + (rate && (e.duration || this.results.get(e.url)?.duration) ? rate * (e.duration || this.results.get(e.url).duration) : average), 0));
    const images = [...this.results.values()].filter(r => r.image).length + (samples.length ? pending.length : 0);
    const unfinished = samples.filter(r => !r.completed);
    const largest = unfinished.map(r => r.bytes).sort((a, b) => b - a).slice(0, 3);
    if (pending.length && !largest.length && samples.length) largest.push(Math.max(...samples.map(r => r.bytes)));
    if (pending.length && largest.length) while (largest.length < Math.min(3, unfinished.length + pending.length)) largest.push(largest[0]);
    const value = CapacityEstimate({ total: this.entries.length, skipped, unknown: unknownEntries.length, mediaBytes: mediaBytes + predicted, images, largest, freeBytes: this.freeBytes });
    const remaining = CapacityEstimate({ total: this.entries.length, skipped, unknown: unknownEntries.length,
      mediaBytes: unfinished.reduce((n, r) => n + r.bytes, 0) + predicted,
      images: [...this.results.values()].filter(r => r.image && !r.completed).length + (samples.length ? pending.length : 0), largest, freeBytes: this.freeBytes });
    value.requiredBytes = remaining.requiredBytes;
    const projected = pending.length > 0 && samples.length > 0;
    if (projected) {
      const timing = CapacityEstimate({ total: this.entries.length, skipped, unknown: 0, mediaBytes: mediaBytes + predicted, images, largest, freeBytes: this.freeBytes });
      value.secondsMin = timing.secondsMin; value.secondsMax = timing.secondsMax;
    }
    return { ...value, checked: this.results.size, projected, knownMediaBytes: mediaBytes, key: EstimateKey(this.entries, this.options, this.directory), createdAt: Date.now() };
  }
}
async function EstimateDownloads(entries, options, { directory, resolve, cached, cover, signal, pause = delay, changed = () => {} }) {
  let mediaBytes = 0, images = 0, skipped = 0, unknown = 0, checked = 0; const failures = [], largest = [];
  for (const entry of entries) {
    signal.throwIfAborted(); const saved = cached(entry, options.kind, true);
    if (saved && (options.kind === 'audio' || saved.requestedHeight === (options.height || 720))) { skipped++; if (!cover(saved.token)) images++; }
    else {
      try { const plan = await resolve(entry, options.kind, signal, { height: options.height || 720 }); signal.throwIfAborted(); const bytes = PlanBytes(plan); if (bytes === null) unknown++; else { mediaBytes += bytes; largest.push(bytes); largest.sort((a, b) => b - a); largest.length = Math.min(3, largest.length); } if (plan.thumbnailURL) images++; }
      catch (error) { if (signal.aborted || error.stopBatch) throw error; unknown++; if (failures.length < 20) failures.push({ title: entry.title || entry.videoId, ...DownloadDiagnostic(error, 'metadata') }); }
      if (checked + 1 < entries.length) await pause(350, null, { signal });
    }
    changed({ checked: ++checked, total: entries.length });
  }
  return { ...CapacityEstimate({ total: entries.length, skipped, unknown, mediaBytes, images, largest, freeBytes: await AvailableBytes(directory) }),
    key: EstimateKey(entries, options, directory), createdAt: Date.now(), checked, projected: false, failures };
}
function JobTiming(job, now = Date.now()) {
  if (!job) return null;
  const elapsedSeconds = Math.max(0, ((job.endedAt || now) - (job.startedAt || now)) / 1000);
  let remainingSeconds = null;
  if (['completed', 'partial'].includes(job.status)) remainingSeconds = 0;
  else if (job.status === 'running' && elapsedSeconds >= 2) {
    if (job.estimate && (!job.estimate.unknown || job.estimate.projected) && job.downloadedBytes >= 128 * 1024) remainingSeconds = Math.ceil(Math.max(0, job.estimate.downloadBytes - job.downloadedBytes) / (job.downloadedBytes / elapsedSeconds) + (job.total - job.finished) * 3);
    else if (job.finished) remainingSeconds = Math.ceil(elapsedSeconds / job.finished * (job.total - job.finished));
  }
  return { ...structuredClone(job), elapsedSeconds, remainingSeconds };
}
module.exports = { DownloadSelection, EstimateKey, PlanBytes, AvailableBytes, EstimateDownloads, LiveEstimate, JobTiming };
