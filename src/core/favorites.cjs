'use strict';
// お気に入り（v0.7.4〜）：お気に入りの曲は、シャッフル再生で、少しだけ選ばれやすくする（重みの倍率は play-ledger.cjs の FAVORITE_BOOST）。
// ・単位＝曲のメディアのキー（再生回数と同じ。同じ動画・パートは、どのリストにあっても共通）。
// ・ローカルの曲（local:...）はこの端末内のみ、Bilibiliの曲（bili:... / bili-av:...）は同期する（v0.7.5）。規則は favorites-core.cjs（共通JS）。
const { ReadJson, WriteJsonAtomic } = require('./json-file.cjs');
const { CanonicalMediaKey } = require('./library-identity.cjs');
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
  Set(key, value) {
    return this.SetMany([key], value).fav;
  }
  // keys の全要素を検証し、まとめて 1 回だけ原子保存する。途中で失敗した場合は直前の状態へ戻す。
  SetMany(keys, value) {
    if (!Array.isArray(keys)) throw new Error('曲を選んでください。');
    const fav = value === true;
    if (!keys.length) return { fav, changed: 0 };
    const prevStates = { ...this.doc.states }, prevKeys = [...this.doc.keys];
    const protectedKeys = new Set([...this.dirty, ...this.inFlight, ...this.touched]);
    const now = this.now(), changed = [];
    try {
      for (const key of keys) {
        const result = FavCore.Set(this.doc, key, fav, now, protectedKeys);
        if (result.changed) changed.push({ key, syncable: result.syncable });
      }
    } catch (error) {
      this.doc.states = prevStates; this.doc.keys = prevKeys; this.keys = new Set(prevKeys);
      throw error;
    }
    if (!changed.length) return { fav, changed: 0 };
    if (!this.Save()) {
      this.doc.states = prevStates; this.doc.keys = prevKeys; this.keys = new Set(prevKeys);
      throw new Error('お気に入りを保存できませんでした。');
    }
    this.keys = new Set(this.doc.keys);
    let syncable = false;
    for (const item of changed) {
      if (!item.syncable) continue;
      syncable = true;
      this.dirty.add(item.key);
      if (this.inFlight.has(item.key)) this.touched.add(item.key);
    }
    this.onChange?.({ key: changed[0].key, keys: changed.map(i => i.key), value: fav, syncable });
    return { fav, changed: changed.length };
  }
  SyncRead(deviceId) {
    const rows = FavCore.SyncRows(this.doc, this.pushedOnce ? this.dirty : null);
    this.inFlight = new Set(rows.map(row => row.key)); this.touched = new Set();
    return { deviceId, cursor: this.doc.syncCursor || 0, rows };
  }
  SyncApply({ rows = [], cursor = 0 } = {}) {
    const prevStates = { ...this.doc.states }, prevKeys = [...this.doc.keys], prevCursor = this.doc.syncCursor || 0;
    const protectedKeys = new Set([...this.dirty, ...this.inFlight, ...this.touched]);
    const { changed, moved } = FavCore.Merge(this.doc, rows, cursor, this.now(), protectedKeys);
    if (changed || moved || this.migrated) {
      if (!this.Save()) {
        this.doc.states = prevStates; this.doc.keys = prevKeys; this.doc.syncCursor = prevCursor;
        this.keys = new Set(prevKeys);
        return 0;
      }
      this.keys = new Set(this.doc.keys);
      this.migrated = false;
    }
    return changed;
  }
  MigrateAliases(aliases) {
    const prevStates = { ...this.doc.states }, prevKeys = [...this.doc.keys];
    const protectedKeys = new Set([...this.dirty, ...this.inFlight, ...this.touched]);
    const res = FavCore.MigrateAliases(this.doc, CanonicalMediaKey(aliases), protectedKeys);
    if (!res.changed) return false;
    if (!this.Save()) {
      this.doc.states = prevStates; this.doc.keys = prevKeys; this.keys = new Set(prevKeys);
      return false;
    }
    this.keys = new Set(this.doc.keys);
    let syncable = false;
    for (const key of res.migratedKeys) {
      if (!FavCore.IsSyncKey(key)) continue;
      syncable = true;
      this.dirty.add(key);
      if (this.inFlight.has(key)) this.touched.add(key);
    }
    if (res.migratedKeys.length) this.onChange?.({ key: res.migratedKeys[0], keys: res.migratedKeys, syncable });
    return true;
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
