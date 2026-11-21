'use strict';
// 画面（app.js）を、読み込み順に分けたもの：保存（オフライン）の表示と操作、曲のメニュー、移動。全体は、classic script として順に読み込む（index.html）。
function UpdateDownloads(value = {}) {
  const wasBusy = ['running', 'cancelling'].includes(downloadInfo.job?.status);
  downloadInfo = { ...downloadInfo, ...value }; const job = downloadInfo.job, busy = ['running', 'cancelling'].includes(job?.status);
  if (value.available) {
    savedKinds = new Map(); for (const item of value.available) { const kinds = savedKinds.get(item.url) || new Set(); kinds.add(item.kind); savedKinds.set(item.url, kinds); }
    for (const badge of $('entries').querySelectorAll('.entry-type')) if (badge.dataset.mediaUrl) PaintSavedBadge(badge, { type: 'bilibili', url: badge.dataset.mediaUrl });
    for (const [badge, entry] of homeSearchBadges) PaintSavedBadge(badge, entry);
    if ($('entry-download-state')) PaintSavedBadge($('entry-download-state'), { type: 'bilibili', url: $('entry-download-state').dataset.mediaUrl });
    if ($('download-entry-saved') && downloadSingle) PaintSavedBadge($('download-entry-saved'), { type: 'bilibili', url: downloadSingle.entryURL });
    if (state) UpdateTransport();
  }
  $('downloads-status').textContent = busy ? `保存中 ${job.finished} / ${job.total}件` : '動画・音声の保存';
  clearTimeout(downloadPanelTimer);
  const remaining = !busy && typeof job?.endedAt === 'number' ? Math.max(0, job.endedAt + 5000 - Date.now()) : 0;
  $('download-mini').classList.toggle('hidden', !busy && !remaining);
  $('download-mini-cancel').classList.toggle('hidden', !busy); $('download-mini-cancel').disabled = job?.status === 'cancelling';
  if (job) {
    const active = job.active || [], fraction = active.reduce((n, a) => n + Math.min(.95, a.totalBytes > 0 ? a.bytes / a.totalBytes : /形式|サムネイル/.test(a.phase) ? .95 : 0), 0);
    $('download-mini-gauge').value = job.status === 'completed' || job.status === 'partial' ? 100 : Math.min(busy ? 99 : 100, 100 * (job.finished + fraction) / Math.max(1, job.total));
    $('download-mini-label').textContent = busy ? `${job.status === 'cancelling' ? '中止しています' : '保存中'} ${job.finished} / ${job.total}件` : job.status === 'completed' ? '保存が終了しました。' : job.status === 'partial' ? `保存が終了しました。失敗 ${job.failed}件` : job.status === 'cancelled' ? '保存を中止しました。' : '保存を中断しました。';
    $('download-mini-detail').textContent = busy ? `${active.length}件を処理中${job.estimate?.checked ? ` · ${job.estimate.projected ? '全体の推計' : '確認済み容量'} 約${DownloadBytes(job.estimate.fileBytes)}（${job.estimate.checked}/${job.total}件）` : ' · 容量を計算中'}${job.remainingSeconds == null ? '' : ` · 残り約${DownloadTime(job.remainingSeconds)}`}` : job.failed || job.thumbnailFailed || job.status === 'failed' ? '保存画面でエラーの詳細を確認できます。' : '';
    if (remaining) downloadPanelTimer = setTimeout(() => $('download-mini').classList.add('hidden'), remaining);
  }
  if (!$('download-start')) return;
  $('download-path').textContent = downloadInfo.directory || '標準の保存先';
  for (const id of ['download-kind', 'download-children', 'download-directory', 'download-list-picker', 'download-recalculate']) if ($(id)) $(id).disabled = busy || downloadStarting;
  $('download-start').disabled = busy || downloadStarting || !downloadTargetCount;
  $('download-height').disabled = busy || downloadStarting || $('download-kind').value === 'audio'; $('download-stop').disabled = !busy || job?.status === 'cancelling';
  const states = { running: '保存中', cancelling: '中止しています', cancelled: '中止', completed: '完了', partial: '一部を保存できませんでした', failed: '中断' };
  $('download-progress').textContent = job ? `${job.playlistName}：${states[job.status]} · ${job.finished} / ${job.total}件\n保存 ${job.completed}件 · 保存済み ${job.skipped}件 · 失敗 ${job.failed}件\n${job.phase ? `${job.phase}：${job.title}` : job.message || ''}${job.phase === 'ダウンロード中' ? `\n${(job.bytes / 1048576).toFixed(1)} MB${job.totalBytes ? ` / ${(job.totalBytes / 1048576).toFixed(1)} MB` : ''}` : ''}` : downloadInfo.warning || '形式を選んで「保存を開始」を押してください。';
  if (job) $('download-progress').textContent += `\n全体の取得量：${DownloadBytes(job.downloadedBytes || 0)}${job.estimate && (!job.estimate.unknown || job.estimate.projected) ? ` / 約${DownloadBytes(job.estimate.downloadBytes)}` : ''} · 経過 ${DownloadTime(job.elapsedSeconds || 0)} · 残り ${job.remainingSeconds == null ? '計測中' : `約${DownloadTime(job.remainingSeconds)}`}`;
  if (job?.active?.length) $('download-progress').textContent += `\n${job.active.map(a => `${a.phase}：${a.title}`).join('\n')}`;
  if (!downloadEstimate && value?.estimateProgress?.playlistId === downloadPicker?.get() && (value.estimateProgress.entryId || null) === (downloadSingle?.entryId || null)) $('download-estimate').textContent = `容量を確認中 ${value.estimateProgress.checked} / ${value.estimateProgress.total}件…`;
  if (busy && job.estimate && DownloadJobMatches(job)) $('download-estimate').textContent = DownloadEstimateText(job.estimate);
  if (wasBusy && !busy) void refreshDownloadEstimate?.();
  $('download-errors').replaceChildren(); for (const failure of job?.failures?.slice(-20) || []) $('download-errors').append(Element('p', '', `${failure.title}：[${failure.code || 'FP-DOWNLOAD-UNKNOWN'}] ${failure.message}${failure.recordId ? ` 記録ID: ${failure.recordId}` : ''}`));
  for (const warning of job?.warnings?.slice(-20) || []) $('download-errors').append(Element('p', 'form-note', `${warning.title}：[${warning.code || 'FP-DOWNLOAD-COVER'}] ${warning.message}${warning.recordId ? ` 記録ID: ${warning.recordId}` : ''}`));
}
function SavedState(entry) {
  if (entry.type === 'local') return entry.missing ? { label: 'ファイルなし', detail: 'ローカルファイルが見つかりません。', kind: 'missing' } : { label: 'オフライン', detail: 'PC内のローカルファイルです。', kind: 'local' };
  const kinds = savedKinds.get(entry.url), video = kinds?.has('video'), audio = kinds?.has('audio');
  return video ? { label: 'DL済み', detail: audio ? '動画と音声を保存済みです。' : '動画を保存済みです。', kind: audio ? 'both' : 'video' }
    : audio ? { label: '音声DL済み', detail: '音声のみ保存済みです。動画は未保存です。', kind: 'audio' }
    : { label: 'オンライン', detail: '動画・音声は未保存です。', kind: 'none' };
}
function PaintSavedBadge(badge, entry, playbackDetail = '') {
  const value = SavedState(entry), detail = value.detail + (playbackDetail ? ` ${playbackDetail}` : '');
  if (badge.textContent !== value.label) badge.textContent = value.label;
  if (badge.title !== detail) badge.title = detail;
  const label = `${value.label}：${detail}`; if (badge.getAttribute('aria-label') !== label) badge.setAttribute('aria-label', label);
  if (badge.dataset.savedKind !== value.kind) badge.dataset.savedKind = value.kind;
  if (entry.type === 'bilibili') { if (badge.dataset.mediaUrl !== entry.url) badge.dataset.mediaUrl = entry.url; }
  else delete badge.dataset.mediaUrl;
}
function DownloadBytes(bytes) { return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : `${(bytes / 1048576).toFixed(1)} MB`; }
function DownloadTime(seconds) { if (seconds < 60) return `${Math.ceil(seconds)}秒`; const minutes = Math.ceil(seconds / 60); return minutes < 60 ? `${minutes}分` : `${Math.floor(minutes / 60)}時間${minutes % 60}分`; }
function DownloadEstimateText(e) {
  return `対象 ${e.total}件 · 保存済み ${e.skipped}件${e.checked !== undefined ? ` · 確認 ${e.checked}/${e.total}件` : ''}\n${e.projected ? '確認済みの曲から推計した全体の保存容量：' : e.unknown ? `容量未確定 ${e.unknown}件・確認できた分：` : '追加の保存容量：'}約${DownloadBytes(e.fileBytes)}\n作業用を含む必要空き容量：${e.unknown && !e.projected ? '少なくとも ' : '約'}${DownloadBytes(e.requiredBytes)}${e.freeBytes == null ? '' : ` / 空き ${DownloadBytes(e.freeBytes)}`}`
    + `\n完了までの目安：${e.secondsMin == null ? '未確定の曲があるため算出できません' : `約${DownloadTime(e.secondsMin)}〜${DownloadTime(e.secondsMax)}`}`
    + `\n回線10〜100 Mbpsと形式処理の目安から算出します。容量は画像と一時ファイルの余裕を含む概算です。未確認の曲は確認済みの容量・長さから推計し、保存中に更新します。`
    + (e.freeBytes != null && e.requiredBytes > e.freeBytes ? '\n空き容量が不足する見込みです。保存先を変更してください。' : '')
    + (e.failures?.length ? `\n${e.failures.map(f => `${f.title}：[${f.code || 'FP-DOWNLOAD-METADATA'}] ${f.message}`).join('\n')}` : '');
}
function DownloadEntry(target) { return state.playlists.find(p => p.id === target.playlistId)?.entries.find(e => e.id === target.entryId && e.type === 'bilibili' && e.url === target.entryURL); }
function DownloadJobMatches(job) { return job.playlistId === downloadPicker?.get() && (job.entryId || null) === (downloadSingle?.entryId || null) && job.kind === $('download-kind').value && (job.kind === 'audio' || job.height === Number($('download-height').value)); }
function DownloadsDialog(target = null, back = null) {
  const list = target ? state.playlists.find(p => p.id === target.playlistId) : List(), single = target && DownloadEntry(target);
  if (!list || target && !single) { Toast('保存対象が変更されました。動画の編集を開き直してください。'); return; }
  downloadEstimate = null; downloadTargetCount = 0;
  OpenModal(target ? 'この動画のみをダウンロード' : 'プレイリストの動画・音声を保存', `${target ? '<section class="download-target"><p class="form-note">保存対象（1曲）</p><strong id="download-entry-title"></strong><p id="download-entry-meta" class="form-note"></p><p id="download-entry-saved" class="status-detail"></p></section><p class="form-note">表示名の変更はここでは保存しません。「戻る」で編集画面へ戻れます。</p>' : '<fieldset id="download-list-picker" class="download-picker"></fieldset>'}
    <label class="field">保存形式<select id="download-kind"><option value="video">動画（MP4）</option><option value="audio">音声のみ（M4A）</option></select></label>
    <label class="field">動画の画質<select id="download-height"><option value="720">標準：720p（画質と容量のバランス）</option><option value="360">小さめ：360p</option><option value="1080">高画質：1080p</option></select></label>
    <p class="form-note">配信済みのH.264・AACを再圧縮せず保存します。音声は原則192 kbps以下の最良候補を選びます。配信内容により指定画質と異なる場合があります。</p>
    ${target ? '' : '<label class="check-row"><input id="download-children" type="checkbox">子プレイリストも含める</label>'}
    <p id="download-count" class="form-note"></p><p class="form-note">保存先</p><p id="download-path" class="download-path"></p>
    <div class="settings-actions"><button id="download-directory" type="button" class="button secondary">保存先を変更</button><button id="download-open" type="button" class="button secondary">保存先を開く</button></div>
    <p class="form-note">最大3曲を同時に保存します。容量の確認が途中でも開始でき、保存しながら容量と残り時間を更新します。この画面を閉じても保存は続き、左下に進捗を表示します。保存済み・オンラインの再生優先は、設定の「再生・表示」で選べます。</p>
    <p id="download-estimate" class="form-note download-estimate" role="status" aria-live="polite"></p><button id="download-recalculate" type="button" class="button secondary">容量・時間を再計算</button>
    <div class="settings-actions"><button id="download-start" type="button" class="button primary">保存を開始</button><button id="download-stop" type="button" class="button secondary">保存を中止</button></div>
    <p id="download-progress" class="status-detail download-progress" role="status" aria-live="polite"></p><div id="download-errors" class="download-errors"></div>`, null, '保存', back);
  downloadSingle = target;
  if (target) { $('download-entry-title').textContent = EntryTitle(single); $('download-entry-meta').textContent = `${single.videoId} / パート ${single.part}`; PaintSavedBadge($('download-entry-saved'), single); }
  const epoch = modalEpoch; let revision = 0;
  const valid = () => modalEpoch === epoch && $('modal').open;
  const options = () => ({ playlistId: downloadPicker.get(), kind: $('download-kind').value, height: Number($('download-height').value), includeChildren: target ? false : $('download-children').checked, ...(target ? { entryId: target.entryId, entryURL: target.entryURL } : {}) });
  const recalculate = async () => {
    const nonce = ++revision; downloadEstimate = null;
    if (!valid()) return;
    const input = options(), selected = state.playlists.find(p => p.id === input.playlistId), entries = target ? (DownloadEntry(target) ? [DownloadEntry(target)] : []) : selected ? (input.includeChildren ? tree.Entries(state, selected.id) : selected.entries) : [];
    const count = new Set(entries.filter(e => e.type === 'bilibili').map(e => e.url)).size;
    downloadTargetCount = count;
    $('download-count').textContent = target ? count ? 'この動画・パートの1曲だけを保存します。' : '対象の曲が移動・削除されました。編集画面を開き直してください。' : `保存対象 ${count}件（同じURLは1回・ローカルファイルは対象外）`; UpdateDownloads();
    if (['running', 'cancelling'].includes(downloadInfo.job?.status)) { $('download-estimate').textContent = downloadInfo.job.estimate && DownloadJobMatches(downloadInfo.job) ? DownloadEstimateText(downloadInfo.job.estimate) : '別の保存処理が進行中です。終了後に容量を確認します。'; return; }
    if (!count) { $('download-estimate').textContent = '保存対象のBilibili動画がありません。'; return; }
    $('download-estimate').textContent = '容量・時間を確認しています…';
    try { const result = await api.estimateDownload(input); if (!valid() || nonce !== revision) return; downloadEstimate = result; $('download-estimate').textContent = DownloadEstimateText(result); }
    catch (error) { if (valid() && nonce === revision) $('download-estimate').textContent = `見積もりを取得できませんでした。${error.message}`; }
    finally { if (valid() && nonce === revision) UpdateDownloads(); }
  };
  downloadPicker = target ? { get: () => target.playlistId } : window.FavecusParentPicker($('download-list-picker'), state, { selected: downloadInfo.job?.status === 'running' ? downloadInfo.job.playlistId : list.id, allowRoot: false, label: '保存するプレイリストを検索', onChange: () => { void recalculate(); } });
  $('download-kind').value = 'video'; $('download-height').value = '720'; if ($('download-children')) $('download-children').checked = true;
  refreshDownloadEstimate = recalculate;
  cancelModal = () => { revision++; downloadEstimate = null; downloadPicker = null; downloadSingle = null; refreshDownloadEstimate = null; return api.cancelDownloadEstimate(); };
  for (const id of ['download-children', 'download-kind', 'download-height']) if ($(id)) $(id).onchange = () => { void recalculate(); };
  $('download-recalculate').onclick = () => { void recalculate(); };
  $('download-start').onclick = () => Run(async () => {
    if (!downloadTargetCount || downloadStarting || ['running', 'cancelling'].includes(downloadInfo.job?.status)) return;
    const input = { ...options(), ...(downloadEstimate ? { estimateId: downloadEstimate.id } : {}) }; revision++; downloadEstimate = null; downloadStarting = true; UpdateDownloads();
    try { const result = await api.downloadPlaylist(input); UpdateDownloads(result); if (valid()) { if (back) back(); else CloseModal(); } }
    finally { downloadStarting = false; if (valid()) UpdateDownloads(); }
  });
  $('download-stop').onclick = () => Run(async () => UpdateDownloads(await api.cancelDownload()));
  $('download-directory').onclick = () => Run(async () => { const result = await api.downloadDirectory(); if (valid()) { UpdateDownloads(result); await recalculate(); } });
  $('download-open').onclick = () => Run(() => api.openDownloads());
  UpdateDownloads(); void recalculate(); void Run(async () => { const value = await api.downloads(); if (valid() && !downloadStarting) UpdateDownloads(value); });
}

