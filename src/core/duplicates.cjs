'use strict';
const { ParseBilibili } = require('./urls.cjs');
const TAGS = /^(?:双语字幕|雙語字幕|中日双语字幕|中日雙語字幕|中文字幕|日文字幕|中日字幕)\s*/;
const NOISE = new Set(['双语字幕', '雙語字幕', '中文字幕', '日文字幕', '中日字幕', '字幕', 'off', 'vocal', 'instrumental', 'lyrics', 'official', 'mv', 'pv', 'bgm', 'cover', '完整版', '高音质']);
function MediaKey(entry) { return entry.type === 'local' ? `local:${entry.fileName}` : `bilibili:${ParseBilibili(entry.url).url}`; }
function NameShape(value) {
  let title = String(value || '').normalize('NFKC').toLowerCase().trim();
  const full = title.replace(/[\p{P}\p{S}\s]+/gu, '');
  // 字幕タグと「曲名 - 投稿者」の付記は候補判定だけで除き、保存名は変えない。
  title = title.split(/\s+[-–—－]\s*/u)[0].replace(/[\p{P}\p{S}]+/gu, ' ').trim();
  let previous;
  do { previous = title; title = title.replace(TAGS, '').trim(); } while (title !== previous);
  const words = [...new Set(title.split(/\s+/u).filter(word => word && !NOISE.has(word)))];
  return { full, key: words.join(''), words };
}
function CompareNames(a, b) {
  if (a.full && a.full === b.full) return '曲名が一致';
  if (a.key && a.key === b.key) return '付記や表記の違いを除くと曲名が一致';
  const small = a.words.length <= b.words.length ? a.words : b.words, large = new Set(a.words.length <= b.words.length ? b.words : a.words);
  if (small.length && small.every(word => large.has(word)) && small.some(word => word.length >= 2)) return `曲名の語句が一致（${small.join(' ')}）`;
  return null;
}
class DuplicateIndex {
  constructor(entries = []) { this.media = new Map(); this.full = new Map(); this.names = new Map(); this.words = new Map(); for (const entry of entries) this.Add(entry); }
  Put(index, key, value) { if (!key) return; if (!index.has(key)) index.set(key, []); index.get(key).push(value); }
  Add(entry, origin = '既存の曲') {
    const record = { entry, origin, name: NameShape(entry.title) };
    this.Put(this.media, MediaKey(entry), record); this.Put(this.full, record.name.full, record); this.Put(this.names, record.name.key, record);
    for (const word of record.name.words) if (word.length >= 2) this.Put(this.words, word, record);
  }
  Find(entry) {
    const exact = this.media.get(MediaKey(entry));
    if (exact?.length) return { reason: entry.type === 'local' ? '同じ取り込み済みファイル' : 'URLとパートが一致', matches: exact.slice(0, 3) };
    const name = NameShape(entry.title), candidates = new Set([...(this.full.get(name.full) || []), ...(this.names.get(name.key) || [])]);
    for (const word of name.words) for (const record of this.words.get(word) || []) candidates.add(record);
    const matches = []; let reason;
    for (const record of candidates) {
      const match = CompareNames(name, record.name);
      if (match) { reason ||= match; matches.push(record); if (matches.length === 3) break; }
    }
    return matches.length ? { reason, matches } : null;
  }
}
module.exports = { MediaKey, NameShape, CompareNames, DuplicateIndex };
