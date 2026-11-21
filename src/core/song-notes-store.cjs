'use strict';
// 曲の情報のファイル保存（PC版。規則は song-notes.cjs＝共通JS）。曲のメディアのキー → 記録。この端末内だけ。原子的に書く。
const { ReadJson, WriteJsonAtomic } = require('./json-file.cjs');
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
    if (Notes.IsEmpty(normalized)) delete this.records[key];
    else {
      if (!this.records[key] && Object.keys(this.records).length >= MAX_SONGS) throw new Error('保存できる曲の情報の数の上限です。');
      this.records[key] = normalized;
    }
    this.Save();
    return this.Get(key);
  }
  Save() { WriteJsonAtomic(this.file, { version: 1, records: this.records }); }
}

module.exports = { SongNotesStore, MAX_SONGS };
