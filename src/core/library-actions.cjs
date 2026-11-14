'use strict';
// プレイリストの編集操作（階層・名前・並び順・曲の削除/並べ替え）。Windows版のStoreとiPhone版（共通JS）が同じ規則を使うための、端末APIを使わない純粋な処理。
// 状態（data）をその場で書き換える。保存・検証の確定（Tree.ValidateGraph・Save）は呼び出し側が行う。
// ctx：{ createId(), now()（ISO文字列）, cleanTitle(text) }。乱数・時刻・曲名の整形は注入する。
// URLからの追加・移動/コピー（Transfer）・ZIP・設定は端末ごとの処理のため、ここには含めない。
const Tree = require('../ui/library-tree.js');
const { ValidateIcon } = require('./playlist-icon-data.cjs');
const { MAX_PLAYLISTS, MAX_ENTRIES, CleanText, ValidatePlaylistCount } = require('./library-data.cjs');
const { LibraryMediaKey, PlanMediaIds } = require('./library-identity.cjs');
const { ParseBilibili } = require('./urls.cjs');

const TYPES = new Set(['create', 'select', 'rename', 'playlist-properties', 'delete', 'playlist-move', 'playlist-attach', 'playlist-reorder', 'remove', 'title', 'move', 'reorder', 'add-video']);

