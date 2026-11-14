'use strict';
// Supabase（PostgREST・Auth）上のSyncRepositoryと、メールのワンタイムコードによるサインイン。
// 共通JS：通信は注入された request(method, url, { headers, body }) → Promise<{ status, json }> で行う（Windowsはnet.fetch、iPhoneはURLSession）。supabase-jsは使わない。
// サーバーは追記だけの変更ログ（supabase/schema.sql）。競合解決・整理の規則は sync-state.cjs にあり、ここでは複製しない。
// トークンはこのモジュールが保存しない：session の get/set を呼び出し側（OSの暗号化保管）に任せ、ログ・エラー文にも含めない。
const S = require('./sync-state.cjs');
const { Records, RETENTION_MS } = require('./sync-engine.cjs');
const { DerivedId } = require('./sync-library.cjs');

class SyncError extends Error {
  constructor(code, message) { super(message); this.code = code; } // code: offline | auth | paused | server | bad
}
const FRIENDLY = { offline: 'サーバーに接続できません。', auth: 'サインインが必要です。', paused: 'サーバーが応答しません（Supabaseが一時停止している可能性があります。ダッシュボードで再開してください）。', server: 'サーバーでエラーが発生しました。', bad: 'サーバーの応答が正しくありません。' };

// 接続設定：URLは https の *.supabase.co（開発用に localhost も可）。キーは anon / publishable のみ（service_role / secret は拒否）。
function SupabaseConfig(input) {
  const url = String(input?.url || '').trim().replace(/\/+$/, ''), key = String(input?.anonKey || '').trim();
  if (!/^https:\/\/[a-z0-9-]{3,64}\.supabase\.co$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(url)) throw new SyncError('bad', 'SupabaseのURLが正しくありません（https://<プロジェクト>.supabase.co）。');
  if (key.length < 20 || key.length > 4096 || /\s/.test(key)) throw new SyncError('bad', 'anonキーの形式が正しくありません。');
  if (/^sb_secret_/.test(key)) throw new SyncError('bad', '秘密キーは使えません。anon（publishable）キーを指定してください。');
  if (key.split('.').length === 3) {
    let role = null;
    try { const payload = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); role = JSON.parse(atob(payload + '='.repeat((4 - payload.length % 4) % 4))).role; } catch { /* 読めない形式は、サーバー側の判定に任せる */ }
    if (role && role !== 'anon') throw new SyncError('bad', 'anon以外のキー（service_roleなど）は使えません。');
  }
  return { url, anonKey: key };
}

async function Send(request, method, url, headers, body) {
  let response;
  try { response = await request(method, url, { headers, body }); } catch { throw new SyncError('offline', FRIENDLY.offline); }
  if (!response || !Number.isInteger(response.status)) throw new SyncError('bad', FRIENDLY.bad);
  return response;
}
const ErrorFor = response => {
  if (response.status === 401 || response.status === 403) return new SyncError('auth', FRIENDLY.auth);
  if (response.status === 502 || response.status === 503 || response.status === 504 || response.status === 540) return new SyncError('paused', FRIENDLY.paused);
  if (response.status >= 500) return new SyncError('server', FRIENDLY.server);
  return new SyncError('bad', `${FRIENDLY.bad}（${response.status}）`);
};
const AuthHeaders = config => ({ apikey: config.anonKey, 'Content-Type': 'application/json' });
function ToSession(json, now) {
  const userId = json?.user?.id;
  if (typeof json?.access_token !== 'string' || typeof json?.refresh_token !== 'string' || typeof userId !== 'string') throw new SyncError('bad', FRIENDLY.bad);
  const expiresAt = Number.isFinite(json.expires_at) ? json.expires_at : Math.floor(now() / 1000) + (Number.isFinite(json.expires_in) ? json.expires_in : 3600);
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt, userId };
}
// メールへ6桁のコードを送る（未登録のメールは、Supabase側の設定でアカウントが作られる）。
async function SendCode(config, request, email) {
  const address = String(email || '').trim();
  if (!/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(address)) throw new SyncError('bad', 'メールアドレスが正しくありません。');
  const response = await Send(request, 'POST', `${config.url}/auth/v1/otp`, AuthHeaders(config), { email: address, create_user: true });
  if (response.status < 200 || response.status >= 300) throw ErrorFor(response);
}
async function VerifyCode(config, request, email, code, now = Date.now) {
  const token = String(code || '').trim();
  if (!/^\d{6,10}$/.test(token)) throw new SyncError('bad', 'コードは数字で入力してください。');
  const response = await Send(request, 'POST', `${config.url}/auth/v1/verify`, AuthHeaders(config), { type: 'email', email: String(email || '').trim(), token });
  if (response.status < 200 || response.status >= 300) throw response.status === 400 || response.status === 401 || response.status === 403 || response.status === 422 ? new SyncError('auth', 'コードが正しくないか、期限が切れています。') : ErrorFor(response);
  return ToSession(response.json, now);
}
async function RefreshSession(config, request, session, now = Date.now) {
  const response = await Send(request, 'POST', `${config.url}/auth/v1/token?grant_type=refresh_token`, AuthHeaders(config), { refresh_token: session.refreshToken });
  if (response.status < 200 || response.status >= 300) throw response.status >= 500 ? ErrorFor(response) : new SyncError('auth', FRIENDLY.auth);
  return ToSession(response.json, now);
}

