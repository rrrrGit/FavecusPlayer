'use strict';
// 再生履歴（v0.7.4）：「最近聴いた曲」。再生回数を数えたとき（実再生の3秒など。数え方は play-ledger/PlayTracker）に、曲のキーと時刻を足す。
// この端末内だけに保存し、同期しない。新しいものが先頭。最大500件。PC版・iPhone版で同じ規則（共通JS）。
const MAX_ITEMS = 500;
const SAME_SONG_MS = 60 * 1000; // 同じ曲が続けて数えられたとき（リピート・やり直し）は、1回の記録にまとめる
const KEY = /^[A-Za-z0-9:._-]{1,220}$/;

// 保存された形を、安全な形にする（壊れた行・並びの崩れ・件数の超過を直す）。
function Clean(raw) {
  const items = [];
  for (const item of Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : []) {
    if (item && typeof item.key === 'string' && KEY.test(item.key) && Number.isFinite(item.at) && item.at > 0) items.push({ key: item.key, at: Math.floor(item.at) });
  }
  items.sort((a, b) => b.at - a.at);
  return items.slice(0, MAX_ITEMS);
}
// 1回の再生を足す（新しい配列を返す）。時刻が過去に戻っていても、並びは新しい順を保つ。
function Add(items, key, atMs) {
  if (typeof key !== 'string' || !KEY.test(key) || !Number.isFinite(atMs) || atMs <= 0) return Clean({ items });
  const list = Clean({ items });
  if (list[0] && list[0].key === key && Math.abs(atMs - list[0].at) < SAME_SONG_MS) { list[0] = { key, at: Math.max(atMs, list[0].at) }; return list; }
  return Clean({ items: [{ key, at: Math.floor(atMs) }, ...list] });
}
// 最近聴いた曲のキー（新しい順。同じ曲は、いちばん新しい1回だけ）。
function RecentKeys(items, limit = 100) {
  const seen = new Set(), keys = [];
  for (const item of Clean({ items })) { if (seen.has(item.key)) continue; seen.add(item.key); keys.push(item.key); if (keys.length >= limit) break; }
  return keys;
}

module.exports = { MAX_ITEMS, SAME_SONG_MS, Clean, Add, RecentKeys };