function Playlist(data, id) {
  const result = data.playlists.find(p => p.id === id);
  if (!result) throw new Error('再生リストが見つかりません。');
  return result;
}
function Entry(data, playlistId, entryId) {
  const result = Playlist(data, playlistId).entries.find(e => e.id === entryId);
  if (!result) throw new Error('動画が見つかりません。');
  return result;
}
function NewPlaylist(ctx, name = 'お気に入り') {
  return { id: ctx.createId(), name: CleanText(name, 60) || '無題のリスト', icon: '', entries: [], childIds: [], createdAt: ctx.now(), lastAddedAt: '', includeInAll: true };
}
// idを親（parentId、なければ最上位）の子にする。move=trueなら元の親から外す。
function Parent(data, ctx, id, parentId, move) {
  Playlist(data, id); const parent = parentId ? Playlist(data, parentId) : null;
  if (!Tree.CanParent(data, id, parentId)) throw new Error('自分自身や子孫を親にはできません。');
  if (move) { data.rootPlaylistIds = data.rootPlaylistIds.filter(x => x !== id); for (const p of data.playlists) p.childIds = p.childIds.filter(x => x !== id); }
  const siblings = parent ? parent.childIds : data.rootPlaylistIds;
  if (!siblings.includes(id)) { siblings.push(id); if (parent) parent.lastAddedAt = ctx.now(); }
}
// 対象の操作なら実行してtrueを返す。それ以外（または対象のリストがない場合）はfalse（呼び出し側が別の処理・エラーにする）。
function Apply(data, action, ctx) {
  if (!action || typeof action !== 'object' || !TYPES.has(action.type)) return false;
  const p = action.playlistId ? Playlist(data, action.playlistId) : null;
  if (action.type === 'create') {
    ValidatePlaylistCount(data.playlists.length + 1);
    const parent = action.parentId ? Playlist(data, action.parentId) : null;
    const created = NewPlaylist(ctx, action.name); data.playlists.push(created);
    (parent ? parent.childIds : data.rootPlaylistIds).push(created.id);
    if (parent) parent.lastAddedAt = created.createdAt;
    if (action.select !== false) data.activePlaylistId = created.id;
    return true;
  }
  if (!p) return false;
  if (action.type === 'select') data.activePlaylistId = p.id;
  else if (action.type === 'rename') p.name = CleanText(action.name, 60) || p.name;
  else if (action.type === 'playlist-properties') {
    if (typeof action.includeInAll !== 'boolean') throw new Error('全体再生の設定が正しくありません。');
    p.name = CleanText(action.name, 60) || p.name; p.includeInAll = action.includeInAll;
    if (Object.hasOwn(action, 'icon')) p.icon = ValidateIcon(action.icon);
  } else if (action.type === 'delete') {
    if (data.playlists.length === 1) throw new Error('最後の再生リストは削除できません。');
    const parent = Tree.Parent(data, p.id);
    data.playlists = data.playlists.filter(x => x.id !== p.id);
    const promote = siblings => [...new Set(siblings.flatMap(id => id === p.id ? p.childIds : [id]))];
    data.rootPlaylistIds = promote(data.rootPlaylistIds);
    for (const list of data.playlists) list.childIds = promote(list.childIds);
    if (data.activePlaylistId === p.id) data.activePlaylistId = p.childIds[0] || parent || data.playlists[0].id;
  } else if (action.type === 'playlist-move') Parent(data, ctx, p.id, action.parentId || null, true);
  else if (action.type === 'playlist-attach') {
    if (!Array.isArray(action.ids) || !action.ids.length || action.ids.length > MAX_PLAYLISTS) throw new Error('取り込むプレイリストを選んでください。');
    const ids = [...new Set(action.ids)], descendants = new Set(ids.flatMap(id => Tree.RawWalk(data, [id]).slice(1).map(child => child.id)));
    for (const id of ids.filter(id => !descendants.has(id))) Parent(data, ctx, id, p.id, action.removeOriginal === true);
  } else if (action.type === 'playlist-reorder') {
    const siblings = action.parentId ? Playlist(data, action.parentId).childIds : data.rootPlaylistIds;
    if (!siblings.includes(p.id) || !siblings.includes(action.targetId)) throw new Error('同じ階層のリストを指定してください。');
    if (p.id !== action.targetId) { siblings.splice(siblings.indexOf(p.id), 1); siblings.splice(siblings.indexOf(action.targetId) + (action.after ? 1 : 0), 0, p.id); }
  } else if (action.type === 'remove') p.entries = p.entries.filter(e => e.id !== action.entryId);
  else if (action.type === 'title') Entry(data, p.id, action.entryId).title = ctx.cleanTitle(action.title);
  else if (action.type === 'move') {
    const index = p.entries.findIndex(e => e.id === action.entryId);
    const target = index + (action.direction === -1 ? -1 : 1);
    if (index >= 0 && target >= 0 && target < p.entries.length) [p.entries[index], p.entries[target]] = [p.entries[target], p.entries[index]];
  } else if (action.type === 'add-video') {
    // Bilibiliの動画1件を、このリストの末尾へ追加（iPhone版の「曲を追加」）。同じ動画（av/BVの別表記を含む）がこのリストにあれば追加しない。
    const item = ParseBilibili(action.url), keyOf = LibraryMediaKey(data.videoAliases || []);
    if (p.entries.some(e => keyOf(e) === keyOf(item))) throw new Error('この動画は、このリストにすでにあります。');
    if (data.playlists.reduce((n, q) => n + q.entries.length, 0) >= MAX_ENTRIES) throw new Error('登録数の上限は全リスト合計10000件です。');
    const duration = Number.isFinite(action.duration) && action.duration > 0 ? { duration: Math.min(action.duration, 604800) } : {};
    p.entries.push({ ...item, title: ctx.cleanTitle(action.title) || item.videoId, ...duration, id: ctx.createId(), addedAt: ctx.now() });
    p.lastAddedAt = ctx.now();
    // 新しい曲のメディア識別番号：同じ動画（av/BVの別表記を含む）が他のリストにあれば、その番号を再利用する（Windows版のSaveと同じ割り当て）
    for (const [entry, mediaId] of PlanMediaIds(data.playlists, ctx.createId, keyOf)) if (!Object.hasOwn(entry, 'mediaId')) entry.mediaId = mediaId;
  } else if (action.type === 'reorder') {
    const index = p.entries.findIndex(e => e.id === action.entryId);
    const target = p.entries.findIndex(e => e.id === action.targetId);
    if (index < 0 || target < 0) throw new Error('並べ替える動画が見つかりません。');
    if (index !== target) {
      const [entry] = p.entries.splice(index, 1);
      const insert = p.entries.findIndex(e => e.id === action.targetId) + (action.after === true ? 1 : 0);
      p.entries.splice(insert, 0, entry);
    }
  }
  return true;
}
module.exports = { TYPES, Apply, NewPlaylist, Parent, Playlist, Entry };
