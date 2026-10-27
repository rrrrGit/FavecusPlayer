'use strict';
// 開発用HTTPプレビューでのみ、同じ保存処理をローカルサーバーへ接続する。
if (!window.favecusApp && location.hostname === '127.0.0.1' && location.search === '?preview=1') {
  const note = document.createElement('div'); note.className = 'preview-note'; note.textContent = '開発用プレビュー：動画再生・Discord接続はデスクトップ版で使用'; document.body.append(note);
  const listeners = new Set();
  const send = async (name, ...args) => {
    const response = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args }) });
    const result = await response.json(); if (!result.ok) throw new Error(result.error); return result.value;
  };
  window.favecusApp = { state: () => send('state'), action: action => send('action', action), entryThumbnail: async () => null, accounts: async () => ({}), bounds: () => {}, onEvent: cb => { listeners.add(cb); return () => listeners.delete(cb); } };
  for (const name of ['choosePlaylistIcon', 'resetPlayCounts', 'shortcut', 'downloads', 'downloadPlaylist', 'cancelDownload', 'downloadDirectory', 'openDownloads', 'preferSaved', 'addFiles', 'prepareAdd', 'prepareFiles', 'commitAdd', 'cancelAdd', 'importLibrary', 'exportLibrary', 'play', 'shufflePlay', 'browseBilibili', 'command', 'openOfficial', 'help', 'discordPortal', 'login', 'favoriteFolders', 'favoriteVideos', 'playlistSources', 'playlistVideos', 'playlistParts', 'volume', 'mini']) window.favecusApp[name] = () => { throw new Error('この操作はデスクトップ版で使用できます。'); };
}
