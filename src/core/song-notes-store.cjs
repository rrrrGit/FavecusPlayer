'use strict';
// 曲の情報のファイル保存（PC版。規則は song-notes.cjs＝共通JS）。曲のメディアのキー → 記録。この端末内だけ。原子的に書く。
const fs = require('node:fs');
const path = require('node:path');
const Notes = require('./song-notes.cjs');

const MAX_SONGS = 20000;
const KEY = /^[A-Za-z0-9:._-]{1,220}$/;

class SongNotesStore {
  constructor(file) {
    this.file = file; this.records = {};
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data?.version === 1 && data.records && typeof data.records === 'object') {
        for (const [key, record] of Object.entries(data.records).slice(0, MAX_SONGS)) if (KEY.test(key) && !Notes.IsEmpty(record)) this.records[key] = Notes.Normalize(record);
      }
    } catch { /* 初めて・壊れている：空 */ }
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
  Save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`; fs.writeFileSync(temp, JSON.stringify({ version: 1, records: this.records })); fs.renameSync(temp, this.file);
    } catch { /* 保存できなくても、この起動の間は使える */ }
  }
}

module.exports = { SongNotesStore, MAX_SONGS };
