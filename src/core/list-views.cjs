'use strict';
// プレイリストごとの「並べ替え・絞り込み」の選択（v0.7.4）。この端末内だけに保存し、同期しない。
// 規則（段階・既定）は ui/entry-view.js（PC版・iPhone版で共通）。
const { ReadJson, WriteJsonAtomic } = require('./json-file.cjs');
const EntryView = require('../ui/entry-view.js');

const MAX_LISTS = 2000;

class ListViewStore {
  constructor(file) {
    this.file = file; this.views = {};
    const data = ReadJson(file);
    if (data?.version === 1 && data.views && typeof data.views === 'object') {
      for (const [id, view] of Object.entries(data.views).slice(0, MAX_LISTS)) if (typeof id === 'string' && id.length <= 80 && EntryView.IsActive(view)) this.views[id] = EntryView.Normalize(view);
    }
  }
  // 選択のあるリストだけ、{ プレイリストID: view } で返す。
  All() { return { ...this.views }; }
  Get(playlistId) { return this.views[playlistId] || null; }
  // 既定（並べ替えも絞り込みもなし）に戻したときは、記録を消す。
  Set(playlistId, view) {
    if (typeof playlistId !== 'string' || !playlistId || playlistId.length > 80) throw new Error('プレイリストが正しくありません。');
    const normalized = EntryView.Normalize(view);
    const hadPrev = Object.hasOwn(this.views, playlistId), prev = this.views[playlistId];
    if (EntryView.IsActive(normalized)) {
      if (!this.views[playlistId] && Object.keys(this.views).length >= MAX_LISTS) throw new Error('保存できる並べ替えの数の上限です。');
      this.views[playlistId] = normalized;
    } else delete this.views[playlistId];
    if (!this.Save()) {
      if (hadPrev) this.views[playlistId] = prev; else delete this.views[playlistId];
      throw new Error('曲の表示設定を保存できませんでした。');
    }
    return this.Get(playlistId);
  }
  Save() { return WriteJsonAtomic(this.file, { version: 1, views: this.views }); }
}

module.exports = { ListViewStore, MAX_LISTS };
