'use strict';
// 同期の保存（Windows／Node専用）：sync/state.json（端末の時計・cursor・未送信の変更・同期状態）、sync/config.json（接続設定）、サインイン情報の暗号化保管。
// 書き込みは「一時ファイル→置換」。未知の syncVersion や壊れたファイルは、上書きせず停止状態にする（黙って初期化・削除しない）。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const S = require('./sync-state.cjs');
const Clock = require('./sync-clock.cjs');

const STATE_VERSION = 1, MAX_STATE_BYTES = 256 * 1024 * 1024, MAX_CONFLICTS = 200;

function AtomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.rmSync(temp, { force: true }); } catch { /* 一時ファイルの掃除に失敗しても保存結果は変えない */ } }
}
const StateFile = directory => path.join(directory, 'state.json');
const ConfigFile = directory => path.join(directory, 'config.json');

// 戻り値：{ status: 'none' } | { status: 'ok', snapshot } | { status: 'blocked', reason }
function ReadState(directory) {
  const file = StateFile(directory);
  if (!fs.existsSync(file)) return { status: 'none' };
  try {
    if (fs.statSync(file).size > MAX_STATE_BYTES) return { status: 'blocked', reason: '同期データが大きすぎるため読み込めません。' };
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || !Number.isInteger(value.syncVersion)) return { status: 'blocked', reason: '同期データの形式が正しくありません。' };
    if (value.syncVersion > STATE_VERSION) return { status: 'blocked', reason: '新しい版のFavecusPlayerで作られた同期データです。このまま上書きしないため、同期を停止しました。アプリを更新してください。' };
    if (value.syncVersion < 1 || !Clock.DEVICE.test(value.deviceId) || !Number.isInteger(value.cursor) || value.cursor < 0 || (value.clock !== '' && !Clock.IsHlc(value.clock))) return { status: 'blocked', reason: '同期データの内容が正しくありません。' };
    if (!Array.isArray(value.outbox) || !Array.isArray(value.records) || !Array.isArray(value.conflicts)) return { status: 'blocked', reason: '同期データの内容が正しくありません。' };
    const records = S.Merge(S.NewState(), value.records).state; // 各レコードを検証（不正なら例外）
    const outbox = value.outbox.map(S.CleanChange);
    const conflicts = value.conflicts.slice(0, MAX_CONFLICTS).map(item => ({ reason: String(item?.reason || 'stale').slice(0, 40), change: S.CleanChange(item.change) }));
    return { status: 'ok', snapshot: { deviceId: value.deviceId, clock: value.clock, cursor: value.cursor, state: records, outbox, conflicts, origin: { url: String(value.origin?.url || ''), userId: String(value.origin?.userId || '') }, lastSyncAt: Number.isFinite(value.lastSyncAt) ? value.lastSyncAt : 0, lastCompactAt: Number.isFinite(value.lastCompactAt) ? value.lastCompactAt : 0 } };
  } catch { return { status: 'blocked', reason: '同期データを読み込めません（壊れている可能性があります）。元のファイルは変更していません。' }; }
}
function WriteState(directory, device, extra = {}) {
  const records = Object.keys(device.state.records).sort().map(id => ({ id, f: device.state.records[id].f }));
  AtomicWrite(StateFile(directory), JSON.stringify({ syncVersion: STATE_VERSION, deviceId: device.id, clock: device.clock, cursor: device.cursor, outbox: device.outbox, conflicts: device.conflicts.slice(-MAX_CONFLICTS), records, origin: extra.origin || { url: '', userId: '' }, lastSyncAt: extra.lastSyncAt || 0, lastCompactAt: extra.lastCompactAt || 0 }));
}

function ReadConfig(directory) {
  try {
    const value = JSON.parse(fs.readFileSync(ConfigFile(directory), 'utf8'));
    return { url: String(value.url || ''), anonKey: String(value.anonKey || ''), email: String(value.email || ''), enabled: value.enabled === true };
  } catch { return { url: '', anonKey: '', email: '', enabled: false }; }
}
function WriteConfig(directory, config) {
  AtomicWrite(ConfigFile(directory), JSON.stringify({ url: config.url, anonKey: config.anonKey, email: config.email, enabled: config.enabled === true }));
}

// サインイン情報（アクセス・更新トークン）。OSの暗号化（Electronのsafeストレージ）が使えないときは保存しない（平文へ代替しない）。
class SessionVault {
  constructor(directory, safeStorage) { this.file = path.join(directory, 'session.bin'); this.safe = safeStorage; }
  Available() { try { return !!this.safe?.isEncryptionAvailable(); } catch { return false; } }
  Get() {
    if (!this.Available() || !fs.existsSync(this.file)) return null;
    try {
      const value = JSON.parse(this.safe.decryptString(fs.readFileSync(this.file)));
      if (typeof value.accessToken !== 'string' || typeof value.refreshToken !== 'string' || typeof value.userId !== 'string' || !Number.isFinite(value.expiresAt)) return null;
      return { accessToken: value.accessToken, refreshToken: value.refreshToken, userId: value.userId, expiresAt: value.expiresAt };
    } catch { return null; }
  }
  Set(session) {
    if (!this.Available()) throw new Error('この環境ではサインイン情報を安全に保存できないため、同期を使えません。');
    AtomicWrite(this.file, this.safe.encryptString(JSON.stringify({ accessToken: session.accessToken, refreshToken: session.refreshToken, userId: session.userId, expiresAt: session.expiresAt })));
  }
  Clear() { try { fs.rmSync(this.file, { force: true }); } catch { /* 無ければ何もしない */ } }
}
// 接続先・アカウントの切り替え用：同期データを別名で残して、同期の紐付けを外す（削除しない）。
function SetAside(directory) {
  const file = StateFile(directory);
  if (!fs.existsSync(file)) return '';
  const target = path.join(directory, `state.replaced-${Date.now()}.json`);
  fs.renameSync(file, target); return target;
}
module.exports = { SetAside, STATE_VERSION, ReadState, WriteState, ReadConfig, WriteConfig, SessionVault, AtomicWrite };
