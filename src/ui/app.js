'use strict';
// 画面の最後の部分：プレーヤー・転送バー・長さの取得・イベントの接続。前の部分は、src/ui/app/*.js（index.html の読み込み順）。
function HasView() { return HasPlayback(current); }
function SendBounds() {
  if (!api?.bounds) return;
  const b = $('player-slot').getBoundingClientRect();
  api.bounds({ x: b.x, y: b.y, width: b.width, height: b.height, modalOpen: !!$('modal').open, visible: !allListsView && HasView() && !state?.settings.thumbnailMode && !$('modal').open });
}
async function SelectDisplayMode(mode) {
  if (!['song', 'video'].includes(mode) || !state) return;
  const thumbnailMode = mode === 'song';
  if (state.settings.thumbnailMode === thumbnailMode) return;
  await Action({ type: 'settings', settings: { thumbnailMode } });
}
function RenderPlayer() {
  const hasView = HasView();
  const fixed = hasView && (!!state?.settings.thumbnailMode || current?.offline?.kind === 'audio');
  $('empty-player').classList.toggle('hidden', hasView);
  $('loading').classList.toggle('hidden', !hasView || loaded || fixed);
  $('thumbnail-panel').classList.toggle('hidden', !fixed);
  $('mode-song').setAttribute('aria-pressed', String(fixed));
  $('mode-video').setAttribute('aria-pressed', String(!fixed));
  const image = thumbnail?.image || 'music.png';
  if ($('thumbnail-image').getAttribute('src') !== image) $('thumbnail-image').src = image;
  $('thumbnail-title').textContent = current?.entry ? EntryTitle(current.entry) : '';
  $('thumbnail-note').textContent = current?.offline ? '保存済みのファイルから再生しています' : thumbnail?.pending ? 'サムネイルを取得しています…' : thumbnail?.image ? '音声はそのまま再生できます' : 'サムネイルを取得できないため音楽アイコンを表示しています';
  $('view-actions').classList.toggle('hidden', !hasView);
  $('mode-video').disabled = current?.offline?.kind === 'audio';
  $('page-mode').classList.toggle('hidden', current?.entry?.type !== 'bilibili');
  $('page-mode').textContent = current?.offline ? 'オンラインで再生' : current?.pageMode ? 'プレイヤーだけ表示' : '公式ページ表示';
  $('open-official').classList.toggle('hidden', current?.source === 'local');
  requestAnimationFrame(SendBounds); UpdateTransport();
}
function Time(seconds) {
  const n = Math.floor(Number.isFinite(seconds) ? seconds : 0);
  return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
function Transport() { return TransportState({ current, playback, entries: PlaybackEntries() }); }
function PlayingPath() {
  const queued = queueInfo?.timeline?.current;
  const scope = queued && queued.id === current.entryId && queued.playlistId === current.playlistId ? queueInfo.playlistId : current.queuePlaylistId || '*';
  if (!playingLocation || playingLocation.state !== state || playingLocation.owner !== current.playlistId || playingLocation.scope !== scope) {
    playingLocation = { state, owner: current.playlistId, scope, path: ['ホーム', ...tree.Path(state, current.playlistId, scope).map(p => p.name)].join(' ＞ ') };
  }
  return playingLocation.path;
}
function UpdateTransport() {
  RenderResume(); RenderFavorite();
  const { internal, data, canStart, canSeek } = Transport();
  $('now-title').textContent = data?.title || (current?.entry ? EntryTitle(current.entry) : canStart ? List().name : '再生していません');
  $('now-title').title = $('now-title').textContent;
  const path = internal ? PlayingPath() : '';
  $('now-artist').textContent = internal ? `${path}${!data ? ' · 読み込み中' : data.paused ? ' · 一時停止' : ''}` : canStart ? '▶ で最初の動画から再生' : '動画を選んで再生';
  $('now-artist').title = internal ? `${path}${data?.artist ? `\nアーティスト：${data.artist}` : ''}` : $('now-artist').textContent;
  const entry = internal ? state.playlists.find(p => p.id === current.playlistId)?.entries.find(e => e.id === current.entryId) || current.entry : null;
  $('now-saved').classList.toggle('hidden', !entry);
  if (entry) {
    PaintSavedBadge($('now-saved'), entry, current.offline ? `現在は保存済みの${current.offline.kind === 'audio' ? '音声' : '動画'}から再生しています。` : entry.type === 'bilibili' ? '現在はオンラインで再生しています。' : 'ローカルファイルから再生しています。');
  } else { $('now-saved').textContent = ''; $('now-saved').title = ''; $('now-saved').removeAttribute('aria-label'); delete $('now-saved').dataset.mediaUrl; delete $('now-saved').dataset.savedKind; }
  SetIcon($('toggle'), data && !data.paused ? 'pause' : 'play');
  $('toggle').setAttribute('aria-label', data && !data.paused ? '一時停止' : '再生');
  if (!seeking) { $('position').textContent = Time(data?.position); $('progress').max = data?.duration || 1; $('progress').value = data?.position || 0; }
  $('duration').textContent = Time(data?.duration);
  $('progress').disabled = !canSeek; $('toggle').disabled = !internal && !canStart; $('stop').disabled = !internal;
  for (const id of ['previous', 'next']) $(id).disabled = !internal;
  for (const id of ['back-ten', 'forward-ten']) $(id).disabled = !canSeek;
}
function UpdateStatus() {
  const connected = statuses.discord?.code === 'connected';
  $('discord-status').classList.toggle('connected', connected);
  $('discord-label').textContent = connected ? 'Discord 接続済み' : state?.settings.discordEnabled ? 'Discord 接続待ち' : 'Discord 未設定';
  if ($('discord-detail')) $('discord-detail').textContent = statuses.discord?.text || '';
  if ($('taskbar-detail')) $('taskbar-detail').textContent = statuses.taskbar?.text || '下向き矢印を押すと埋め込みを試します';
}

function EntryDuration(entry) { return entry.duration > 0 ? (entry.duration < 600 ? '0' : '') + Time(entry.duration) : '--:--'; }
function UpdateDuration(id, duration) {
  if (!(duration > 0)) return;
  // 全リストの曲を1回だけ走査して、同じIDの曲の長さを更新する（最後に見つかった曲で、表示を作り直す）
  let target = null;
  for (const p of state.playlists) for (const e of p.entries) if (e.id === id) { e.duration = duration; target = e; }
  if (!target) return;
  const text = target.type === 'bilibili' ? `${EntryDuration(target)} · ${target.videoId} · P${target.part || 1}` : `${EntryDuration(target)} · このPCに保存したファイル`;
  for (const info of $('entries').querySelectorAll('.entry-info')) if (info.dataset.durationEntry === id) info.querySelector('small').textContent = text;
}
function PumpDurations() {
  while (foreground && durationPending < 2 && durationQueue.size && api.entryDuration) {
    const [id, entry] = durationQueue.entries().next().value; durationQueue.delete(id); if (durationFailures.has(id)) continue; durationPending++;
    api.entryDuration(entry.playlistId, id).then(value => { if (value > 0) UpdateDuration(id, value); else durationFailures.add(id); }).catch(() => durationFailures.add(id)).finally(() => { durationPending--; PumpDurations(); });
  }
}
function BackgroundInteractive(enabled) {
  if (!document.querySelectorAll) return;
  const blocked = $('modal').open;
  for (const node of document.querySelectorAll('.sidebar, main, .transport, .titlebar')) node.inert = blocked;
  enabled = enabled && foreground && !blocked;
  searchArtwork?.SetEnabled(enabled && allListsView && homeSearchActive);
  homeArtwork?.SetEnabled(enabled && allListsView && !homeSearchActive);
  for (const node of document.querySelectorAll(enabled ? '[data-saved-title]' : '.sidebar [title], main [title], .transport [title]')) {
    if (enabled) { node.title = node.dataset.savedTitle; delete node.dataset.savedTitle; }
    else { node.dataset.savedTitle = node.title; node.removeAttribute('title'); }
  }
}
if (typeof IntersectionObserver !== 'undefined') durationObserver = new IntersectionObserver(changes => {
  for (const { target, isIntersecting } of changes) if (target.durationEntry) { const e = target.durationEntry; if (isIntersecting && !durationFailures.has(e.id)) durationQueue.set(e.id, e); else durationQueue.delete(e.id); }
  PumpDurations();
}, { root: $('entries'), rootMargin: '60px' });
document.addEventListener('pointerdown', event => { if (existingPopup && !existingPopup.contains(event.target) && event.target !== $('add-existing')) CloseExistingPopup(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { queueDrag?.Cancel(); CloseExistingPopup(); } });
window.addEventListener?.('blur', () => { queueDrag?.Cancel(); queueFollower?.Release(); BackgroundInteractive(false); });
window.addEventListener?.('focus', () => { if (!$('modal').open) BackgroundInteractive(true); });
$('modal-form').addEventListener('submit', event => {
  event.preventDefault(); if (submitModal && !$('modal-submit').disabled) PerformModal(submitModal, true);
});
$('modal-close').onclick = CloseModal; $('modal-cancel').onclick = CloseModal;
$('modal').addEventListener('close', () => { if (!$('modal').open) { CancelModalTask(); modalEpoch++; } BackgroundInteractive(true); SendBounds(); });
$('modal').addEventListener('cancel', CancelModalTask);
$('add-url').onclick = () => AddURL();
$('add-existing').onclick = ExistingMenu;
$('empty-add').onclick = () => PlaybackEntries().length ? PlaybackAction(() => api.play(ViewScope())) : AddURL();
$('browse-bilibili').onclick = () => Run(() => api.browseBilibili());
$('new-list').onclick = () => NewList(); $('list-menu').onclick = ListMenu;
$('new-child-list').onclick = () => NewList(List().id);
$('discord-status').onclick = Settings;
$('up-next-toggle').onclick = () => { timelineOpen = !timelineOpen; timelineManual = false; RenderNext(); if (timelineOpen) RenderTimeline(true); };
document.addEventListener('keydown', event => {
  const keys = window.FavecusKeys;
  if (!keys || event.isComposing || !foreground || $('modal').open || dragged || playlistDrag.value || event.defaultPrevented || event.isTrusted === false || keys.Editing(event.target)) return;
  const registered = keys.Action(state?.settings.keybindings, { ...event, code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey, repeat: false }); if (!registered) return;
  event.preventDefault(); event.stopPropagation();
  const action = keys.Action(state?.settings.keybindings, event); if (!action) return;
  if (['next', 'previous', 'toggle'].includes(action)) queueFollower?.Resume();
  void Run(() => api.shortcut({ scope: ViewScope(), code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey, repeat: event.repeat }));
}, true);
for (const type of ['wheel', 'pointerdown', 'keydown', 'touchmove']) $('queue-timeline').addEventListener(type, () => { timelineManual = true; }, { passive: true });
$('all-lists').onclick = () => { allListsView = true; homePath = []; homePage = 0; homeSearchActive = false; $('home-query').value = ''; $('filter').value = ''; Render(); };
function SearchHome() { homeSearchPage = 0; RenderHome(); if (homeSearchActive) $('home').scrollTop = 0; }
$('home-query').addEventListener('input', event => { if (!event.isComposing) SearchHome(); });
$('home-query').addEventListener('compositionend', SearchHome);
$('home-search-clear').onclick = () => { $('home-query').value = ''; SearchHome(); $('home-query').focus(); };
$('sort-lists').onclick = SortLists;
$('downloads-status').onclick = () => DownloadsDialog();
$('download-mini-cancel').onclick = () => Run(async () => UpdateDownloads(await api.cancelDownload()));
$('playlist-up').onclick = () => Run(async () => {
  const parentId = allListsView ? null : tree.Parent(state, List().id); if (!parentId) return;
  $('filter').value = ''; tree.ExpandTo(state, parentId, expandedLists);
  await Action({ type: 'select', playlistId: parentId });
});
$('all-normal').onclick = () => PlaybackAction(async () => { await api.playEverything(false); allListsView = true; Render(); queueFollower?.Request(); });
$('all-shuffle').onclick = () => PlaybackAction(async () => { await api.playEverything(true); allListsView = true; Render(); queueFollower?.Request(); });
$('add-files').onclick = AddLocalFiles;
$('mini-player').onclick = () => Run(() => api.mini());
$('transport-volume').oninput = () => VolumeInput($('transport-volume'));
$('mute').onclick = () => Run(() => api.volume(state.settings.volume > 0 ? 0 : lastVolume));
$('filter').addEventListener('input', () => { queueFollower?.Interact(); RenderEntries(); });
$('entries').addEventListener('wheel', event => { queueFollower?.Interact(); queueDrag?.Wheel(event); }, { passive: false });
$('entries').addEventListener('touchmove', () => queueFollower?.Interact(), { passive: true });
$('entries').addEventListener('keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) queueFollower?.Interact(); });
$('entries').addEventListener('pointerdown', event => { const bounds = $('entries').getBoundingClientRect(); if (event.pointerType === 'touch' || event.clientX >= bounds.right - 18) queueFollower?.Hold(true); });
for (const event of ['pointerup', 'pointercancel']) document.addEventListener(event, () => queueFollower?.Release());
$('shuffle-play').onclick = () => PlaybackAction(() => api.shufflePlay(ViewScope()));
$('play-all').onclick = () => PlaybackAction(() => api.play(ViewScope()));
$('shuffle').onclick = () => Run(() => Action({ type: 'settings', settings: { shuffle: !state.settings.shuffle } }));
$('resume-last').onclick = () => Run(() => api.resumeLast());
$('favorite').onclick = () => Run(() => current?.playlistId ? SetFavorite(current.playlistId, current.entryId, !IsFavorite(current.entryId)) : undefined);
$('sleep').onclick = () => Run(async () => { sleepState = await api.sleepTimer(NextSleepCommand(sleepState)); RenderSleep(); });
$('repeat').onclick = () => Run(() => Action({ type: 'settings', settings: { repeat: { off: 'all', all: 'one', one: 'off' }[state.settings.repeat] } }));
for (const id of ['next', 'previous']) $(id).onclick = () => PlaybackAction(() => api.command(id));
for (const id of ['stop', 'reload', 'back-ten', 'forward-ten']) $(id).onclick = () => Run(() => api.command(id));
$('page-mode').onclick = () => Run(() => api.command(current?.offline ? 'online' : 'page-mode'));
$('toggle').onclick = () => Transport().canStart ? PlaybackAction(() => api.play(ViewScope())) : Run(() => api.command('toggle'));
$('progress').oninput = () => { seeking = true; $('position').textContent = Time(Number($('progress').value)); };
$('progress').onchange = () => { seeking = false; Run(() => api.command('seek', Number($('progress').value))); };
$('progress').addEventListener('pointercancel', () => { seeking = false; UpdateTransport(); });
$('open-official').onclick = () => Run(() => api.openOfficial());
$('mode-song').onclick = () => Run(() => SelectDisplayMode('song'));
$('mode-video').onclick = () => Run(() => SelectDisplayMode('video'));
if (api) {
  api.onEvent(event => {
    if (event.type === 'state') { state = event.value; Render(); if (downloadSingle && (!DownloadEntry(downloadSingle) || !downloadTargetCount)) void refreshDownloadEstimate?.(); }
    else if (event.type === 'current') { current = event.value; loaded = false; playback = null; thumbnail = null; seeking = false; UpdateCurrentRows(); queueFollower?.Request(); RenderPlayer(); RenderNext(); }
    else if (event.type === 'current-update') { current = event.value; Render(); }
    else if (event.type === 'downloads') UpdateDownloads(event.value);
    else if (event.type === 'thumbnail') { thumbnail = event.value; RenderPlayer(); }
    else if (event.type === 'playback') { playback = event.value; UpdateTransport(); }
    else if (event.type === 'shortcut-follow') queueFollower?.Resume();
    else if (event.type === 'duration') { UpdateDuration(event.value.entryId, event.value.duration); }
    else if (event.type === 'volume') SyncVolume(event.value);
    else if (event.type === 'favorites') { favoriteIds = new Set(event.value || []); RenderFavorite(); }
    else if (event.type === 'resume') { resumeOffer = event.value || null; RenderResume(); }
    else if (event.type === 'sleep') { sleepState = event.value || { mode: 'off' }; RenderSleep(); }
    else if (event.type === 'status') { statuses = event.value; UpdateStatus(); }
    else if (event.type === 'loaded') { loaded = true; RenderPlayer(); }
    else if (event.type === 'notice') Toast(event.value);
    else if (event.type === 'sync') PaintSync(event.value);
    else if (event.type === 'accounts') { accounts = event.value; UpdateAccounts(); }
    else if (event.type === 'queue') { queueInfo = event.value; RenderNext(); if (state) UpdateTransport(); }
    else if (event.type === 'foreground') { const changed = foreground !== (event.value === true); foreground = event.value === true; listArtwork?.SetEnabled(foreground); BackgroundInteractive(foreground); if (!foreground) { queueDrag?.Cancel(); queueFollower?.Release(); } if (foreground) { if (changed) queueFollower?.Request(); PumpDurations(); } }
    else if (event.type === 'change-quality') {
      // ローカル再生画面の「別の画質で保存し直す」。既存の1曲の保存画面を開く（切り替えは再保存。新しい画質は次の再生から使う）。
      const target = event.value;
      if ($('modal').open) Toast('開いている画面を閉じてから、もう一度画質の変更を押してください。');
      else {
        const found = target && state.playlists.find(p => p.id === target.playlistId)?.entries.find(e => e.id === target.entryId && e.type === 'bilibili');
        if (found) DownloadsDialog({ playlistId: target.playlistId, entryId: target.entryId, entryURL: found.url });
      }
    }
    else if (event.type === 'add-url') { if (!$('modal').open) AddURL(event.value); else Toast('追加画面が開いています。閉じてから検索画面の追加ボタンを押してください。'); }
  });
  new ResizeObserver(SendBounds).observe($('player-slot'));
  new ResizeObserver(UpdateQueueTail).observe($('entries'));
  Run(async () => { const initial = await api.state(); state = initial.state; current = initial.current; playback = initial.playback; thumbnail = initial.thumbnail; statuses = initial.statuses; queueInfo = initial.queue; foreground = initial.foreground === true; accounts = initial.accounts || {}; loaded = !!playback; sleepState = initial.sleep || { mode: 'off' }; RenderSleep(); resumeOffer = initial.resume || null; favoriteIds = new Set(initial.favorites || []); UpdateDownloads(initial.downloads); $('version').textContent = initial.version; document.body.classList.toggle('mac', initial.platform === 'darwin'); Render(); queueFollower?.Request(); accounts = await api.accounts(); UpdateAccounts(); });
} else Toast('この画面はFavecus Playerのアプリから開いてください。');
