'use strict';
// 最近削除（v0.7.3 F4）：プレイリストの削除・曲の「このリストから外す」を、30日間、端末内に保管して、元に戻せるようにする。規則は、PC版・iPhone版で共通。
// ・保管は端末内だけ（同期しない）。復元は、同じIDで戻す（同期は、同じIDの再登録を、新しい登録として扱うため、他の端末にも戻る）。
// ・プレイリストは複数の親を持てるため、削除の前後の「親ごとの子の並び」を記録する。
// ・復元は、全部成功か何もしない（呼び出し側が、失敗したときに元の状態へ戻す）。同じIDがすでにある場合などは、理由を出して復元しない。
const Tree = require('../ui/library-tree.js');
const { MAX_ENTRIES, ValidatePlaylistCount } = require('./library-data.cjs');
const { LibraryMediaKey } = require('./library-identity.cjs');

const RETENTION_DAYS = 30;
const MAX_ITEMS = 200;
const UUID = /^[a-f0-9-]{36}$/;
const KINDS = ['playlist', 'entry'];

const Clone = value => JSON.parse(JSON.stringify(value));
const Same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const ListOf = (library, parentId) => (parentId === null ? library.rootPlaylistIds : (library.playlists.find(p => p.id === parentId)?.childIds || null));
const Text = value => typeof value === 'string' && value.length > 0 && value.length <= 400;

// 削除の前後のライブラリから、保管する内容を作る。対象外の操作・対象がない場合は null。
function Capture(before, after, action, now) {
  if (!before || !after || !action || typeof now !== 'string') return null;
  const list = before.playlists.find(p => p.id === action.playlistId);
  if (!list) return null;
  if (action.type === 'remove') {
    const index = list.entries.findIndex(e => e.id === action.entryId);
    if (index < 0) return null;
    const entry = Clone(list.entries[index]);
    return { id: `${now}-${entry.id}`, kind: 'entry', deletedAt: now, playlistId: list.id, index, entry, label: `曲「${entry.title || entry.videoId || 'ローカルファイル'}」（${list.name}）` };
  }
  if (action.type === 'delete') {
    if (after.playlists.some(p => p.id === list.id)) return null; // 実際には削除されていない
    const parents = [];
    if (before.rootPlaylistIds.includes(list.id)) parents.push(null);
    for (const other of before.playlists) if (other.id !== list.id && other.childIds.includes(list.id)) parents.push(other.id);
    const changes = parents.map(parentId => ({ parentId, before: [...ListOf(before, parentId)], after: [...(ListOf(after, parentId) || [])] }));
    return { id: `${now}-${list.id}`, kind: 'playlist', deletedAt: now, playlist: Clone(list), position: before.playlists.findIndex(p => p.id === list.id), changes, label: `プレイリスト「${list.name}」（${list.entries.length}曲）` };
  }
  return null;
}

// 複数の曲を外した操作（remove-many）は、曲ごとの保管（単独の remove と同じ形）に分ける。それ以外は、Capture の1件。
function CaptureMany(before, after, action, now) {
  if (action && action.type === 'remove-many' && Array.isArray(action.entryIds)) {
    const items = [];
    for (const entryId of new Set(action.entryIds)) { const item = Capture(before, after, { type: 'remove', playlistId: action.playlistId, entryId }, now); if (item) items.push(item); }
    return items;
  }
  const one = Capture(before, after, action, now);
  return one ? [one] : [];
}

// 保管ファイルは外部入力として扱い、形を検証する（壊れたものは、使わない）。
function ValidItem(item) {
  try {
    if (!item || typeof item !== 'object' || !KINDS.includes(item.kind) || !Text(item.id) || !Text(item.label) || !Number.isFinite(Date.parse(item.deletedAt))) return false;
    const entryOk = e => e && typeof e === 'object' && typeof e.id === 'string' && UUID.test(e.id) && ['bilibili', 'local'].includes(e.type) && typeof e.title === 'string';
    if (item.kind === 'entry') return typeof item.playlistId === 'string' && UUID.test(item.playlistId) && Number.isInteger(item.index) && item.index >= 0 && entryOk(item.entry);
    const p = item.playlist;
    if (!p || typeof p.id !== 'string' || !UUID.test(p.id) || typeof p.name !== 'string' || !Array.isArray(p.entries) || p.entries.length > MAX_ENTRIES || !Array.isArray(p.childIds) || !p.childIds.every(id => typeof id === 'string' && UUID.test(id))) return false;
    if (!Number.isInteger(item.position) || item.position < 0 || !p.entries.every(entryOk) || !Array.isArray(item.changes) || item.changes.length > 64) return false;
    const ids = list => Array.isArray(list) && list.length <= 20000 && list.every(id => typeof id === 'string' && UUID.test(id));
    return item.changes.every(c => c && (c.parentId === null || (typeof c.parentId === 'string' && UUID.test(c.parentId))) && ids(c.before) && ids(c.after));
  } catch { return false; }
}

