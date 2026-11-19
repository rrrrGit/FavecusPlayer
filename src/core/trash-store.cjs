'use strict';
// 最近削除の保管ファイル（PC版。端末内だけ・同期しない）。保管の中身・復元の規則は、共通の trash.cjs。
// 壊れた項目は、使わない（読めない項目だけ捨てる）。保存は、一時ファイルへ書いて置き換える。保存できなくても、編集・再生は妨げない。
const fs = require('node:fs');
const path = require('node:path');
const Trash = require('./trash.cjs');

class TrashStore {
  constructor(file, now = () => new Date().toISOString()) {
    this.file = file; this.now = now; this.items = [];
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data?.version === 1 && Array.isArray(data.items)) this.items = Trash.Prune(data.items.filter(Trash.ValidItem), this.now());
    } catch { /* ファイルがない・壊れている：空から始める */ }
  }
  Save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`; fs.writeFileSync(temp, JSON.stringify({ version: 1, items: this.items })); fs.renameSync(temp, this.file);
      return true;
    } catch { return false; }
  }
  // 削除の保存に成功したあとに呼ぶ。形が正しくないものは、入れない。
  Add(item) {
    if (!Trash.ValidItem(item)) return false;
    this.items = Trash.Prune([item, ...this.items.filter(x => x.id !== item.id)], this.now());
    return this.Save();
  }
  List() { this.items = Trash.Prune(this.items, this.now()); return this.items.map(item => Trash.Summary(item, this.now())); }
  Get(id) { return this.items.find(item => item.id === id) || null; }
  Remove(id) { const before = this.items.length; this.items = this.items.filter(item => item.id !== id); if (this.items.length !== before) this.Save(); }
  Clear() { this.items = []; this.Save(); }
  // 保管中の曲（保存済みメディアを、保管が終わるまで残すため、参照として数える）。
  Entries() { return this.items.flatMap(item => (item.kind === 'entry' ? [item.entry] : item.playlist.entries)); }
}

module.exports = { TrashStore };
