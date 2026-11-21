'use strict';
// お気に入り（v0.7.4 G）：お気に入りの曲は、シャッフル再生で、少しだけ選ばれやすくする（重みの倍率は play-ledger.cjs の FAVORITE_BOOST）。
// ・単位＝曲のメディアのキー（再生回数と同じ。同じ動画・パートは、どのリストにあっても共通）。
// ・この端末内のファイルにだけ保存する（同期しない・ZIPの出力／取り込みに含めない）。壊れたファイル・正しくないキーは、使わない。
const { ReadJson, WriteJsonAtomic } = require('./json-file.cjs');

const MAX_KEYS = 20000;
const KEY = /^[A-Za-z0-9:._-]{1,200}$/;
const ValidKey = key => typeof key === 'string' && KEY.test(key);

class FavoriteStore {
  constructor(file) {
    this.file = file; this.keys = new Set();
    const data = ReadJson(file);
    if (data?.version === 1 && Array.isArray(data.keys)) for (const key of data.keys) if (ValidKey(key) && this.keys.size < MAX_KEYS) this.keys.add(key);
  }
  Has(key) { return this.keys.has(key); }
  List() { return [...this.keys]; }
  Save() { return WriteJsonAtomic(this.file, { version: 1, keys: [...this.keys] }); }
  // value：true＝お気に入りにする／false＝外す。キーが正しくない・上限を超える場合は、例外（変更しない）。
  Set(key, value) {
    if (!ValidKey(key)) throw new Error('この曲は、まだ識別できないため、お気に入りにできません。');
    if (value && !this.keys.has(key) && this.keys.size >= MAX_KEYS) throw new Error('お気に入りの上限（20000曲）に達しています。');
    const before = this.keys.has(key);
    if (value) this.keys.add(key); else this.keys.delete(key);
    if (before !== this.keys.has(key) && !this.Save()) { if (before) this.keys.add(key); else this.keys.delete(key); throw new Error('お気に入りを保存できませんでした。'); }
    return this.keys.has(key);
  }
}

module.exports = { FavoriteStore, ValidKey, MAX_KEYS };
