'use strict';
// Windows版の同期の運用（Node専用）：ローカルのStore（library.json）と、共通の同期処理（sync-engine）・SupabaseSyncRepositoryをつなぐ。
// 原則：
//  - library.json（Store）が表示・再生の正本。同期の状態（sync/state.json）は補助で、いつでも「ストアとの差分」から作り直せる。
//  - ローカルの編集は、ストアの現在の内容と「直前に同期した表示（base）」との差分として取り込む（古いコピーで他端末の追加を削除しない）。
//  - 受信した変更は、先にlibrary.jsonへ反映し、その後にsync/state.jsonを保存する。途中で止まっても、次回の差分は削除や上書きにならない。
//  - 同期中にローカルの編集があった場合は、同期前のbaseとの差分として取り込んでから反映する（編集を失わない）。
//  - 失敗（オフライン・停止・未サインイン）は、状態とoutboxを保持して再試行できる。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const E = require('./sync-engine.cjs');
const { SyncSession } = require('./sync-session.cjs');
const { SyncExtras } = require('./sync-counts.cjs');
const X = require('./sync-supabase.cjs');
const Storage = require('./sync-storage.cjs');
const { ContextOf, MergeView, Compose } = require('./sync-merge.cjs');

const DAY = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 60 * 60 * 1000; // 定期同期の間隔（変更の1.5秒後・起動5秒後の同期とは別）

