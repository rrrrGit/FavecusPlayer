'use strict';
// 再生履歴のファイル保存（PC版。規則は play-history.cjs＝共通JS）。この端末内だけ。原子的に書く。
const fs = require('node:fs');
const path = require('node:path');
const History = require('./play-history.cjs');

class HistoryStore {
  constructor(file) {
    this.file = file; this.items = [];
    try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); if (data?.version === 1) this.items = History.Clean(data); } catch { /* 初めて・壊れている：空 */ }
  }
  Add(key, atMs) {
    this.items = History.Add(this.items, key, atMs);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`; fs.writeFileSync(temp, JSON.stringify({ version: 1, items: this.items })); fs.renameSync(temp, this.file);
    } catch { /* 保存できなくても、この起動の間は使える */ }
  }
  Keys(limit) { return History.RecentKeys(this.items, limit); }
  Clear() { this.items = []; try { fs.rmSync(this.file, { force: true }); } catch {} }
}

module.exports = { HistoryStore };
