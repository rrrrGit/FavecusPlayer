'use strict';
// Windows版の再生回数の保存。数え方・合計・世代（リセット）の規則は、iPhone版と共通の play-ledger.cjs。ここは、ファイルへの保存と、旧形式からの引き継ぎだけ。
// 保存先：play-ledger.json（端末ごとの加算カウンタの台帳）。旧形式 play-counts.json（曲のURL → 回数）は、読むだけで変更・削除しない。引き継ぎは1回だけ。
const fs = require('node:fs'), path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { ParseBilibili } = require('./urls.cjs');
const { LibrarySyncKey } = require('./library-identity.cjs');
const Ledger = require('./play-ledger.cjs');

// 旧形式の曲のキー（Bilibiliの正規化URL、またはローカルのファイル名）。旧形式の読み込みと、テストで使う。
function TrackKey(entry) { return entry?.type === 'bilibili' ? ParseBilibili(entry.url).url : entry?.type === 'local' ? `local:${entry.fileName}` : ''; }
class PlayCounts {
  // options.legacyFile：旧形式のファイル（あれば1回だけ引き継ぐ）／options.aliases：確認済みのav/BV対応を返す関数（同じ動画を同じキーにするため）
  constructor(file, warn = () => {}, options = {}) {
    this.file = file; this.warn = warn; this.now = () => Date.now(); this.tracker = new Ledger.PlayTracker();
    this.aliases = options.aliases || (() => []); this.onChange = null; this.totals = null;
    this.dirty = new Set(); this.pushedOnce = false; // 変わった行の印（起動後の最初の同期では、すべての行を送る）
    this.ledger = this.Load(file) || Ledger.NewLedger(randomBytes(8).toString('hex'));
    if (!this.ledger.legacyImported && options.legacyFile) this.ImportLegacy(options.legacyFile);
  }
  Load(file) {
    try {
      if (!fs.existsSync(file)) return null;
      if (fs.statSync(file).size > 64 * 1024 * 1024) throw new Error('size');
      const { ledger, dropped } = Ledger.Clean(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (dropped) this.warn(`再生回数の一部（${dropped}件）を読み込めませんでした。それ以外は引き継ぎました。`);
      return ledger;
    } catch { try { fs.copyFileSync(file, `${file}.damaged-${Date.now()}`); } catch {} this.warn('再生回数を読み込めませんでした。元の記録を残し、回数を0から記録します。'); return null; }
  }
  // 旧形式を、この端末の「legacy」の月へ引き継ぐ。読めない・形式が違うときは、何もしない（元のファイルはそのまま）。
  ImportLegacy(legacyFile) {
    try {
      if (!fs.existsSync(legacyFile) || fs.statSync(legacyFile).size > 16 * 1024 * 1024) { this.ledger.legacyImported = true; return; }
      const data = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      if (data.version !== 1 || !data.counts || typeof data.counts !== 'object' || Array.isArray(data.counts)) throw new Error('format');
      const keyOf = old => {
        if (old.startsWith('local:')) return old;
        try { return LibrarySyncKey(this.aliases())({ type: 'bilibili', ...ParseBilibili(old) }); } catch { return null; }
      };
      this.ledger.legacyImported = false;
      Ledger.ImportLegacy(this.ledger, data.counts, keyOf);
      this.totals = null; this.Persist();
    } catch { this.warn('以前の再生回数を引き継げませんでした（元のファイルは変更していません）。'); }
  }
  KeyOf(entry) {
    if (entry?.type === 'bilibili') { try { return LibrarySyncKey(this.aliases())({ ...ParseBilibili(entry.url), ...entry }) || ''; } catch { return ''; } }
    return entry?.type === 'local' && /^[A-Za-z0-9._-]{1,200}$/.test(String(entry.fileName || '')) ? `local:${entry.fileName}` : '';
  }
  Count(entry) { const key = this.KeyOf(entry); if (!key) return 0; this.totals ||= Ledger.Totals(this.ledger); return this.totals.get(key) || 0; }
  Begin(entry) { this.tracker.Begin(this.KeyOf(entry), this.now()); }
  Observe(media) {
    const key = this.tracker.Observe(media, this.now());
    if (!key) return;
    const row = Ledger.Increment(this.ledger, key, this.now()); this.totals = null; this.dirty.add(row.id);
    try { this.Persist(); } catch (error) { this.warn(`再生回数を保存できません: ${error.message}`); }
    this.onChange?.({ rows: Ledger.IsSyncKey(key) ? [row] : [] });
  }
  // 他の端末から受け取った行・世代を取り込む（同期から）。
  MergeRemote({ rows = [], epoch } = {}) {
    const changed = Ledger.MergeRows(this.ledger, rows) + (epoch !== undefined && Ledger.MergeEpoch(this.ledger, epoch) ? 1 : 0);
    if (changed) { this.totals = null; try { this.Persist(); } catch (error) { this.warn(`再生回数を保存できません: ${error.message}`); } }
    return changed;
  }
  Persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(this.ledger), { flag: 'wx' }); fs.renameSync(tmp, this.file); } catch (error) { try { fs.rmSync(tmp, { force: true }); } catch {} throw error; }
  }
  // リセット：世代を1つ上げる（古い世代の行は、履歴として残る）。保存できなければ、元に戻して失敗を知らせる。
  Reset() {
    const before = this.ledger.epoch;
    const epoch = Ledger.Reset(this.ledger); this.totals = null;
    try { this.Persist(); } catch (error) { this.ledger.epoch = before; throw error; }
    this.tracker.Stop();
    this.onChange?.({ epoch });
  }
  // ---- 同期（sync-counts.cjs のアダプター）。設定（優先する・その変更時刻）は、呼び出し側（ストア）が持つ。
  SyncRead(prefs) {
    const rows = Ledger.SyncRows(this.ledger).filter(row => this.pushedOnce ? this.dirty.has(Ledger.RowId(row.device, row.epoch, row.month, row.key)) : true)
      .map(row => ({ epoch: row.epoch, month: row.month, key: row.key, n: row.n }));
    return { deviceId: this.ledger.deviceId, epoch: this.ledger.epoch, cursor: this.ledger.syncCursor || 0, rows, prefs };
  }
  SyncApply({ rows = [], epoch, cursor }) {
    const changed = Ledger.MergeRows(this.ledger, rows) + (epoch !== undefined && Ledger.MergeEpoch(this.ledger, epoch) ? 1 : 0);
    const moved = Number.isSafeInteger(cursor) && cursor > (this.ledger.syncCursor || 0);
    if (moved) this.ledger.syncCursor = cursor;
    if (changed || moved) { this.totals = null; try { this.Persist(); } catch (error) { this.warn(`再生回数を保存できません: ${error.message}`); } }
    return changed;
  }
  SyncPushed() { this.dirty.clear(); this.pushedOnce = true; }
  // 同期へ送る行（Bilibiliの曲だけ）と世代。
  SyncState() { return { deviceId: this.ledger.deviceId, epoch: this.ledger.epoch, rows: Ledger.SyncRows(this.ledger) }; }
}
module.exports = { PlayCounts, TrackKey };
