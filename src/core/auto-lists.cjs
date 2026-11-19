'use strict';
// 自動リスト（v0.7.3 F3）：「よく聴く曲」「最近追加した曲」「未再生」。PC版・iPhone版で同じ選び方（共通）。
// 保存せず、ライブラリと再生回数から、その都度作る（同期しない・編集しない）。
// ・全プレイリストの曲が対象（「すべてのリストに含める」の設定に関係なく）。同じメディア（キーが同じ）の曲は1曲にまとめ、
//   登録が最も新しいものを代表にする。キーのない曲（まだ識別できないBilibili曲など）は、曲ごとに別とし、再生回数は0とみなす。
// ・よく聴く曲：再生回数が1以上を、回数の多い順（同数は、登録の新しい順）。上位50。
// ・最近追加した曲：登録日時の新しい順。上位50。
// ・未再生：再生回数が0の曲を、登録の新しい順。上位200。
const LIMITS = { frequent: 50, recent: 50, unplayed: 200 };
const KINDS = ['frequent', 'recent', 'unplayed'];

const Compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ByRecent = (a, b) => Compare(b.addedAt, a.addedAt) || Compare(a.id, b.id);

// library：ライブラリ（playlists[].entries[]）。keys：{ 曲のID: メディアキー }。counts：{ メディアキー: 再生回数 }。
function Select({ library, keys = {}, counts = {}, limits = {} } = {}) {
  const limit = { ...LIMITS, ...limits }, best = new Map();
  for (const list of Array.isArray(library?.playlists) ? library.playlists : []) {
    for (const entry of Array.isArray(list?.entries) ? list.entries : []) {
      if (!entry || typeof entry.id !== 'string') continue;
      const mediaKey = typeof keys[entry.id] === 'string' && keys[entry.id] ? keys[entry.id] : '';
      const item = { id: entry.id, playlistId: list.id, key: mediaKey || `id:${entry.id}`, addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : '', count: mediaKey ? Math.max(0, Math.floor(Number(counts[mediaKey]) || 0)) : 0 };
      const known = best.get(item.key);
      if (!known || ByRecent(item, known) < 0) best.set(item.key, item);
    }
  }
  const items = [...best.values()];
  const pick = (filtered, compare, max) => filtered.sort(compare).slice(0, Math.max(0, max)).map(({ id, playlistId, count }) => ({ id, playlistId, count }));
  return {
    frequent: pick(items.filter(i => i.count > 0), (a, b) => b.count - a.count || ByRecent(a, b), limit.frequent),
    recent: pick(items, ByRecent, limit.recent),
    unplayed: pick(items.filter(i => i.count === 0), ByRecent, limit.unplayed)
  };
}

module.exports = { Select, LIMITS, KINDS };
