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
const X = require('./sync-supabase.cjs');
const Storage = require('./sync-storage.cjs');
const { DerivedId } = require('./sync-library.cjs');

const DAY = 24 * 60 * 60 * 1000;

// Storeとの接続。Library()：同期用の形の現在のライブラリ。Apply(view)：同期後の表示をStoreへ反映（変化がなければ何もしない）。
function StoreAdapter(store, { validateLibrary, mediaKey }) {
  const Library = () => ({ version: 3, identityVersion: 2, videoAliases: store.data.videoAliases || [], rootPlaylistIds: store.data.rootPlaylistIds, playlists: store.data.playlists });
  return {
    Library,
    Directory: () => store.directory,
    Recovered: () => !!store.recovered,
    // 同期の導出に渡す：ローカルファイルの曲は、この端末に既にあるファイル名を使い、同じ動画は既存のmediaIdを共有する。
    Context() {
      const files = new Map(), media = new Map(), keyOf = mediaKey(store.data.videoAliases || []);
      for (const p of store.data.playlists) for (const e of p.entries) { if (e.type === 'local') files.set(e.id, e.fileName); if (e.mediaId && !media.has(keyOf(e))) media.set(keyOf(e), e.mediaId); }
      return { localFileName: (id, ext) => files.get(id) || `${id}${ext}`, mediaIdFor: key => media.get(key) || DerivedId(`media:${key}`) };
    },
    Apply(view) {
      const current = store.data, byList = new Map(current.playlists.map(p => [p.id, p])), byEntry = new Map();
      for (const p of current.playlists) for (const e of p.entries) byEntry.set(e.id, e);
      const playlists = view.playlists.map(v => {
        const old = byList.get(v.id);
        return { ...(old || {}), ...v, icon: old ? old.icon : v.icon, lastAddedAt: old?.lastAddedAt || v.lastAddedAt, entries: v.entries.map(e => {
          const prior = byEntry.get(e.id);
          if (!prior) return e;
          return { ...prior, ...e, ...(e.type === 'local' && prior.type === 'local' ? { fileName: prior.fileName } : {}), mediaId: prior.mediaId || e.mediaId };
        }) };
      });
      const next = { videoAliases: view.videoAliases, rootPlaylistIds: view.rootPlaylistIds, playlists };
      const keys = ['videoAliases', 'rootPlaylistIds', 'playlists'];
      if (JSON.stringify(keys.map(k => current[k] || [])) === JSON.stringify(keys.map(k => next[k]))) return false;
      const checked = validateLibrary({ version: 3, identityVersion: 2, ...next }); // 不正なら例外（storeは変更しない）
      const before = current;
      const roots = next.rootPlaylistIds, active = checked.some(p => p.id === current.activePlaylistId) ? current.activePlaylistId : (roots[0] || checked[0].id);
      try { store.data = { ...current, identityVersion: 2, videoAliases: next.videoAliases, rootPlaylistIds: roots, playlists: checked, activePlaylistId: active }; store.Save(); }
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
    this.config = Storage.ReadConfig(this.dir); this.device = null; this.base = null; this.blocked = ''; this.error = ''; this.state = 'off';
    this.version = 0; this.lastSyncAt = 0; this.lastCompactAt = 0; this.chain = Promise.resolve(); this.debounce = null; this.interval = null; this.disposed = false;
    this.pendingCode = null; this.loaded = false; this.origin = { url: '', userId: '' };
  }
  Status() {
    return { url: this.config.url, enabled: this.config.enabled, configured: !!(this.config.url && this.config.anonKey), signedIn: !!this.Session(), email: this.config.email, encryption: this.vault.Available(),
      state: this.blocked ? 'blocked' : this.state, error: this.blocked || this.error, lastSyncAt: this.lastSyncAt, pending: this.device ? this.device.outbox.length : 0, conflicts: this.device ? this.device.conflicts.length : 0 };
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
    if (this.adapter.Recovered?.()) { this.blocked = '保存データを読み込めず復旧した状態のため、同期を停止しました（空の状態を他の端末へ反映しないためです）。内容を確認し、アプリを再起動してください。'; return; }
    const loaded = Storage.ReadState(this.dir);
    if (loaded.status === 'blocked') { this.blocked = loaded.reason; return; }
    if (loaded.status === 'ok') {
      const device = E.NewDevice(loaded.snapshot.deviceId);
      Object.assign(device, { clock: loaded.snapshot.clock, cursor: loaded.snapshot.cursor, state: loaded.snapshot.state, outbox: loaded.snapshot.outbox, conflicts: loaded.snapshot.conflicts });
      this.origin = loaded.snapshot.origin; this.device = device; this.lastSyncAt = loaded.snapshot.lastSyncAt; this.lastCompactAt = loaded.snapshot.lastCompactAt;
      E.Refresh(device, this.adapter.Context()); this.base = { view: device.view, derivedEdges: new Set(device.derivedEdges) };
    }
  }
  Start() {
    this.Load();
    if (this.config.enabled && !this.blocked && this.device) { this.Emit('idle'); this.Schedule(5 * 1000); this.interval = this.timers.set(() => this.Tick(), 5 * 60 * 1000); this.interval.unref?.(); }
    else this.Emit(this.blocked ? 'blocked' : 'off');
  }
  Tick() { if (this.disposed) return; this.Request().catch(() => {}); this.interval = this.timers.set(() => this.Tick(), 5 * 60 * 1000); this.interval.unref?.(); }
  async Enable() {
    this.Load(); // Start前でも、既存の同期データを確認してから始める
    if (this.blocked) throw new Error(this.blocked);
    if (!this.Session()) throw new Error('先にサインインしてください。');
    if (!this.device) {
      this.adapter.Backup();
      const device = E.NewDevice(`win-${randomUUID().slice(0, 8)}`);
      E.Initialize(device, this.adapter.Library(), this.now(), this.adapter.Context());
      this.device = device; this.base = { view: device.view, derivedEdges: new Set(device.derivedEdges) };
      this.origin = { url: this.config.url, userId: this.Session().userId };
      Storage.WriteState(this.dir, device, this.Extra());
    }
    this.config = { ...this.config, enabled: true }; Storage.WriteConfig(this.dir, this.config);
    this.Emit('idle'); this.interval = this.interval || this.timers.set(() => this.Tick(), 5 * 60 * 1000); this.interval.unref?.();
    return this.SyncNow();
  }
  Disable() {
    this.config = { ...this.config, enabled: false }; Storage.WriteConfig(this.dir, this.config);
    this.Clear(); this.Emit('off');
  }
  Clear() { if (this.debounce) this.timers.clear(this.debounce); if (this.interval) this.timers.clear(this.interval); this.debounce = null; this.interval = null; }
  Dispose() { this.disposed = true; this.Clear(); }
  Extra() { return { origin: this.origin, lastSyncAt: this.lastSyncAt, lastCompactAt: this.lastCompactAt }; }
  // 接続先・アカウントが同期データの作成時と違うか。
  Mismatch() { const session = this.vault.Get(); return !!this.device && !!this.origin.url && (this.origin.url !== this.config.url || (session && this.origin.userId !== session.userId)); }
  // 別のプロジェクト・アカウントへ切り替える：同期データは別名で残し、手元のライブラリから新しく始める。
  ResetLink() {
    this.Disable(); Storage.SetAside(this.dir); this.device = null; this.base = null; this.origin = { url: '', userId: '' }; this.blocked = ''; this.lastSyncAt = 0; this.lastCompactAt = 0; this.Emit('off');
  }
  // ---- ストアの変更・同期
  Changed() { this.version++; if (this.applying || !this.config.enabled || this.blocked || !this.device) return; this.Schedule(1500); }
  Schedule(ms) { if (this.disposed) return; if (this.debounce) this.timers.clear(this.debounce); this.debounce = this.timers.set(() => { this.debounce = null; this.Request().catch(() => {}); }, ms); this.debounce.unref?.(); }
  Request() { return this.SyncNow(); }
  // 直列化：同時に1つだけ実行する。
  SyncNow() { const run = this.chain.then(() => this.Cycle(), () => this.Cycle()); this.chain = run.catch(() => {}); return run; }
  // ローカルの編集を、baseとの差分として取り込む。失敗（変換できない内容）では何も変えない。
  Reconcile(base = this.base) {
    const device = this.device; device.view = base.view; device.derivedEdges = new Set(base.derivedEdges);
    E.Edit(device, this.adapter.Library(), this.now(), this.adapter.Context());
  }
  Apply() {
    this.applying = true;
    try { const changed = this.adapter.Apply(this.device.view); this.base = { view: this.device.view, derivedEdges: new Set(this.device.derivedEdges) }; if (changed) this.onApplied(); }
    finally { this.applying = false; }
  }
  async Cycle() {
    if (!this.config.enabled || this.blocked || !this.device || this.disposed) return { ok: false, error: this.blocked || '同期は無効です。' };
    if (this.Mismatch()) { this.Emit('error', '接続先またはアカウントが、この同期データの作成時と異なります。「接続を初期化」で切り替えてください（手元のプレイリストは変わりません）。'); return { ok: false, error: this.error }; }
    this.Emit('syncing');
    try { this.Reconcile(); } catch (error) { this.Emit('error', `ローカルの変更を同期用に変換できません：${error.message}`); return { ok: false, error: this.error }; }
    try { this.Apply(); Storage.WriteState(this.dir, this.device, this.Extra()); } catch (error) { this.Emit('error', `保存できません：${error.message}`); return { ok: false, error: this.error }; }
    let repository;
    try { repository = this.Repository(); } catch (error) { this.Emit('error', error.message); return { ok: false, error: error.message }; }
    const base = this.base, version = this.version;
    const result = await E.Sync(this.device, repository, this.now(), this.adapter.Context());
    try {
      if (this.version !== version) this.Reconcile(base); // 同期中にローカルの編集があった：同期前のbaseとの差分として取り込む
      this.Apply(); // 先にlibrary.json、その後にsync/state.json
      if (result.ok) this.lastSyncAt = this.now();
      if (result.ok && this.now() - this.lastCompactAt > DAY) { try { await repository.Compact(this.now()); this.lastCompactAt = this.now(); } catch { /* 整理は次回に回す */ } }
      Storage.WriteState(this.dir, this.device, this.Extra());
    } catch (error) { this.Emit('error', `反映できません：${error.message}`); return { ok: false, error: this.error }; }
    this.Emit(result.ok ? 'idle' : 'error', result.ok ? '' : result.error);
    return result;
  }
}
module.exports = { StoreAdapter, SyncService };
