'use strict';
// お気に入りの状態と同期規則（Windows版・iPhone版で共通。端末APIなし）。
// ・単位＝曲のメディアのキー。ローカルの曲（local:...）は端末内のみ（同期しない）。Bilibiliの曲（bili:... / bili-av:...）だけを同期する。
// ・上限＝お気に入り（fav: true）は最大20000曲。解除履歴（fav: false）は別枠で最大20000件（古い送信済みから整理し、お気に入り枠を圧迫しない）。
const VALID_KEY = /^[A-Za-z0-9:._-]{1,200}$/;
const SYNC_KEY = /^(?:bili:BV[A-Za-z0-9]{10}:p[1-9]\d{0,5}|bili-av:[1-9]\d{0,17}:p[1-9]\d{0,5})$/;
const MAX_KEYS = 20000;
const MAX_TOMBSTONES = 20000;
const MAX_FUTURE_SKEW_MS = 600000; // 未来時刻の防御上限（現在時刻＋10分）

const ValidKey = key => typeof key === 'string' && VALID_KEY.test(key);
const IsSyncKey = key => typeof key === 'string' && SYNC_KEY.test(key);

function DeriveKeys(doc) {
  doc.keys = Object.entries(doc.states).filter(([, state]) => state.fav).map(([key]) => key).sort();
}

function PruneTombstones(doc, protectedKeys = null) {
  const protect = protectedKeys instanceof Set ? protectedKeys : Array.isArray(protectedKeys) ? new Set(protectedKeys) : null;
  const tombstones = Object.entries(doc.states).filter(([, state]) => !state.fav);
  if (tombstones.length <= MAX_TOMBSTONES) return;
  let excess = tombstones.length - MAX_TOMBSTONES;
  tombstones.sort((a, b) => a[1].at - b[1].at || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [key] of tombstones) {
    if (excess <= 0) break;
    if (protect && protect.has(key)) continue;
    delete doc.states[key];
    excess--;
  }
}

// 保存ファイルから安全に読み込む。states がない旧形式（version: 1, keys[]）は、各キーを { fav: true, at: 1 } として移行する。
function Clean(raw) {
  const doc = { version: 1, keys: [], states: {}, syncCursor: 0 };
  let migrated = false;
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return { doc, migrated };
  if (Number.isSafeInteger(raw.syncCursor) && raw.syncCursor >= 0) doc.syncCursor = raw.syncCursor;
  if (raw.states && typeof raw.states === 'object' && !Array.isArray(raw.states)) {
    let favCount = 0;
    for (const [key, entry] of Object.entries(raw.states)) {
      if (!ValidKey(key) || !entry || typeof entry !== 'object' || typeof entry.fav !== 'boolean' || !Number.isFinite(entry.at) || entry.at < 1) continue;
      if (entry.fav) {
        if (favCount >= MAX_KEYS) continue;
        favCount++;
      }
      doc.states[key] = { fav: entry.fav, at: Math.floor(entry.at) };
    }
    PruneTombstones(doc);
    DeriveKeys(doc);
    return { doc, migrated };
  }
  if (Array.isArray(raw.keys)) {
    for (const key of raw.keys) {
      if (!ValidKey(key) || doc.states[key]) continue;
      if (Object.keys(doc.states).length >= MAX_KEYS) break;
      doc.states[key] = { fav: true, at: 1 };
    }
    migrated = Object.keys(doc.states).length > 0;
    DeriveKeys(doc);
  }
  return { doc, migrated };
}

function Newer(incoming, local) {
  if (!local) return true;
  if (incoming.at !== local.at) return incoming.at > local.at;
  return incoming.fav === true && !local.fav; // 同じ時刻の競合は、お気に入り（true）を優先する
}

function SetFavorite(doc, key, value, nowMs = 1, protectedKeys = null) {
  if (!ValidKey(key)) throw new Error('この曲は、まだ識別できないため、お気に入りにできません。');
  const nextFav = value === true, prev = doc.states[key], prevFav = !!prev?.fav;
  if (nextFav && !prevFav && doc.keys.length >= MAX_KEYS) throw new Error('お気に入りの上限（20000曲）に達しています。');
  if (prevFav === nextFav) return { changed: false, syncable: false, fav: nextFav };
  const baseAt = Number.isFinite(nowMs) && nowMs >= 1 ? Math.floor(nowMs) : 1;
  const at = Math.max(baseAt, (prev?.at || 0) + 1);
  doc.states[key] = { fav: nextFav, at };
  DeriveKeys(doc);
  PruneTombstones(doc, protectedKeys);
  return { changed: true, state: { key, fav: nextFav, at }, syncable: IsSyncKey(key), fav: nextFav };
}

function Merge(doc, rows = [], cursor = 0, nowMs = 0, protectedKeys = null) {
  let changed = 0, favCount = doc.keys.length;
  const maxAt = Number.isFinite(nowMs) && nowMs > 0 ? Math.floor(nowMs) + MAX_FUTURE_SKEW_MS : Infinity;
  for (const row of rows || []) {
    if (!row || !IsSyncKey(row.key) || typeof row.fav !== 'boolean' || !Number.isFinite(row.at) || row.at < 1) continue;
    const at = Math.min(Math.floor(row.at), maxAt);
    if (at < 1) continue;
    const local = doc.states[row.key];
    if (!Newer({ fav: row.fav, at }, local)) continue;
    if (row.fav && (!local || !local.fav)) {
      if (favCount >= MAX_KEYS) continue;
      favCount++;
    } else if (!row.fav && local?.fav) {
      favCount = Math.max(0, favCount - 1);
    }
    doc.states[row.key] = { fav: row.fav, at };
    changed++;
  }
  let moved = false;
  if (Number.isSafeInteger(cursor) && cursor > (doc.syncCursor || 0)) { doc.syncCursor = cursor; moved = true; }
  if (changed) { DeriveKeys(doc); PruneTombstones(doc, protectedKeys); }
  return { changed, moved };
}

// 判明した av→BV 対応を使って古いキーを正規キーへ統合する（より新しい状態を残す）。
function MigrateAliases(doc, canonical, protectedKeys = null) {
  if (typeof canonical !== 'function') return { changed: 0, migratedKeys: [] };
  let changed = 0;
  const migrated = new Set();
  for (const oldKey of Object.keys(doc.states)) {
    const nextKey = canonical(oldKey);
    if (!nextKey || nextKey === oldKey || !ValidKey(nextKey)) continue;
    const oldState = doc.states[oldKey], target = doc.states[nextKey];
    if (!target || Newer(oldState, target)) {
      doc.states[nextKey] = { fav: oldState.fav, at: oldState.at };
      migrated.add(nextKey);
    }
    delete doc.states[oldKey];
    changed++;
  }
  if (changed) { DeriveKeys(doc); PruneTombstones(doc, protectedKeys); }
  return { changed, migratedKeys: [...migrated].sort() };
}

function SyncRows(doc, filterKeys = null) {
  const filterSet = filterKeys instanceof Set ? filterKeys : Array.isArray(filterKeys) ? new Set(filterKeys) : null;
  return Object.entries(doc.states)
    .filter(([key]) => IsSyncKey(key) && (!filterSet || filterSet.has(key)))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, state]) => ({ key, fav: state.fav, at: state.at }));
}

module.exports = { VALID_KEY, SYNC_KEY, MAX_KEYS, MAX_TOMBSTONES, MAX_FUTURE_SKEW_MS, ValidKey, IsSyncKey, Clean, Newer, Set: SetFavorite, Merge, MigrateAliases, SyncRows, PruneTombstones };
