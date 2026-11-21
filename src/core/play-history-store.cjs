'use strict';
// 再生履歴のファイル保存（PC版。規則は play-history.cjs＝共通JS）。この端末内だけ。原子的に書く。
const { ReadJson, WriteJsonAtomic, RemoveFile } = require('./json-file.cjs');
const History = require('./play-history.cjs');

class HistoryStore {
  constructor(file) {
    this.file = file; this.items = [];
    const data = ReadJson(file);
    if (data?.version === 1) this.items = History.Clean(data);
  }
  Add(key, atMs) {
    this.items = History.Add(this.items, key, atMs);
    WriteJsonAtomic(this.file, { version: 1, items: this.items });
  }
  Keys(limit) { return History.RecentKeys(this.items, limit); }
  Clear() { this.items = []; RemoveFile(this.file); }
}

module.exports = { HistoryStore };
