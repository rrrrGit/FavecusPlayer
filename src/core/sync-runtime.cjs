'use strict';
// iPhone版（JavaScriptCore）の同期の入口。通信・保存・ライブラリの読み書きは、Swiftが用意した host（globalThis.__favecusHost）を通す。
// データの安全に関わる規則は、Windows版と共通の sync-session.cjs・sync-merge.cjs・sync-statefile.cjs・sync-supabase.cjs。ここは接続だけ。
// host の関数（Promiseを返す）：
//   library() → 現在のライブラリのJSON文字列     write(JSON文字列{base,text}) → ライブラリを置き換える（baseが現在と違えば拒否）
//   persist(状態のJSON文字列) → sync/state.json を保存     backup() → 有効化前のバックアップ     recovered() → 復旧した状態か
//   request(method, url, {headers, body}) → {status, json}     saveSession(JSON文字列) → サインイン情報を保管（Keychain）
const { SyncSession } = require('./sync-session.cjs');
const { ParseState, SerializeState } = require('./sync-statefile.cjs');
const { ContextOf, MergeView, Compose } = require('./sync-merge.cjs');
const { ValidateLibrary } = require('./library-data.cjs');
const X = require('./sync-supabase.cjs');
const { SyncExtras } = require('./sync-counts.cjs');

const Pretty = value => JSON.stringify(value, null, 2);
let runtime = null;
const Host = () => { const host = globalThis.__favecusHost; if (!host) throw new Error('同期の接続先（host）が用意されていません。'); return host; };
// hostとは文字列だけでやり取りする（JavaScriptCoreとSwiftの境界を単純にするため）。
const Request = host => async (method, url, init) => JSON.parse(await host.request(method, url, JSON.stringify({ headers: (init && init.headers) || {}, body: init && init.body !== undefined ? init.body : null })));
const Fail = error => ({ error: String(error && error.message || error) });

function Adapter(host) {
  const load = async () => { const text = await host.library(); return { text, data: JSON.parse(text) }; };
  return {
    // token：読み取ったライブラリの文字列。Applyが、読み取り後に編集が入っていないかの確認に使う。
    Library: async () => { const { text, data } = await load(); return { version: 3, identityVersion: 2, videoAliases: data.videoAliases || [], rootPlaylistIds: data.rootPlaylistIds, playlists: data.playlists, token: text }; },
    Context: async () => ContextOf((await load()).data),
    Recovered: async () => !!(await host.recovered()),
    Backup: async () => host.backup(),
    Apply: async (view, token) => {
      const { text, data } = await load(), { changed, next } = MergeView(data, view);
      // 取り込みの後に編集が入っていたら、反映せずやり直させる（編集を黙って取り消さない）。
      if (token !== undefined && token !== text) throw Object.assign(new Error('同期中に保存データが変更されました。'), { code: 'changed' });
      if (!changed) return false;
      const checked = ValidateLibrary({ version: 3, identityVersion: 2, ...next }); // 不正なら例外（ライブラリは変更しない）
      try { await host.write(JSON.stringify({ base: text, text: Pretty(Compose(data, next, checked)) })); }
      catch (error) { throw Object.assign(new Error(String(error && error.message || error)), { code: 'changed' }); } // 書き込み時に編集が入っていた場合も、やり直す
      return true;
    }
  };
}
// 再生回数・お気に入り・再生履歴の同期アダプター：読み書きは、Swift の host が行う。
function CountsAdapter(host) {
  return {
    Read: async () => { const text = await host.countsRead(); return text ? JSON.parse(text) : null; },
    Apply: async value => { await host.countsApply(JSON.stringify(value)); },
    Pushed: async () => { await host.countsPushed(); }
  };
}
function FavoritesAdapter(host) {
  return {
    Read: async () => { const text = await host.favoritesRead(); return text ? JSON.parse(text) : null; },
    Apply: async value => { await host.favoritesApply(JSON.stringify(value)); },
    Pushed: async () => { await host.favoritesPushed(); }
  };
}
function HistoryAdapter(host) {
  return {
    Read: async () => { const text = await host.historyRead(); return text ? JSON.parse(text) : null; },
    Apply: async value => { await host.historyApply(JSON.stringify(value)); },
    Pushed: async () => { await host.historyPushed(); }
  };
}
const Status = () => runtime && runtime.session.device ? { pending: runtime.session.device.outbox.length, conflicts: runtime.session.device.conflicts.length, lastSyncAt: runtime.session.lastSyncAt, origin: runtime.session.origin, blocked: runtime.session.blocked, deviceId: runtime.session.device.id } : { pending: 0, conflicts: 0, lastSyncAt: 0, origin: { url: '', userId: '' }, blocked: '', deviceId: '' };

