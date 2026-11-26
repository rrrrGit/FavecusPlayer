'use strict';
// Supabase（PostgREST・Auth）上のSyncRepositoryと、メールのワンタイムコードによるサインイン。
// 共通JS：通信は注入された request(method, url, { headers, body }) → Promise<{ status, json }> で行う（Windowsはnet.fetch、iPhoneはURLSession）。supabase-jsは使わない。
// サーバーは追記だけの変更ログ（supabase/schema.sql）。競合解決・整理の規則は sync-state.cjs にあり、ここでは複製しない。
// トークンはこのモジュールが保存しない：session の get/set を呼び出し側（OSの暗号化保管）に任せ、ログ・エラー文にも含めない。
const S = require('./sync-state.cjs');
const { Records, RETENTION_MS } = require('./sync-engine.cjs');
const { DerivedId } = require('./sync-library.cjs');
const FavCore = require('./favorites-core.cjs');
const History = require('./play-history.cjs');

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
    const rows = []; let last = after, done = false;
    for (let page = 0; page < 10000; page++) {
      const got = await this.Call('GET', `sync_changes?select=seq,record_id,f&seq=gt.${last}&order=seq.asc&limit=${this.pageSize}`);
      if (!Array.isArray(got)) throw new SyncError('bad', FRIENDLY.bad);
      for (const row of got) { if (!Number.isInteger(row.seq) || row.seq <= last || typeof row.record_id !== 'string' || row.f === null || typeof row.f !== 'object') throw new SyncError('bad', FRIENDLY.bad); last = row.seq; rows.push(row); }
      if (got.length === 0) { done = true; break; } // 件数ではなく「空」で終える（サーバー側の最大件数が小さくても取りこぼさない）
    }
    if (!done) throw new SyncError('bad', FRIENDLY.bad);
    return { rows, last };
  }
  async Pull(cursor) {
    const meta = await this.Meta();
    const fullResync = async initialMeta => {
      let current = initialMeta;
      for (let attempt = 0; attempt < 2; attempt++) {
        const all = await this.Rows(0);
        const after = await this.Meta();
        if (after.watermark === current.watermark || attempt === 1) {
          return { resync: true, snapshot: Records(S.Merge(S.NewState(), all.rows.map(row => ({ id: row.record_id, f: row.f }))).state), cursor: Math.max(all.last, current.lastSeq) };
        }
        current = after;
      }
    };
    if (!Number.isInteger(cursor) || cursor < meta.watermark) return fullResync(meta);
    const got = await this.Rows(cursor);
    const after = await this.Meta();
    // 取得中に Compact が走って watermark が進んだ場合は、90日超の削除 Tombstone 取りこぼしを防ぐため全量再同期へ切り替える。
    if (after.watermark > meta.watermark || cursor < after.watermark) return fullResync(after);
    return { changes: got.rows.map(row => ({ id: row.record_id, f: row.f })), cursor: got.last };
  }
  // ---- v0.7.1〜v0.7.5：再生回数・設定・お気に入り・再生履歴（別テーブル。supabase/schema.sql を再実行していないときは、code: 'missing' で知らせる。ライブラリの同期は、これと無関係に動く）
  async Extra(method, path, options) {
    try { return await this.Call(method, path, options); }
    catch (error) { if (error instanceof SyncError && error.code === 'bad' && /404/.test(error.message)) throw new SyncError('missing', '再生回数・お気に入り・再生履歴の同期は、まだ設定されていません（Supabaseで最新の schema.sql を実行してください）。'); throw error; }
  }
  // 自分の端末の行を、一意化・ソートして上書きで送る（サーバーは、回数が減る更新を拒む）。rows：[{ epoch, month, key, n }]
  async PushCounts(deviceId, rows) {
    const best = new Map();
    for (const row of rows || []) {
      if (!row || !Number.isSafeInteger(row.epoch) || row.epoch < 0 || typeof row.month !== 'string' || typeof row.key !== 'string' || !Number.isFinite(row.n) || row.n < 1) continue;
      const n = Math.floor(row.n), id = `${row.epoch}\0${row.month}\0${row.key}`, prev = best.get(id);
      if (!prev || n > prev.n) best.set(id, { epoch: row.epoch, month: row.month, key: row.key, n });
    }
    const body = [...best.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([, row]) => ({ device_id: deviceId, epoch: row.epoch, month: row.month, media_key: row.key, n: row.n }));
    for (let i = 0; i < body.length; i += this.chunk) {
      await this.Extra('POST', 'sync_counts?on_conflict=user_id,device_id,epoch,month,media_key', { body: body.slice(i, i + this.chunk), prefer: 'resolution=merge-duplicates,return=minimal' });
    }
  }
  // cursorより後に変わった行（自分の端末の行は除く）。戻り値：{ rows: [{ device, epoch, month, key, n }], cursor }
  async PullCounts(cursor, ownDeviceId) {
    const rows = []; let last = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0, done = false;
    for (let page = 0; page < 10000; page++) {
      const got = await this.Extra('GET', `sync_counts?select=seq,device_id,epoch,month,media_key,n&seq=gt.${last}&order=seq.asc&limit=${this.pageSize}`);
      if (!Array.isArray(got)) throw new SyncError('bad', FRIENDLY.bad);
      if (got.length === 0) { done = true; break; }
      for (const row of got) {
        if (!Number.isInteger(row.seq) || row.seq <= last) throw new SyncError('bad', FRIENDLY.bad);
        last = row.seq;
        if (row.device_id !== ownDeviceId) rows.push({ device: row.device_id, epoch: row.epoch, month: row.month, key: row.media_key, n: Number(row.n) });
      }
    }
    if (!done) throw new SyncError('bad', FRIENDLY.bad);
    return { rows, cursor: last };
  }
  async GetPrefs() {
    const got = await this.Extra('GET', 'sync_prefs?select=epoch,weighted_shuffle,weighted_at');
    if (!Array.isArray(got)) throw new SyncError('bad', FRIENDLY.bad);
    const row = got[0];
    return row ? { epoch: Number(row.epoch) || 0, weighted: row.weighted_shuffle !== false, at: Number(row.weighted_at) || 0 } : null;
  }
  async PutPrefs({ epoch, weighted, at }) {
    await this.Extra('POST', 'sync_prefs?on_conflict=user_id', { body: [{ epoch, weighted_shuffle: weighted, weighted_at: at }], prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  // お気に入り（v0.7.5）：送信前に曲キーで一意化・ソートして ON CONFLICT 重複エラーを防ぐ。
  async PushFavorites(deviceId, rows) {
    const best = new Map();
    for (const row of rows || []) {
      if (!row || !FavCore.IsSyncKey(row.key) || typeof row.fav !== 'boolean' || !Number.isFinite(row.at) || row.at < 1) continue;
      const at = Math.floor(row.at), prev = best.get(row.key);
      if (!prev || FavCore.Newer({ fav: row.fav, at }, prev)) best.set(row.key, { fav: row.fav, at });
    }
    const body = [...best.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([key, s]) => ({ media_key: key, fav: s.fav, updated_at: s.at, device_id: deviceId }));
    for (let i = 0; i < body.length; i += this.chunk) {
      await this.Extra('POST', 'sync_favorites?on_conflict=user_id,media_key', { body: body.slice(i, i + this.chunk), prefer: 'resolution=merge-duplicates,return=minimal' });
    }
  }
  // 共有行のため device_id フィルタはしない（初期化・破損後の自己復旧を可能にするため）。
  async PullFavorites(cursor) {
    const rows = []; let last = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0, done = false;
    for (let page = 0; page < 10000; page++) {
      const got = await this.Extra('GET', `sync_favorites?select=seq,media_key,fav,updated_at&seq=gt.${last}&order=seq.asc&limit=${this.pageSize}`);
      if (!Array.isArray(got)) throw new SyncError('bad', FRIENDLY.bad);
      if (got.length === 0) { done = true; break; }
      for (const row of got) {
        if (!Number.isInteger(row.seq) || row.seq <= last) throw new SyncError('bad', FRIENDLY.bad);
        last = row.seq;
        rows.push({ key: row.media_key, fav: row.fav === true, at: Number(row.updated_at) });
      }
    }
    if (!done) throw new SyncError('bad', FRIENDLY.bad);
    return { rows, cursor: last };
  }
  // 再生履歴（v0.7.5）：曲ごとに最新の再生時刻を保持。送信前に一意化・ソートする。
  async PushHistory(deviceId, rows) {
    const best = new Map();
    for (const row of rows || []) {
      if (!row || !History.IsSyncKey(row.key) || !Number.isFinite(row.at) || row.at < 1) continue;
      const at = Math.floor(row.at), prev = best.get(row.key) || 0;
      if (at > prev) best.set(row.key, at);
    }
    const body = [...best.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([key, at]) => ({ media_key: key, played_at: at, device_id: deviceId }));
    for (let i = 0; i < body.length; i += this.chunk) {
      await this.Extra('POST', 'sync_history?on_conflict=user_id,media_key', { body: body.slice(i, i + this.chunk), prefer: 'resolution=merge-duplicates,return=minimal' });
    }
  }
  async PullHistory(cursor) {
    const rows = []; let last = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0, done = false;
    for (let page = 0; page < 10000; page++) {
      const got = await this.Extra('GET', `sync_history?select=seq,media_key,played_at&seq=gt.${last}&order=seq.asc&limit=${this.pageSize}`);
      if (!Array.isArray(got)) throw new SyncError('bad', FRIENDLY.bad);
      if (got.length === 0) { done = true; break; }
      for (const row of got) {
        if (!Number.isInteger(row.seq) || row.seq <= last) throw new SyncError('bad', FRIENDLY.bad);
        last = row.seq;
        rows.push({ key: row.media_key, at: Number(row.played_at) });
      }
    }
    if (!done) throw new SyncError('bad', FRIENDLY.bad);
    return { rows, cursor: last };
  }
  async GetHistoryState() {
    const got = await this.Extra('GET', 'sync_history_state?select=cleared_at');
    if (!Array.isArray(got)) throw new SyncError('bad', FRIENDLY.bad);
    const row = got[0];
    return row ? { clearedAt: Number(row.cleared_at) || 0 } : null;
  }
  async PutHistoryState({ clearedAt }) {
    const at = Number.isFinite(clearedAt) && clearedAt >= 0 ? Math.floor(clearedAt) : 0;
    await this.Extra('POST', 'sync_history_state?on_conflict=user_id', { body: [{ cleared_at: at }], prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  // 保持期間を過ぎたTombstoneの整理。どのレコードを消すかは共通の規則（S.Compact：復旧に使われるTombstoneは残す）で決め、サーバーは指定されたIDの行を消すだけ。
  async Compact(now = this.now(), retentionMs = RETENTION_MS) {
    const all = await this.Rows(0), state = S.Merge(S.NewState(), all.rows.map(row => ({ id: row.record_id, f: row.f }))).state;
    const kept = S.Compact(state, now, retentionMs).state, ids = Object.keys(state.records).filter(id => !kept.records[id]);
    // 1回のトランザクションで整理し、バッチ間で watermark が同値のまま途中スナップショットが読まれる競合を防ぐ。
    if (ids.length) await this.Call('POST', 'rpc/sync_compact', { body: { p_ids: ids, p_upto: all.last } });
    return ids.length;
  }
}
module.exports = { SyncError, SupabaseConfig, SendCode, VerifyCode, RefreshSession, SupabaseSyncRepository, RowOf };
