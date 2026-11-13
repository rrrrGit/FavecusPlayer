'use strict';
// 端末ごとのメディア保存情報（DeviceMedia）の共通定義。端末非依存の純粋な処理で、ファイル・通信・時計に依存しない。
// 保存形式は変更しない。Windows版ではDLカタログ（layout 4）を読み取り専用で投影する。
// DeviceMediaは同期しない（端末ごとの保存状態であり、パスは含めない）。
const { LibrarySyncKey } = require('./library-identity.cjs');

const DEVICE_MEDIA_STATES = Object.freeze(['NotDownloaded', 'Preparing', 'Downloading', 'Processing', 'Validating', 'Completed', 'Failed', 'Cancelled']);
const IN_PROGRESS = Object.freeze(['Preparing', 'Downloading', 'Processing', 'Validating']);
const KINDS = Object.freeze(['video', 'audio']);

const IsDeviceMediaState = value => DEVICE_MEDIA_STATES.includes(value);
const IsComplete = state => state === 'Completed';
// 再起動後の扱い：保存の途中だった状態は完成扱いにせず、未保存へ戻す。完成・失敗・取消は保持する。
// 未知の状態は完成扱いにしない。
function RestoredState(state) {
  if (state === 'Completed' || state === 'Failed' || state === 'Cancelled' || state === 'NotDownloaded') return state;
  return 'NotDownloaded';
}
// 読み取り専用の投影。records：DLカタログ相当の記録 [{ url, kind, height, bytes, duration }]、isAvailable(record)：実体を確認済みか。
// 出力に端末のパス・トークン・URLは含めない。カタログが証明できるものだけを写す（確認済みの実体があればCompleted、なければNotDownloaded。
// 途中の状態はカタログからは分からないため作らない）。同じsyncKey・形式に複数の記録がある場合も、推測で統合せず全件を決定的な順で返し、
// collision（同じ組の件数）で知らせる。何も削除しない。
function Available(isAvailable, record) {
  try { return typeof isAvailable === 'function' && isAvailable(record) === true; } catch { return false; }
}
function DeviceMediaList({ records = [], videoAliases = [], isAvailable = () => false } = {}) {
  // 読み取り専用の投影が呼び出し側を壊さないよう、型の異なる入力は空として扱い、実体確認の例外はその記録だけ未保存とする。
  // 矛盾したav/BV対応表は誤ったキーを黙って作らないため、例外のまま伝える。
  const syncKey = LibrarySyncKey(Array.isArray(videoAliases) ? videoAliases : []), items = [];
  let skipped = 0;
  for (const record of Array.isArray(records) ? records : []) {
    let key = null;
    try { key = record && KINDS.includes(record.kind) ? syncKey({ type: 'bilibili', url: record.url }) : null; } catch { key = null; }
    if (!key) { skipped++; continue; }
    items.push({ syncKey: key, kind: record.kind, height: Number.isFinite(record.height) ? record.height : 0, bytes: Number.isSafeInteger(record.bytes) ? record.bytes : 0,
      duration: Number.isFinite(record.duration) ? record.duration : 0, state: Available(isAvailable, record) ? 'Completed' : 'NotDownloaded' });
  }
  const count = new Map();
  for (const item of items) { const id = `${item.syncKey}\n${item.kind}`; count.set(id, (count.get(id) || 0) + 1); }
  items.sort((a, b) => a.syncKey < b.syncKey ? -1 : a.syncKey > b.syncKey ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : b.height - a.height || b.bytes - a.bytes || a.duration - b.duration || (a.state < b.state ? -1 : a.state > b.state ? 1 : 0));
  for (const item of items) item.collision = count.get(`${item.syncKey}\n${item.kind}`);
  return { items, skipped };
}

module.exports = { DEVICE_MEDIA_STATES, IN_PROGRESS, IsDeviceMediaState, IsComplete, RestoredState, DeviceMediaList };
