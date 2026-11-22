'use strict';
// お気に入り（v0.7.4〜）：お気に入りの曲は、シャッフル再生で、少しだけ選ばれやすくする（重みの倍率は play-ledger.cjs の FAVORITE_BOOST）。
// ・単位＝曲のメディアのキー（再生回数と同じ。同じ動画・パートは、どのリストにあっても共通）。
// ・ローカルの曲（local:...）はこの端末内のみ、Bilibiliの曲（bili:... / bili-av:...）は同期する（v0.7.5）。規則は favorites-core.cjs（共通JS）。
const { ReadJson, WriteJsonAtomic } = require('./json-file.cjs');
const FavCore = require('./favorites-core.cjs');

const { ValidKey, MAX_KEYS } = FavCore;

class FavoriteStore {
  constructor(file, options = {}) {
    this.file = file;
    this.now = options.now || (() => Date.now());
    this.onChange = null;
    this.dirty = new Set(); this.inFlight = new Set(); this.touched = new Set(); this.pushedOnce = false;
    const { doc, migrated } = FavCore.Clean(ReadJson(file));
    this.doc = doc;
    this.keys = new Set(doc.keys);
    this.migrated = migrated;
  }
  Has(key) { return this.keys.has(key); }
  List() { return [...this.keys]; }
  Save() { return WriteJsonAtomic(this.file, this.doc); }
  // value：true＝お気に入りにする／false＝外す。キーが正しくない・上限を超える場合は、例外（変更しない）。
  Set(key, value) {
    const prevStates = { ...this.doc.states }, prevKeys = [...this.doc.keys];
    const protectedKeys = new Set([...this.dirty, ...this.inFlight, ...this.touched]);
    const result = FavCore.Set(this.doc, key, value, this.now(), protectedKeys);
    if (!result.changed) return result.fav;
    if (!this.Save()) {
      this.doc.states = prevStates; this.doc.keys = prevKeys; this.keys = new Set(prevKeys);
      throw new Error('お気に入りを保存できませんでした。');
    }
    this.keys = new Set(this.doc.keys);
    if (result.syncable) { this.dirty.add(key); if (this.inFlight.has(key)) this.touched.add(key); }
    this.onChange?.({ key, value: result.fav, syncable: result.syncable });
    return result.fav;
  }
  SyncRead(deviceId) {
    const rows = FavCore.SyncRows(this.doc, this.pushedOnce ? this.dirty : null);
    this.inFlight = new Set(rows.map(row => row.key)); this.touched = new Set();
    return { deviceId, cursor: this.doc.syncCursor || 0, rows };
  }
  SyncApply({ rows = [], cursor = 0 } = {}) {
    const protectedKeys = new Set([...this.dirty, ...this.inFlight, ...this.touched]);
    const { changed, moved } = FavCore.Merge(this.doc, rows, cursor, this.now(), protectedKeys);
    if (changed || moved || this.migrated) {
      this.keys = new Set(this.doc.keys);
      if (this.Save()) this.migrated = false;
    }
    return changed;
  }
  SyncPushed() {
    for (const key of this.inFlight) if (!this.touched.has(key)) this.dirty.delete(key);
    this.inFlight = new Set(); this.touched = new Set(); this.pushedOnce = true;
    if (this.migrated && this.Save()) this.migrated = false;
  }
  ResetSync() {
    this.doc.syncCursor = 0; this.pushedOnce = false;
    this.dirty.clear(); this.inFlight.clear(); this.touched.clear();
    this.Save();
  }
}

module.exports = { FavoriteStore, ValidKey, MAX_KEYS };
