'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, session, protocol, net, Menu, nativeImage, crashReporter } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const { Store, MEDIA_NAME } = require('./core/store.cjs');
const { LocalDuration } = require('./core/media-duration.cjs');
const { LibraryArchive } = require('./core/library-archive.cjs');
const { Queue } = require('./core/queue.cjs');
const { PlayCounts } = require('./core/play-counts.cjs');
const { ReadIcon } = require('./core/playlist-icon.cjs');
const Keys = require('./ui/keybindings.js');
const { DriveURL } = require('./core/releases.cjs');
const { OfflineLibrary } = require('./core/offline-library.cjs');
const { DownloadFetch } = require('./core/download-fetch.cjs');
const { BackgroundMode } = require('./core/background-mode.cjs');
const { AdditionReview } = require('./core/addition-review.cjs');
const { BilibiliBrowser } = require('./core/bilibili-browser.cjs');
const { PlayerRecovery } = require('./core/player-recovery.cjs');
const { StartCrashDiagnostics } = require('./core/crash-diagnostics.cjs');
const { MediaChannel } = require('./core/media-channel.cjs');
const { PlayerURL, ParseBilibili, IsAllowedRemote, MEDIA_EXTENSIONS } = require('./core/urls.cjs');
const { SameVideo } = require('./core/media-identity.cjs');
const { DiscordPresence, BuildActivity } = require('./core/discord.cjs');
const { NormalizeMedia } = require('./core/playback.cjs');
const { MiniPlayer } = require('./core/mini-player.cjs');
const { MediaResponse } = require('./core/files.cjs');
const { ConvertWma } = require('./core/audio-import.cjs');
const { BilibiliAccount } = require('./core/bilibili.cjs');
const { Thumbnails, SmallImage } = require('./core/thumbnail.cjs');
const { APP_ID, ConfigureTaskbar, PreviousInstallRoots } = require('./core/windows-identity.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'favecus', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.setName('Favecus Player');
const isSmoke = process.argv.includes('--smoke-test');
const dataDirectory = isSmoke && process.env.FAVECUS_TEST_DIRECTORY ? process.env.FAVECUS_TEST_DIRECTORY : require('./core/data-migration.cjs').PrepareDataDirectory(app.getPath('appData'));
app.setPath('userData', dataDirectory);
app.setPath('sessionData', dataDirectory);
let win, store, presence, remoteView, mini, volumeSaveTimer, backgroundMode;
let viewVisible = false;
let current = null, playback = null;
let thumbnails, thumbnail = null;
let visibleBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
let statuses = { discord: { code: 'off', text: 'Discord連携はオフです' }, taskbar: { code: 'off', text: '下向き矢印を押すと埋め込みを試します' } };
let playCounts;
const ShuffleWeight = entry => store?.data.settings.weightedShuffle === false ? 1 : 1 / (1 + (playCounts?.Count(entry) || 0));
let queue = new Queue(null, ShuffleWeight);
const playbackMetadata = new Map(), metadataPending = new Map(), officialPreferred = new Set();
let generation = 0, loadRequest = 0, lastPlayerCommand = null, nativeDiagnostics;
let biliAccount, additionReview, biliBrowser, recovery, archive, helpWindow, offline;
let accountRefresh = null, accountStatus = {}, accountCheckedAt = 0;
const accountWindows = new Map();
const mediaChannels = new WeakMap();
const Emit = (type, value) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('app:event', { type, value });
    if (store && ['state', 'current', 'current-update'].includes(type)) win.webContents.send('app:event', { type: 'queue', value: QueueState() });
  }
  mini?.Update();
};
function QueueState() {
  if (!current?.playlistId) return null;
  const scope = queue.playlistId, entries = store.Entries(scope), nextId = queue.Peek(store.data.settings.repeat);
  const next = entries.find(entry => entry.id === nextId);
  const timeline = queue.Timeline(store.data.settings.repeat);
  const byId = new Map(entries.map(e => [e.id, e]));
  const describe = id => { const e = byId.get(id) || queue.catalog.get(id); return e ? { id, playlistId: e.playlistId, title: e.title || e.videoId || 'ローカルファイル' } : { id, title: '一覧から削除された曲' }; };
  return { playlistId: scope, name: scope === '*' ? '全プレイリスト' : store.Playlist(scope).name, shuffle: queue.shuffle, repeat: store.data.settings.repeat,
    timeline: { history: timeline.history.map(describe), current: timeline.current ? describe(timeline.current) : null, upcoming: timeline.upcoming.map(describe) },
    next: next ? { id: next.id, playlistId: next.playlistId, title: next.title || next.videoId || 'ローカルファイル', index: entries.indexOf(next) + 1 } : null };
}
function Foreground() { return !!win && !win.isDestroyed() && win.isFocused?.() !== false && win.isVisible?.() !== false && !win.isMinimized?.(); }
function UpdateForeground(value = Foreground()) { backgroundMode?.SetForeground(value); Emit('foreground', value); SyncShortcuts(); }
function LivePlayer() { const wc = remoteView?.webContents; return wc && !wc.isDestroyed() ? wc : null; }
function SendToPlayer(channel, value) {
  if (!remoteView?.navigationReady) return false;
  const wc = LivePlayer(); return !!wc && !!mediaChannels.get(wc)?.Send(channel, value);
}
function SuspendPlayer() {
  if (!remoteView) return;
  remoteView.navigationReady = false;
  const wc = remoteView.webContents;
  if (wc) mediaChannels.get(wc)?.Suspend();
}
function SyncShortcuts() { SendToPlayer('media:shortcuts', { bindings: store?.data.settings.keybindings, enabled: Foreground() && !visibleBounds.modalOpen }); }
function DownloadDiagnosticLog(record) {
  try {
    const directory = process.env.FAVECUS_INSTALL_ROOT ? path.join(process.env.FAVECUS_INSTALL_ROOT, 'runtime/logs') : app.getPath('userData');
    fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'download-diagnostics.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.previous`);
    fs.appendFileSync(file, JSON.stringify({ version: app.getVersion(), ...record }) + '\n');
  } catch {}
}
function PlayerDiagnostic(reason, details = {}) {
  try {
    nativeDiagnostics?.Annotate({ event: reason, generation, source: current?.source, video: current?.entry.videoId, part: current?.entry.part, command: lastPlayerCommand });
    const memory = process.memoryUsage?.();
    const logs = process.env.FAVECUS_INSTALL_ROOT ? path.join(process.env.FAVECUS_INSTALL_ROOT, 'runtime/logs') : app.getPath('userData');
    fs.mkdirSync(logs, { recursive: true }); const file = path.join(logs, 'player-diagnostics.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), version: app.getVersion(), runId: process.env.FAVECUS_RUN_ID || null, eventCode: `FP-PLAYER-${reason.toUpperCase()}`, reason, generation, source: current?.source, saved: !!current?.offline, lastCommand: lastPlayerCommand, attempt: current?.recoveryAttempt || 0, videoId: current?.entry.videoId, part: current?.entry.part, official: !!current?.officialPlayer, memory, ...details }) + '\n');
  } catch {}
}
function TrustedMediaEvent(event) {
  try { const wc = LivePlayer(); return !!wc && remoteView.navigationReady && !!current && event.sender === wc && event.senderFrame === wc.mainFrame; } catch { return false; }
}
async function Shortcut(input) {
  if (!Foreground() || visibleBounds.modalOpen) return false;
  const action = Keys.Action(store.data.settings.keybindings, input); if (!action) return false;
  if (action === 'volumeUp' || action === 'volumeDown') await ChangeVolume(Math.round((store.data.settings.volume + (action === 'volumeUp' ? .02 : -.02)) * 100) / 100);
  else if (action === 'toggle' && !current && input.scope === '*') await AllPlay(false);
  else { if (['next', 'previous', 'toggle'].includes(action)) Emit('shortcut-follow', true); await Command({ forward: 'forward-ten', backward: 'back-ten' }[action] || action); }
  return true;
}

const Notify = text => Emit('notice', text);
function Status(kind, code, text) { statuses[kind] = { code, text }; Emit('status', statuses); }
function ViewBounds() {
  if (!LivePlayer() || !win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const b = visibleBounds;
  const x = Math.min(width, Math.max(0, Math.ceil(b.x))), y = Math.min(height, Math.max(0, Math.ceil(b.y)));
  const bounds = { x, y, width: Math.max(0, Math.min(width, Math.floor(b.x + b.width)) - x), height: Math.max(0, Math.min(height, Math.floor(b.y + b.height)) - y) };
  const visible = !!b.visible && !store?.data.settings.thumbnailMode && current?.offline?.kind !== 'audio' && bounds.width > 0 && bounds.height > 0;
  remoteView.setBounds(bounds); remoteView.setVisible(visible);
  if (visible && !viewVisible) RefreshVideo();
  viewVisible = visible;
}
function RefreshVideo() {
  const wc = remoteView?.webContents;
  if (!remoteView?.navigationReady || !wc || wc.isDestroyed() || store?.data.settings.thumbnailMode) return;
  wc.invalidate?.(); SendToPlayer('media:command', { type: 'refresh-display' });
}
const retiredPlayers = new Map(); let quitting = false;
function DisposePlayer(view) {
  const retired = retiredPlayers.get(view);
  if (!retired || retired.closing) return;
  clearImmediate(retired.timer); retired.closing = true;
  const wc = retired.contents;
  try { if (win && !win.isDestroyed()) win.contentView.removeChildView(view); } catch (error) { PlayerDiagnostic('detach-failed', { message: error.message }); }
  try { if (wc && !wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }); }
  catch (error) { retired.closing = false; PlayerDiagnostic('close-failed', { message: error.message }); }
  // close中にview.webContentsが消えるため、取得済みの参照だけを使う。
  if (!wc || wc.isDestroyed()) retiredPlayers.delete(view);
}
function CloseView() {
  generation++; viewVisible = false; recovery?.Cancel();
  const old = remoteView; remoteView = null;
  if (!old) return;
  old.navigationReady = false;
  const wc = old.webContents;
  if (wc && !wc.isDestroyed()) {
    mediaChannels.get(wc)?.Suspend();
    try { wc.setAudioMuted(true); } catch {}
  }
  // Viewの切り離しもIPC・終了イベントから抜けた後に行う。
  retiredPlayers.set(old, { contents: wc, closing: false, timer: quitting ? null : setImmediate(() => DisposePlayer(old)) });
  if (quitting) DisposePlayer(old);
}
function UpdatePresence() {
  const internal = playback && Date.now() - playback.receivedAt < 15000 ? playback : null;
  const entry = current?.entry, details = entry?.type === 'bilibili' ? playbackMetadata.get(entry.videoId) : null;
  presence?.SetActivity(BuildActivity(internal ? { ...internal, source: entry?.type || internal.source, thumbnailURL: store.data.settings.discordThumbnail ? details?.pic || (current.offline && offline?.File(current.offline.token)?.thumbnailURL) : null, videoURL: store.data.settings.discordVideoLink && entry?.type === 'bilibili' ? entry.url : null } : null, store.data.settings.hideWhenPaused, Date.now(), store.data.settings.discordImageKey, store.data.settings.discordThumbnailSize));
}
async function LoadThumbnail() {
  if (!current || (!store.data.settings.thumbnailMode && current.offline?.kind !== 'audio') || !thumbnails) return;
  if (current.offline) { thumbnail = { entryId: current.entryId, image: offline?.Cover(current.offline.token), pending: false }; Emit('thumbnail', thumbnail); return; }
  const gen = generation;
  thumbnail = { entryId: current.entryId, image: null, pending: true }; Emit('thumbnail', thumbnail);
  const active = () => !!current && generation === gen && store.data.settings.thumbnailMode;
  const image = await thumbnails.Get(current.entry, active);
  if (!active()) return;
  thumbnail = { entryId: current.entryId, image, pending: false }; Emit('thumbnail', thumbnail);
}
function AcceptPlayback(data) {
  playback = data; playCounts?.Observe(data); Emit('playback', data); UpdatePresence();
  if (current?.officialPlayer && !data.paused && data.position >= 3) { officialPreferred.add(current.entry.videoId); const season = playbackMetadata.get(current.entry.videoId)?.ugc_season?.id; if (season) officialPreferred.add(`season:${season}`); if (officialPreferred.size > 1000) officialPreferred.delete(officialPreferred.values().next().value); }
}
function StopPlayer() {
  loadRequest++;
  CloseView(); current = null; playback = null; thumbnail = null; queue.Clear();
  Emit('current', null); Emit('playback', null); UpdatePresence(); backgroundMode?.Refresh();
}
function SetVolume() {
  const volume = store.data.settings.volume; biliBrowser?.SetVolume(volume);
  for (const wc of [remoteView?.webContents, ...[...accountWindows.values()].map(w => w.webContents)].filter(Boolean)) {
    if (!wc.isDestroyed()) {
      const channel = mediaChannels.get(wc);
      wc.setAudioMuted(volume === 0 || !channel?.ready);
      channel?.Send('media:command', { type: 'volume', value: volume });
    }
  }
}
function ChangeVolume(value) {
  if (!Number.isFinite(value)) throw new Error('音量の値が正しくありません。');
  store.data.settings.volume = Math.max(0, Math.min(1, value));
  SetVolume(); Emit('volume', store.data.settings.volume);
  clearTimeout(volumeSaveTimer);
  volumeSaveTimer = setTimeout(() => { volumeSaveTimer = null; try { store.Save(); } catch (error) { Notify(`音量を保存できません: ${error.message}`); } }, 150);
  return store.data.settings.volume;
}
function MiniState() {
  const list = store?.data.playlists.find(p => p.id === store.data.activePlaylistId);
  return { title: playback?.title || current?.entry?.title || current?.entry?.videoId || list?.name || 'Favecus Player',
    artist: current ? (playback?.artist || (current.source === 'local' ? 'ローカルファイル' : 'Bilibili')) : '動画を選んで再生',
    paused: playback?.paused !== false, canToggle: !!current || !!(list && store.Entries(list.id).length), canStop: !!current, canStep: !!current?.playlistId, volume: store?.data.settings.volume ?? 1 };
}
async function Accounts(force = true) {
  if (accountRefresh) return accountRefresh;
  if (!force && Date.now() - accountCheckedAt < 30000) return accountStatus;
  accountRefresh = (async () => {
    let profile;
    try { profile = await biliAccount.Profile(); }
    catch (error) { profile = { loggedIn: false, error: error.message }; }
    accountStatus = { bilibili: profile }; accountCheckedAt = Date.now(); Emit('accounts', accountStatus);
    return accountStatus;
  })();
  try { return await accountRefresh; } finally { accountRefresh = null; }
}

function OpenAccount(source, favorites = false) {
  if (source !== 'bilibili') throw new Error('サービスが正しくありません。');
  const old = accountWindows.get(source);
  if (old && !old.isDestroyed()) { old.focus(); return; }
  const account = new BrowserWindow({ width: 1040, height: 800, parent: win, title: 'Bilibili · アカウント', autoHideMenuBar: true,
    webPreferences: { partition: `persist:favecus-${source}`, preload: path.join(__dirname, 'preloads/media.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  accountWindows.set(source, account);
  const wc = account.webContents;
  const channel = new MediaChannel(wc, { suspended: () => { if (!wc.isDestroyed()) wc.setAudioMuted(true); } });
  mediaChannels.set(wc, channel); wc.setAudioMuted(true);
  wc.setWindowOpenHandler(({ url }) => { if (IsAllowedRemote(url, source)) { channel.Suspend(); wc.loadURL(url).catch(() => {}); } return { action: 'deny' }; });
  for (const event of ['will-navigate', 'will-redirect']) wc.on(event, (e, url) => { if (!IsAllowedRemote(url, source)) e.preventDefault(); });
  wc.on('dom-ready', () => { channel.Ready(); SetVolume(); });
  wc.on('did-finish-load', SetVolume);
  account.on('closed', () => { accountWindows.delete(source); void Accounts().then(value => Emit('accounts', value)).catch(() => {}); });
  const open = async () => {
    let url = 'https://passport.bilibili.com/login';
    if (favorites) { const p = await biliAccount.Profile(); url = p.loggedIn ? `https://space.bilibili.com/${p.uid}/favlist` : url; }
    await wc.loadURL(url);
  };
  void open().catch(error => Notify(error.message));
}
function SecureSession(partition) {
  const s = session.fromPartition(partition);
  s.setPermissionRequestHandler((_contents, permission, callback) => callback(['fullscreen', 'mediaKeySystem'].includes(permission)));
  s.setPermissionCheckHandler((_contents, permission) => ['fullscreen', 'mediaKeySystem'].includes(permission));
  s.on('will-download', event => { event.preventDefault(); Notify('動画の保存は、左下の「動画・音声の保存」から行えます。'); });
}
function MatchesCurrentURL(raw) {
  if (!current?.entry || current.entry.type !== 'bilibili') return false;
  try {
    const entry = current.entry;
    return SameVideo(entry, raw, playbackMetadata.get(entry.videoId));
  } catch { return false; }
}
function MakeView(source, forceNew = false, officialPlayer = false) {
  if (!forceNew && current?.source === source && !current.pageMode && current.officialPlayer === officialPlayer && LivePlayer()) {
    generation++; recovery?.Cancel();
    SuspendPlayer(); remoteView.pendingToggle = false;
    remoteView.webContents.setAudioMuted(true);
    remoteView.webContents.stop();
    return remoteView;
  }
  CloseView();
  const view = new WebContentsView({ webPreferences: {
    preload: path.join(__dirname, 'preloads/media.cjs'),
    additionalArguments: ['--favecus-start-at-zero', ...(source === 'bilibili' ? ['--favecus-quality-360p'] : []), ...(officialPlayer ? ['--favecus-official-player'] : [])],
    partition: source === 'local' ? undefined : `persist:favecus-${source}`,
    nodeIntegration: false, contextIsolation: true, sandbox: true,
    webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false
  } });
  remoteView = view; view.navigationReady = false; win.contentView.addChildView(view); ViewBounds();
  const wc = view.webContents;
  const channel = new MediaChannel(wc, {
    suspended: () => { view.navigationReady = false; if (!wc.isDestroyed()) wc.setAudioMuted(true); },
    failed: error => PlayerDiagnostic('send-failed', { message: error.message }),
    sending: (name, value) => nativeDiagnostics?.Annotate({ operation: `${name}:${value?.type || 'settings'}` })
  });
  mediaChannels.set(wc, channel);
  wc.once('destroyed', () => {
    if (retiredPlayers.get(view)?.closing) retiredPlayers.delete(view);
    if (remoteView !== view) return;
    view.navigationReady = false; viewVisible = false;
    if (quitting) return;
    PlayerDiagnostic('view-destroyed');
    if (current?.source === 'bilibili') recovery?.Trigger(generation, 'view-destroyed');
    else { StopPlayer(); Notify('[FP-PLAYER-VIEW-DESTROYED] 再生画面が閉じられました。曲を選び直して再生できます。'); }
  });
  wc.on('focus', () => { if (remoteView === view) UpdateForeground(); });
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(({ url }) => {
    if (IsAllowedRemote(url, source)) {
      if (source === 'bilibili' && new URL(url).hostname === 'passport.bilibili.com') { channel.Suspend(); wc.loadURL(url).catch(() => {}); }
      else Notify('外部ページは上部の「ブラウザーで開く」から開けます。');
    }
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (source === 'local' || !IsAllowedRemote(url, source)) event.preventDefault();
    else if (source === 'bilibili') {
      try {
        const target = ParseBilibili(url);
        if (!MatchesCurrentURL(target.url)) { event.preventDefault(); Notify('別の動画はURLを再生リストへ追加して再生してください。'); }
      } catch {}
    }
  });
  wc.on('will-redirect', (event, url, _inPlace, mainFrame) => {
    if (source !== 'local' && !IsAllowedRemote(url, source)) event.preventDefault();
    else if (mainFrame && remoteView === view) view.requestedURL = url;
  });
  wc.on('dom-ready', () => {
    if (remoteView !== view || wc.isDestroyed() || wc.getURL() !== view.requestedURL) return;
    channel.Ready(); view.navigationReady = true;
    PlayerDiagnostic('document-ready');
    SetVolume(); UpdateForeground(); RefreshVideo();
    if (view.resume) { SendToPlayer('media:command', { type: 'restore', ...view.resume }); view.resume = null; }
    if (view.pendingToggle) { view.pendingToggle = false; SendToPlayer('media:command', { type: 'toggle' }); }
  });
  wc.on('did-finish-load', () => { if (remoteView === view && view.navigationReady) { SetVolume(); Emit('loaded', true); } });
  wc.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (mainFrame && code !== -3 && remoteView === view && url === view.requestedURL) {
      PlayerDiagnostic('load-error', { code, description }); recovery?.Trigger(generation, 'load-error'); UpdatePresence(); Notify(`[FP-PLAYER-LOAD-ERROR] ページを開けませんでした（${code}: ${description}）。`);
    }
  });
  wc.on('render-process-gone', (_event, details = {}) => { if (remoteView === view) { view.navigationReady = false; PlayerDiagnostic('renderer-exited', { exitReason: details.reason, exitCode: details.exitCode }); if (current?.source === 'bilibili') recovery?.Trigger(generation, 'renderer-exited'); else { StopPlayer(); Notify('[FP-PLAYER-RENDERER-EXITED] 再生画面が終了しました。動画を選び直してください。'); } } });
  wc.on('unresponsive', () => { if (remoteView === view) { PlayerDiagnostic('unresponsive'); recovery?.Trigger(generation, 'unresponsive'); } });
  return view;
}
function PlayableEntry(playlistId, entryId) {
  const entry = store.Entry(playlistId, entryId);
  if (entry.type === 'local' && !fs.existsSync(path.join(store.media, entry.fileName))) throw new Error('動画ファイルが見つかりません。「ファイル追加」で再登録してください。');
  return entry;
}
function RememberVideo(entry, details) {
  try { if (store.RememberVideo(entry, details)) Emit('state', store.Snapshot()); }
  catch (error) { Notify(`動画の対応情報を保存できません: ${error.message}`); }
}
function WarmMetadata(entry) {
  if (entry?.type !== 'bilibili' || playbackMetadata.has(entry.videoId)) return Promise.resolve(playbackMetadata.get(entry?.videoId));
  if (!metadataPending.has(entry.videoId) && metadataPending.size >= 2) return Promise.resolve(null);
  if (!metadataPending.has(entry.videoId)) metadataPending.set(entry.videoId, biliAccount.Details(entry.videoId).then(details => {
    RememberVideo(entry, details);
    if (playbackMetadata.size >= 200) playbackMetadata.delete(playbackMetadata.keys().next().value);
    playbackMetadata.set(entry.videoId, details); if (current?.entry.videoId === entry.videoId) UpdatePresence(); return details;
  }).catch(() => null).finally(() => metadataPending.delete(entry.videoId)));
  return metadataPending.get(entry.videoId);
}
async function LoadEntry(playlistId, entryId, pageMode = false, { allowRecovery = true, forceNew = false, useSaved = true, officialPlayer = null, recoveryAttempt = 0, resume = null, preserveCount = false } = {}) {
  PlayableEntry(playlistId, entryId);
  const request = ++loadRequest; generation++; recovery?.Cancel();
  SuspendPlayer();
  if (remoteView) { remoteView.requestedURL = null; remoteView.pendingToggle = false; }
  // ended等の通知中に同じネイティブ画面を操作せず、連打では最後の要求を採用する。
  await new Promise(resolve => setImmediate(resolve));
  if (quitting || request !== loadRequest) return current;
  const entry = PlayableEntry(playlistId, entryId);
  const saved = useSaved && !pageMode && offline?.preferSaved ? offline.Find(entry, store.data.settings.thumbnailMode ? 'audio' : 'video') : null;
  const source = saved ? 'local' : entry.type;
  const details = playbackMetadata.get(entry.videoId);
  officialPlayer = source === 'bilibili' && !pageMode && (officialPlayer ?? (officialPreferred.has(entry.videoId) || officialPreferred.has(`season:${details?.ugc_season?.id}`)));
  const view = MakeView(source, forceNew || pageMode, officialPlayer), gen = generation; view.resume = resume;
  if (!preserveCount) playCounts?.Begin(entry);
  current = { source, queuePlaylistId: queue.playlistId, playlistId, entryId, entry: structuredClone(entry), pageMode, officialPlayer, recoveryAttempt, offline: saved ? { token: saved.token, kind: saved.kind, height: saved.height } : null };
  PlayerDiagnostic('track-change', { source, saved: !!saved });
  playback = null; thumbnail = null; UpdatePresence(); UpdateForeground(); Emit('current', current); void LoadThumbnail(); backgroundMode?.Refresh();
  recovery?.Begin(gen, source === 'bilibili' && !pageMode && allowRecovery);
  const url = saved ? `favecus://app/local.html?offline=${saved.token}` : entry.type === 'local' ? `favecus://app/local.html?media=${entry.fileName}` : pageMode ? entry.url : officialPlayer ? `${entry.url}${entry.url.includes('?') ? '&' : '?'}autoplay=1` : PlayerURL(entry, details);
  view.requestedURL = url;
  if (source === 'bilibili') { void WarmMetadata(entry); const upcoming = queue.Timeline(store.data.settings.repeat).upcoming.slice(0, 2); for (const id of upcoming) void WarmMetadata(queue.catalog.get(id)); }
  PlayerDiagnostic('navigation-start'); nativeDiagnostics?.Annotate({ operation: 'load-url' });
  try { await view.webContents.loadURL(url); }
  catch (error) { if (gen === generation && error.code !== 'ERR_ABORTED') { PlayerDiagnostic('navigation-error', { code: error.code, message: String(error.message).slice(0, 200) }); Notify('[FP-PLAYER-NAVIGATION-ERROR] 再生ページを読み込めませんでした。「再読み込み」または「ブラウザーで開く」を使用してください。'); } }
  return current;
}
async function Step(direction, automatic = false) {
  lastPlayerCommand = automatic ? 'auto-next' : direction > 0 ? 'next' : 'previous';
  if (!current?.playlistId) return;
  const nextQueue = queue.Clone(), id = nextQueue.Move(direction, store.data.settings.repeat, automatic);
  if (!id) { if (automatic) { StopPlayer(); Notify('再生リストの最後まで再生しました。'); } return; }
  const next = store.Entries(nextQueue.playlistId).find(e => e.id === id);
  if (!next) return;
  PlayableEntry(next.playlistId, id); queue = nextQueue;
  await LoadEntry(next.playlistId, id);
}
function SyncPlayingQueue() {
  if (!current?.playlistId) return;
  const list = store.data.playlists.find(p => p.id === current.playlistId);
  if (!list?.entries.some(e => e.id === current.entryId)) StopPlayer();
  else {
    const scope = queue.playlistId === '*' || store.data.playlists.some(p => p.id === queue.playlistId) ? queue.playlistId : list.id;
    const entries = store.Entries(scope);
    if (!entries.some(e => e.id === current.entryId)) { if (scope === '*') { StopPlayer(); return; } queue.Start(list.id, store.Entries(list.id), current.entryId, store.data.settings.shuffle); }
    else queue.Sync(scope, entries, current.entryId, store.data.settings.shuffle);
    current.queuePlaylistId = queue.playlistId;
  }
}
function SecureIPC(event) {
  try { return win && !win.isDestroyed() && !win.webContents.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === 'favecus://app/index.html'; } catch { return false; }
}
function Handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!SecureIPC(event)) return { ok: false, error: '許可されていない操作です。' };
    try { return { ok: true, value: await callback(...args) }; }
    catch (error) { return { ok: false, error: error.message || '操作に失敗しました。' }; }
  });
}
async function Configure() {
  const settings = store.data.settings;
  presence.Configure(settings.discordEnabled, settings.discordClientId);
  UpdatePresence();
  SetVolume();
  await mini?.Configure?.();
}
function Resources(folder) { return app.isPackaged ? path.join(process.resourcesPath, folder) : path.join(app.getAppPath(), folder); }
async function Play(playlistId, entryId) {
  const entries = store.Entries(playlistId), selected = entries.find(e => e.id === entryId) || (!entryId ? entries[0] : null);
  if (!selected) throw new Error('再生する曲がありません。');
  PlayableEntry(selected.playlistId, selected.id);
  queue.Start(playlistId, entries, selected.id, store.data.settings.shuffle);
  return LoadEntry(selected.playlistId, selected.id);
}
async function ShufflePlay(playlistId) {
  const entries = store.Entries(playlistId);
  if (!entries.length) throw new Error('再生する曲がありません。');
  const nextQueue = new Queue(null, ShuffleWeight), first = nextQueue.ShuffleStart(playlistId, entries), selected = entries.find(e => e.id === first);
  PlayableEntry(selected.playlistId, first);
  const settings = { shuffle: true };
  if (store.data.settings.repeat === 'one') settings.repeat = 'off';
  const state = store.Apply({ type: 'settings', settings }); queue = nextQueue; Emit('state', state);
  return LoadEntry(selected.playlistId, first);
}
async function AllPlay(shuffle) {
  if (shuffle) return ShufflePlay('*');
  const state = store.Apply({ type: 'settings', settings: { shuffle: false } }); Emit('state', state); return Play('*');
}
function OpenHelp(page = 'GUIDE.html') {
  if (!['GUIDE.html', 'TASKBAR.html', 'DISCORD.html'].includes(page)) return;
  if (helpWindow && !helpWindow.isDestroyed()) { void helpWindow.loadFile(path.join(Resources('docs'), page)); helpWindow.show(); helpWindow.focus(); return; }
  helpWindow = new BrowserWindow({ width: 1000, height: 780, parent: win, title: 'Favecus Player · 使い方', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  const window = helpWindow, wc = window.webContents;
  const allowed = raw => { try { const u = new URL(raw); return ['GUIDE.html', 'TASKBAR.html', 'DISCORD.html'].some(name => u.href.split('#')[0] === pathToFileURL(path.join(Resources('docs'), name)).href); } catch { return false; } };
  wc.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  wc.setWindowOpenHandler(() => ({ action: 'deny' })); window.on('closed', () => { helpWindow = null; });
  return window.loadFile(path.join(Resources('docs'), page));
}
async function Command(command, value) {
  lastPlayerCommand = String(command).slice(0, 40);
  if (command === 'toggle' && !current) {
    const list = store.Playlist(store.data.activePlaylistId);
    if (store.Entries(list.id).length) await Play(list.id);
    return;
  }
  if (!current) return;
  if (command === 'stop') StopPlayer();
  else if (command === 'next' || command === 'previous') await Step(command === 'next' ? 1 : -1);
  else if (command === 'toggle') {
    if (!LivePlayer()) await LoadEntry(current.playlistId, current.entryId, current.pageMode, { forceNew: true, officialPlayer: current.officialPlayer, preserveCount: true, resume: { position: current.resumeAfterFailure?.position || 0, paused: false } });
    else if (!remoteView.navigationReady) remoteView.pendingToggle = !remoteView.pendingToggle;
    else SendToPlayer('media:command', { type: 'toggle' });
  }
  else if (command === 'seek' && Number.isFinite(value) && playback?.duration > 0) SendToPlayer('media:command', { type: 'seek', value: Math.max(0, Math.min(value, playback.duration)) });
  else if (command === 'back-ten' || command === 'forward-ten') {
    if (playback?.duration > 0) SendToPlayer('media:command', { type: 'seek-relative', value: command === 'back-ten' ? -10 : 10 });
  }
  else if (command === 'reload') {
    await LoadEntry(current.playlistId, current.entryId, current.pageMode, { forceNew: true, officialPlayer: current.officialPlayer, preserveCount: true, resume: playback ? { position: playback.position, paused: playback.paused } : current.resumeAfterFailure || null });
  }
  else if (command === 'online' && current?.entry.type === 'bilibili') await LoadEntry(current.playlistId, current.entryId, false, { forceNew: true, useSaved: false });
  else if (command === 'page-mode' && current?.source === 'bilibili') await LoadEntry(current.playlistId, current.entryId, !current.pageMode, { forceNew: true });
}

async function Start() {
  const ffmpeg = process.env.FAVECUS_INSTALL_ROOT ? path.join(process.env.FAVECUS_INSTALL_ROOT, 'runtime', 'ffmpeg', 'ffmpeg.exe') : app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : path.join(app.getAppPath(), 'runtime', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  store = new Store(app.getPath('userData'), { convertWma: (source, destination) => ConvertWma(ffmpeg, source, destination) });

  protocol.handle('favecus', async request => {
    const url = new URL(request.url);
    if (url.host === 'offline') { const token = url.pathname.slice(1), saved = current?.offline?.token === token ? offline?.File(token) : null; return saved ? MediaResponse(request, saved.path) : new Response(null, { status: 403 }); }
    if (url.host === 'media') {
      const name = url.pathname.slice(1);
      if (!MEDIA_NAME.test(name) || !store.data.playlists.some(p => p.entries.some(e => e.type === 'local' && e.fileName === name))) return new Response(null, { status: 403 });
      return MediaResponse(request, path.join(store.media, name));
    }
    const names = new Set(['keybindings.js', 'library-tree.js', 'tree-view.js', 'parent-picker.js', 'index.html', 'app.js', 'style.css', 'local.html', 'local.js', 'preview.js', 'transport-model.js', 'playlist-reader.js', 'queue-follow.js', 'queue-drag.js', 'list-artwork.js', 'browse.html', 'browse.js', 'browse.css', 'mini.html', 'mini.js', 'mini.css', 'icons.svg', 'icon.png', 'music.png']);
    const name = url.pathname.slice(1);
    if (url.host !== 'app' || !names.has(name)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(['icon.png', 'music.png'].includes(name) ? path.join(__dirname, '../build', name) : path.join(__dirname, 'ui', name)).href);
  });
  SecureSession('persist:favecus-bilibili');
  const biliSession = session.fromPartition('persist:favecus-bilibili');
  for (const url of ['https://player.bilibili.com', 'https://api.bilibili.com']) {
    try { biliSession.preconnect({ url, numSockets: 1 }); } catch {}
  }
  biliAccount = new BilibiliAccount((...args) => biliSession.fetch(...args));
  offline = new OfflineLibrary({ directory: path.join(process.env.FAVECUS_INSTALL_ROOT || (app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath()), 'downloads'), previousDirectories: process.env.FAVECUS_INSTALL_ROOT ? PreviousInstallRoots(process.env.FAVECUS_INSTALL_ROOT).map(p => path.join(p, 'downloads')) : [], settingsFile: path.join(app.getPath('userData'), 'download-settings.json'), fetch: DownloadFetch(biliSession), ffmpeg, libraryData: () => store.data, identify: RememberVideo, diagnostic: DownloadDiagnosticLog, changed: value => Emit('downloads', value) });
  await offline.Organize(); archive = new LibraryArchive(store, offline);
  playCounts = new PlayCounts(path.join(app.getPath('userData'), 'play-counts.json'), Notify);
  additionReview = new AdditionReview(store, { resolveTitle: async entry => {
    const data = await biliAccount.Details(entry.videoId);
    RememberVideo(entry, data);
    const page = data?.pages?.find(p => p.page === entry.part) || data?.pages?.[entry.part - 1];
    return data?.pages?.length > 1 ? page?.part || data?.title : data?.title;
  } });
  thumbnails = new Thumbnails(biliAccount, (...args) => net.fetch(...args), ffmpeg, store.media, { resize: data => SmallImage(data, nativeImage) });
  session.defaultSession.setPermissionRequestHandler((_c, permission, callback) => callback(permission === 'fullscreen'));
  session.defaultSession.setPermissionCheckHandler((_c, permission) => permission === 'fullscreen');
  Menu.setApplicationMenu(null);
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  win = new BrowserWindow({ width: 1440, height: 900, minWidth: 1060, minHeight: 680, backgroundColor: '#11131b', title: 'Favecus Player', icon: path.join(__dirname, '../build/icon.png'),
    titleBarStyle: 'hidden', ...(process.platform !== 'darwin' ? { titleBarOverlay: { color: '#171923', symbolColor: '#edf0f8', height: 36 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preloads/ui.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
  let taskbarWarning = '';
  try { ConfigureTaskbar(win, app, shell, process.env.FAVECUS_INSTALL_ROOT); }
  catch (error) { taskbarWarning = `ピン留め用の設定を更新できませんでした: ${error.message}`; }
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('resize', ViewBounds);
  recovery = new PlayerRecovery(async (token, reason) => {
    if (token !== generation || !current || current.source !== 'bilibili' || current.pageMode) return;
    const { playlistId, entryId } = current, attempt = (current.recoveryAttempt || 0) + 1;
    PlayerDiagnostic('recovery', { trigger: reason, nextAttempt: attempt });
    const resume = playback ? { position: playback.position, paused: playback.paused } : { position: 0, paused: false };
    if (attempt > 2) { PlayerDiagnostic('recovery-exhausted', { trigger: reason }); current.resumeAfterFailure = resume; CloseView(); playback = null; Emit('playback', null); UpdatePresence(); Notify('[FP-PLAYER-RECOVERY-EXHAUSTED] 再生を再開できなかったため、停止したプレイヤーを閉じました。再生・次の曲・再読み込みは引き続き操作できます。'); return; }
    Notify(attempt === 1 ? '再生が進まないため、アプリ内の公式プレイヤーに切り替えています。' : '公式プレイヤーを再作成して、停止した位置から再開します。');
    await LoadEntry(playlistId, entryId, false, { forceNew: true, officialPlayer: true, recoveryAttempt: attempt, resume, preserveCount: true, useSaved: false });
  }, { delay: 12000, stallDelay: 15000, onError: error => Notify(error.message) });

  backgroundMode = new BackgroundMode(() => store.data.settings, () => !!current && !store.data.settings.thumbnailMode, () => {
    const state = store.Apply({ type: 'settings', settings: { thumbnailMode: true } });
    ViewBounds(); Emit('state', state); void LoadThumbnail();
    Notify('一定時間アプリが前面から外れていたため、曲モードへ切り替えました。「動画」で元の画面へ戻れます。');
  }, { onError: error => Notify(`自動表示切り替えを保存できません: ${error.message}`) });
  for (const event of ['blur', 'hide', 'minimize']) win.on(event, () => UpdateForeground(false));
  win.on('focus', () => { UpdateForeground(); RefreshVideo(); void Accounts(false); });
  win.webContents.on('focus', () => UpdateForeground());
  for (const event of ['show', 'restore']) win.on(event, () => { UpdateForeground(); RefreshVideo(); });
  win.on('closed', () => { offline?.Cancel(); biliBrowser?.Destroy(); backgroundMode?.Dispose(); mini?.Destroy(); mini = null; StopPlayer(); win = null; presence?.Stop(); app.quit(); });
  presence = new DiscordPresence((code, text) => Status('discord', code, text));
  mini = new MiniPlayer(win, MiniState, Command, ChangeVolume, Notify, { settings: () => store.data.settings, status: (code, text) => Status('taskbar', code, text) });
  biliBrowser = new BilibiliBrowser({ BrowserWindow, WebContentsView, ipcMain }, {
    profile: async () => (await Accounts()).bilibili, details: id => biliAccount.Details(id), volume: () => store.data.settings.volume,
    refresh: () => { void Accounts(); },
    add: entry => {
      if (visibleBounds.modalOpen) throw new Error('開いている追加・設定画面を閉じてから、もう一度追加ボタンを押してください。');
      biliBrowser.Hide(); mini.Restore(); Emit('add-url', entry);
    }
  });
  Handle('app:state', () => ({ state: store.Snapshot(), statuses, current, playback, thumbnail, queue: QueueState(), downloads: offline.Snapshot(), foreground: Foreground(), accounts: accountStatus, version: app.getVersion(), platform: process.platform }));
  Handle('library:choose-icon', async () => { const result = await dialog.showOpenDialog(win, { title: 'プレイリストの画像を選択', properties: ['openFile'], filters: [{ name: '画像', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] }); return result.canceled ? null : ReadIcon(result.filePaths[0], nativeImage); });
  Handle('player:reset-counts', () => { playCounts.Reset(); return true; });
  Handle('downloads:state', () => offline.Snapshot());
  const downloadTarget = options => {
    if (!options || typeof options.includeChildren !== 'boolean') throw new Error('保存対象を指定してください。');
    const list = store.Playlist(options.playlistId);
    return { entries: options.includeChildren ? store.Entries(list.id) : list.entries.map(e => ({ ...e, playlistId: list.id })), options: { kind: options.kind, height: options.height, playlistId: list.id, playlistName: list.name, estimateId: options.estimateId } };
  };
  Handle('downloads:estimate', options => { const target = downloadTarget(options); return offline.Estimate(target.entries, target.options); });
  Handle('downloads:estimate-cancel', () => offline.CancelEstimate());
  Handle('downloads:start', options => { const target = downloadTarget(options); return offline.Start(target.entries, target.options); });
  Handle('downloads:cancel', () => offline.Cancel());
  Handle('downloads:prefer', value => offline.PreferSaved(value));
  Handle('downloads:directory', async () => { if (offline.controller) throw new Error('保存中は保存先を変更できません。'); const result = await dialog.showOpenDialog(win, { title: '動画・音声の保存先', defaultPath: offline.directory, properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? offline.Snapshot() : offline.SetDirectory(result.filePaths[0]); });
  Handle('downloads:open', async () => { fs.mkdirSync(offline.directory, { recursive: true }); if (await shell.openPath(offline.directory)) throw new Error('保存先を開けませんでした。'); return true; });
  Handle('library:thumbnail', (playlistId, entryId, scope = store.data.activePlaylistId) => {
    const entry = structuredClone(store.Entry(playlistId, entryId));
    if (offline.Find(entry)) { const cover = offline.Cover(entry); return cover ? SmallImage(cover, nativeImage) : null; }
    const active = () => !!win && !win.isDestroyed() && (scope === '*' || scope === store.data.activePlaylistId && store.Entries(scope).some(e => e.id === entryId)) && !!store.data.playlists.find(p => p.id === playlistId)?.entries.some(e => e.id === entryId);
    return thumbnails.GetPreview(entry, active);
  });
  Handle('library:action', async action => {
    const state = store.Apply(action);
    if (current?.playlistId && !['select', 'rename', 'title', 'settings'].includes(action.type)) SyncPlayingQueue();
    if (current?.playlistId && ((action.type === 'title' && current.entryId === action.entryId && current.playlistId === action.playlistId) || (action.type === 'settings' && Object.hasOwn(action.settings || {}, 'titleCleanupWords')))) {
      current.entry.title = store.Entry(current.playlistId, current.entryId).title;
      Emit('current-update', current);
      if (playback) { playback.title = current.entry.title || store.CleanTitle(playback.title) || current.entry.videoId || 'ローカル動画'; AcceptPlayback(playback); }
      mini?.Update();
    }
    if (action.type === 'settings') {
      if (['shuffle', 'playlistSort'].some(key => Object.hasOwn(action.settings || {}, key))) SyncPlayingQueue();
      await Configure();
      ViewBounds(); SyncShortcuts();
      if (Object.hasOwn(action.settings || {}, 'thumbnailMode')) { void LoadThumbnail(); if (!state.settings.thumbnailMode) RefreshVideo(); }
      backgroundMode?.Refresh();
    }
    Emit('state', state); return state;
  });
  Handle('library:prepare-add', action => additionReview.Prepare(action));
  Handle('library:prepare-files', async destinationIds => {
    store.Targets(destinationIds);
    const selected = await dialog.showOpenDialog(win, { title: '動画・音楽ファイルを追加', properties: ['openFile', 'multiSelections'], filters: [{ name: '動画・音楽', extensions: [...MEDIA_EXTENSIONS].map(x => x.slice(1)) }] });
    return selected.canceled ? null : additionReview.PrepareFiles(destinationIds, selected.filePaths);
  });
  Handle('library:commit-add', async (id, allowedIds) => {
    const result = await additionReview.Commit(id, allowedIds);
    SyncPlayingQueue(); Emit('state', result.state); return result;
  });
  Handle('library:cancel-add', id => { additionReview.Cancel(id); return true; });
  Handle('library:transfer', action => {
    const result = store.Transfer(action);
    if (result.moved && current?.playlistId === action.playlistId && current?.entryId === action.entryId) {
      const target = result.destinations[0];
      current.playlistId = target.playlistId; current.entryId = target.entryId;
      current.entry = structuredClone(store.Entry(target.playlistId, target.entryId));
      if (thumbnail) thumbnail.entryId = target.entryId;
      Emit('current-update', current);
      if (playback) { playback.title = current.entry.title || playback.title; AcceptPlayback(playback); }
    }
    SyncPlayingQueue();
    Emit('state', result.state); return result;
  });
  Handle('library:files', async destinationIds => {
    const ids = store.Targets(destinationIds).map(p => p.id);
    const result = await dialog.showOpenDialog(win, { title: '動画・音楽ファイルを追加', properties: ['openFile', 'multiSelections'], filters: [{ name: '動画・音楽', extensions: [...MEDIA_EXTENSIONS].map(x => x.slice(1)) }] });
    if (result.canceled) return null;
    let state;
    try { state = await store.AddFiles(ids, result.filePaths); }
    catch (error) { Emit('state', store.Snapshot()); throw error; }
    if (current?.playlistId && ids.includes(current.playlistId)) SyncPlayingQueue();
    Emit('state', state); return state;
  });
  Handle('library:move-tracks', action => {
    const result = store.TransferMany(action);
    const moved = result.mappings.find(m => m.playlistId === current?.playlistId && m.entryId === current?.entryId);
    if (moved) { Object.assign(current, moved.destinations[0]); current.entry = structuredClone(store.Entry(current.playlistId, current.entryId)); if (thumbnail) thumbnail.entryId = current.entryId; Emit('current-update', current); }
    SyncPlayingQueue(); Emit('state', result.state); return result;
  });
  Handle('library:export', async () => {
    const result = await dialog.showSaveDialog(win, { title: 'プレイリストをZIPで出力', defaultPath: `FavecusPlayer-playlists-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: 'ZIPアーカイブ', extensions: ['zip'] }] });
    return result.canceled ? null : archive.Export(result.filePath);
  });
  Handle('library:import', async () => {
    const result = await dialog.showOpenDialog(win, { title: 'プレイリストのZIPを選択', properties: ['openFile'], filters: [{ name: 'Favecus Playerのプレイリスト', extensions: ['zip', 'json'] }] });
    return result.canceled ? null : archive.Prepare(result.filePaths[0]);
  });
  Handle('library:import-commit', async (id, ids, options) => { const result = await archive.Commit(id, ids, options); SyncPlayingQueue(); Emit('state', result.state); return result; });
  Handle('library:import-cancel', id => archive.Cancel(id));
  Handle('library:duration', async (playlistId, entryId) => {
    const entry = store.Entry(playlistId, entryId); if (entry.duration) return entry.duration;
    const value = offline.Find(entry)?.duration || (entry.type === 'bilibili' ? (await biliAccount.Resolve(entry.url)).video?.duration : await LocalDuration(ffmpeg, path.join(store.media, entry.fileName)));
    const actual = store.data.playlists.find(p => p.id === playlistId)?.entries.find(e => e.id === entryId);
    if (actual && value > 0) { actual.duration = value; store.Save(); }
    return value || null;
  });
  Handle('player:play', Play);
  Handle('player:shuffle', ShufflePlay);
  Handle('player:all', AllPlay);
  Handle('player:command', Command);
  Handle('player:shortcut', Shortcut);
  Handle('player:volume', ChangeVolume);
  Handle('window:mini', () => mini.Show());
  Handle('player:official', () => {
    if (current?.entry.type === 'bilibili') return shell.openExternal(ParseBilibili(current.entry.url).url);
  });
  Handle('account:status', Accounts);
  Handle('account:open', OpenAccount);
  Handle('account:folders', () => biliAccount.Folders());
  Handle('account:videos', (id, page) => biliAccount.Videos(id, page));
  Handle('bilibili:browse', () => biliBrowser.Open());
  Handle('bilibili:resolve', input => biliAccount.Resolve(input));
  Handle('bilibili:lists', input => biliAccount.Lists(input));
  Handle('bilibili:parts', input => biliAccount.Parts(input));
  Handle('bilibili:list-videos', (source, page) => biliAccount.ListVideos(source, page));
  Handle('app:release-open', () => shell.openExternal(DriveURL(store.data.settings.releaseDriveURL)));
  Handle('app:help', () => OpenHelp('GUIDE.html'));
  Handle('app:discord-portal', () => shell.openExternal('https://discord.com/developers/applications'));
  Handle('app:discord-guide', () => OpenHelp('DISCORD.html'));
  Handle('app:discord-image', () => shell.showItemInFolder(path.join(Resources('docs'), 'favecus_player_music.png')));
  Handle('app:taskbar-guide', () => OpenHelp('TASKBAR.html'));
  Handle('app:taskbar-log', async () => {
    const error = await shell.openPath(path.join(app.getPath('userData'), 'taskbar.log'));
    if (error) throw new Error('診断記録を開けませんでした。一度、下向き矢印から埋め込みを実行してください。');
  });
  ipcMain.on('view:bounds', (event, bounds) => {
    if (!SecureIPC(event) || !bounds || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(bounds[k]) && Math.abs(bounds[k]) < 20000)) return;
    visibleBounds = bounds; ViewBounds(); SyncShortcuts();
  });
  ipcMain.on('media:shortcut', (event, input) => {
    if (TrustedMediaEvent(event)) void Shortcut(input).catch(error => Notify(error.message));
  });
  let lastMediaError = '', mediaErrorAt = 0;
  ipcMain.on('media:error', (event, message) => { if (TrustedMediaEvent(event)) { const text = String(message).slice(0, 200); if (text !== lastMediaError || Date.now() - mediaErrorAt > 10000) { lastMediaError = text; mediaErrorAt = Date.now(); PlayerDiagnostic('media-error', { message: text }); Notify(`[FP-PLAYER-MEDIA-ERROR] ${text}`); } } });
  ipcMain.on('media:health', (event, input) => {
    if (!TrustedMediaEvent(event) || !input) return;
    if (current.source === 'bilibili' && !MatchesCurrentURL(input.url)) return;
    recovery?.Observe(generation, input);
  });
  ipcMain.on('media:state', (event, input) => {
    if (!TrustedMediaEvent(event)) return;
    let data;
    try { data = NormalizeMedia(input, current.source); } catch { return; }
    if (current.source === 'bilibili' && !MatchesCurrentURL(input.url)) return;
    if (current.playlistId) data.title = current.entry.title || store.CleanTitle(data.title) || current.entry.videoId || 'ローカル動画';
    if (current.playlistId && current.source !== 'local' && !current.entry.title && data.title !== current.entry.videoId && data.title.length > 1) {
      try {
        store.Apply({ type: 'title', playlistId: current.playlistId, entryId: current.entryId, title: data.title });
        current.entry.title = store.Entry(current.playlistId, current.entryId).title;
        Emit('current-update', current); Emit('state', store.Snapshot());
      } catch {}
    }
    if (data.duration > 0 && current?.playlistId && Math.abs((current.entry.duration || 0) - data.duration) > 1) {
      try { store.Entry(current.playlistId, current.entryId).duration = data.duration; current.entry.duration = data.duration; store.Save(); Emit('duration', { entryId: current.entryId, duration: data.duration }); } catch {}
    }
    AcceptPlayback(data);
    if (data.ended && current.playlistId) {
      SendToPlayer('media:command', { type: 'pause' });
      void Step(1, true).catch(error => { StopPlayer(); Notify(error.message); });
    }
  });
  await win.loadURL('favecus://app/index.html'); await Configure();
  if (store.warning) Notify(store.warning);
  if (taskbarWarning) Notify(taskbarWarning);
  const timer = setInterval(UpdatePresence, 5000); timer.unref();
  if (isSmoke) setTimeout(() => { process.stdout.write('FAVECUS_SMOKE_READY\n'); app.quit(); }, 1500);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  nativeDiagnostics = StartCrashDiagnostics({ app, crashReporter, installRoot: process.env.FAVECUS_INSTALL_ROOT, runId: process.env.FAVECUS_RUN_ID });
  PlayerDiagnostic('diagnostics-start', { started: nativeDiagnostics.started, error: nativeDiagnostics.error, electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform, arch: process.arch });
  app.on('second-instance', () => mini?.Restore());
  app.whenReady().then(Start).catch(error => { PlayerDiagnostic('app-start', { message: String(error.message).slice(0, 240) }); dialog.showErrorBox('Favecus Playerを起動できません', `[FP-PLAYER-APP-START] ${error.message}`); app.quit(); });
}
app.on('child-process-gone', (_event, details = {}) => PlayerDiagnostic('child-process-exited', { processType: details.type, exitReason: details.reason, exitCode: details.exitCode }));
process.on?.('uncaughtExceptionMonitor', (error, origin) => PlayerDiagnostic('uncaught-exception', { origin, name: error.name, code: error.code, message: String(error.message).slice(0, 240), stack: String(error.stack || '').split('\n').slice(0, 8).join('\n').slice(0, 3000) }));
app.on('before-quit', () => {
  quitting = true; loadRequest++; offline?.CancelEstimate();
  offline?.Cancel();
  if (volumeSaveTimer) { clearTimeout(volumeSaveTimer); volumeSaveTimer = null; try { store?.Save(); } catch {} }
  biliBrowser?.Destroy(); backgroundMode?.Dispose(); mini?.Destroy(); mini = null; presence?.Stop(); CloseView(); for (const view of retiredPlayers.keys()) DisposePlayer(view);
});
