'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, session, protocol, net, Menu, nativeImage, crashReporter, safeStorage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const { randomUUID, randomInt } = require('node:crypto');
const { Store, MEDIA_NAME, ValidateLibrary } = require('./core/store.cjs');
const { LibraryMediaKey } = require('./core/library-identity.cjs');
const { SyncService, StoreAdapter } = require('./core/sync-service.cjs');
const { SessionVault } = require('./core/sync-storage.cjs');
const { LocalDuration } = require('./core/media-duration.cjs');
const { LibraryArchive } = require('./core/library-archive.cjs');
const { ShareMode } = require('./core/library-share.cjs');
const { Queue } = require('./core/queue.cjs');
const { PlayCounts } = require('./core/play-counts.cjs');
const PlayLedger = require('./core/play-ledger.cjs');
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
const { Thumbnails, SmallImage, CoverImage, FlatImage, ImageData } = require('./core/thumbnail.cjs');
const { SleepTimer } = require('./core/sleep-timer.cjs');
const { ResumeStore } = require('./core/resume-point.cjs');
const AutoListsCore = require('./core/auto-lists.cjs');
const { TrashStore } = require('./core/trash-store.cjs');
const { LoudnessStore } = require('./core/loudness.cjs');
const { FavoriteStore } = require('./core/favorites.cjs');
const { APP_ID, ConfigureTaskbar, PreviousInstallRoots } = require('./core/windows-identity.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'favecus', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.setName('Favecus Player');
const isSmoke = process.argv.includes('--smoke-test');
const dataDirectory = isSmoke && process.env.FAVECUS_TEST_DIRECTORY ? process.env.FAVECUS_TEST_DIRECTORY : require('./core/data-migration.cjs').PrepareDataDirectory(app.getPath('appData'));
app.setPath('userData', dataDirectory);
app.setPath('sessionData', dataDirectory);
let win, store, presence, remoteView, mini, volumeSaveTimer, backgroundMode, sync;
let viewVisible = false;
let current = null, playback = null;
let thumbnails, thumbnail = null, sleepTimer = null, resumeStore = null, trashStore = null, loudness = null, songGain = 1, favorites = null;
let visibleBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
let statuses = { discord: { code: 'off', text: 'Discord連携はオフです' }, taskbar: { code: 'off', text: '下向き矢印を押すと埋め込みを試します' } };
let playCounts;
// シャッフルの重み：1/(1+再生回数)。お気に入りの曲は、倍率を掛けて、少しだけ選ばれやすくする（共通の規則：play-ledger.cjs）
const ShuffleWeight = entry => store?.data.settings.weightedShuffle === false ? 1 : PlayLedger.WeightOf(playCounts?.Count(entry) || 0, IsFavorite(entry));
function IsFavorite(entry) { const key = playCounts?.KeyOf(entry); return !!key && !!favorites?.Has(key); }
// お気に入りの曲の、登録曲ID（画面の表示用。同じメディアの曲は、すべて）。
function FavoriteIds() {
  const ids = [];
  for (const list of store?.data.playlists || []) for (const entry of list.entries) if (IsFavorite(entry)) ids.push(entry.id);
  return ids;
}
let queue = new Queue(null, ShuffleWeight, randomInt);
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
// 自動リスト（よく聴く曲・最近追加した曲・未再生）。保存せず、その都度、共通の規則（core/auto-lists.cjs）で選ぶ。
// 再生するときは、そのときの曲の並び（スナップショット）を再生範囲（auto:…）にする。再生回数が増えても、再生中の並びは変わらない。
const AUTO_NAMES = { 'auto:frequent': 'よく聴く曲', 'auto:recent': '最近追加した曲', 'auto:unplayed': '未再生', 'auto:favorites': 'お気に入り' };
const autoSnapshots = new Map();
function BuildAutoLists() {
  const keys = {}, counts = {};
  for (const list of store.data.playlists) for (const entry of list.entries) {
    const key = playCounts?.KeyOf(entry);
    if (key) { keys[entry.id] = key; if (!(key in counts)) counts[key] = playCounts.Count(entry); }
  }
  return AutoListsCore.Select({ library: store.data, keys, counts, favorites: favorites ? favorites.List() : [] });
}
function AutoEntries(kind) {
  const scope = `auto:${kind}`;
  if (!AUTO_NAMES[scope]) throw new Error('自動リストの種類が正しくありません。');
  const owners = new Map();
  for (const list of store.data.playlists) for (const entry of list.entries) if (!owners.has(entry.id)) owners.set(entry.id, { ...entry, playlistId: list.id });
  const entries = (BuildAutoLists()[kind] || []).map(item => owners.get(item.id)).filter(Boolean);
  autoSnapshots.set(scope, entries);
  return entries;
}
const ScopeEntries = scope => AUTO_NAMES[scope]
  ? (autoSnapshots.get(scope) || []).filter(e => store.data.playlists.some(p => p.id === e.playlistId && p.entries.some(x => x.id === e.id)))
  : store.Entries(scope);
async function AutoPlay(kind, entryId, shuffled) {
  const entries = AutoEntries(kind), scope = `auto:${kind}`;
  if (!entries.length) throw new Error('再生する曲がありません。');
  if (shuffled) {
    const nextQueue = new Queue(null, ShuffleWeight, randomInt), first = nextQueue.ShuffleStart(scope, entries), selected = entries.find(e => e.id === first);
    PlayableEntry(selected.playlistId, first);
    const settings = { shuffle: true };
    if (store.data.settings.repeat === 'one') settings.repeat = 'off';
    const state = store.Apply({ type: 'settings', settings }); queue = nextQueue; Emit('state', state);
    return LoadEntry(selected.playlistId, first);
  }
  const selected = entries.find(e => e.id === entryId) || entries[0];
  PlayableEntry(selected.playlistId, selected.id);
  queue.Start(scope, entries, selected.id, store.data.settings.shuffle);
  return LoadEntry(selected.playlistId, selected.id);
}
// 最近削除に保管中の曲も、保存済みメディアの整理では「参照されている」ものとして数える（元に戻したときに、保存済みの動画・音声が残るように）。
function WithTrashedEntries(data) {
  const extra = trashStore?.Entries() || [];
  if (!data || !Array.isArray(data.playlists) || !extra.length) return data;
  return { ...data, playlists: [...data.playlists, { id: 'trash', name: 'trash', entries: extra, childIds: [] }] };
}
// 保存済み・ローカルの曲の音量を測り（初めてだけ。結果は覚える）、大きい曲を下げる倍率を、再生中の音量に反映する。オンライン再生は、対象外。
async function LevelCurrent(request, file) {
  if (!file || !loudness || store.data.settings.volumeLeveling === false) return;
  try {
    const gain = await loudness.GainFor(file);
    if (request === loadRequest && gain !== songGain) { songGain = gain; SetVolume(); }
  } catch { /* 測れなくても、再生は妨げない */ }
}
function QueueState() {
  if (!current?.playlistId) return null;
  const scope = queue.playlistId, entries = ScopeEntries(scope), nextId = queue.Peek(store.data.settings.repeat);
  const next = entries.find(entry => entry.id === nextId);
  const timeline = queue.Timeline(store.data.settings.repeat);
  const byId = new Map(entries.map(e => [e.id, e]));
  const describe = id => { const e = byId.get(id) || queue.catalog.get(id); return e ? { id, playlistId: e.playlistId, title: e.title || e.videoId || 'ローカルファイル' } : { id, title: '一覧から削除された曲' }; };
  return { playlistId: scope, name: scope === '*' ? '全プレイリスト' : AUTO_NAMES[scope] || store.Playlist(scope).name, shuffle: queue.shuffle, repeat: store.data.settings.repeat,
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
  // 拡大中でも、モーダル・曲モード・音声のみ・再生なしのときは拡大を解除する（古い拡大状態を残さない）。
  if (videoFullscreen && (visibleBounds.modalOpen || store?.data.settings.thumbnailMode || current?.offline?.kind === 'audio' || !current)) ExitVideoFullscreen();
  const b = videoFullscreen ? { x: 0, y: 0, width, height, visible: true } : visibleBounds;
  const x = Math.min(width, Math.max(0, Math.ceil(b.x))), y = Math.min(height, Math.max(0, Math.ceil(b.y)));
  const bounds = { x, y, width: Math.max(0, Math.min(width, Math.floor(b.x + b.width)) - x), height: Math.max(0, Math.min(height, Math.floor(b.y + b.height)) - y) };
  const visible = !!b.visible && !store?.data.settings.thumbnailMode && current?.offline?.kind !== 'audio' && bounds.width > 0 && bounds.height > 0;
  remoteView.setBounds(bounds); remoteView.setVisible(visible);
  if (visible && !viewVisible) RefreshVideo();
  viewVisible = visible;
}
// 動画の拡大（画面全体）。状態はmainだけが持つ。HTMLの全画面（Bilibili自身のボタン）・アプリ内の拡大ボタン・ローカル再生画面の拡大ボタンのどれからでも同じ状態へ入り、
// Esc・動画の入れ替え・モーダル・曲モード・ウィンドウの非表示/全画面解除で必ず解除する。
function EnterVideoFullscreen(byApp) {
  const wc = LivePlayer();
  if (videoFullscreen) return true;
  if (!wc || !win || win.isDestroyed() || !viewVisible || visibleBounds.modalOpen || store?.data.settings.thumbnailMode || current?.offline?.kind === 'audio') return false;
  videoFullscreen = true; fullscreenHtml = byApp ? null : wc;
  if (byApp && !win.isFullScreen()) { fullscreenByApp = true; win.setFullScreen(true); }
  ViewBounds(); try { wc.focus(); } catch {}
  return true;
}
function ExitVideoFullscreen() {
  if (!videoFullscreen) return;
  videoFullscreen = false;
  // Bilibili自身のHTML全画面で入っていた場合は、ページ側の全画面（とElectronが行ったウィンドウの全画面）も解除する。Escを横取りしているため、ここで解除しないと残る。
  const html = fullscreenHtml; fullscreenHtml = null;
  if (html && !html.isDestroyed()) html.executeJavaScript('document.fullscreenElement && document.exitFullscreen()').catch(() => {});
  if (fullscreenByApp) { fullscreenByApp = false; if (win && !win.isDestroyed() && win.isFullScreen()) win.setFullScreen(false); }
  ViewBounds();
}
const ToggleVideoFullscreen = () => { if (videoFullscreen) ExitVideoFullscreen(); else EnterVideoFullscreen(true); return videoFullscreen; };
// 曲モード・非表示から動画モードへ戻したあと、音は進むのに映像だけが止まる状態が稀に起きる（実ElectronのBilibili再生で確認。再現は不安定）。
// 戻した少し後に、映像のフレームが進んでいるかを再生ビュー内で数え、止まっていれば既存の復旧（公式プレイヤーへ切り替えて同じ位置から再開）へつなぐ。
const FRAME_PROBE = `new Promise(resolve => { const v = document.querySelector('video'); if (!v || v.paused || v.ended || typeof v.requestVideoFrameCallback !== 'function') { resolve(true); return; }
  let frames = 0, running = true; const tick = () => { if (!running) return; frames++; v.requestVideoFrameCallback(tick); }; v.requestVideoFrameCallback(tick); const start = v.currentTime;
  setTimeout(() => { running = false; resolve(frames >= 4 || v.currentTime - start < .5); }, 1500); })`;
const frameChecks = new WeakMap();
function VerifyVideoFrames(view) {
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed() || current?.source !== 'bilibili' || current.pageMode) return;
  clearTimeout(frameChecks.get(view)); // 連続した復帰（表示・フォーカス・曲モード解除）では、最後の復帰から数える
  const timer = setTimeout(async () => {
    frameChecks.delete(view);
    const live = () => remoteView === view && viewVisible && !store?.data.settings.thumbnailMode && !wc.isDestroyed() && win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
    const token = generation;
    // 復旧は一度しか使えないため、誤検知で使い切らないよう、間をおいて2回続けて止まっているときだけ復旧する。
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!live() || token !== generation) return;
      let ok = true;
      try { ok = await wc.executeJavaScript(FRAME_PROBE); } catch { return; }
      if (ok !== false) return;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 1500));
    }
    if (!live() || token !== generation) return;
    PlayerDiagnostic('frame-stall'); recovery?.Trigger(token, 'frame-stall');
  }, 2500);
  timer.unref?.(); frameChecks.set(view, timer);
}
function RefreshVideo() {
  const view = remoteView, wc = view?.webContents;
  if (!view?.navigationReady || !wc || wc.isDestroyed() || store?.data.settings.thumbnailMode) return;
  wc.invalidate?.(); SendToPlayer('media:command', { type: 'refresh-display' });
  VerifyVideoFrames(view);
}
const retiredPlayers = new Map(), playbackRoutes = new Map(); let quitting = false, sessionEnding = false, sessionTimer = null;
let videoFullscreen = false, fullscreenByApp = false, fullscreenHtml = null;
function DisposePlayer(view) {
  const retired = retiredPlayers.get(view);
  if (!retired || retired.closing) return;
  clearImmediate(retired.timer); retired.closing = true;
  const wc = retired.contents;
  try { if (win && !win.isDestroyed()) win.contentView.removeChildView(view); } catch (error) { PlayerDiagnostic('detach-failed', { message: error.message }); }
  try { if (wc && !wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }); }
  catch (error) { retired.closing = false; PlayerDiagnostic('close-failed', { message: error.message }); }
  // close中にview.webContentsが消えるため、取得済みの参照だけを使う。
  if (!wc || wc.isDestroyed()) { view.releaseOffline?.(); retiredPlayers.delete(view); }
}
function CloseView() {
  ExitVideoFullscreen();
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
  // 前回の続きから再生：曲・再生範囲・位置を、この端末にだけ保存する（約10秒ごと・一時停止の瞬間）
  if (current?.playlistId && queue?.playlistId) resumeStore?.Observe({ entryId: current.entryId, playlistId: current.playlistId, scope: AUTO_NAMES[queue.playlistId] ? '*' : queue.playlistId, position: data.position, duration: data.duration }, data.paused === true);
  if (current?.officialPlayer && !data.paused && data.position >= 3) { officialPreferred.add(current.entry.videoId); const season = playbackMetadata.get(current.entry.videoId)?.ugc_season?.id; if (season) officialPreferred.add(`season:${season}`); if (officialPreferred.size > 1000) officialPreferred.delete(officialPreferred.values().next().value); }
}
function StopPlayer() {
  loadRequest++;
  CloseView(); current = null; playback = null; thumbnail = null; queue.Clear();
  Emit('current', null); Emit('playback', null); Emit('resume', ResumeOffer()); UpdatePresence(); backgroundMode?.Refresh();
}
// 「前回の続きから」の案内（再生中でなく、保存した曲がライブラリにあるときだけ）。位置は、規則で補正済み。
function ResumeOffer() {
  const saved = resumeStore?.Get();
  if (!saved || current || !store) return null;
  let entry = null;
  try { entry = store.Entries(saved.scope).find(e => e.id === saved.entryId) || null; } catch {}
  if (!entry) return null;
  return { title: entry.title || entry.videoId || 'ローカル動画', position: saved.position, duration: saved.duration };
}
// factor：おやすみタイマーの終わりの音量の倍率（1＝設定の音量。設定の値は変えない）。
function SetVolume(factor = 1) {
  // 曲ごとの自動調整（保存済み・ローカルの曲だけ。大きい曲を下げる。設定でオフにできる）
  const volume = store.data.settings.volume * factor * (store.data.settings.volumeLeveling === false ? 1 : songGain); biliBrowser?.SetVolume(volume);
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
    view.releaseOffline?.();
    retiredPlayers.delete(view);
    if (remoteView !== view) return;
    view.navigationReady = false; viewVisible = false;
    if (quitting) return;
    PlayerDiagnostic('view-destroyed');
    if (current?.source === 'bilibili') recovery?.Trigger(generation, 'view-destroyed');
    else { StopPlayer(); Notify('[FP-PLAYER-VIEW-DESTROYED] 再生画面が閉じられました。曲を選び直して再生できます。'); }
  });
  wc.on('focus', () => { if (remoteView === view) UpdateForeground(); });
  // Bilibili自身の全画面ボタン（HTMLの全画面）も、同じ拡大状態へ入る。入れないとき（動画が見えていない等）はHTML側を解除する。
  wc.on('enter-html-full-screen', () => { if (remoteView !== view) return; if (!EnterVideoFullscreen(false)) wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()').catch(() => {}); });
  wc.on('leave-html-full-screen', () => { if (remoteView !== view) return; fullscreenHtml = null; ExitVideoFullscreen(); });
  wc.on('before-input-event', (event, input) => { if (remoteView === view && videoFullscreen && input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); ExitVideoFullscreen(); } });
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
  try { if (store.RememberVideo(entry, details)) { Emit('state', store.Snapshot()); if (offline) Emit('downloads', offline.Snapshot()); } }
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
  const release = saved ? offline.Pin(saved) : null; let view;
  try { view = MakeView(source, forceNew || pageMode || !!saved || !!remoteView?.offlineRoute, officialPlayer); }
  catch (error) { release?.(); throw error; }
  if (saved) {
    const id = randomUUID(); view.offlineRoute = id; playbackRoutes.set(id, { record: saved });
    view.releaseOffline = () => { playbackRoutes.delete(id); release(); };
  }
  const gen = generation; view.resume = resume;
  if (!preserveCount) playCounts?.Begin(entry);
  songGain = 1; void LevelCurrent(request, saved ? offline.ResolvePath(saved.file) : entry.type === 'local' ? path.join(store.media, entry.fileName) : null);
  current = { source, queuePlaylistId: queue.playlistId, playlistId, entryId, entry: structuredClone(entry), pageMode, officialPlayer, recoveryAttempt, offline: saved ? { token: saved.token, kind: saved.kind, height: saved.height } : null };
  PlayerDiagnostic('track-change', { source, saved: !!saved });
  playback = null; thumbnail = null; UpdatePresence(); UpdateForeground(); Emit('current', current); void LoadThumbnail(); backgroundMode?.Refresh();
  recovery?.Begin(gen, source === 'bilibili' && !pageMode && allowRecovery);
  const url = saved ? `favecus://app/local.html?offline=${saved.token}&playback=${view.offlineRoute}&kind=${saved.kind === 'audio' ? 'audio' : 'video'}${Number.isInteger(saved.height) && saved.height > 0 && saved.height < 10000 ? `&height=${saved.height}` : ''}` : entry.type === 'local' ? `favecus://app/local.html?media=${entry.fileName}` : pageMode ? entry.url : officialPlayer ? `${entry.url}${entry.url.includes('?') ? '&' : '?'}autoplay=1` : PlayerURL(entry, details);
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
  const next = ScopeEntries(nextQueue.playlistId).find(e => e.id === id) || nextQueue.catalog.get(id); // 「次に再生」で足した、ほかのリストの曲も
  if (!next) return;
  PlayableEntry(next.playlistId, id); queue = nextQueue;
  await LoadEntry(next.playlistId, id);
}
function SyncPlayingQueue() {
  if (!current?.playlistId) return;
  const list = store.data.playlists.find(p => p.id === current.playlistId);
  if (!list?.entries.some(e => e.id === current.entryId)) StopPlayer();
  else {
    const scope = queue.playlistId === '*' || AUTO_NAMES[queue.playlistId] || store.data.playlists.some(p => p.id === queue.playlistId) ? queue.playlistId : list.id;
    const entries = ScopeEntries(scope);
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
async function Play(playlistId, entryId, resume = null) {
  const entries = store.Entries(playlistId), selected = entries.find(e => e.id === entryId) || (!entryId ? entries[0] : null);
  if (!selected) throw new Error('再生する曲がありません。');
  PlayableEntry(selected.playlistId, selected.id);
  queue.Start(playlistId, entries, selected.id, store.data.settings.shuffle);
  return LoadEntry(selected.playlistId, selected.id, false, resume ? { resume } : {});
}
async function ShufflePlay(playlistId) {
  const entries = store.Entries(playlistId);
  if (!entries.length) throw new Error('再生する曲がありません。');
  const nextQueue = new Queue(null, ShuffleWeight, randomInt), first = nextQueue.ShuffleStart(playlistId, entries), selected = entries.find(e => e.id === first);
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
  trashStore = new TrashStore(path.join(app.getPath('userData'), 'trash.json'));
  favorites = new FavoriteStore(path.join(app.getPath('userData'), 'favorites.json'));
  loudness = new LoudnessStore(path.join(app.getPath('userData'), 'loudness.json'), ffmpeg);
  store = new Store(app.getPath('userData'), { trash: item => trashStore.Add(item), committed: () => { offline?.ScheduleCleanup(); sync?.Changed(); }, convertWma: (source, destination) => ConvertWma(ffmpeg, source, destination) });

  // プレイリストの同期（既定はオフ。利用者が設定で有効にしたときだけ動く）。library.jsonが正本で、同期の状態はuserData/sync/にある。
  const syncDirectory = path.join(app.getPath('userData'), 'sync');
  sync = new SyncService({
    directory: syncDirectory, adapter: StoreAdapter(store, { validateLibrary: input => ValidateLibrary(input), mediaKey: LibraryMediaKey }), vault: new SessionVault(syncDirectory, safeStorage),
    request: async (method, url, { headers, body }) => { const response = await net.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) }); return { status: response.status, json: await response.json().catch(() => null) }; },
    // 再生回数・「再生回数が少ない曲を優先する」設定の同期（ライブラリの同期のあとに行う）
    extras: () => ({
      Read: async () => playCounts.SyncRead({ weighted: store.data.settings.weightedShuffle !== false, at: store.data.settings.weightedShuffleAt || 0 }),
      Apply: async ({ rows, epoch, cursor, prefs }) => { playCounts.SyncApply({ rows, epoch, cursor }); if (prefs) Emit('state', store.Apply({ type: 'settings', settings: { weightedShuffle: prefs.weighted, weightedShuffleAt: prefs.at } })); },
      Pushed: async () => playCounts.SyncPushed()
    }),
    onStatus: status => Emit('sync', status), onApplied: () => { if (current?.playlistId) SyncPlayingQueue(); Emit('state', store.Snapshot()); }
  });

  protocol.handle('favecus', async request => {
    const url = new URL(request.url);
    if (url.host === 'offline') {
      const token = url.pathname.slice(1), saved = playbackRoutes.get(url.searchParams.get('playback'))?.record;
      return saved?.token === token ? MediaResponse(request, saved.path, offline.Pin(saved)) : new Response(null, { status: 403 });
    }
    if (url.host === 'media') {
      const name = url.pathname.slice(1);
      if (!MEDIA_NAME.test(name) || !store.data.playlists.some(p => p.entries.some(e => e.type === 'local' && e.fileName === name))) return new Response(null, { status: 403 });
      return MediaResponse(request, path.join(store.media, name));
    }
    const names = new Set(['keybindings.js', 'library-tree.js', 'home-view.js', 'library-search.js', 'tree-view.js', 'parent-picker.js', 'index.html', 'app.js', 'style.css', 'local.html', 'local.js', 'preview.js', 'transport-model.js', 'playlist-reader.js', 'queue-follow.js', 'queue-drag.js', 'list-artwork.js', 'browse.html', 'browse.js', 'browse.css', 'mini.html', 'mini.js', 'mini.css', 'icons.svg', 'icon.png', 'music.png']);
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
  offline = new OfflineLibrary({ directory: path.join(process.env.FAVECUS_INSTALL_ROOT || (app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath()), 'downloads'), previousDirectories: process.env.FAVECUS_INSTALL_ROOT ? PreviousInstallRoots(process.env.FAVECUS_INSTALL_ROOT).map(p => path.join(p, 'downloads')) : [], settingsFile: path.join(app.getPath('userData'), 'download-settings.json'), fetch: DownloadFetch(biliSession), ffmpeg, libraryData: () => store.data, referenceData: () => WithTrashedEntries(store.SavedData()), identify: RememberVideo, diagnostic: DownloadDiagnosticLog, changed: value => Emit('downloads', value) });
  await offline.Organize(); archive = new LibraryArchive(store, offline);
  // 再生回数：台帳は play-ledger.json。以前の play-counts.json は、変更せずに1回だけ引き継ぐ（同期は、台帳の行だけを送る）
  playCounts = new PlayCounts(path.join(app.getPath('userData'), 'play-ledger.json'), Notify, { legacyFile: path.join(app.getPath('userData'), 'play-counts.json'), aliases: () => store?.data.videoAliases || [] });
  additionReview = new AdditionReview(store, { resolveTitle: async entry => {
    const data = await biliAccount.Details(entry.videoId);
    RememberVideo(entry, data);
    const page = data?.pages?.find(p => p.page === entry.part) || data?.pages?.[entry.part - 1];
    return data?.pages?.length > 1 ? page?.part || data?.title : data?.title;
  } });
  thumbnails = new Thumbnails(biliAccount, (...args) => net.fetch(...args), ffmpeg, store.media, { resize: data => SmallImage(data, nativeImage), resizeCover: data => CoverImage(data, nativeImage), flat: data => FlatImage(data, nativeImage), crop: (data, rect) => ImageData(nativeImage.createFromDataURL(data).crop(rect).toPNG()) });
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
  // ×ボタンは通知領域（トレイ）へ格納する。通知は出さない。終了はトレイの「終了」から行う。
  // 終了中・OSのシャットダウン/ログオフ/更新ツールの終了要求・トレイのアイコンが無いとき（再表示できなくなるため）は、通常どおり閉じる。
  // 拡大中にウィンドウが隠れる・全画面が解除される・メイン画面側でEscが押されたときも解除する。
  for (const event of ['hide', 'minimize', 'leave-full-screen']) win.on(event, () => {
    // leave-full-screen は非同期に届く。すぐ再度拡大した後に遅れて届いた古い通知では解除しない（まだ全画面なら無視）。
    if (event === 'leave-full-screen') { if (win?.isFullScreen()) return; fullscreenByApp = false; fullscreenHtml = null; }
    ExitVideoFullscreen();
  });
  win.webContents.on('before-input-event', (event, input) => { if (videoFullscreen && input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); ExitVideoFullscreen(); } });
  win.on('close', event => {
    if (quitting || sessionEnding || !mini?.CanHideToTray?.()) return;
    event.preventDefault(); win.hide();
  });
  win.on('query-session-end', () => { sessionEnding = true; clearTimeout(sessionTimer); sessionTimer = setTimeout(() => { sessionEnding = false; }, 30000); sessionTimer.unref?.(); });
  win.on('session-end', () => { clearTimeout(sessionTimer); sessionEnding = true; });
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
  Handle('sync:run', async command => {
    const kind = command?.action;
    if (kind === 'status') return sync.Status();
    if (kind === 'configure') sync.Configure({ url: command.url, anonKey: command.anonKey });
    else if (kind === 'send-code') await sync.SendCode(command.email);
    else if (kind === 'verify') await sync.VerifyCode(command.email, command.code);
    else if (kind === 'enable') { const result = await sync.Enable(); if (!result.ok) throw new Error(result.error); }
    else if (kind === 'disable') sync.Disable();
    else if (kind === 'now') { const result = await sync.SyncNow(); if (!result.ok) throw new Error(result.error); }
    else if (kind === 'sign-out') sync.SignOut();
    else if (kind === 'reset') sync.ResetLink();
    else if (kind === 'unblock') { const result = await sync.Unblock(command.mode); if (!result.ok) throw new Error(result.error); }
    else throw new Error('対応していない操作です。');
    return sync.Status();
  });
  Handle('app:state', () => ({ favorites: FavoriteIds(), sleep: sleepTimer?.State() || { mode: 'off' }, resume: ResumeOffer(), state: store.Snapshot(), statuses, current, playback, thumbnail, queue: QueueState(), downloads: offline.Snapshot(), foreground: Foreground(), accounts: accountStatus, version: app.getVersion(), platform: process.platform }));
  Handle('player:reset-counts', () => { playCounts.Reset(); return true; });
  Handle('downloads:state', () => offline.Snapshot());
  const downloadTarget = options => {
    if (!options || typeof options.includeChildren !== 'boolean') throw new Error('保存対象を指定してください。');
    const list = store.Playlist(options.playlistId), selected = { kind: options.kind, height: options.height, playlistId: list.id, playlistName: list.name, estimateId: options.estimateId };
    if (Object.hasOwn(options, 'entryId') || Object.hasOwn(options, 'entryURL')) {
      if (options.includeChildren || typeof options.entryId !== 'string' || typeof options.entryURL !== 'string') throw new Error('保存する1曲を指定してください。');
      const entry = store.Entry(list.id, options.entryId);
      if (entry.type !== 'bilibili' || ParseBilibili(options.entryURL).url !== entry.url) throw new Error('保存対象が変更されました。動画の編集を開き直してください。');
      return { entries: [{ ...entry, playlistId: list.id }], options: { ...selected, entryId: entry.id, entryURL: entry.url } };
    }
    return { entries: options.includeChildren ? store.Entries(list.id) : list.entries.map(e => ({ ...e, playlistId: list.id })), options: selected };
  };
  Handle('downloads:estimate', options => { const target = downloadTarget(options); return offline.Estimate(target.entries, target.options); });
  Handle('downloads:estimate-cancel', () => offline.CancelEstimate());
  Handle('downloads:start', options => { const target = downloadTarget(options); return offline.Start(target.entries, target.options); });
  Handle('downloads:cancel', () => offline.Cancel());
  Handle('downloads:prefer', value => offline.PreferSaved(value));
  Handle('downloads:directory', async () => { if (offline.controller) throw new Error('保存中は保存先を変更できません。'); const result = await dialog.showOpenDialog(win, { title: '動画・音声の保存先', defaultPath: offline.directory, properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? offline.Snapshot() : offline.SetDirectory(result.filePaths[0]); });
  Handle('downloads:open', async () => { fs.mkdirSync(offline.directory, { recursive: true }); if (await shell.openPath(offline.directory)) throw new Error('保存先を開けませんでした。'); return true; });
  Handle('library:thumbnail', async (playlistId, entryId, scope = store.data.activePlaylistId, variant = 'small') => {
    const entry = structuredClone(store.Entry(playlistId, entryId)); variant = variant === 'cover' ? 'cover' : 'small';
    const saved = offline.Find(entry);
    if (saved) {
      let cover = offline.Cover(entry);
      // 保存済みのサムネイルが一色に近い場合は、保存済みの動画（なければオンライン）の60秒付近の場面に置き換えて表示する（保存データは変えない）。
      if (cover) cover = await thumbnails.Improve(entry, cover, saved.kind === 'video' ? saved.path : '');
      return cover ? (variant === 'cover' ? CoverImage : SmallImage)(cover, nativeImage) : null;
    }
    const active = () => !!win && !win.isDestroyed() && (scope === '*' || scope === store.data.activePlaylistId && store.Entries(scope).some(e => e.id === entryId)) && !!store.data.playlists.find(p => p.id === playlistId)?.entries.some(e => e.id === entryId);
    return thumbnails.GetPreview(entry, active, variant);
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
  let exporting = false;
  Handle('library:export', async (options = {}) => {
    const mode = ShareMode(options), information = mode === 'information';
    if (exporting) throw new Error('別の出力処理が進行中です。完了後にもう一度お試しください。');
    exporting = true;
    try {
      const result = await dialog.showSaveDialog(win, { title: information ? 'プレイリスト情報のみ出力' : 'DLデータを含めて出力',
        defaultPath: `FavecusPlayer-playlists-${information ? 'information' : 'media'}-${new Date().toISOString().slice(0, 10)}.${information ? 'json' : 'zip'}`,
        filters: information ? [{ name: 'プレイリスト情報（JSON）', extensions: ['json'] }, { name: 'ZIPアーカイブ', extensions: ['zip'] }] : [{ name: 'ZIPアーカイブ', extensions: ['zip'] }] });
      return result.canceled ? null : await archive.Export(result.filePath, undefined, { mode });
    } finally { exporting = false; }
  });
  Handle('library:import', async () => {
    const result = await dialog.showOpenDialog(win, { title: 'プレイリストのJSON・ZIPを選択', properties: ['openFile'], filters: [{ name: 'Favecus Playerのプレイリスト', extensions: ['zip', 'json'] }] });
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
  Handle('player:play', (playlistId, entryId) => Play(playlistId, entryId));
  // 自動リスト：kind なし＝3つの件数、kind あり＝その曲の一覧（開いた時点の並びを、再生範囲として覚える）
  Handle('library:auto-list', kind => {
    if (!kind) { const lists = BuildAutoLists(); return { frequent: lists.frequent.length, recent: lists.recent.length, unplayed: lists.unplayed.length, favorites: lists.favorites.length }; }
    return AutoEntries(kind).map(e => ({ id: e.id, playlistId: e.playlistId, title: e.title || e.videoId || 'ローカルファイル', type: e.type, count: playCounts?.Count(e) || 0 }));
  });
  Handle('player:auto-play', (kind, entryId, shuffled) => AutoPlay(kind, typeof entryId === 'string' ? entryId : null, shuffled === true));
  // 最近削除（一覧・元に戻す・完全に削除）。元に戻すのは共通の規則（core/trash.cjs）。失敗したときは、保管を残して、理由を返す。
  // お気に入り：曲のメディア単位（同じ動画・パートは、どのリストにあっても共通）。この端末内だけ（同期しない）。
  Handle('library:favorite', (playlistId, entryId, value) => {
    const entry = store.Entry(String(playlistId), String(entryId)), key = playCounts?.KeyOf(entry);
    favorites.Set(key, value === true);
    const ids = FavoriteIds(); Emit('favorites', ids); return ids;
  });
  Handle('trash:list', () => { const list = trashStore.List(); if (trashStore.TakePruned()) offline?.ScheduleCleanup(); return list; });
  Handle('trash:restore', id => {
    const item = trashStore.Get(String(id));
    if (!item) throw new Error('この項目は、すでに保管の期限が切れたか、なくなっています。');
    const state = store.Apply({ type: 'restore', item });
    trashStore.Remove(item.id); Emit('state', state);
    return trashStore.List();
  });
  Handle('trash:delete', id => { trashStore.Remove(String(id)); offline?.ScheduleCleanup(); return trashStore.List(); }); // 完全に削除したあと、参照のなくなった保存済みメディアを整理する
  Handle('trash:clear', () => { trashStore.Clear(); offline?.ScheduleCleanup(); return []; });
  Handle('player:resume-last', () => {
    const saved = resumeStore?.Get();
    if (!saved || !ResumeOffer()) throw new Error('前回の続きがありません。');
    return Play(saved.scope, saved.entryId, saved.position > 0 ? { position: saved.position, paused: false } : null);
  });
  Handle('player:shuffle', ShufflePlay);
  Handle('player:fullscreen', () => ToggleVideoFullscreen());
  Handle('player:all', AllPlay);
  Handle('player:command', Command);
  Handle('player:shortcut', Shortcut);
  Handle('player:volume', ChangeVolume);
  // おやすみタイマー（規則は core/sleep-timer.cjs。iPhone版と同じ）。終わりに、音量を下げて一時停止し、音量を戻す。
  resumeStore = new ResumeStore(path.join(app.getPath('userData'), 'playback-resume.json'));
  sleepTimer = new SleepTimer({
    onFade: factor => SetVolume(factor),
    onExpire: () => SendToPlayer('media:command', { type: 'pause' }),
    onChange: state => Emit('sleep', state)
  });
  // 再生キュー：これから再生する曲の並べ替え・任意の曲へのジャンプ（共通の Queue.Reorder / Queue.JumpTo）
  Handle('queue:reorder', (from, to) => {
    if (!current?.playlistId) return { ok: false };
    const next = queue.Clone(), ok = next.Reorder(Number(from), Number(to));
    if (ok) { queue = next; win?.webContents.send('app:event', { type: 'queue', value: QueueState() }); }
    return { ok };
  });
  // 「次に再生」「最後に追加」：再生中のキューへ、この曲を足す（再生していないときは、何もしない）
  Handle('queue:insert', (playlistId, entryId, where) => {
    if (!current?.playlistId) return { ok: false, idle: true };
    const entry = PlayableEntry(String(playlistId), String(entryId)), next = queue.Clone();
    const ok = where === 'end' ? next.AddToEnd({ ...entry, playlistId: String(playlistId) }) : next.PlayNext({ ...entry, playlistId: String(playlistId) });
    if (ok) { queue = next; win?.webContents.send('app:event', { type: 'queue', value: QueueState() }); }
    return { ok };
  });
  Handle('queue:jump', async id => {
    if (!current?.playlistId) return { ok: false };
    const next = queue.Clone(), target = next.JumpTo(String(id));
    if (!target) return { ok: false };
    const entry = ScopeEntries(next.playlistId).find(e => e.id === target) || next.catalog.get(target);
    if (!entry) return { ok: false };
    PlayableEntry(entry.playlistId, target); queue = next;
    await LoadEntry(entry.playlistId, target);
    return { ok: true };
  });
  Handle('player:sleep', command => {
    if (command?.cancel) sleepTimer.Cancel();
    else if (command?.song) sleepTimer.StartEndOfSong();
    else sleepTimer.Start(Number(command?.minutes));
    return sleepTimer.State();
  });
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
    // 画面側が動画を表示しないと報告したとき（モーダル・ホーム・曲モード等）は、拡大を残さない。
    if (videoFullscreen && !bounds.visible) ExitVideoFullscreen();
    visibleBounds = bounds; ViewBounds(); SyncShortcuts();
  });
  // ローカル再生画面（favecus://app/local.html）の拡大・画質ボタン。Bilibiliなど外部ページには公開しない（preload側でも同じ条件）。引数は受け取らず、mainの現在の曲を使う。
  const TrustedLocalPlayer = event => TrustedMediaEvent(event) && /^favecus:\/\/app\/local\.html(?:\?|$)/.test(String(event.senderFrame?.url || ''));
  ipcMain.on('media:fullscreen', event => { if (TrustedLocalPlayer(event)) ToggleVideoFullscreen(); });
  ipcMain.on('media:quality', event => {
    if (!TrustedLocalPlayer(event) || current?.offline?.kind !== 'video' || !current.playlistId || !current.entryId) return;
    ExitVideoFullscreen(); Emit('change-quality', { playlistId: current.playlistId, entryId: current.entryId });
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
      if (sleepTimer?.ConsumeEndOfSong()) return; // 「曲の終わりまで」：次の曲へ進まず、ここで止める
      void Step(1, true).catch(error => { StopPlayer(); Notify(error.message); });
    }
  });
  await win.loadURL('favecus://app/index.html'); await Configure();
  sync.Start();
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
  quitting = true; resumeStore?.Flush(); loadRequest++; sync?.Dispose(); offline?.CancelEstimate();
  offline?.Cancel();
  if (volumeSaveTimer) { clearTimeout(volumeSaveTimer); volumeSaveTimer = null; try { store?.Save(); } catch {} }
  biliBrowser?.Destroy(); backgroundMode?.Dispose(); mini?.Destroy(); mini = null; presence?.Stop(); CloseView(); for (const view of retiredPlayers.keys()) DisposePlayer(view); offline?.cleanup.Dispose();
});
