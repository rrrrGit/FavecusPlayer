'use strict';
const Tree = require('../ui/library-tree.js');
const { ValidateIcon } = require('./playlist-icon-data.cjs');
const { ParseBilibili, MEDIA_EXTENSIONS } = require('./urls.cjs');
const { IDENTITY_SCHEMA_VERSION, MEDIA_ID, IdentityError, ValidateIdentityVersion, PlanMediaIds, LibraryMediaKey } = require('./library-identity.cjs');
const MAX_PLAYLISTS = 999, MAX_ENTRIES = 10000;
const ID = /^[a-f0-9-]{36}$/;
const MEDIA_NAME = /^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/;
function CleanText(value, max = 180) { return String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max); }
function ValidatePlaylistCount(count) {
  if (count <= MAX_PLAYLISTS) return;
  const error = new Error(`再生リストは親・子を合わせて${MAX_PLAYLISTS}個までです。`); error.playlistLimitExceeded = true; throw error;
}
function ValidateLibrary(input, freshIds = false, createId = () => { throw new Error('識別番号の生成処理を指定してください。'); }) {
  if (!input || ![1, 2, 3].includes(input.version) || !Array.isArray(input.playlists) || input.playlists.length < 1) throw new Error('対応していない再生リストファイルです。');
  ValidatePlaylistCount(input.playlists.length);
  ValidateIdentityVersion(input);
  const keyOf = LibraryMediaKey(input.identityVersion === 2 ? input.videoAliases : []);
  let total = 0;
  const seen = new Set();
  const identifier = value => {
    const id = !freshIds && ID.test(value || '') ? value : createId();
    if (!ID.test(id || '')) throw new Error('生成された識別番号が正しくありません。');
    if (seen.has(id)) throw new Error('再生リスト内の識別番号が重複しています。');
    seen.add(id); return id;
  };
  const remap = new Map();
  const lists = input.playlists.map(p => {
    if (!p || !Array.isArray(p.entries) || (total += p.entries.length) > MAX_ENTRIES) throw new Error('再生リストが大きすぎるか、形式が正しくありません。');
    if (input.version === 3 && (!ID.test(p.id || '') || !Array.isArray(p.childIds))) throw new Error('階層の識別情報が正しくありません。');
    const id = identifier(p.id); remap.set(p.id, id);
    const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '';
    return { id, childIds: [], icon: ValidateIcon(p.icon), name: CleanText(p.name, 60) || '無題のリスト', createdAt: timestamp(p.createdAt), lastAddedAt: timestamp(p.lastAddedAt), includeInAll: p.includeInAll !== false, entries: p.entries.filter(e => !(input.version === 1 && e?.type === 'youtube')).map(e => {
      if (!e || !['bilibili', 'local'].includes(e.type)) throw new Error('不明な種類の動画が含まれています。');
      const base = { id: identifier(e.id), title: CleanText(e.title), addedAt: CleanText(e.addedAt, 40), ...(Number.isFinite(e.duration) && e.duration > 0 ? { duration: Math.min(e.duration, 604800) } : {}) };
      if (!freshIds && [1, IDENTITY_SCHEMA_VERSION].includes(input.identityVersion)) {
        if (typeof e.mediaId !== 'string' || !MEDIA_ID.test(e.mediaId)) throw IdentityError('メディア識別番号がありません。保存データは変更していません。');
        base.mediaId = e.mediaId;
      }
      if (e.type === 'bilibili') return { ...base, ...ParseBilibili(e.url) };
      if (!MEDIA_NAME.test(e.fileName || '') || !MEDIA_EXTENSIONS.has(e.fileName.slice(e.fileName.lastIndexOf('.')))) throw new Error('動画ファイルの参照先が正しくありません。');
      return { ...base, type: 'local', fileName: e.fileName };
    }) };
  });
  if (input.version === 3) {
    Tree.ValidateGraph(input.playlists, input.rootPlaylistIds);
    input.playlists.forEach((p, i) => { lists[i].childIds = p.childIds.map(id => remap.get(id)); });
  }
  if (!freshIds && [1, IDENTITY_SCHEMA_VERSION].includes(input.identityVersion)) PlanMediaIds(lists, () => { throw IdentityError('メディア識別番号がありません。'); }, keyOf);
  return lists;
}

module.exports = { MAX_PLAYLISTS, MAX_ENTRIES, MEDIA_NAME, CleanText, ValidatePlaylistCount, ValidateLibrary };
