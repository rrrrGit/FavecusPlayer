'use strict';
// 同期の保存（Windows／Node専用）：sync/state.json（端末の時計・cursor・未送信の変更・同期状態）、sync/config.json（接続設定）、サインイン情報の暗号化保管。
// 書き込みは「一時ファイル→置換」。未知の syncVersion や壊れたファイルは、上書きせず停止状態にする（黙って初期化・削除しない）。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { STATE_VERSION, MAX_STATE_BYTES, ParseState, SerializeState } = require('./sync-statefile.cjs');

function AtomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.rmSync(temp, { force: true }); } catch { /* 一時ファイルの掃除に失敗しても保存結果は変えない */ } }
}
const StateFile = directory => path.join(directory, 'state.json');
const ConfigFile = directory => path.join(directory, 'config.json');

// 戻り値：{ status: 'none' } | { status: 'ok', snapshot } | { status: 'blocked', reason }（検証は共通の sync-statefile.cjs）
function ReadState(directory) {
  const file = StateFile(directory);
  if (!fs.existsSync(file)) return { status: 'none' };
  try {
    if (fs.statSync(file).size > MAX_STATE_BYTES) return { status: 'blocked', reason: '同期データが大きすぎるため読み込めません。' };
    return ParseState(fs.readFileSync(file, 'utf8'));
  } catch { return { status: 'blocked', reason: '同期データを読み込めません（壊れている可能性があります）。元のファイルは変更していません。' }; }
}
function WriteState(directory, device, extra = {}) { AtomicWrite(StateFile(directory), SerializeState(device, extra)); }

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
