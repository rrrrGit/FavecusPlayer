'use strict';
// IPC：自動リスト・お気に入り・最近削除
// main.cjs から分けたもの（動作は同じ）。状態（store・current など）は、ctx 経由で、その都度読む（S.store など）。
module.exports = function RegisterLists(ctx) {
  const S = ctx;
  const { AutoEntries, AutoPlay, BuildAutoLists, Emit, FavoriteIds, Handle } = ctx;
  Handle('library:auto-list', kind => {
    if (!kind) { const lists = BuildAutoLists(); return { frequent: lists.frequent.length, recent: lists.recent.length, unplayed: lists.unplayed.length, favorites: lists.favorites.length }; }
    return AutoEntries(kind).map(e => ({ id: e.id, playlistId: e.playlistId, title: e.title || e.videoId || 'ローカルファイル', type: e.type, count: S.playCounts?.Count(e) || 0 }));
  });
  Handle('player:auto-play', (kind, entryId, shuffled) => AutoPlay(kind, typeof entryId === 'string' ? entryId : null, shuffled === true));
  // 最近削除（一覧・元に戻す・完全に削除）。元に戻すのは共通の規則（core/trash.cjs）。失敗したときは、保管を残して、理由を返す。
  // お気に入り：曲のメディア単位（同じ動画・パートは、どのリストにあっても共通）。この端末内だけ（同期しない）。
  Handle('library:favorite', (playlistId, entryId, value) => {
    const entry = S.store.Entry(String(playlistId), String(entryId)), key = S.playCounts?.KeyOf(entry);
    S.favorites.Set(key, value === true);
    const ids = FavoriteIds(); Emit('favorites', ids); return ids;
  });
  Handle('trash:list', () => { const list = S.trashStore.List(); if (S.trashStore.TakePruned()) S.offline?.ScheduleCleanup(); return list; });
  Handle('trash:restore', id => {
    const item = S.trashStore.Get(String(id));
    if (!item) throw new Error('この項目は、すでに保管の期限が切れたか、なくなっています。');
    const state = S.store.Apply({ type: 'restore', item });
    S.trashStore.Remove(item.id); Emit('state', state);
    return S.trashStore.List();
  });
  Handle('trash:delete', id => { S.trashStore.Remove(String(id)); S.offline?.ScheduleCleanup(); return S.trashStore.List(); }); // 完全に削除したあと、参照のなくなった保存済みメディアを整理する
  Handle('trash:clear', () => { S.trashStore.Clear(); S.offline?.ScheduleCleanup(); return []; });
};
