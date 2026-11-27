'use strict';
// 画面（app.js）を、読み込み順に分けたもの：プレイリストURL・取り込み・書き出し。全体は、classic script として順に読み込む（index.html）。
function PlaylistURL(prefill = {}) {
  let browser, destinations;
  OpenModal('再生リストURLから追加', `
    <label class="field">共有文・動画URL・一覧URL<textarea id="playlist-source-url" maxlength="8192" placeholder="【動画名】 https://www.bilibili.com/video/BV…/" required></textarea><small>合集などの動画一覧から、それぞれの動画の全パートへ進めます。</small></label>
    <div class="playlist-url-actions"><button id="playlist-fetch" type="button" class="button secondary">リストを取得</button><button id="playlist-fetch-cancel" type="button" class="button secondary" disabled>取得を中断</button></div>
    <select id="playlist-sources" aria-label="追加元の再生リスト" class="hidden"></select>
    <div id="playlist-navigation" class="playlist-navigation hidden"><button id="playlist-parent" type="button" class="button secondary">← 親のリストへ戻る</button><span id="playlist-path"></span></div>
    <p id="playlist-message" class="status-detail" role="status" aria-live="polite">URLを貼り付けて「リストを取得」を押してください。</p>
    <div id="playlist-selection-tools" class="selection-tools hidden"><button id="playlist-select-all" type="button" class="button secondary">表示中をすべて選択</button><button id="playlist-select-none" type="button" class="button secondary">選択をすべて解除</button><span id="playlist-selected-count"></span></div>
    <label class="field">一覧の動画を検索<input id="playlist-video-filter" type="search" placeholder="曲名・動画番号で検索"></label><div id="playlist-videos" class="favorite-list"></div>`, async () => {
    if (!browser.ready || !browser.selected.size) throw new Error('取得が完了してから、追加する動画にチェックしてください。');
    return AddSelected({ type: 'add-videos', videos: [...browser.selected].map(([url, title]) => ({ url, title, duration: browser.metadata?.get(url)?.duration })) }, destinations());
  }, '選択した動画を追加');
  destinations = AddDestinations({ initialIds: prefill.destinationIds || null });
  const epoch = modalEpoch;
  const visibleVideos = () => (browser.current?.videos || []).filter(v => tree.Matches(`${browser.Title(v)} ${v.title} ${v.videoId}`, $('playlist-video-filter').value));
  const updateSelection = () => {
    const videos = visibleVideos();
    $('playlist-selected-count').textContent = `この一覧 ${videos.filter(v => browser.selected.has(v.url)).length} / ${videos.length}本 · 合計 ${browser.selected.size}本`;
    $('modal-submit').disabled = !browser.ready || !browser.selected.size;
  };
  const render = () => {
    if (epoch !== modalEpoch || !$('modal').open) { browser.Close(); return; }
    const list = browser.current, videos = visibleVideos(), fragment = document.createDocumentFragment();
    for (const [index, video] of videos.entries()) {
      const row = Element('div', 'playlist-video-row'), label = Element('label', 'favorite-row'), checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = browser.selected.has(video.url); checkbox.disabled = browser.busy;
      checkbox.onchange = () => { checkbox.checked ? browser.selected.set(video.url, browser.Title(video)) : browser.selected.delete(video.url); updateSelection(); };
      const info = Element('span', '', `${index + 1}. ${video.title || video.videoId}`);
      info.append(Element('small', '', `${video.videoId}${video.part > 1 ? ` · パート ${video.part}` : ''}${video.artist ? ` · ${video.artist}` : ''}`));
      label.append(checkbox, info);
      const details = Element('div', 'playlist-video-info'), field = Element('label', 'video-title-field', '追加する名前'), name = Element('input');
      name.type = 'text'; name.maxLength = 180; name.value = browser.titles.get(video.url) ?? video.title ?? ''; name.disabled = browser.busy;
      name.setAttribute('aria-label', `${video.title || video.videoId}の追加する名前`); name.oninput = () => browser.Rename(video, name.value); field.append(name); details.append(label, field); row.append(details);
      if (list.source.kind !== 'parts') {
        const open = Button('パートを開く →', 'button secondary playlist-child', () => browser.Enter(video), `${video.title || video.videoId}の全パートを開く`);
        open.disabled = browser.busy; row.append(open);
      }
      fragment.append(row);
    }
    $('playlist-videos').replaceChildren(fragment);
    const sourceSelect = $('playlist-sources'), rootSource = browser.parents[0]?.source || list?.source;
    sourceSelect.replaceChildren();
    for (const [index, source] of browser.sources.entries()) { const option = Element('option', '', source.title); option.value = index; sourceSelect.append(option); }
    sourceSelect.value = Math.max(0, browser.sources.indexOf(rootSource)); sourceSelect.disabled = browser.busy;
    sourceSelect.classList.toggle('hidden', browser.sources.length < 2);
    $('playlist-navigation').classList.toggle('hidden', !list);
    $('playlist-parent').disabled = !browser.parents.length;
    $('playlist-path').textContent = [...browser.parents, ...(list ? [list] : [])].map(p => p.source.title).join(' › ');
    $('playlist-message').textContent = browser.message || 'URLを貼り付けて「リストを取得」を押してください。';
    $('playlist-fetch-cancel').disabled = !browser.busy;
    $('playlist-selection-tools').classList.toggle('hidden', !videos.length);
    $('playlist-select-all').disabled = browser.busy; $('playlist-select-none').disabled = browser.busy;
    updateSelection();
  };
  browser = new window.FavecusPlaylistReader.PlaylistBrowser(api, render);
  $('playlist-fetch').onclick = () => browser.Search($('playlist-source-url').value);
  $('playlist-sources').onchange = () => browser.Select(Number($('playlist-sources').value));
  $('playlist-parent').onclick = () => browser.Back();
  $('playlist-fetch-cancel').onclick = () => browser.Cancel();
  $('playlist-video-filter').oninput = render;
  $('playlist-select-all').onclick = () => { for (const video of visibleVideos()) browser.selected.set(video.url, browser.Title(video)); render(); };
  $('playlist-select-none').onclick = () => { browser.selected.clear(); render(); };
  cancelModal = async () => browser.Close();
  render();
  if (prefill.url) { $('playlist-source-url').value = prefill.url; void browser.Search(prefill.url); }
}
function Transfer() {
  OpenModal('プレイリストの出力・取り込み', `<p class="form-note">ライブラリ内のすべてのプレイリストを、親子関係と並び順を保って出力します。ログイン情報とアプリ設定は含みません。パスワードは不要です。</p>
    <div class="share-options"><section class="share-option"><h3>プレイリスト情報のみ</h3><p class="share-purpose">主な用途：PC・スマホ間で情報を共有</p><p class="form-note">リスト名、親子関係、並び順、曲名、動画リンク、パート番号などを含めます。動画・音声ファイルとDLサムネイルは含めません。</p><button type="button" id="export-information" class="button primary">プレイリスト情報のみ出力</button><p class="form-note">JSON（標準）またはZIP。ローカル曲は登録情報のみです。</p></section>
    <section class="share-option"><h3>DLデータ付き</h3><p class="share-purpose">主な用途：PC間で情報と保存データを共有</p><p class="form-note">上記の情報と、保存済みの動画・音声・サムネイルをZIPにまとめます。ローカルファイルも同梱します。</p><button type="button" id="export-media" class="button primary">DLデータを含めて出力</button><p class="form-note">未保存の曲はリンク情報を保持します。ローカルファイルの不足は完了時に件数を案内します。</p></section></div>
    <p class="form-note">取り込みでは、取り込むリストと取り込み先の親を選べます。情報のみのJSON・ZIP、DLデータ付きZIP、旧形式に対応します。</p><button type="button" id="import-button" class="button secondary">JSON・ZIPを取り込む</button><p id="share-status" class="status-detail" role="status" aria-live="polite"></p>`, null, '保存', Settings);
  const epoch = modalEpoch; let busy = false;
  const valid = () => epoch === modalEpoch && $('modal').open;
  const controls = () => { if (valid()) for (const id of ['export-information', 'export-media', 'import-button']) $(id).disabled = busy; };
  const perform = task => Run(async () => {
    if (busy) return;
    busy = true; controls();
    try { await task(); }
    catch (error) { if (valid()) $('share-status').textContent = `処理を完了できませんでした。${error.message}`; throw error; }
    finally { busy = false; controls(); }
  });
  const output = mode => perform(async () => {
    $('share-status').textContent = '出力先を選んでください。ファイルを作成しています…';
    const result = await api.exportLibrary({ mode }); if (!valid()) return;
    if (!result) { $('share-status').textContent = '出力をキャンセルしました。'; return; }
    const format = result.file?.toLowerCase().endsWith('.json') ? 'JSON' : 'ZIP';
    const message = mode === 'information' ? `プレイリスト情報を${format}で出力しました。${result.omitted ? `ローカルファイル ${result.omitted}件は含めていません。` : ''}`
      : `DLデータ付きZIPを出力しました。保存済み動画・音声 ${result.downloaded || 0}件を同梱しました。${result.missing ? `見つからないローカルファイル：${result.missing}件。` : ''}`;
    $('share-status').textContent = message; Toast(message);
  });
  $('export-information').onclick = () => output('information'); $('export-media').onclick = () => output('media');
  $('import-button').onclick = () => perform(async () => {
    $('share-status').textContent = '取り込むファイルを選んでください。内容を確認しています…';
    const result = await api.importLibrary();
    if (!result) { if (valid()) $('share-status').textContent = '取り込みをキャンセルしました。'; return; }
    if (!valid()) { await api.cancelImport(result.id); return; }
    ImportSelection(result);
  });
}
function ImportSelection(plan) {
  const incoming = { ...plan, playlists: plan.playlists.map(p => ({ ...p, entries: [] })) }, selected = new Set(), expanded = new Set();
  let picker, destination, importing = false;
  const commit = async ids => {
    if (importing) return false;
    if (!ids.length) throw new Error('取り込むプレイリストにチェックしてください。');
    const epoch = modalEpoch;
    importing = true; $('archive-import-all').disabled = true;
    try {
      const result = await api.commitImport(plan.id, ids, { parentId: destination.get() });
      const sameModal = epoch === modalEpoch && $('modal').open;
      if (sameModal) cancelModal = null;
      state = result.state;
      if (sameModal) { allListsView = false; tree.ExpandTo(state, state.activePlaylistId, expandedLists); }
      Render();
      Toast(`${result.imported}リストを親子関係を保って取り込みました。${result.ancestors ? `祖先 ${result.ancestors}リストは階層を保つために追加しました。` : ''}${result.downloaded ? `保存済み動画・音声 ${result.downloaded}件を復元しました。` : ''}${result.missing ? `ファイル不足：${result.missing}件。` : ''}${result.omitted ? `ローカル曲 ${result.omitted}件は登録情報のみ取り込みました。` : ''}`);
      if (!sameModal) return false;
    } finally { importing = false; if ($('archive-import-all')) $('archive-import-all').disabled = false; }
  };
  OpenModal('取り込むプレイリストを選択', '<p id="archive-content-summary" class="form-note"></p><p class="form-note">親を選ぶと子孫もまとめて取り込みます。子だけを選んでも元の祖先を構造として残します。未選択の祖先の曲や、無関係な兄弟は取り込みません。同名リストは別名で追加します。</p><div class="field"><span>取り込み先の親プレイリスト</span><div id="archive-parent"></div></div><label class="field">取り込むリストを検索<input id="archive-search" type="search" placeholder="プレイリスト名を検索"></label><div class="settings-actions"><button id="archive-select-all" type="button" class="button secondary">すべて選択</button><button id="archive-select-none" type="button" class="button secondary">選択を解除</button><button id="archive-import-all" type="button" class="button primary">すべて取り込む</button></div><p id="archive-selection-summary" class="form-note" role="status"></p><div id="archive-lists" class="archive-lists"></div>', () => commit(picker.get()), '選択したリストを取り込む');
  $('archive-content-summary').textContent = plan.mode === 'information' ? '情報のみ：動画・音声ファイルとDLサムネイルは含まれていません。ローカル曲は登録情報のみです。' : plan.mode === 'media' ? 'DLデータ付き：同梱された動画・音声・サムネイルとローカルファイルを復元します。' : '既存形式のプレイリストを取り込みます。';
  cancelModal = () => api.cancelImport(plan.id);
  destination = window.FavecusParentPicker($('archive-parent'), state, { selected: null, label: '取り込み先の親を検索' });
  const summary = () => {
    const value = tree.Selection(incoming, [...selected]);
    $('archive-selection-summary').textContent = `取り込み ${value.playlists.length}リスト · 曲を含む ${value.contentIds.length}リスト${value.ancestorIds.length ? ` · 構造のみ ${value.ancestorIds.length}リスト` : ''}`;
  };
  const render = () => {
    $('archive-lists').replaceChildren();
    picker = window.FavecusTreeView($('archive-lists'), incoming, { selected, expanded, checkboxes: true, selectChildren: true, query: $('archive-search').value,
      count: p => `${p.count}曲${p.downloaded ? ` · 保存済み${p.downloaded}件` : ''}${p.sameName ? '（同名あり）' : ''}`, onChange: summary }); summary();
  };
  $('archive-search').oninput = render;
  $('archive-select-all').onclick = () => { for (const p of plan.playlists) selected.add(p.id); render(); };
  $('archive-select-none').onclick = () => { selected.clear(); render(); };
  $('archive-import-all').onclick = () => PerformModal(() => commit(plan.playlists.map(p => p.id)), true);
  render();
}