// 開く。options：{ stateText（保存された同期状態。なければnull）, config: { url, anonKey }, session（サインイン情報またはnull）, deviceId }
// 戻り値：{ status: 'none' | 'ok' | 'blocked', reason?, ...Status }
async function Open(options) {
  try {
    const host = Host(), config = X.SupabaseConfig(options.config || {}), adapter = Adapter(host);
    const tokens = { value: options.session || null };
    const session = new SyncSession({
      adapter, now: () => Date.now(), deviceId: () => options.deviceId,
      repository: () => new X.SupabaseSyncRepository({ config, request: Request(host), now: () => Date.now(), session: { get: () => tokens.value, set: value => { tokens.value = value; host.saveSession(JSON.stringify(value)); } } }),
      persist: current => host.persist(SerializeState(current.device, current.Extra()))
    });
    runtime = { session, tokens, config };
    if (options.stateText === null || options.stateText === undefined) return { status: 'none', ...Status() };
    const parsed = ParseState(options.stateText);
    if (parsed.status === 'blocked') { runtime = null; return { status: 'blocked', reason: parsed.reason }; }
    session.Restore({ ...parsed.snapshot, context: await adapter.Context() });
    return { status: 'ok', ...Status() };
  } catch (error) { runtime = null; return Fail(error); }
}
// 初めての有効化（バックアップ → 既定のままなら共通の既定リストへ → 端末を作る）。origin：{ url, userId }
async function Enable(options) {
  try {
    if (!runtime) throw new Error('同期が開かれていません。');
    if (!runtime.session.ready) await runtime.session.Enable(options.origin);
    return { ok: true, ...Status() };
  } catch (error) { return Fail(error); }
}
// 1回の同期。戻り値：{ ok, error?, blocked? , ...Status }
// options：{ origin: { url, userId } }（いまの接続先・アカウント。同期データの作成時と違えば、通信せずに止める）
async function Cycle(options) {
  try {
    if (!runtime || !runtime.session.ready) throw new Error('同期が有効になっていません。');
    const host = Host();
    const isAborted = typeof host.isAborted === 'function' ? () => !!host.isAborted() : null;
    const result = await runtime.session.Cycle({ ...(options || {}), ...(isAborted ? { isAborted } : {}) });
    // 再生回数・お気に入り・再生履歴の同期（ライブラリの同期が成功したあと。失敗・SQL未実行でも、ライブラリの同期には影響しない）
    let extras = null;
    const hasCounts = typeof host.countsRead === 'function';
    const hasFavorites = typeof host.favoritesRead === 'function';
    const hasHistory = typeof host.historyRead === 'function';
    if (result.ok && !isAborted?.() && (hasCounts || hasFavorites || hasHistory)) {
      const adapter = hasCounts ? CountsAdapter(host) : {};
      if (hasFavorites) adapter.favorites = FavoritesAdapter(host);
      if (hasHistory) adapter.history = HistoryAdapter(host);
      extras = await SyncExtras(adapter, runtime.session.makeRepository(), isAborted ? { isAborted } : {});
    }
    return { ...result, ...(extras ? { extras } : {}), ...Status() };
  } catch (error) { return Fail(error); }
}
// 停止の解除（利用者の選択）。mode：'restore'（同期した内容で復元）／'keep'（この端末の内容を正とする）
async function Unblock(options) {
  try {
    if (!runtime || !runtime.session.ready) throw new Error('同期が開かれていません。');
    await runtime.session.Unblock(options.mode);
    return { ok: true, ...Status() };
  } catch (error) { return Fail(error); }
}
function Changed() { if (runtime) runtime.session.Changed(); return { ok: true }; }
function Reset() { if (runtime) runtime.session.Reset(); return { ok: true }; }
function State() { return Status(); }
// サインイン（メールのワンタイムコード）。サインイン情報は呼び出し側（Keychain）が保管する。
async function SendCode(options) {
  try { await X.SendCode(X.SupabaseConfig(options.config), Request(Host()), options.email); return { ok: true }; }
  catch (error) { return Fail(error); }
}
async function VerifyCode(options) {
  try {
    const session = await X.VerifyCode(X.SupabaseConfig(options.config), Request(Host()), options.email, options.code);
    if (runtime) runtime.tokens.value = session;
    return { ok: true, session };
  } catch (error) { return Fail(error); }
}
// 接続設定の検証（https の *.supabase.co・anon／publishable のみ。service_role・secret は拒否）。正規化した設定を返す。
function ValidateConfig(options) {
  try { return { ok: true, config: X.SupabaseConfig(options.config || {}) }; }
  catch (error) { return Fail(error); }
}
// 端末ごとの稼働履歴（日単位・7日分）を Supabase へ送信する。
async function PushActivityLogs(options) {
  try {
    if (!runtime || !runtime.session) throw new Error('同期が開かれていません。');
    const host = Host();
    if (typeof host.isAborted === 'function' && host.isAborted()) return { ok: false, aborted: true, error: '同期は中断されました。' };
    const origin = options?.origin;
    const expected = runtime.session.origin;
    if (expected?.url && origin && (expected.url !== origin.url || expected.userId !== origin.userId)) {
      return { ok: false, mismatch: true, error: '接続先またはアカウントが異なります。' };
    }
    const deviceId = options?.deviceId || runtime.session.device?.id;
    if (!deviceId) throw new Error('端末IDが特定できません。');
    const repository = runtime.session.makeRepository();
    const result = await repository.PushActivityLogs(deviceId, options?.days || [], options?.retentionBeforeDay);
    return { ok: true, ...result };
  } catch (error) {
    return { ...Fail(error), ok: false, missing: error?.code === 'missing' };
  }
}
module.exports = { Open, Enable, Cycle, Unblock, Changed, Reset, State, SendCode, VerifyCode, ValidateConfig, PushActivityLogs };
