'use strict';
// 曲の情報のファイル保存（PC版。規則は song-notes.cjs＝共通JS）。曲のメディアのキー → 記録。この端末内だけ。原子的に書く。
const { ReadJson, WriteJsonAtomic } = require('./json-file.cjs');
const { CanonicalMediaKey } = require('./library-identity.cjs');
const Notes = require('./song-notes.cjs');

const MAX_SONGS = 20000;
const KEY = /^[A-Za-z0-9:._-]{1,220}$/;

class SongNotesStore {
  constructor(file) {
    this.file = file; this.records = {};
    const data = ReadJson(file);
    if (data?.version === 1 && data.records && typeof data.records === 'object') {
      for (const [key, record] of Object.entries(data.records).slice(0, MAX_SONGS)) if (KEY.test(key) && !Notes.IsEmpty(record)) this.records[key] = Notes.Normalize(record);
    }
  }
  Get(key) { return this.records[key] ? Notes.Normalize(this.records[key]) : null; }
  Has(key) { return !!this.records[key]; }
  // 空にしたときは、記録を消す。キーが正しくない・上限を超えるときは、例外。
  Set(key, record) {
    if (typeof key !== 'string' || !KEY.test(key)) throw new Error('この曲は、まだ識別できないため、情報を保存できません。');
    const normalized = Notes.Normalize(record);
    const hadPrev = Object.hasOwn(this.records, key), prev = this.records[key];
    if (Notes.IsEmpty(normalized)) delete this.records[key];
    else {
      if (!this.records[key] && Object.keys(this.records).length >= MAX_SONGS) throw new Error('保存できる曲の情報の数の上限です。');
      this.records[key] = normalized;
    }
    if (!this.Save()) {
      if (hadPrev) this.records[key] = prev;
      else delete this.records[key];
      throw new Error('曲の情報を保存できませんでした。');
    }
    return this.Get(key);
  }
  MigrateAliases(aliases) {
    const canonical = CanonicalMediaKey(aliases);
    const prevRecords = { ...this.records };
    let changed = false;
    for (const oldKey of Object.keys(this.records)) {
      const nextKey = canonical(oldKey);
      if (!nextKey || nextKey === oldKey || !KEY.test(nextKey)) continue;
      const oldRec = this.records[oldKey], cur = this.records[nextKey];
      const merged = cur
        ? Notes.Normalize({ artist: cur.artist || oldRec.artist, tags: [...oldRec.tags, ...cur.tags], memo: cur.memo || oldRec.memo, chapters: [...oldRec.chapters, ...cur.chapters] })
        : oldRec;
      delete this.records[oldKey];
      if (!Notes.IsEmpty(merged)) this.records[nextKey] = merged;
      changed = true;
    }
    if (!changed) return false;
    if (!this.Save()) { this.records = prevRecords; return false; }
    return true;
  }
  Save() { return WriteJsonAtomic(this.file, { version: 1, records: this.records }); }
}

module.exports = { SongNotesStore, MAX_SONGS };
