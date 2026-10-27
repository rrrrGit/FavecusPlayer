'use strict';
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ParseBilibili } = require('./urls.cjs');
function TrackKey(entry) { return entry?.type === 'bilibili' ? ParseBilibili(entry.url).url : entry?.type === 'local' ? `local:${entry.fileName}` : ''; }
class PlayCounts {
  constructor(file, warn = () => {}) {
    this.file = file; this.warn = warn; this.counts = {}; this.active = null; this.now = () => Date.now();
    try {
      if (fs.existsSync(file)) {
        if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error('size');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.version !== 1 || !data.counts || typeof data.counts !== 'object' || Array.isArray(data.counts)) throw new Error('format');
        for (const [key, value] of Object.entries(data.counts)) if (/^(?:https:\/\/www\.bilibili\.com\/video\/|local:[a-f0-9-]+\.)/.test(key) && Number.isSafeInteger(value) && value >= 0) this.counts[key] = value;
      }
    } catch { try { fs.copyFileSync(file, `${file}.damaged-${Date.now()}`); } catch {} warn('再生回数を読み込めませんでした。元の記録を残し、回数を0から記録します。'); }
  }
  Count(entry) { return this.counts[TrackKey(entry)] || 0; }
  Begin(entry) { this.active = { key: TrackKey(entry), played: 0, position: null, at: this.now(), counted: false }; }
  Observe(media) {
    const a = this.active; if (!a || a.counted || !a.key || !media) return;
    const now = this.now(), elapsed = Math.max(0, (now - a.at) / 1000), delta = media.position - (a.position ?? media.position);
    // シークで飛ばした時間や、読み込めなかった曲を再生回数に含めない。
    if (!media.paused && a.playing && delta > 0 && delta <= elapsed * Math.max(1, media.playbackRate || 1) + .75) a.played += Math.min(delta, elapsed);
    a.position = media.position; a.at = now; a.playing = !media.paused;
    if (a.played >= 3 || media.ended && media.duration > 0 && a.played > 0 && a.played >= Math.min(3, media.duration * .8)) {
      a.counted = true; this.counts[a.key] = Math.min(Number.MAX_SAFE_INTEGER, (this.counts[a.key] || 0) + 1);
      try { this.Save(); } catch (error) { this.warn(`再生回数を保存できません: ${error.message}`); }
    }
  }
  Save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); const tmp = `${this.file}.${randomUUID()}.tmp`; try { fs.writeFileSync(tmp, JSON.stringify({ version: 1, counts: this.counts }), { flag: 'wx' }); fs.renameSync(tmp, this.file); } finally { fs.rmSync(tmp, { force: true }); } }
  Reset() { const old = this.counts; this.counts = {}; try { this.Save(); } catch (e) { this.counts = old; throw e; } if (this.active) this.active.counted = true; }
}
module.exports = { PlayCounts, TrackKey };
