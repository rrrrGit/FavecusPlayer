'use strict';
// 同期後の表示（view）を、端末のライブラリへ合成する規則（端末APIなし。Windows版・iPhone版で共通）。
// 同期しない端末固有の情報（アイコン、ローカルファイルの名前、既存のmediaId、設定、選択中のリスト）は、受信の反映でも保持する。
const { LibraryMediaKey, VideoAliases } = require('./library-identity.cjs');
const { DerivedId } = require('./sync-library.cjs');

// 同期の導出に渡す文脈：ローカルファイルの曲は、この端末に既にあるファイル名を使い、同じ動画は既存のmediaIdを共有する。
function ContextOf(library) {
  const files = new Map(), media = new Map(), keyOf = LibraryMediaKey(VideoAliases(library.videoAliases || []));
  for (const p of library.playlists) for (const e of p.entries) {
    if (e.type === 'local') files.set(e.id, e.fileName);
    if (e.mediaId && !media.has(keyOf(e))) media.set(keyOf(e), e.mediaId);
  }
  return { localFileName: (id, ext) => files.get(id) || `${id}${ext}`, mediaIdFor: key => media.get(key) || DerivedId(`media:${key}`) };
}
// current：端末のライブラリ（playlists・rootPlaylistIds・videoAliases）、view：同期後の表示。
// 戻り値：{ changed, next }（nextは検証前。呼び出し側がValidateLibraryを通してから保存する）。
function MergeView(current, view) {
  const byList = new Map(current.playlists.map(p => [p.id, p])), byEntry = new Map();
  for (const p of current.playlists) for (const e of p.entries) byEntry.set(e.id, e);
  const playlists = view.playlists.map(v => {
    const old = byList.get(v.id);
    return { ...(old || {}), ...v, icon: old ? old.icon : v.icon, lastAddedAt: old?.lastAddedAt || v.lastAddedAt, entries: v.entries.map(e => {
      const prior = byEntry.get(e.id);
      if (!prior) return e;
      return { ...prior, ...e, ...(e.type === 'local' && prior.type === 'local' ? { fileName: prior.fileName } : {}), mediaId: prior.mediaId || e.mediaId };
    }) };
  });
  const next = { videoAliases: view.videoAliases, rootPlaylistIds: view.rootPlaylistIds, playlists };
  const keys = ['videoAliases', 'rootPlaylistIds', 'playlists'];
  const changed = JSON.stringify(keys.map(k => current[k] || [])) !== JSON.stringify(keys.map(k => next[k]));
  return { changed, next };
}
// 検証済みのリスト（checked）から、保存するライブラリを作る（選択中のリストは、残っていれば保持）。
function Compose(current, next, checked) {
  const roots = next.rootPlaylistIds, active = checked.some(p => p.id === current.activePlaylistId) ? current.activePlaylistId : (roots[0] || checked[0].id);
  return { ...current, identityVersion: 2, videoAliases: next.videoAliases, rootPlaylistIds: roots, playlists: checked, activePlaylistId: active };
}
module.exports = { ContextOf, MergeView, Compose };
