'use strict';
// IPC：ライブラリの操作・追加・取り込み・書き出し・サムネイル
// main.cjs から分けたもの（動作は同じ）。状態（store・current など）は、ctx 経由で、その都度読む（S.store など）。
module.exports = function RegisterLibrary(ctx) {
  const S = ctx;
  const { fs, ScanFolder, ReadTags, AcceptPlayback, Configure, CoverImage, Emit, FavoriteIds, Handle, LoadThumbnail, LocalDuration, MEDIA_EXTENSIONS, RefreshVideo, ShareMode, SmallImage, SyncPlayingQueue, SyncShortcuts, ViewBounds, dialog, nativeImage, path } = ctx;
  Handle('library:thumbnail', async (playlistId, entryId, scope = S.store.data.activePlaylistId, variant = 'small') => {
    const entry = structuredClone(S.store.Entry(playlistId, entryId)); variant = variant === 'cover' ? 'cover' : 'small';
    const saved = S.offline.Find(entry);
    if (saved) {
      let cover = S.offline.Cover(entry);
      // 保存済みのサムネイルが一色に近い場合は、保存済みの動画（なければオンライン）の60秒付近の場面に置き換えて表示する（保存データは変えない）。
      if (cover) cover = await S.thumbnails.Improve(entry, cover, saved.kind === 'video' ? saved.path : '');
      return cover ? (variant === 'cover' ? CoverImage : SmallImage)(cover, nativeImage) : null;
    }
    const active = () => !!S.win && !S.win.isDestroyed() && (scope === '*' || scope === S.store.data.activePlaylistId && S.store.Entries(scope).some(e => e.id === entryId)) && !!S.store.data.playlists.find(p => p.id === playlistId)?.entries.some(e => e.id === entryId);
    return S.thumbnails.GetPreview(entry, active, variant);
  });
  Handle('library:action', async action => {
    const state = S.store.Apply(action);
    if (S.current?.playlistId && !['select', 'rename', 'title', 'settings'].includes(action.type)) SyncPlayingQueue(false);
    if (S.current?.playlistId && ((action.type === 'title' && S.current.entryId === action.entryId && S.current.playlistId === action.playlistId) || (action.type === 'settings' && Object.hasOwn(action.settings || {}, 'titleCleanupWords')))) {
      S.current.entry.title = S.store.Entry(S.current.playlistId, S.current.entryId).title;
      Emit('current-update', S.current);
      if (S.playback) { S.playback.title = S.current.entry.title || S.store.CleanTitle(S.playback.title) || S.current.entry.videoId || 'ローカル動画'; AcceptPlayback(S.playback); }
      S.mini?.Update();
    }
    if (action.type === 'settings') {
      if (['shuffle', 'playlistSort'].some(key => Object.hasOwn(action.settings || {}, key))) SyncPlayingQueue(false);
      await Configure();
      ViewBounds(); SyncShortcuts();
      if (Object.hasOwn(action.settings || {}, 'thumbnailMode')) { void LoadThumbnail(); if (!state.settings.thumbnailMode) RefreshVideo(); }
      S.backgroundMode?.Refresh();
    }
    Emit('state', state);
    if (S.favorites && !['select', 'rename', 'title', 'settings'].includes(action.type)) Emit('favorites', FavoriteIds());
    return state;
  });
  Handle('library:prepare-add', action => S.additionReview.Prepare(action));
  // フォルダから追加（v0.7.4）：フォルダの中の動画・音楽ファイル（サブフォルダも。最大2000件）を探し、埋め込みのタグ（曲名・アーティスト）を読んで、いつもの追加の確認へ進む。
  // ファイルは、PC内のメディアの置き場へ複製する（元のファイルは変えない）。アーティストは、追加が済んだあと、曲の情報へ入れる。
  const pendingArtists = new Map();
  const pruneArtists = () => { for (const key of pendingArtists.keys()) if (!S.additionReview.plans.has(key)) pendingArtists.delete(key); };
  Handle('library:prepare-folder', async destinationIds => {
    S.store.Targets(destinationIds);
    const selected = await dialog.showOpenDialog(S.win, { title: 'フォルダから動画・音楽を追加', properties: ['openDirectory'] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const found = await ScanFolder(selected.filePaths[0]);
    if (!found.files.length) throw new Error('そのフォルダに、追加できる動画・音楽ファイルが見つかりません。');
    const plan = await S.additionReview.PrepareFiles(destinationIds, found.files, { describe: async file => { const tags = await ReadTags(S.ffmpeg, file); return { title: tags.title, artist: tags.artist }; } });
    pruneArtists();
    const artists = (S.additionReview.plans.get(plan.id)?.items || []).filter(item => item.artist).map(item => ({ fileName: item.entry.fileName, artist: item.artist }));
    if (artists.length) pendingArtists.set(plan.id, artists);
    const notes = [];
    if (found.truncated) notes.push('ファイルが多いため、先頭の2000件までを対象にしました。');
    if (found.skipped) notes.push(`リンク・読めない場所・深い階層の${found.skipped}項目は、飛ばしました。`);
    return { ...plan, warnings: [...(plan.warnings || []), ...notes] };
  });
  Handle('library:prepare-files', async destinationIds => {
    S.store.Targets(destinationIds);
    const selected = await dialog.showOpenDialog(S.win, { title: '動画・音楽ファイルを追加', properties: ['openFile', 'multiSelections'], filters: [{ name: '動画・音楽', extensions: [...MEDIA_EXTENSIONS].map(x => x.slice(1)) }] });
    return selected.canceled ? null : S.additionReview.PrepareFiles(destinationIds, selected.filePaths);
  });
  Handle('library:commit-add', async (id, allowedIds) => {
    const result = await S.additionReview.Commit(id, allowedIds);
    // フォルダから追加した曲のアーティスト（タグ）を、曲の情報へ。追加された曲（ファイルがある）だけ。失敗しても、追加は成功のまま。
    const artists = pendingArtists.get(id); pendingArtists.delete(id);
    for (const item of artists || []) { try { if (fs.existsSync(path.join(S.store.media, item.fileName))) S.notesStore?.Set('local:' + item.fileName, { artist: item.artist }); } catch { /* 曲の情報は、なくても追加は成功 */ } }
    SyncPlayingQueue(false); Emit('state', result.state); if (S.favorites) Emit('favorites', FavoriteIds()); return result;
  });
  Handle('library:cancel-add', id => { pendingArtists.delete(id); S.additionReview.Cancel(id); return true; });
  const SyncMovedCurrent = target => {
    S.current.playlistId = target.playlistId; S.current.entryId = target.entryId;
    S.current.entry = structuredClone(S.store.Entry(target.playlistId, target.entryId));
    if (S.thumbnail) S.thumbnail.entryId = target.entryId;
    Emit('current-update', S.current);
    if (S.playback) { S.playback.title = S.current.entry.title || S.playback.title; AcceptPlayback(S.playback); }
  };
  Handle('library:transfer', action => {
    const result = S.store.Transfer(action);
    if (result.moved && S.current?.playlistId === action.playlistId && S.current?.entryId === action.entryId) SyncMovedCurrent(result.destinations[0]);
    SyncPlayingQueue(false);
    Emit('state', result.state); if (S.favorites) Emit('favorites', FavoriteIds()); return result;
  });
  Handle('library:move-tracks', action => {
    const result = S.store.TransferMany(action);
    const moved = result.mappings.find(m => m.playlistId === S.current?.playlistId && m.entryId === S.current?.entryId);
    if (moved) SyncMovedCurrent(moved.destinations[0]);
    SyncPlayingQueue(false); Emit('state', result.state); if (S.favorites) Emit('favorites', FavoriteIds()); return result;
  });
  let exporting = false;
  Handle('library:export', async (options = {}) => {
    const mode = ShareMode(options), information = mode === 'information';
    if (exporting) throw new Error('別の出力処理が進行中です。完了後にもう一度お試しください。');
    exporting = true;
    try {
      const result = await dialog.showSaveDialog(S.win, { title: information ? 'プレイリスト情報のみ出力' : 'DLデータを含めて出力',
        defaultPath: `FavecusPlayer-playlists-${information ? 'information' : 'media'}-${new Date().toISOString().slice(0, 10)}.${information ? 'json' : 'zip'}`,
        filters: information ? [{ name: 'プレイリスト情報（JSON）', extensions: ['json'] }, { name: 'ZIPアーカイブ', extensions: ['zip'] }] : [{ name: 'ZIPアーカイブ', extensions: ['zip'] }] });
      return result.canceled ? null : await S.archive.Export(result.filePath, undefined, { mode });
    } finally { exporting = false; }
  });
  Handle('library:import', async () => {
    const result = await dialog.showOpenDialog(S.win, { title: 'プレイリストのJSON・ZIPを選択', properties: ['openFile'], filters: [{ name: 'Favecus Playerのプレイリスト', extensions: ['zip', 'json'] }] });
    return result.canceled ? null : S.archive.Prepare(result.filePaths[0]);
  });
  Handle('library:import-commit', async (id, ids, options) => { const result = await S.archive.Commit(id, ids, options); SyncPlayingQueue(false); Emit('state', result.state); if (S.favorites) Emit('favorites', FavoriteIds()); return result; });
  Handle('library:import-cancel', id => S.archive.Cancel(id));
  Handle('library:duration', async (playlistId, entryId) => {
    const entry = S.store.Entry(playlistId, entryId); if (entry.duration) return entry.duration;
    const value = S.offline.Find(entry)?.duration || (entry.type === 'bilibili' ? (await S.biliAccount.Resolve(entry.url)).video?.duration : await LocalDuration(S.ffmpeg, path.join(S.store.media, entry.fileName)));
    const actual = S.store.data.playlists.find(p => p.id === playlistId)?.entries.find(e => e.id === entryId);
    if (actual && value > 0) { actual.duration = value; S.store.Save(); }
    return value || null;
  });
};
