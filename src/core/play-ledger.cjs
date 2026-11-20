'use strict';
// 再生回数の台帳（Windows版・iPhone版で共通。端末APIなし）。
// 回数は「端末 × 世代 × 月 × 曲のキー」ごとの加算カウンタ（行）で持つ。1つの行を書くのは、その端末だけ（単独の書き手）なので、
// 端末間のマージは「行ごとに大きい方を残す」だけで、二重に数えず、順序・重複に依存せず収束する（G-Counter）。曲の回数は、現在の世代の行の合計。
// 月ごとに分けるのは、のちの「月間の再生回数ランキング」などにも使えるようにするため（今回の範囲では使わない）。
// リセット：世代を1つ上げる（大きい世代が勝つ）。古い世代の行は消さない（履歴を残す）。同時に複数の端末がリセットしても、同じ世代へ収束する。
// 曲のキー：Bilibiliは同期用メディアキー（bili:<BV>:p<パート>、共通の LibrarySyncKey）。ローカルの曲は「local:<ファイル名>」でこの端末だけ（同期しない）。
const TZ_OFFSET_MS = 9 * 3600 * 1000; // 月の区切りは日本標準時（端末の設定に依存させない）
const LEGACY = 'legacy';              // 旧形式（play-counts.json）から引き継いだ回数の月（月間の集計には含めない）
const MAX_ROWS = 200000, MAX_COUNT = Number.MAX_SAFE_INTEGER;
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
const MONTH = /^(?:\d{4}-(?:0[1-9]|1[0-2])|legacy)$/;
const KEY = /^(?:bili:BV[A-Za-z0-9]{10}:p[1-9]\d{0,5}|bili-av:[1-9]\d{0,17}:p[1-9]\d{0,5}|local:[A-Za-z0-9._-]{1,200})$/;
const IsSyncKey = key => typeof key === 'string' && key.startsWith('bili');

