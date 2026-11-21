'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args).then(result => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
});
contextBridge.exposeInMainWorld('favecusApp', {
  state: invoke('app:state'), action: invoke('library:action'), addFiles: invoke('library:files'),
  entryThumbnail: invoke('library:thumbnail'), videoFullscreen: invoke('player:fullscreen'), resetPlayCounts: invoke('player:reset-counts'),
  openRelease: invoke('app:release-open'), downloads: invoke('downloads:state'), estimateDownload: invoke('downloads:estimate'), cancelDownloadEstimate: invoke('downloads:estimate-cancel'), downloadPlaylist: invoke('downloads:start'), cancelDownload: invoke('downloads:cancel'), downloadDirectory: invoke('downloads:directory'), openDownloads: invoke('downloads:open'), preferSaved: invoke('downloads:prefer'),
  importLibrary: invoke('library:import'), exportLibrary: invoke('library:export'),
  resolveURL: invoke('bilibili:resolve'), entryDuration: invoke('library:duration'), playEverything: invoke('player:all'),
  moveTracks: invoke('library:move-tracks'), commitImport: invoke('library:import-commit'), cancelImport: invoke('library:import-cancel'),
  transferEntry: invoke('library:transfer'),
  prepareAdd: invoke('library:prepare-add'), prepareFiles: invoke('library:prepare-files'),
  commitAdd: invoke('library:commit-add'), cancelAdd: invoke('library:cancel-add'),
  shortcut: invoke('player:shortcut'), play: invoke('player:play'), shufflePlay: invoke('player:shuffle'), command: invoke('player:command'), volume: invoke('player:volume'), sleepTimer: invoke('player:sleep'), speed: invoke('player:speed'), listViewSet: invoke('list:view-set'), audit: invoke('library:audit'), favoriteMany: invoke('library:favorite-many'), saveSelected: invoke('downloads:save-selected'), autoListSettings: invoke('autolist:settings'), clearHistory: invoke('history:clear'), stats: invoke('stats:get'), listStats: invoke('list:stats'), queueReorder: invoke('queue:reorder'), queueJump: invoke('queue:jump'), queueInsert: invoke('queue:insert'), resumeLast: invoke('player:resume-last'), favorite: invoke('library:favorite'), trashList: invoke('trash:list'), trashRestore: invoke('trash:restore'), trashDelete: invoke('trash:delete'), trashClear: invoke('trash:clear'), autoList: invoke('library:auto-list'), autoPlay: invoke('player:auto-play'), mini: invoke('window:mini'),
  openOfficial: invoke('player:official'), help: invoke('app:help'), discordPortal: invoke('app:discord-portal'),
  discordGuide: invoke('app:discord-guide'), discordImage: invoke('app:discord-image'),
  taskbarLog: invoke('app:taskbar-log'),
  taskbarGuide: invoke('app:taskbar-guide'),
  accounts: invoke('account:status'), login: invoke('account:open'), sync: invoke('sync:run'),
  browseBilibili: invoke('bilibili:browse'),
  favoriteFolders: invoke('account:folders'), favoriteVideos: invoke('account:videos'),
  playlistSources: invoke('bilibili:lists'), playlistVideos: invoke('bilibili:list-videos'), playlistParts: invoke('bilibili:parts'),
  bounds: value => ipcRenderer.send('view:bounds', value),
  onEvent: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('app:event', listener); return () => ipcRenderer.removeListener('app:event', listener); }
});
