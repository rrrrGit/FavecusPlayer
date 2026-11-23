'use strict';
// 再生履歴（v0.7.4〜）：「最近聴いた曲」。再生回数を数えたとき（実再生の3秒など。数え方は play-ledger/PlayTracker）に、曲のキーと時刻を足す。
// 新しいものが先頭。最大500件。ローカルの曲（local:...）はこの端末内のみ。Bilibiliの曲（bili:... / bili-av:...）と履歴の削除時刻は同期する（v0.7.5）。PC版・iPhone版で同じ規則（共通JS）。
const MAX_ITEMS = 500;
const SAME_SONG_MS = 60 * 1000; // 同じ曲が続けて数えられたとき（リピート・やり直し）は、1回の記録にまとめる
const KEY = /^[A-Za-z0-9:._-]{1,220}$/;
const SYNC_KEY = /^(?:bili:BV[A-Za-z0-9]{10}:p[1-9]\d{0,5}|bili-av:[1-9]\d{0,17}:p[1-9]\d{0,5})$/;
const MAX_FUTURE_SKEW_MS = 600000; // 未来時刻の防御上限（現在時刻＋10分）

const IsSyncKey = key => typeof key === 'string' && SYNC_KEY.test(key);

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

// ---- 同期向けの状態管理（v0.7.5）：{ version: 1, items, clearedAt, syncCursor }。旧形式もそのまま読める。
function CleanState(raw) {
  const clearedAt = Number.isFinite(raw?.clearedAt) && raw.clearedAt > 0 ? Math.floor(raw.clearedAt) : 0;
  const syncCursor = Number.isSafeInteger(raw?.syncCursor) && raw.syncCursor >= 0 ? raw.syncCursor : 0;
  const items = Clean(raw).filter(item => !(IsSyncKey(item.key) && item.at <= clearedAt));
  return { version: 1, items, clearedAt, syncCursor };
}
function AddState(state, key, atMs) {
  const s = CleanState(state);
  if (typeof key !== 'string' || !KEY.test(key) || !Number.isFinite(atMs) || atMs <= 0) return { state: s, added: null, syncable: false };
  const syncable = IsSyncKey(key);
  const at = syncable && s.clearedAt > 0 ? Math.max(Math.floor(atMs), s.clearedAt + 1) : Math.floor(atMs);
  const items = Add(s.items, key, at);
  return { state: { ...s, items }, added: { key, at }, syncable };
}
function ClearState(state, nowMs = 1) {
  const s = CleanState(state);
  const baseAt = Number.isFinite(nowMs) && nowMs >= 1 ? Math.floor(nowMs) : 1;
  return { version: 1, items: [], clearedAt: Math.max(baseAt, (s.clearedAt || 0) + 1), syncCursor: s.syncCursor };
}
function MergeState(state, { rows = [], clearedAt = 0, cursor = 0 } = {}, nowMs = 0) {
  const s = CleanState(state);
  const maxAt = Number.isFinite(nowMs) && nowMs > 0 ? Math.floor(nowMs) + MAX_FUTURE_SKEW_MS : Infinity;
  const clampedClear = Number.isFinite(clearedAt) && clearedAt > 0 ? Math.min(Math.floor(clearedAt), maxAt) : 0;
  const nextCleared = Math.max(s.clearedAt || 0, clampedClear);
  let itemsChanged = false;
  // リモートの履歴クリアは Bilibili の曲だけに適用し、ローカルの曲（この端末だけ）の履歴は残す
  const kept = [];
  for (const item of s.items) {
    if (IsSyncKey(item.key) && item.at <= nextCleared) { itemsChanged = true; continue; }
    kept.push(item);
  }
  const existingMax = new Map();
  for (const item of kept) {
    if (!IsSyncKey(item.key)) continue;
    const prev = existingMax.get(item.key) || 0;
    if (item.at > prev) existingMax.set(item.key, item.at);
  }
  const incomingWins = new Map();
  for (const row of rows || []) {
    if (!row || !IsSyncKey(row.key) || !Number.isFinite(row.at) || row.at <= 0) continue;
    const at = Math.min(Math.floor(row.at), maxAt);
    if (at <= nextCleared) continue;
    const currentBest = incomingWins.get(row.key) || 0;
    const localBest = existingMax.get(row.key) || 0;
    if (at > localBest && at > currentBest) incomingWins.set(row.key, at);
  }
  let mergedItems;
  if (incomingWins.size > 0) {
    itemsChanged = true;
    const filtered = kept.filter(item => !incomingWins.has(item.key));
    for (const [key, at] of incomingWins.entries()) filtered.push({ key, at });
    mergedItems = Clean({ items: filtered });
  } else {
    mergedItems = itemsChanged ? Clean({ items: kept }) : s.items;
  }
  const clearChanged = nextCleared !== (s.clearedAt || 0);
  const moved = Number.isSafeInteger(cursor) && cursor > (s.syncCursor || 0);
  const nextCursor = moved ? cursor : s.syncCursor;
  const changed = itemsChanged || clearChanged;
  return {
    state: changed || moved ? { version: 1, items: mergedItems, clearedAt: nextCleared, syncCursor: nextCursor } : s,
    changed,
    moved
  };
}
function SyncRows(state, filterKeys = null) {
  const s = CleanState(state), cleared = s.clearedAt || 0;
  const filterSet = filterKeys instanceof Set ? filterKeys : Array.isArray(filterKeys) ? new Set(filterKeys) : null;
  const best = new Map();
  for (const item of s.items) {
    if (!IsSyncKey(item.key) || item.at <= cleared) continue;
    if (filterSet && !filterSet.has(item.key)) continue;
    const prev = best.get(item.key) || 0;
    if (item.at > prev) best.set(item.key, item.at);
  }
  return [...best.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, at]) => ({ key, at }));
}

function MigrateAliases(state, canonical) {
  const s = CleanState(state);
  if (typeof canonical !== 'function') return { state: s, changed: false, migratedKeys: [] };
  let changed = false;
  const migrated = new Set();
  const mapped = s.items.map(item => {
    const nextKey = canonical(item.key);
    if (!nextKey || nextKey === item.key || !KEY.test(nextKey)) return item;
    changed = true;
    if (IsSyncKey(nextKey)) migrated.add(nextKey);
    return { key: nextKey, at: item.at };
  });
  if (!changed) return { state: s, changed: false, migratedKeys: [] };
  return {
    state: { version: 1, items: Clean({ items: mapped }), clearedAt: s.clearedAt, syncCursor: s.syncCursor },
    changed: true,
    migratedKeys: [...migrated].sort()
  };
}

module.exports = { MAX_ITEMS, SAME_SONG_MS, MAX_FUTURE_SKEW_MS, SYNC_KEY, IsSyncKey, Clean, Add, RecentKeys, CleanState, AddState, ClearState, MergeState, MigrateAliases, SyncRows };
