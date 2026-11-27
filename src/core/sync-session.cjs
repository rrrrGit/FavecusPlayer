'use strict';
// 同期の運用の中心（端末APIなし）：ローカルのライブラリと同期の状態をつなぐ、データの安全に関わる規則を1か所に集める。
// Windows版（sync-service.cjs）とiPhone版（JavaScriptCore）が同じ処理を使う。通信・保存・時刻・設定は注入される。
// 規則：
//  - ローカルの編集は、ストアの現在の内容と「直前に同期した表示（base）」との差分として取り込む（古いコピーで他端末の追加を削除しない）。
//  - 受信した変更は先にライブラリへ反映し、その後に同期の状態を保存する。途中で止まっても、次回の差分は削除や上書きにならない。
//  - 同期中にローカルの編集があった場合は、同期前のbaseとの差分として取り込んでから反映する。
//  - 既定のままの空のライブラリで始めるとき（初回の有効化）は、それを他端末へ送らず、共通の既定リストにしてから受信する（既定リストの重複を防ぐ）。
//  - 同期の状態があるのに、ライブラリが既定のままの空の状態に見えるときは、削除を送らず停止する（消失・復旧の取り違えで全端末の曲を消さない）。
const E = require('./sync-engine.cjs');
const L = require('./sync-library.cjs');

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_NAME = 'お気に入り';

// 既定のまま・未編集の空のライブラリか（リスト1つ、既定の名前、曲も子もない）。
function IsPristine(library) {
  const lists = library.playlists || [];
  if (lists.length !== 1) return false;
  const only = lists[0];
  return only.name === DEFAULT_NAME && !only.icon && (only.entries || []).length === 0 && (only.childIds || []).length === 0 && (library.rootPlaylistIds || []).length === 1 && (library.videoAliases || []).length === 0;
}
const HasContent = library => (library.playlists || []).length > 1 || (library.playlists || []).some(p => (p.entries || []).length > 0);
const Snapshot = device => ({ view: device.view, derivedEdges: new Set(device.derivedEdges) });

