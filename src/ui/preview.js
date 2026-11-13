'use strict';
// 開発用HTTPプレビューでのみ、同じ保存処理をローカルサーバーへ接続する。
if (!window.favecusApp && location.hostname === '127.0.0.1' && location.search === '?preview=1') {
  const note = document.createElement('div'); note.className = 'preview-note'; note.textContent = '開発用プレビュー：動画再生・Discord接続はデスクトップ版で使用'; document.body.append(note);
  const listeners = new Set();
  // 模擬のサムネイル（実機と同じ128x72以内のPNG）。実際の動画画像は取得しない。
  const Thumbnail = (id, variant) => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; const canvas = document.createElement('canvas'); const cover = variant === 'cover'; canvas.width = cover ? 300 : 128; canvas.height = cover ? 300 : 72; const g = canvas.getContext('2d'), hue = h % 360;
    const gradient = g.createLinearGradient(0, 0, canvas.width, canvas.height); gradient.addColorStop(0, `hsl(${hue} 70% 55%)`); gradient.addColorStop(1, `hsl(${(hue + 60) % 360} 70% 35%)`); g.fillStyle = gradient; g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#ffffff55'; g.font = cover ? 'bold 52px sans-serif' : 'bold 22px sans-serif'; g.fillText('PREVIEW', cover ? 30 : 14, cover ? 160 : 42); return canvas.toDataURL(cover ? 'image/jpeg' : 'image/png', 0.85); };
  const send = async (name, ...args) => {
    const response = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args }) });
    const result = await response.json(); if (!result.ok) throw new Error(result.error); return result.value;
  };
  // デスクトップ版は前面表示の状態を通知する。プレビューでは表示中を前面として通知し、サムネイルの取得を有効にする。
  const announce = () => listeners.forEach(cb => cb({ type: 'foreground', value: document.visibilityState === 'visible' }));
  setTimeout(announce, 300); document.addEventListener('visibilitychange', announce);
  window.favecusApp = { state: () => send('state'), action: action => send('action', action), entryThumbnail: async (playlistId, entryId, scope, variant) => Thumbnail(entryId, variant), accounts: async () => ({}), bounds: () => {}, onEvent: cb => { listeners.add(cb); return () => listeners.delete(cb); } };
  for (const name of ['resetPlayCounts', 'shortcut', 'downloads', 'downloadPlaylist', 'cancelDownload', 'downloadDirectory', 'openDownloads', 'preferSaved', 'addFiles', 'prepareAdd', 'prepareFiles', 'commitAdd', 'cancelAdd', 'importLibrary', 'exportLibrary', 'play', 'shufflePlay', 'browseBilibili', 'command', 'openOfficial', 'help', 'discordPortal', 'login', 'favoriteFolders', 'favoriteVideos', 'playlistSources', 'playlistVideos', 'playlistParts', 'volume', 'mini']) window.favecusApp[name] = () => { throw new Error('この操作はデスクトップ版で使用できます。'); };
}
