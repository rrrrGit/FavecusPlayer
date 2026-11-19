'use strict';
// 音量の自動調整（v0.7.3 F5）：曲ごとの音量差を、大きい曲を下げて揃える（上げない＝音割れを避ける）。規則は、PC版・iPhone版で同じ。
// ・測るもの：曲全体の平均音量（RMS、dBFS。PC版は ffmpeg の volumedetect の mean_volume、iPhone版は復号した音声のRMS）。
// ・補正：目標 −16 dBより大きい曲だけ、差の分だけ下げる。下げすぎないよう、下限は 0.25（−12 dB）。
// ・測った結果は、曲のファイルごとに端末内へ覚える（ファイルが変わったら測り直す）。同期しない。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TARGET_DB = -16;
const MIN_GAIN = 0.25;

// 平均音量（dBFS）から、再生音量の倍率（0.25〜1）。測れない・無音に近い曲は、1（変えない）。
function Gain(meanDb) {
  if (!Number.isFinite(meanDb) || meanDb <= -60) return 1;
  const gain = 10 ** ((TARGET_DB - meanDb) / 20);
  return Math.max(MIN_GAIN, Math.min(1, gain));
}

// ffmpeg の volumedetect の出力（stderr）から、mean_volume（dB）を取り出す。なければ null。
function ParseMeanVolume(text) {
  const match = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(String(text));
  return match ? Number(match[1]) : null;
}

function Measure(executable, file, { timeoutMs = 120000, spawnFn = spawn } = {}) {
  return new Promise(resolve => {
    let output = '', done = false;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    let child;
    try { child = spawnFn(executable, ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file,pipe', '-i', path.resolve(file), '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, timeoutMs);
    child.stderr?.on('data', chunk => { output += chunk; if (output.length > 200000) output = output.slice(-100000); });
    child.once('error', () => finish(null));
    child.once('close', code => finish(code === 0 ? ParseMeanVolume(output) : null));
  });
}

class LoudnessStore {
  constructor(file, executable, options = {}) {
    this.file = file; this.executable = executable; this.options = options; this.pending = new Map(); this.records = {};
    try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); if (data?.version === 1 && data.records && typeof data.records === 'object') this.records = data.records; } catch { /* 空から始める */ }
  }
  Save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`; fs.writeFileSync(temp, JSON.stringify({ version: 1, records: this.records })); fs.renameSync(temp, this.file);
    } catch { /* 保存できなくても、再生は妨げない */ }
  }
  // ファイルの識別（パス・大きさ・更新時刻）。変わったら、測り直す。
  Identity(file) { try { const stat = fs.statSync(file); return `${path.resolve(file)}|${stat.size}|${Math.floor(stat.mtimeMs)}`; } catch { return null; } }
  Cached(file) {
    const identity = this.Identity(file), record = identity ? this.records[identity] : null;
    return record && Number.isFinite(record.meanDb) ? Gain(record.meanDb) : null;
  }
  // 倍率。測ったことがあれば、すぐ返す。なければ測る（同じファイルの同時の測定は、1回にまとめる）。測れなければ 1。
  async GainFor(file) {
    const cached = this.Cached(file);
    if (cached !== null) return cached;
    const identity = this.Identity(file);
    if (!identity || !this.executable) return 1;
    if (!this.pending.has(identity)) {
      this.pending.set(identity, Measure(this.executable, file, this.options).then(meanDb => {
        if (meanDb !== null) { this.records[identity] = { meanDb, at: Date.now() }; this.Prune(); this.Save(); }
        return meanDb;
      }).finally(() => this.pending.delete(identity)));
    }
    const meanDb = await this.pending.get(identity);
    return meanDb === null ? 1 : Gain(meanDb);
  }
  // 古い記録を整理する（最大2000件）。
  Prune() {
    const keys = Object.keys(this.records);
    if (keys.length <= 2000) return;
    for (const key of keys.sort((a, b) => (this.records[a].at || 0) - (this.records[b].at || 0)).slice(0, keys.length - 2000)) delete this.records[key];
  }
}

module.exports = { Gain, ParseMeanVolume, Measure, LoudnessStore, TARGET_DB, MIN_GAIN };