// 元に戻す。library をその場で書き換える（失敗したときは、例外を投げる。呼び出し側が、操作前の状態へ戻す）。
function Restore(library, item) {
  if (!ValidItem(item)) throw new Error('保管されたデータが正しくないため、元に戻せません。');
  const keyOf = LibraryMediaKey(library.videoAliases || []);
  const allEntries = () => library.playlists.flatMap(p => p.entries);
  if (item.kind === 'entry') {
    const list = library.playlists.find(p => p.id === item.playlistId);
    if (!list) throw new Error('元のプレイリストがないため、曲を戻せません。先にプレイリストを戻してください。');
    if (allEntries().some(e => e.id === item.entry.id)) throw new Error('この曲は、すでに戻っています。');
    if (list.entries.some(e => keyOf(e) === keyOf(item.entry))) throw new Error('同じ動画が、そのプレイリストにすでにあります。');
    if (allEntries().length + 1 > MAX_ENTRIES) throw new Error('登録数の上限は全リスト合計10000件です。');
    list.entries.splice(Math.min(item.index, list.entries.length), 0, Clone(item.entry));
    return;
  }
  const saved = Clone(item.playlist);
  if (library.playlists.some(p => p.id === saved.id)) throw new Error('このプレイリストは、すでに戻っています。');
  const existing = new Set(allEntries().map(e => e.id));
  if (saved.entries.some(e => existing.has(e.id))) throw new Error('このプレイリストの曲が、すでに別の場所にあるため、戻せません。');
  if (allEntries().length + saved.entries.length > MAX_ENTRIES) throw new Error('登録数の上限は全リスト合計10000件です。');
  ValidatePlaylistCount(library.playlists.length + 1);
  const exists = id => library.playlists.some(p => p.id === id);
  const taken = new Set();
  let placed = false;
  for (const change of item.changes) {
    const current = ListOf(library, change.parentId);
    if (!current) continue; // 元の親が、もうない
    if (Same(current, change.after)) {
      // 削除の直後のまま：元の並びへ戻す（いまもあるものだけ）
      for (const child of saved.childIds) if (change.after.includes(child)) taken.add(child);
      current.splice(0, current.length, ...change.before.filter(id => id === saved.id || exists(id)));
    } else {
      // そのあとに変更されている：削除で繰り上がった子のうち、いま、この親にいるものだけを取り戻し、元の位置へ入れる
      for (const child of saved.childIds) {
        const at = current.indexOf(child);
        if (at >= 0 && change.after.includes(child)) { current.splice(at, 1); taken.add(child); }
      }
      if (!current.includes(saved.id)) current.splice(Math.min(change.before.indexOf(saved.id), current.length), 0, saved.id);
    }
    placed = true;
  }
  if (!placed) library.rootPlaylistIds.push(saved.id); // 元の親が、すべてない：最上位へ
  saved.childIds = saved.childIds.filter(id => taken.has(id) && exists(id));
  library.playlists.splice(Math.min(item.position, library.playlists.length), 0, saved); // 配列の元の位置へ
  Tree.ValidateGraph(library.playlists, library.rootPlaylistIds);
}

// 保管の期限（30日）・件数（200件）で整理する。新しいものを残す。
function Prune(items, now) {
  const limit = Date.parse(now) - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return items.filter(item => Date.parse(item.deletedAt) > limit).sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt)).slice(0, MAX_ITEMS);
}

// 画面に出す一覧用の要約（残り日数つき）。
function Summary(item, now) {
  const left = Math.max(0, Math.ceil((Date.parse(item.deletedAt) + RETENTION_DAYS * 24 * 60 * 60 * 1000 - Date.parse(now)) / (24 * 60 * 60 * 1000)));
  return { id: item.id, kind: item.kind, label: item.label, deletedAt: item.deletedAt, daysLeft: left };
}

module.exports = { Capture, CaptureMany, Restore, ValidItem, Prune, Summary, RETENTION_DAYS, MAX_ITEMS };