// 同じ変更は同じ batch_id になる（内容から導く）。応答が失われて再送しても、サーバーの一意制約で行が増えない。
const FieldsKey = change => JSON.stringify([change.id, Object.keys(change.f).sort().map(name => [name, change.f[name]])]);
const RowOf = (deviceId, change) => ({ record_id: change.id, f: change.f, device_id: deviceId, batch_id: DerivedId(`chg:${FieldsKey(change)}`), idx: 0 });

class SupabaseSyncRepository {
  // options: { config, request, session: { get(): session|null, set(session) }, now, chunk, pageSize }
  constructor(options) {
    this.config = options.config; this.request = options.request; this.session = options.session; this.now = options.now || Date.now;
    this.chunk = options.chunk || 500; this.pageSize = options.pageSize || 1000;
  }
  async Token(force) {
    let session = this.session.get();
    if (!session) throw new SyncError('auth', FRIENDLY.auth);
    if (force || session.expiresAt - 60 <= Math.floor(this.now() / 1000)) { session = await RefreshSession(this.config, this.request, session, this.now); this.session.set(session); }
    return session.accessToken;
  }
  // 認証つきの要求。401は1回だけトークンを更新して再試行する。
  async Call(method, path, { body, prefer } = {}) {
    for (let attempt = 0; ; attempt++) {
      const headers = { apikey: this.config.anonKey, Authorization: `Bearer ${await this.Token(attempt > 0)}`, 'Content-Type': 'application/json' };
      if (prefer) headers.Prefer = prefer;
      const response = await Send(this.request, method, `${this.config.url}/rest/v1/${path}`, headers, body);
      if (response.status === 401 && attempt === 0) continue;
      if (response.status < 200 || response.status >= 300) throw ErrorFor(response);
      return response.json;
    }
  }
  async Push(deviceId, changes) {
    const clean = changes.map(S.CleanChange); // 1件でも不正なら、何も送らない
    for (let i = 0; i < clean.length; i += this.chunk) {
      await this.Call('POST', 'sync_changes?on_conflict=user_id,batch_id,idx', { body: clean.slice(i, i + this.chunk).map(change => RowOf(deviceId, change)), prefer: 'resolution=ignore-duplicates,return=minimal' });
    }
    return { cursor: (await this.Meta()).lastSeq };
  }
  async Meta() {
    const rows = await this.Call('GET', 'sync_meta?select=last_seq,watermark');
    if (!Array.isArray(rows)) throw new SyncError('bad', FRIENDLY.bad);
    const row = rows[0] || {};
    return { lastSeq: Number.isInteger(row.last_seq) ? row.last_seq : 0, watermark: Number.isInteger(row.watermark) ? row.watermark : 0 };
  }
  // seqより後の行を、seq順にすべて読む。連番はコミット順（schema.sql）なので、読み取り済みの位置より前に後からコミットされる行はない。
  async Rows(after) {
    const rows = []; let last = after;
    for (let page = 0; page < 10000; page++) {
      const got = await this.Call('GET', `sync_changes?select=seq,record_id,f&seq=gt.${last}&order=seq.asc&limit=${this.pageSize}`);
      if (!Array.isArray(got)) throw new SyncError('bad', FRIENDLY.bad);
      for (const row of got) { if (!Number.isInteger(row.seq) || row.seq <= last || typeof row.record_id !== 'string' || row.f === null || typeof row.f !== 'object') throw new SyncError('bad', FRIENDLY.bad); last = row.seq; rows.push(row); }
      if (got.length === 0) break; // 件数ではなく「空」で終える（サーバー側の最大件数が小さくても取りこぼさない）
    }
    return { rows, last };
  }
  async Pull(cursor) {
    const meta = await this.Meta();
    if (!Number.isInteger(cursor) || cursor < meta.watermark) {
      const all = await this.Rows(0);
      return { resync: true, snapshot: Records(S.Merge(S.NewState(), all.rows.map(row => ({ id: row.record_id, f: row.f }))).state), cursor: Math.max(all.last, meta.lastSeq) };
    }
    const got = await this.Rows(cursor);
    return { changes: got.rows.map(row => ({ id: row.record_id, f: row.f })), cursor: got.last };
  }
  // 保持期間を過ぎたTombstoneの整理。どのレコードを消すかは共通の規則（S.Compact：復旧に使われるTombstoneは残す）で決め、サーバーは指定されたIDの行を消すだけ。
  async Compact(now = this.now(), retentionMs = RETENTION_MS) {
    const all = await this.Rows(0), state = S.Merge(S.NewState(), all.rows.map(row => ({ id: row.record_id, f: row.f }))).state;
    const kept = S.Compact(state, now, retentionMs).state, ids = Object.keys(state.records).filter(id => !kept.records[id]);
    for (let i = 0; i < ids.length; i += 200) await this.Call('POST', 'rpc/sync_compact', { body: { p_ids: ids.slice(i, i + 200), p_upto: all.last } });
    return ids.length;
  }
}
module.exports = { SyncError, SupabaseConfig, SendCode, VerifyCode, RefreshSession, SupabaseSyncRepository, RowOf };
