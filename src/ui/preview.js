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
  // 同期設定の模擬（通信しない。画面の操作と状態表示の確認用）。
  const demoSync = { url: '', enabled: false, configured: false, signedIn: false, email: '', encryption: true, state: 'off', error: '', lastSyncAt: 0, pending: 0, conflicts: 0 };
  const syncApi = async command => {
    if (command.action === 'configure') { if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(command.url || '')) throw new Error('SupabaseのURLが正しくありません。'); Object.assign(demoSync, { url: command.url, configured: true }); }
    else if (command.action === 'send-code') { if (!demoSync.configured) throw new Error('先に接続先を保存してください。'); demoSync.email = command.email; }
    else if (command.action === 'verify') { if (command.code !== '123456') throw new Error('コードが正しくないか、期限が切れています。（模擬：123456）'); demoSync.signedIn = true; }
    else if (command.action === 'sign-out') demoSync.signedIn = false;
    else if (command.action === 'enable') Object.assign(demoSync, { enabled: true, state: 'idle', lastSyncAt: Date.now() });
    else if (command.action === 'unblock') Object.assign(demoSync, { state: 'idle', canUnblock: false })
    else if (command.action === 'reset') Object.assign(demoSync, { enabled: false, state: 'off', signedIn: false });
    else if (command.action === 'disable') Object.assign(demoSync, { enabled: false, state: 'off' });
    else if (command.action === 'now') demoSync.lastSyncAt = Date.now();
    return { ...demoSync };
  };
  window.favecusApp = { sync: syncApi, state: () => send('state'), action: action => send('action', action), entryThumbnail: async (playlistId, entryId, scope, variant) => Thumbnail(entryId, variant), accounts: async () => ({}), speed: async value => { listeners.forEach(cb => cb({ type: 'speed', value })); return value; }, bounds: () => {}, onEvent: cb => { listeners.add(cb); return () => listeners.delete(cb); } };
  for (const name of ['videoFullscreen', 'resetPlayCounts', 'shortcut', 'downloads', 'downloadPlaylist', 'cancelDownload', 'downloadDirectory', 'openDownloads', 'preferSaved', 'addFiles', 'prepareAdd', 'prepareFiles', 'commitAdd', 'cancelAdd', 'importLibrary', 'exportLibrary', 'play', 'shufflePlay', 'browseBilibili', 'command', 'openOfficial', 'help', 'discordPortal', 'login', 'favoriteFolders', 'favoriteVideos', 'playlistSources', 'playlistVideos', 'playlistParts', 'volume', 'mini']) window.favecusApp[name] = () => { throw new Error('この操作はデスクトップ版で使用できます。'); };
}