const MonthOf = ms => new Date(Math.floor(ms) + TZ_OFFSET_MS).toISOString().slice(0, 7);
const RowId = (device, epoch, month, key) => `${device}|${epoch}|${month}|${key}`;
function ParseRowId(id) {
  const parts = String(id).split('|');
  if (parts.length !== 4) return null;
  const [device, epochText, month, key] = parts, epoch = Number(epochText);
  if (!DEVICE.test(device) || !Number.isSafeInteger(epoch) || epoch < 0 || String(epoch) !== epochText || !MONTH.test(month) || !KEY.test(key)) return null;
  return { device, epoch, month, key };
}
const NewLedger = deviceId => {
  if (!DEVICE.test(String(deviceId))) throw new Error('端末の識別子が正しくありません。');
  return { version: 1, deviceId, epoch: 0, legacyImported: false, syncCursor: 0, rows: {} };
};
// 保存ファイル・外部から読んだ台帳の検証（不正な行は捨てる。捨てた件数は dropped）。
function Clean(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !DEVICE.test(String(raw.deviceId)) || !Number.isSafeInteger(raw.epoch) || raw.epoch < 0 || !raw.rows || typeof raw.rows !== 'object' || Array.isArray(raw.rows)) throw new Error('再生回数の形式が正しくありません。');
  const ledger = { version: 1, deviceId: raw.deviceId, epoch: raw.epoch, legacyImported: raw.legacyImported === true, syncCursor: Number.isSafeInteger(raw.syncCursor) && raw.syncCursor >= 0 ? raw.syncCursor : 0, rows: {} };
  let dropped = 0;
  for (const [id, n] of Object.entries(raw.rows)) {
    const parsed = ParseRowId(id);
    if (!parsed || !Number.isSafeInteger(n) || n < 1 || Object.keys(ledger.rows).length >= MAX_ROWS) { dropped++; continue; }
    ledger.rows[id] = n;
  }
  return { ledger, dropped };
}
// 曲の合計（現在の世代の行だけ）。Map<key, count>。
function Totals(ledger) {
  const totals = new Map();
  for (const [id, n] of Object.entries(ledger.rows)) {
    const row = ParseRowId(id);
    if (row && row.epoch === ledger.epoch) totals.set(row.key, Math.min(MAX_COUNT, (totals.get(row.key) || 0) + n));
  }
  return totals;
}
const Count = (ledger, key) => Totals(ledger).get(key) || 0;
// 抽選の重み：1/(1+回数)。回数が多い曲も、完全には排除しない。
const Weight = count => 1 / (1 + Math.max(0, Number(count) || 0));
// お気に入りの曲は、重みに倍率を掛けて、少しだけ選ばれやすくする（再生回数が多くても、完全には、逆転させない程度）。
const FAVORITE_BOOST = 1.5;
const WeightOf = (count, favorite) => Weight(count) * (favorite === true ? FAVORITE_BOOST : 1);
// この端末で1回数える。戻り値：更新した行 { id, device, epoch, month, key, n }（同期へ送る）。
function Increment(ledger, key, nowMs, month = null) {
  if (!KEY.test(key)) throw new Error('曲のキーが正しくありません。');
  const id = RowId(ledger.deviceId, ledger.epoch, month || MonthOf(nowMs), key);
  ledger.rows[id] = Math.min(MAX_COUNT, (ledger.rows[id] || 0) + 1);
  return { id, device: ledger.deviceId, epoch: ledger.epoch, month: month || MonthOf(nowMs), key, n: ledger.rows[id] };
}
// 他の端末から受け取った行を取り込む（行ごとに大きい方）。不正な行は無視する。戻り値：変わった行の数。
function MergeRows(ledger, rows) {
  let changed = 0;
  for (const row of rows || []) {
    if (!row || !Number.isSafeInteger(row.n) || row.n < 1) continue;
    const id = RowId(row.device, row.epoch, row.month, row.key);
    if (!ParseRowId(id)) continue;
    if (!(id in ledger.rows) && Object.keys(ledger.rows).length >= MAX_ROWS) continue;
    if ((ledger.rows[id] || 0) < row.n) { ledger.rows[id] = row.n; changed++; }
  }
  return changed;
}
// 世代：大きい方が勝つ。受け取った世代が大きければ、この端末もそこへ移る（古い世代の行は、そのまま残す）。
function MergeEpoch(ledger, epoch) {
  if (!Number.isSafeInteger(epoch) || epoch <= ledger.epoch) return false;
  ledger.epoch = epoch;
  return true;
}
// リセット：世代を1つ上げる。戻り値：新しい世代（同期へ送る）。
function Reset(ledger) { ledger.epoch += 1; return ledger.epoch; }
// 旧形式（曲のキー → 回数）の合計を、この端末の「legacy」の月へ1回だけ引き継ぐ。keyOf：旧形式のキー → 新しいキー（変換できなければnull＝引き継がない）。
function ImportLegacy(ledger, counts, keyOf) {
  if (ledger.legacyImported) return { imported: 0, skipped: 0 };
  let imported = 0, skipped = 0;
  for (const [oldKey, n] of Object.entries(counts || {})) {
    const key = keyOf(oldKey);
    if (!key || !KEY.test(key) || !Number.isSafeInteger(n) || n < 1) { skipped++; continue; }
    const id = RowId(ledger.deviceId, ledger.epoch, LEGACY, key);
    ledger.rows[id] = Math.min(MAX_COUNT, (ledger.rows[id] || 0) + n);
    imported++;
  }
  ledger.legacyImported = true;
  return { imported, skipped };
}
// 同期へ送る行（Bilibiliの曲だけ。ローカルの曲は端末内のみ）。
const SyncRows = ledger => Object.entries(ledger.rows).filter(([id]) => IsSyncKey(ParseRowId(id)?.key)).map(([id, n]) => ({ ...ParseRowId(id), n }));

// 再生を数える規則（実再生3秒で1回。シークで飛ばした時間・停止・読み込み失敗は含めない。短い曲は80%以上を実再生して終わったとき）。
// 位置の増分を時計の経過と照合する。端末APIなし：現在時刻は呼び出し側が渡す（ミリ秒）。
class PlayTracker {
  constructor() { this.active = null; }
  Begin(key, nowMs) { this.active = { key: key || '', played: 0, position: null, at: nowMs, counted: false, playing: false }; }
  Stop() { if (this.active) this.active.counted = true; }
  // media：{ position, duration, paused, ended, playbackRate }。数え終えた（1回数える）とき、曲のキーを返す。まだなら null。
  Observe(media, nowMs) {
    const a = this.active;
    if (!a || a.counted || !a.key || !media) return null;
    const elapsed = Math.max(0, (nowMs - a.at) / 1000), delta = media.position - (a.position ?? media.position);
    if (!media.paused && a.playing && delta > 0 && delta <= elapsed * Math.max(1, media.playbackRate || 1) + 0.75) a.played += Math.min(delta, elapsed);
    a.position = media.position; a.at = nowMs; a.playing = !media.paused;
    if (a.played >= 3 || (media.ended && media.duration > 0 && a.played > 0 && a.played >= Math.min(3, media.duration * 0.8))) { a.counted = true; return a.key; }
    return null;
  }
}
module.exports = { TZ_OFFSET_MS, LEGACY, KEY, IsSyncKey, MonthOf, RowId, ParseRowId, NewLedger, Clean, Totals, Count, Weight, FAVORITE_BOOST, WeightOf, Increment, MergeRows, MergeEpoch, Reset, ImportLegacy, SyncRows, PlayTracker };
