'use strict';
// 再生回数・設定・お気に入り・再生履歴の同期（Windows版・iPhone版で共通。端末APIなし）。
// ライブラリの同期（sync-session.cjs）の後に、別の処理として動かす。失敗・テーブル未作成でも、ライブラリの同期には影響しない。
// adapter（端末側）：
//   Read / Apply / Pushed（再生回数：既存形。counts.* がなくてもそのまま動作）
//   favorites?: { Read() → { deviceId, cursor, rows }, Apply({ rows, cursor }), Pushed() }
//   history?:   { Read() → { deviceId, cursor, clearedAt, rows }, Apply({ rows, clearedAt, cursor }), Pushed() }
// repository：sync-supabase.cjs の PushCounts / PullCounts / GetPrefs / PutPrefs / PushFavorites / PullFavorites / PushHistory / PullHistory / GetHistoryState / PutHistoryState。
const FavCore = require('./favorites-core.cjs');

const FATAL_CODES = new Set(['auth', 'paused', 'offline']);
const IsFatal = error => !!error && FATAL_CODES.has(error.code);

async function SyncCountsBlock(countsAdapter, repository, isAborted) {
  if (isAborted?.()) return null;
  const local = await countsAdapter.Read();
  if (!local || isAborted?.()) return null;
  const remote = await repository.GetPrefs();
  if (isAborted?.()) return null;
  const epoch = Math.max(local.epoch, remote ? remote.epoch : 0);
  // 設定は、新しい時刻の方が勝つ（同じなら、この端末のまま）
  const remoteWins = !!remote && remote.at > local.prefs.at;
  const prefs = remoteWins ? { weighted: remote.weighted, at: remote.at } : { weighted: local.prefs.weighted, at: local.prefs.at };
  const pulled = await repository.PullCounts(local.cursor, local.deviceId);
  if (isAborted?.()) return null;
  await countsAdapter.Apply({ rows: pulled.rows, epoch, cursor: pulled.cursor, prefs: remoteWins ? prefs : null });
  if (isAborted?.()) return null;
  if (local.rows.length) await repository.PushCounts(local.deviceId, local.rows);
  if (isAborted?.()) return null;
  if (!remote || local.epoch > remote.epoch || (!remoteWins && local.prefs.at > (remote ? remote.at : 0))) await repository.PutPrefs({ epoch, weighted: prefs.weighted, at: prefs.at });
  if (isAborted?.()) return null;
  await countsAdapter.Pushed();
  return { pushed: local.rows.length, pulled: pulled.rows.length, epoch };
}

async function SyncFavoritesBlock(favAdapter, repository, isAborted) {
  if (isAborted?.()) return null;
  const local = await favAdapter.Read();
  if (!local || isAborted?.()) return null;
  const pulled = await repository.PullFavorites(local.cursor);
  if (isAborted?.()) return null;
  await favAdapter.Apply({ rows: pulled.rows, cursor: pulled.cursor });
  if (isAborted?.()) return null;
  const pulledMap = new Map();
  for (const row of pulled.rows) pulledMap.set(row.key, row);
  const toPush = (local.rows || []).filter(row => {
    const remote = pulledMap.get(row.key);
    return !remote || FavCore.Newer(row, remote);
  });
  if (toPush.length) await repository.PushFavorites(local.deviceId, toPush);
  if (isAborted?.()) return null;
  await favAdapter.Pushed();
  return { pushed: toPush.length, pulled: pulled.rows.length };
}

async function SyncHistoryBlock(histAdapter, repository, isAborted) {
  if (isAborted?.()) return null;
  const local = await histAdapter.Read();
  if (!local || isAborted?.()) return null;
  const remoteState = await repository.GetHistoryState();
  if (isAborted?.()) return null;
  let remoteCleared = remoteState ? remoteState.clearedAt : 0;
  const pulled = await repository.PullHistory(local.cursor);
  if (isAborted?.()) return null;
  const afterState = await repository.GetHistoryState();
  if (isAborted?.()) return null;
  if (afterState && afterState.clearedAt > remoteCleared) remoteCleared = afterState.clearedAt;
  const clearedAt = Math.max(local.clearedAt || 0, remoteCleared);
  await histAdapter.Apply({ rows: pulled.rows, clearedAt, cursor: pulled.cursor });
  if (isAborted?.()) return null;
  const pulledMap = new Map();
  for (const row of pulled.rows) {
    const prev = pulledMap.get(row.key) || 0;
    if (row.at > prev) pulledMap.set(row.key, row.at);
  }
  const toPush = (local.rows || []).filter(row => row.at > clearedAt && row.at > (pulledMap.get(row.key) || 0));
  if ((local.clearedAt || 0) > remoteCleared) await repository.PutHistoryState({ clearedAt: local.clearedAt });
  if (isAborted?.()) return null;
  if (toPush.length) await repository.PushHistory(local.deviceId, toPush);
  if (isAborted?.()) return null;
  await histAdapter.Pushed();
  return { pushed: toPush.length, pulled: pulled.rows.length, clearedAt };
}

async function SyncExtras(adapter, repository, options = {}) {
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : null;
  const summary = {};
  const errors = [];
  let missing = false;
  const run = async (name, fn) => {
    if (isAborted?.()) return null;
    try {
      const result = await fn();
      if (!result) return null;
      if (name === 'counts') Object.assign(summary, result);
      else summary[name] = result;
    } catch (error) {
      if (IsFatal(error)) return { fatal: error };
      if (error && error.code === 'missing') missing = true;
      errors.push(String(error && error.message || error));
    }
    return null;
  };
  if (adapter && typeof adapter.Read === 'function') {
    const failed = await run('counts', () => SyncCountsBlock(adapter, repository, isAborted));
    if (failed) return { ok: false, missing: false, error: String(failed.fatal && failed.fatal.message || failed.fatal) };
  }
  if (adapter && adapter.favorites) {
    const failed = await run('favorites', () => SyncFavoritesBlock(adapter.favorites, repository, isAborted));
    if (failed) return { ok: false, missing: false, ...summary, error: String(failed.fatal && failed.fatal.message || failed.fatal) };
  }
  if (adapter && adapter.history) {
    const failed = await run('history', () => SyncHistoryBlock(adapter.history, repository, isAborted));
    if (failed) return { ok: false, missing: false, ...summary, error: String(failed.fatal && failed.fatal.message || failed.fatal) };
  }
  if (isAborted?.()) return { ok: false, aborted: true, missing, ...summary, error: '同期は中断されました。' };
  if (errors.length) return { ok: false, missing, ...summary, error: errors[0] };
  return { ok: true, ...summary };
}

module.exports = { SyncExtras };