function EntryMenu(entry, draft = undefined) {
  const p = state.playlists.find(p => p.id === entry.playlistId) || List();
  OpenModal('動画の編集', '<label class="field">表示する名前<input id="entry-title-input" maxlength="180"></label>' + (entry.type === 'bilibili' ? '<section class="entry-download"><p id="entry-download-state" class="status-detail"></p><button id="entry-download-button" type="button" class="button secondary">この動画のみをダウンロード</button><p class="form-note">この動画・パートの1曲を保存します。表示名の変更は「保存」で確定します。</p></section>' : '') + '<div class="settings-actions" id="entry-actions"></div><p class="form-note">上下への移動で、再生順を変更できます。</p>', () => Action({ type: 'title', playlistId: p.id, entryId: entry.id, title: $('entry-title-input').value }));
  $('entry-title-input').value = draft ?? EntryTitle(entry);
  if (entry.type === 'bilibili') {
    PaintSavedBadge($('entry-download-state'), entry);
    $('entry-download-button').onclick = () => {
      const value = $('entry-title-input').value, target = { playlistId: p.id, entryId: entry.id, entryURL: entry.url };
      DownloadsDialog(target, () => {
        const latest = DownloadEntry(target);
        if (!latest) { CloseModal(); Toast('対象の曲が変更されました。編集画面を開き直してください。'); return; }
        EntryMenu({ ...latest, playlistId: p.id }, value);
      });
    };
  }
  const index = p.entries.findIndex(e => e.id === entry.id);
  for (const [label, direction] of [['↑ 上へ', -1], ['↓ 下へ', 1]]) {
    const b = Button(label, 'button secondary', async () => { await Action({ type: 'move', playlistId: p.id, entryId: entry.id, direction }); CloseModal(); });
    b.disabled = direction === -1 ? index === 0 : index === p.entries.length - 1; $('entry-actions').append(b);
  }
  $('entry-actions').append(Button('曲の情報（アーティスト・タグ・メモ・チャプター）', 'button secondary', () => { CloseModal(); void SongInfoDialog(p.id, entry); }));
  const favorite = IsFavorite(entry.id);
  $('entry-actions').append(Button(favorite ? '♥ お気に入りから外す' : '♡ お気に入りにする', 'button secondary', async () => { await SetFavorite(p.id, entry.id, !favorite); CloseModal(); Toast(favorite ? 'お気に入りから外しました。' : 'お気に入りにしました。シャッフル再生で、少しだけ選ばれやすくなります。'); }));
  for (const [label, where, done] of [['次に再生', 'next', '次に再生します。'], ['キューの最後に追加', 'end', 'キューの最後に追加しました。']]) {
    $('entry-actions').append(Button(label, 'button secondary', async () => { const r = await api.queueInsert(p.id, entry.id, where); CloseModal(); Toast(r?.ok ? done : r?.idle ? '再生中のときに使えます。' : '追加できませんでした。'); }));
  }
  $('entry-actions').append(Button('別のリストへ移動・追加', 'button secondary', () => { CloseModal(); TransferEntry(p.id, entry); }));
  $('entry-actions').append(Button('リストから外す', 'button secondary danger', async () => { await Action({ type: 'remove', playlistId: p.id, entryId: entry.id }); CloseModal(); }));
}
function DropTrackIntoPlaylist(item, targetId, placement = {}) {
  const entry = state.playlists.find(p => p.id === item.playlistId)?.entries.find(e => e.id === item.entryId), target = state.playlists.find(p => p.id === targetId);
  const anchor = placement.targetId ? target?.entries.find(e => e.id === placement.targetId) : null;
  if (!entry || !target || item.playlistId === targetId || (placement.targetId && !anchor)) return;
  OpenModal('プレイリストへ楽曲を追加・移動', '<p id="drop-track-note" class="form-note"></p><div id="drop-track-actions" class="settings-actions"></div>', null);
  const destination = tree.Path(state, targetId).map(p => p.name).join('/');
  $('drop-track-note').textContent = `「${EntryTitle(entry)}」を「${destination}」の${anchor ? `「${EntryTitle(anchor)}」の${placement.after ? '後' : '前'}` : '末尾'}へどう入れますか？`;
  const epoch = modalEpoch;
  const perform = async mode => {
    if (epoch !== modalEpoch) return false;
    if (mode === 'copy' && !anchor) return AddSelected({ type: 'add-existing', entries: [{ playlistId: item.playlistId, entryId: item.entryId }] }, [targetId]);
    const result = await api.transferEntry({ ...item, destinationIds: [targetId], mode, ...(anchor ? { targetId: anchor.id, after: !!placement.after } : {}) });
    state = result.state; Render(); Toast(mode === 'move' ? '楽曲を移動しました。' : result.skipped ? '追加先にある同じ楽曲を指定位置へ移動しました。' : '楽曲を追加しました。');
  };
  $('drop-track-actions').append(Button('追加（元にも残す）', 'button primary', () => PerformModal(() => perform('copy'), true)), Button('移動', 'button secondary', () => PerformModal(() => perform('move'), true)));
  $('modal-cancel').textContent = 'キャンセル';
}
function TransferEntry(playlistId, entry) {
  const targets = state.playlists.filter(p => p.id !== playlistId);
  OpenModal('別のリストへ移動・追加', '<p id="transfer-track" class="form-note"></p><label class="field">操作<select id="transfer-mode"><option value="copy">追加：元のリストにも残す</option><option value="move">移動：元のリストから外す</option></select></label><p class="form-note">移動・追加先は複数選べます。追加では重複候補を確認できます。移動では同じ動画やファイルがあるリストへ重複登録しません。</p><div id="transfer-targets" class="transfer-targets"></div>', async () => {
    const destinationIds = choose();
    if ($('transfer-mode').value === 'copy') return AddSelected({ type: 'add-existing', entries: [{ playlistId, entryId: entry.id }] }, destinationIds);
    const result = await api.transferEntry({ playlistId, entryId: entry.id, destinationIds, mode: 'move' });
    state = result.state; Render();
    Toast(`${result.moved ? '移動' : '追加'}しました。追加先 ${result.destinations.length}リスト${result.skipped ? `（登録済み ${result.skipped}リスト）` : ''}。`);
  }, '実行する');
  $('transfer-track').textContent = EntryTitle(entry);
  const choose = AddDestinations({ exclude: [playlistId] });
  $('transfer-targets').remove();

}
