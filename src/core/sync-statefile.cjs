'use strict';
// 同期状態ファイル（sync/state.json）の内容の検証と書き出し（端末APIなし）。ファイルの読み書き自体は端末側（Windows：sync-storage.cjs、iPhone：Swift）。
// 未知の syncVersion や壊れた内容は、上書きせず停止状態（blocked）にする（黙って初期化・削除しない）。
const S = require('./sync-state.cjs');
const Clock = require('./sync-clock.cjs');

const STATE_VERSION = 1, MAX_STATE_BYTES = 256 * 1024 * 1024, MAX_CONFLICTS = 200;

// 戻り値：{ status: 'ok', snapshot } | { status: 'blocked', reason }
function ParseState(text) {
  try {
    if (typeof text !== 'string' || text.length > MAX_STATE_BYTES) return { status: 'blocked', reason: '同期データが大きすぎるため読み込めません。' };
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || !Number.isInteger(value.syncVersion)) return { status: 'blocked', reason: '同期データの形式が正しくありません。' };
    if (value.syncVersion > STATE_VERSION) return { status: 'blocked', reason: '新しい版のFavecusPlayerで作られた同期データです。このまま上書きしないため、同期を停止しました。アプリを更新してください。' };
    if (value.syncVersion < 1 || !Clock.DEVICE.test(value.deviceId) || !Number.isInteger(value.cursor) || value.cursor < 0 || (value.clock !== '' && !Clock.IsHlc(value.clock))) return { status: 'blocked', reason: '同期データの内容が正しくありません。' };
    if (!Array.isArray(value.outbox) || !Array.isArray(value.records) || !Array.isArray(value.conflicts)) return { status: 'blocked', reason: '同期データの内容が正しくありません。' };
    const records = S.Merge(S.NewState(), value.records).state; // 各レコードを検証（不正なら例外）
    const outbox = value.outbox.map(S.CleanChange);
    const conflicts = value.conflicts.slice(0, MAX_CONFLICTS).map(item => ({ reason: String(item?.reason || 'stale').slice(0, 40), change: S.CleanChange(item.change) }));
    return { status: 'ok', snapshot: { deviceId: value.deviceId, clock: value.clock, cursor: value.cursor, state: records, outbox, conflicts, origin: { url: String(value.origin?.url || ''), userId: String(value.origin?.userId || '') }, blocked: typeof value.blocked === 'string' ? value.blocked.slice(0, 1000) : '', lastSyncAt: Number.isFinite(value.lastSyncAt) ? value.lastSyncAt : 0, lastCompactAt: Number.isFinite(value.lastCompactAt) ? value.lastCompactAt : 0 } };
  } catch { return { status: 'blocked', reason: '同期データを読み込めません（壊れている可能性があります）。元のファイルは変更していません。' }; }
}
function SerializeState(device, extra = {}) {
  const records = Object.keys(device.state.records).sort().map(id => ({ id, f: device.state.records[id].f }));
  return JSON.stringify({ syncVersion: STATE_VERSION, deviceId: device.id, clock: device.clock, cursor: device.cursor, outbox: device.outbox, conflicts: device.conflicts.slice(-MAX_CONFLICTS), records, origin: extra.origin || { url: '', userId: '' }, blocked: extra.blocked || '', lastSyncAt: extra.lastSyncAt || 0, lastCompactAt: extra.lastCompactAt || 0 });
}
module.exports = { STATE_VERSION, MAX_STATE_BYTES, MAX_CONFLICTS, ParseState, SerializeState };
