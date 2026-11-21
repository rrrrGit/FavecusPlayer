'use strict';
// プレイリストごとの「並べ替え・絞り込み」の選択（v0.7.4）。この端末内だけに保存し、同期しない。
// 規則（段階・既定）は ui/entry-view.js（PC版・iPhone版で共通）。
const fs = require('node:fs');
const path = require('node:path');
const EntryView = require('../ui/entry-view.js');

const MAX_LISTS = 2000;

class ListViewStore {
  constructor(file) {
    this.file = file; this.views = {};
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data?.version === 1 && data.views && typeof data.views === 'object') {
        for (const [id, view] of Object.entries(data.views).slice(0, MAX_LISTS)) if (typeof id === 'string' && id.length <= 80 && EntryView.IsActive(view)) this.views[id] = EntryView.Normalize(view);
      }
    } catch { /* 初めて・壊れている：選択なし */ }
  }
  // 選択のあるリストだけ、{ プレイリストID: view } で返す。
  All() { return { ...this.views }; }
  Get(playlistId) { return this.views[playlistId] || null; }
  // 既定（並べ替えも絞り込みもなし）に戻したときは、記録を消す。
  Set(playlistId, view) {
    if (typeof playlistId !== 'string' || !playlistId || playlistId.length > 80) throw new Error('プレイリストが正しくありません。');
    const normalized = EntryView.Normalize(view);
    if (EntryView.IsActive(normalized)) {
      if (!this.views[playlistId] && Object.keys(this.views).length >= MAX_LISTS) throw new Error('保存できる並べ替えの数の上限です。');
      this.views[playlistId] = normalized;
    } else delete this.views[playlistId];
    this.Save();
    return this.Get(playlistId);
  }
  Save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`; fs.writeFileSync(temp, JSON.stringify({ version: 1, views: this.views })); fs.renameSync(temp, this.file);
    } catch { /* 保存できなくても、この起動の間は使える */ }
  }
}

module.exports = { ListViewStore, MAX_LISTS };