class SyncSession {
  // options: { adapter: { Library(), Context(), Apply(view)→変更したか, Recovered?(), Backup?() }, repository(): リポジトリ, persist(session): 状態の保存, now(), onApplied?(), deviceId(): 新しい端末ID }
  constructor(options) {
    this.adapter = options.adapter; this.makeRepository = options.repository; this.persist = options.persist; this.now = options.now || Date.now;
    this.onApplied = options.onApplied || (() => {}); this.newDeviceId = options.deviceId;
    this.device = null; this.base = null; this.origin = { url: '', userId: '' }; this.lastSyncAt = 0; this.lastCompactAt = 0; this.version = 0; this.applying = false;
    this.blocked = ''; this.skipEmptyCheck = false; this.recoveredAck = false;
  }
  get ready() { return !!this.device; }
  Extra() { return { origin: this.origin, blocked: this.blocked, lastSyncAt: this.lastSyncAt, lastCompactAt: this.lastCompactAt }; }
  // 保存された状態（sync-statefile.cjsのParseState）から復元する。context：同期の導出に渡す文脈（adapter.Context()の結果）。
  Restore(snapshot) {
    const device = E.NewDevice(snapshot.deviceId);
    Object.assign(device, { clock: snapshot.clock, cursor: snapshot.cursor, state: snapshot.state, outbox: snapshot.outbox, conflicts: snapshot.conflicts });
    this.origin = snapshot.origin; this.blocked = snapshot.blocked || ''; this.device = device; this.lastSyncAt = snapshot.lastSyncAt; this.lastCompactAt = snapshot.lastCompactAt;
    E.Refresh(device, snapshot.context); this.base = Snapshot(device);
  }
  Reset() { this.device = null; this.base = null; this.origin = { url: '', userId: '' }; this.lastSyncAt = 0; this.lastCompactAt = 0; this.blocked = ''; this.skipEmptyCheck = false; this.recoveredAck = false; }
  // 初めての有効化。ライブラリのバックアップを残し、端末を作る。
  // adapterの各操作は、同期の値でも非同期（Promise）でもよい（iPhone版はSwiftへの問い合わせが非同期）。
  async Enable(origin) {
    await this.adapter.Backup?.();
    const device = E.NewDevice(this.newDeviceId());
    const library = await this.adapter.Library(), context = await this.adapter.Context();
    if (IsPristine(library)) {
      // 既定のままの空のライブラリは送らない。共通の既定リスト（導出）に置き換え、あとの受信で他端末のリストを取り込む。
      E.Refresh(device, context);
      await this.adapter.Apply(device.view);
    } else E.Initialize(device, library, this.now(), context);
    this.device = device; this.base = Snapshot(device); this.origin = origin;
    await this.persist(this);
  }
  // ストアが変わった通知（同期中の変更の検出に使う）。
  Changed() { this.version++; }
  // ローカルの編集を、baseとの差分として取り込む。失敗（変換できない内容）では何も変えない。
  // 戻り値：読み取ったライブラリの照合用の値（token）。Applyが、読み取り後に編集が入っていないかの確認に使う。
  async Reconcile(base = this.base) {
    this.device.view = base.view; this.device.derivedEdges = new Set(base.derivedEdges);
    const library = await this.adapter.Library(), context = await this.adapter.Context();
    E.Edit(this.device, library, this.now(), context);
    return library.token;
  }
  async Apply(token) {
    this.applying = true;
    try { const changed = await this.adapter.Apply(this.device.view, token); this.base = Snapshot(this.device); if (changed) this.onApplied(); }
    finally { this.applying = false; }
  }
  // 差分の取り込み→反映。取り込みと反映の間に編集が入ったとき（iPhone版は問い合わせが非同期）は、編集を取り消さず、やり直す。
  async Converge(base) {
    for (let attempt = 0; ; attempt++) {
      // JSC の structuredClone はJSON用なので、Setは明示して複製する。
      const before = { ...JSON.parse(JSON.stringify(this.device)), derivedEdges: new Set(this.device.derivedEdges) };
      const previousBase = this.base;
      try { const token = await this.Reconcile(base); await this.Apply(token); return token; }
      catch (error) {
        this.device = before; this.base = previousBase;
        if (attempt < 3 && error && error.code === 'changed') continue;
        throw error;
      }
    }
  }
  // 停止する。理由は同期状態へ保存し、再起動しても、利用者が選ぶまで解除しない（ファイルの消失・復旧の取り違えで、他の端末の内容を消さないため）。
  async Block(reason) { this.blocked = reason; try { await this.persist(this); } catch { /* 保存できなくても、この起動では停止したままにする */ } return { ok: false, blocked: reason }; }
  // 停止の解除（利用者の選択）。mode：'restore'＝同期した内容でこの端末を復元する／'keep'＝この端末の内容を正として同期する（削除も送る）。
  async Unblock(mode) {
    if (!this.blocked) return { ok: true };
    if (!['restore', 'keep'].includes(mode)) throw new Error('操作が正しくありません。');
    if (mode === 'restore') {
      E.Refresh(this.device, await this.adapter.Context());
      this.applying = true;
      try {
        await this.adapter.Apply(this.device.view);
        this.base = Snapshot(this.device);
      } finally { this.applying = false; }
    } else this.skipEmptyCheck = true;
    this.recoveredAck = true; this.blocked = '';
    await this.persist(this);
    return { ok: true };
  }
  // 1回の同期。戻り値：{ ok, error?, blocked? }（blockedがあれば、呼び出し側は同期を止める）。
  async Cycle(context = {}) {
    if (this.blocked) return { ok: false, blocked: this.blocked };
    const origin = context.origin;
    if (origin && this.origin.url && (this.origin.url !== origin.url || (origin.userId && this.origin.userId !== origin.userId))) {
      return { ok: false, mismatch: true, error: '接続先またはアカウントが、この同期データの作成時と異なります。「接続を初期化」で切り替えてください（手元のプレイリストは変わりません）。' };
    }
    if (!this.recoveredAck && await this.adapter.Recovered?.()) return this.Block('保存データを読み込めず復旧した状態のため、同期を停止しました（古い内容を他の端末へ反映しないためです）。「サーバーの内容で復元」か、この端末の内容を正とするかを選んでください。');
    const local = await this.adapter.Library();
    if (!this.skipEmptyCheck && IsPristine(local) && HasContent(this.base.view)) {
      return this.Block('ライブラリが空の状態に見えるため、同期を停止しました（他の端末の内容を消さないためです）。意図した操作でなければ「サーバーの内容で復元」を、意図して空にした場合は「この端末の内容を正とする」を選んでください。');
    }
    let token;
    try { token = await this.Converge(); this.skipEmptyCheck = false; } catch (error) { return { ok: false, error: `ローカルの変更を同期用に変換・反映できません：${error.message}` }; }
    try { await this.persist(this); } catch (error) { return { ok: false, error: `保存できません：${error.message}` }; }
    let repository;
    try { repository = this.makeRepository(); } catch (error) { return { ok: false, error: error.message }; }
    const base = this.base, version = this.version;
    const result = await E.Sync(this.device, repository, this.now(), await this.adapter.Context());
    if (context.isAborted?.()) return { ok: false, aborted: true, error: '同期は中断されました。' };
    try {
      // 同期中にローカルの編集があった：同期前のbaseとの差分として取り込んでから反映する。先にライブラリ、その後に同期の状態。
      if (this.version !== version) await this.Converge(base);
      else {
        try { await this.Apply(token); }
        catch (error) { if (error?.code !== 'changed') throw error; await this.Converge(base); }
      }
      if (context.isAborted?.()) return { ok: false, aborted: true, error: '同期は中断されました。' };
      if (result.ok) this.lastSyncAt = this.now();
      if (result.ok && this.now() - this.lastCompactAt > DAY) { try { await repository.Compact(this.now()); this.lastCompactAt = this.now(); } catch { /* 整理は次回に回す */ } }
      if (context.isAborted?.()) return { ok: false, aborted: true, error: '同期は中断されました。' };
      await this.persist(this);
    } catch (error) { return { ok: false, error: `反映できません：${error.message}` }; }
    return result.ok ? { ok: true, resynced: !!result.resynced } : { ok: false, error: result.error };
  }
}
module.exports = { DAY, DEFAULT_NAME, IsPristine, HasContent, SyncSession };
