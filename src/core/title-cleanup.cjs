'use strict';

const DEFAULT_TITLE_WORDS = Object.freeze(['ニコカラ', '純k投屏', '[', ']', '「', '」', '【', '】']);
function ValidateTitleWords(input = DEFAULT_TITLE_WORDS) {
  if (!Array.isArray(input) || input.length > 200) throw new Error('自動消去する語句は200個まで登録できます。');
  const seen = new Set(), words = [];
  for (const value of input) {
    if (typeof value !== 'string') throw new Error('自動消去する語句を文字で入力してください。');
    const word = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
    if (!word || word.length > 80) throw new Error('自動消去する語句は1〜80文字で入力してください。');
    const key = word.toLowerCase();
    if (!seen.has(key)) { words.push(word); seen.add(key); }
  }
  return words;
}
function TitleCleaner(words) {
  const escaped = ValidateTitleWords(words).sort((a, b) => b.length - a.length).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = escaped.length ? new RegExp(escaped.join('|'), 'gi') : null;
  return value => {
    let title = String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 180).replace(/\s+/g, ' ').trim();
    if (!pattern) return title;
    // 削除で語句が隣接しても、再起動や再追加で結果が変わらないようにする。
    let previous;
    do { previous = title; title = title.replace(pattern, '').replace(/\s+/g, ' ').trim(); } while (title !== previous);
    return title;
  };
}

module.exports = { DEFAULT_TITLE_WORDS, ValidateTitleWords, TitleCleaner };