// Storeとの接続。Library()：同期用の形の現在のライブラリ。Apply(view)：同期後の表示をStoreへ反映（変化がなければ何もしない）。
function StoreAdapter(store, { validateLibrary }) {
  const Library = () => ({ version: 3, identityVersion: 2, videoAliases: store.data.videoAliases || [], rootPlaylistIds: store.data.rootPlaylistIds, playlists: store.data.playlists });
  return {
    Library,
    Directory: () => store.directory,
    Recovered: () => !!store.recovered,
    // 同期の導出に渡す文脈と、受信の反映の規則は、iPhone版と共通の sync-merge.cjs。
    Context() { return ContextOf(store.data); },
    Apply(view) {
      const current = store.data, { changed, next } = MergeView(current, view);
      if (!changed) return false;
      const checked = validateLibrary({ version: 3, identityVersion: 2, ...next }); // 不正なら例外（storeは変更しない）
      const before = current;
      try { store.data = Compose(current, next, checked); store.Save(); }
      catch (error) { store.data = before; throw error; }
      return true;
    },
    Backup() { // 同期を有効にする前の library.json を残す
      const target = path.join(store.directory, `library.pre-sync-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
      fs.copyFileSync(store.file, target, fs.constants.COPYFILE_EXCL); return target;
    }
  };
}

class SyncService {
  // options: { directory(sync dir), adapter, vault, request, now, timers, onStatus(status), onApplied() }
  constructor(options) {
    this.dir = options.directory; this.adapter = options.adapter; this.vault = options.vault; this.request = options.request;
    this.now = options.now || Date.now; this.timers = options.timers || { set: setTimeout, clear: clearTimeout };
    this.onStatus = options.onStatus || (() => {}); this.onApplied = options.onApplied || (() => {});
    this.extras = options.extras || null; this.extrasNotice = ''; // extras(): sync-counts.cjs のアダプター
    this.config = Storage.ReadConfig(this.dir); this.blocked = ''; this.error = ''; this.state = 'off';
    this.session = new SyncSession({ adapter: this.adapter, repository: () => this.Repository(), persist: session => Storage.WriteState(this.dir, session.device, session.Extra()), now: this.now, onApplied: () => this.onApplied(), deviceId: () => `win-${randomUUID().slice(0, 8)}` });
    this.chain = Promise.resolve(); this.debounce = null; this.interval = null; this.disposed = false;
    this.pendingCode = null; this.loaded = false;
  }
  get device() { return this.session.device; }
  get lastSyncAt() { return this.session.lastSyncAt; }
  Status() {
    return { url: this.config.url, enabled: this.config.enabled, canUnblock: !!(this.device && this.session.blocked), configured: !!(this.config.url && this.config.anonKey), signedIn: !!this.Session(), email: this.config.email, encryption: this.vault.Available(),
      extrasNotice: this.extrasNotice, state: this.blocked ? 'blocked' : this.state, error: this.blocked || this.error, lastSyncAt: this.lastSyncAt, pending: this.device ? this.device.outbox.length : 0, conflicts: this.device ? this.device.conflicts.length : 0 };
  }
  Emit(state, error = '') { this.state = state; this.error = error; try { this.onStatus(this.Status()); } catch { /* 通知の失敗は同期に影響させない */ } }
  Session() { return this.vault.Get(); }
  Repository() {
    const config = X.SupabaseConfig({ url: this.config.url, anonKey: this.config.anonKey });
    return new X.SupabaseSyncRepository({ config, request: this.request, now: this.now, session: { get: () => this.vault.Get(), set: session => this.vault.Set(session) } });
  }
  // ---- 設定とサインイン（利用者の操作）
  Configure({ url, anonKey }) {
    const config = X.SupabaseConfig({ url, anonKey });
    if (this.config.enabled) throw new Error('同期を止めてから接続先を変更してください。');
    if (config.url !== this.config.url) this.vault.Clear(); // 別の接続先へ古いトークンを送らない
    this.config = { ...this.config, url: config.url, anonKey: config.anonKey }; Storage.WriteConfig(this.dir, this.config); this.Emit(this.state, this.error);
  }
  async SendCode(email) {
    if (!this.vault.Available()) throw new Error('この環境ではサインイン情報を安全に保存できないため、同期を使えません。');
    const config = X.SupabaseConfig({ url: this.config.url, anonKey: this.config.anonKey });
    await X.SendCode(config, this.request, email); this.pendingCode = String(email).trim();
  }
  async VerifyCode(email, code) {
    const config = X.SupabaseConfig({ url: this.config.url, anonKey: this.config.anonKey });
    const session = await X.VerifyCode(config, this.request, email, code, this.now);
    this.vault.Set(session); this.config = { ...this.config, email: String(email).trim() }; Storage.WriteConfig(this.dir, this.config); this.Emit(this.state, '');
  }
  SignOut() { this.vault.Clear(); this.Emit(this.state, ''); }
  // ---- 開始・有効化・停止
  Load() {
    if (this.loaded) return; this.loaded = true;
    const loaded = Storage.ReadState(this.dir);
    if (loaded.status === 'blocked') { this.blocked = loaded.reason; return; }
    if (loaded.status === 'ok') { this.session.Restore({ ...loaded.snapshot, context: this.adapter.Context() }); this.blocked = this.session.blocked; } // 停止の理由は保存されており、再起動しても、利用者が選ぶまで解除しない
  }
  Start() {
    this.Load();
    if (this.config.enabled && !this.blocked && this.device) { this.Emit('idle'); this.Schedule(5 * 1000); this.interval = this.timers.set(() => this.Tick(), INTERVAL_MS); this.interval.unref?.(); }
    else this.Emit(this.blocked ? 'blocked' : 'off');
  }
  Tick() { if (this.disposed) return; this.Request().catch(() => {}); this.interval = this.timers.set(() => this.Tick(), INTERVAL_MS); this.interval.unref?.(); }
  async Enable() {
    this.Load(); // Start前でも、既存の同期データを確認してから始める
    if (this.blocked) throw new Error(this.blocked);
    if (!this.Session()) throw new Error('先にサインインしてください。');
    if (!this.device) await this.session.Enable({ url: this.config.url, userId: this.Session().userId });
    this.config = { ...this.config, enabled: true }; Storage.WriteConfig(this.dir, this.config);
    this.Emit('idle'); this.interval = this.interval || this.timers.set(() => this.Tick(), INTERVAL_MS); this.interval.unref?.();
    return this.SyncNow();
  }
  // 停止の解除（利用者の選択）。mode：'restore'＝同期した内容でこの端末を復元／'keep'＝この端末の内容を正として同期（削除も送る）。
  async Unblock(mode) {
    this.Load();
    if (!this.device || !this.session.blocked) throw new Error('解除できる停止状態がありません。');
    await this.session.Unblock(mode);
    this.blocked = ''; this.Emit('idle');
    return this.SyncNow();
  }
  Disable() {
    this.config = { ...this.config, enabled: false }; Storage.WriteConfig(this.dir, this.config);
    this.Clear(); this.Emit('off');
  }
  Clear() { if (this.debounce) this.timers.clear(this.debounce); if (this.interval) this.timers.clear(this.interval); this.debounce = null; this.interval = null; }
  Dispose() { this.disposed = true; this.Clear(); }
  // 接続先・アカウントが同期データの作成時と違うか。
  Mismatch() { const session = this.vault.Get(); const origin = this.session.origin; return !!this.device && !!origin.url && (origin.url !== this.config.url || (session && origin.userId !== session.userId)); }
  // 別のプロジェクト・アカウントへ切り替える：同期データは別名で残し、手元のライブラリから新しく始める。
  ResetLink() {
    this.Disable(); Storage.SetAside(this.dir); this.session.Reset(); this.blocked = ''; this.Emit('off');
  }
  // ---- ストアの変更・同期
  Changed() { this.session.Changed(); if (this.session.applying || !this.config.enabled || this.blocked || !this.device) return; this.Schedule(1500); }
  Schedule(ms) { if (this.disposed) return; if (this.debounce) this.timers.clear(this.debounce); this.debounce = this.timers.set(() => { this.debounce = null; this.Request().catch(() => {}); }, ms); this.debounce.unref?.(); }
  Request() { return this.SyncNow(); }
  // 直列化：同時に1つだけ実行する。
  SyncNow() { const run = this.chain.then(() => this.Cycle(), () => this.Cycle()); this.chain = run.catch(() => {}); return run; }
  async Cycle() {
    if (!this.config.enabled || this.blocked || !this.device || this.disposed) return { ok: false, error: this.blocked || '同期は無効です。' };
    if (this.Mismatch()) { this.Emit('error', '接続先またはアカウントが、この同期データの作成時と異なります。「接続を初期化」で切り替えてください（手元のプレイリストは変わりません）。'); return { ok: false, error: this.error }; }
    this.Emit('syncing');
    const result = await this.session.Cycle(); // データの安全に関わる規則は共通の sync-session.cjs
    if (result.blocked) { this.blocked = result.blocked; this.Emit('blocked'); return { ok: false, error: result.blocked }; }
    if (result.ok && this.extras) {
      const extra = await SyncExtras(this.extras(), this.Repository());
      this.extrasNotice = extra.ok ? '' : extra.error; // テーブル未作成（SQL未実行）などは、お知らせとして表示するだけ
    }
    this.Emit(result.ok ? 'idle' : 'error', result.ok ? '' : result.error);
    return result;
  }
}
module.exports = { StoreAdapter, SyncService };
