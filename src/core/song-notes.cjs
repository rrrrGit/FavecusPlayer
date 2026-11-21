'use strict';
// 曲の情報（v0.7.4）：アーティスト・タグ・メモ・チャプター（歌枠や長尺動画の頭出し）。曲のメディアのキー単位（同じ動画・パートは共通）。
// この端末内だけに保存し、同期しない・ZIPにも含めない（ライブラリの形式は変えない）。PC版・iPhone版で同じ規則（共通JS）。
const MAX_ARTIST = 100, MAX_TAGS = 20, MAX_TAG = 30, MAX_MEMO = 2000, MAX_CHAPTERS = 200, MAX_CHAPTER_TITLE = 100, MAX_SECONDS = 604800;

const clean = (value, max) => String(value ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanMemo = value => String(value ?? '').normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, MAX_MEMO);

// 入力を、安全な形にする（長さ・件数の上限、重複の除去、チャプターは時刻順）。知らない項目は捨てる。
function Normalize(input) {
  const raw = input && typeof input === 'object' ? input : {}, seenTags = new Set(), tags = [];
  for (const tag of Array.isArray(raw.tags) ? raw.tags : []) {
    const text = clean(tag, MAX_TAG).replace(/^#/, '');
    if (!text || seenTags.has(text.toLowerCase())) continue;
    seenTags.add(text.toLowerCase()); tags.push(text);
    if (tags.length >= MAX_TAGS) break;
  }
  const byTime = new Map();
  for (const chapter of Array.isArray(raw.chapters) ? raw.chapters : []) {
    const at = Math.floor(Number(chapter?.at)), title = clean(chapter?.title, MAX_CHAPTER_TITLE);
    if (!Number.isFinite(at) || at < 0 || at > MAX_SECONDS || !title) continue;
    byTime.set(at, { at, title }); // 同じ時刻は、あとのものを使う
  }
  const chapters = [...byTime.values()].sort((a, b) => a.at - b.at).slice(0, MAX_CHAPTERS);
  return { artist: clean(raw.artist, MAX_ARTIST), tags, memo: cleanMemo(raw.memo), chapters };
}
const IsEmpty = record => { const r = Normalize(record); return !r.artist && !r.tags.length && !r.memo && !r.chapters.length; };

// 時刻の文字（「1:23」「01:02:03」「83」）を、秒にする。読めなければ null。
function ParseTime(text) {
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})$/.exec(String(text).trim()) || /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!match) return null;
  const parts = String(text).trim().split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n)) || parts.at(-1) >= 60 || (parts.length === 3 && parts[1] >= 60)) return null;
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}
// 貼り付けた文（動画の説明欄の目次など）から、チャプターを取り出す。1行に「時刻 題名」（時刻は行頭か行末。「-」「・」「 」で区切る）。読めない行は飛ばす。
function ParseChapters(text) {
  const chapters = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const head = /^[\[(（【]?(\d{1,3}:\d{2}(?::\d{2})?)[\])）】]?[\s\-–—・:：]*(.*)$/.exec(trimmed), tail = /^(.*?)[\s\-–—・:：]*[\[(（【]?(\d{1,3}:\d{2}(?::\d{2})?)[\])）】]?$/.exec(trimmed);
    const found = head && head[2] ? [head[1], head[2]] : tail && tail[1] ? [tail[2], tail[1]] : null;
    if (!found) continue;
    const at = ParseTime(found[0]);
    if (at !== null) chapters.push({ at, title: found[1] });
  }
  return Normalize({ chapters }).chapters;
}
const FormatTime = seconds => {
  const s = Math.max(0, Math.floor(Number(seconds) || 0)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
// チャプターを、編集用の文（1行に「時刻 題名」）にする。ParseChapters の逆。
const FormatChapters = chapters => Normalize({ chapters }).chapters.map(c => `${FormatTime(c.at)} ${c.title}`).join('\n');
// 再生位置（秒）がいるチャプター（なければ null）。
function ChapterAt(chapters, seconds) {
  let current = null;
  for (const chapter of Normalize({ chapters }).chapters) if (chapter.at <= seconds) current = chapter; else break;
  return current;
}

module.exports = { MAX_ARTIST, MAX_TAGS, MAX_TAG, MAX_MEMO, MAX_CHAPTERS, MAX_CHAPTER_TITLE, MAX_SECONDS, Normalize, IsEmpty, ParseTime, ParseChapters, FormatTime, FormatChapters, ChapterAt };
