'use strict';
// 画面（app.js）を、読み込み順に分けたもの：再生キュー・曲の一覧・ホーム・全体の描画。全体は、classic script として順に読み込む（index.html）。
function PlayingRow() {
  if (!current) return null;
  const own = entryRows.get(current.entryId); if (own) return own;
  const playlist = playlistRows.get(current.playlistId); if (playlist) return playlist;
  for (const [id, row] of [...playlistRows].reverse()) if (tree.Walk(state, [id]).some(p => p.id === current.playlistId)) return row;
  return null;
}
function UpdateCurrentRows() {
  highlightedRow?.classList.remove('current'); highlightedRow = PlayingRow(); highlightedRow?.classList.add('current');
}
const queueFollower = window.FavecusQueueFollow ? new window.FavecusQueueFollow.QueueFollower({
  now: () => Date.now(), schedule: callback => requestAnimationFrame(callback), foreground: () => foreground,
  allowed: () => !allListsView && !!PlayingRow() && !$('modal').open && !dragged && !playlistDrag.value,
  align: () => {
    const list = $('entries'), row = PlayingRow();
    if (!row) return;
    UpdateQueueTail(); list.scrollTo({ top: list.scrollTop + row.getBoundingClientRect().top - list.getBoundingClientRect().top, behavior: 'instant' });
  }
}) : null;
const queueDrag = window.FavecusQueueDrag ? new window.FavecusQueueDrag({
  list: () => $('entries'), hit: (x, y) => document.elementFromPoint(x, y)?.closest('.entry, .playlist-entry'), schedule: fn => requestAnimationFrame(fn), clear: ClearDropMarks,
  start: item => { dragged = item; queueFollower?.Hold(true); }, end: () => { dragged = null; queueFollower?.Hold(false); }, interact: () => queueFollower?.Interact(),
  drop: (item, target) => target.playlistId ? DropTrackIntoPlaylist(item, target.playlistId, target) : Run(() => Action({ type: 'reorder', playlistId: item.playlistId, entryId: item.entryId, ...target }))
}) : null;
function UpdateQueueTail() {
  const list = $('entries'), tail = list.querySelector('.queue-tail');
  if (tail) tail.style.height = `${Math.max(0, list.clientHeight - (list.children[list.children.length - 2]?.offsetHeight || 0))}px`;
}
function RenderNext() {
  const box = $('up-next');
  box.classList.toggle('hidden', !current || !queueInfo);
  box.classList.toggle('expanded', timelineOpen); $('up-next-toggle').setAttribute('aria-expanded', String(timelineOpen));
  $('queue-timeline').classList.toggle('hidden', !timelineOpen);
  $('up-next-label').textContent = queueInfo?.repeat === 'one' ? '次に再生 · 1曲リピート' : '次に再生';
  const next = queueInfo?.next;
  const path = next ? tree.Path(state, next.playlistId, queueInfo.playlistId).map(p => p.name).join('/') : '';
  $('up-next-path').textContent = path; $('up-next-path').title = path;
  $('up-next-title').textContent = next ? `${String(next.index).padStart(2, '0')}　${next.title}` : 'この曲で再生リストが終了します';
  box.title = next ? `${path || queueInfo.name} / ${next.index}. ${next.title}` : '';
  if (timelineOpen) RenderTimeline(!timelineManual);
}
function RenderTimeline(focusNext = false) {
  const list = $('queue-timeline'), previousTop = list.scrollTop; list.replaceChildren();
  const data = queueInfo?.timeline; if (!data) return;
  const row = (track, label, className) => { const line = Element('div', `timeline-row ${className}`); line.append(Element('small', '', label), Element('strong', '', track.title)); list.append(line); return line; };
  for (const track of data.history) row(track, '再生済み', 'timeline-history');
  if (data.current) row(data.current, '現在の曲', 'timeline-current');
  let first;
  for (const [index, track] of data.upcoming.entries()) {
    const line = row(track, `次の${index + 1}曲目`, 'timeline-future'); if (!first) first = line;
    // 並べ替え・この曲へ移る（1曲リピート中は、同じ曲が並ぶだけなので出さない）
    if (queueInfo.repeat !== 'one' && track.id) {
      const actions = Element('span', 'timeline-actions');
      const make = (text, label, run, disabled) => { const b = Button(text, 'timeline-action', () => { queueFollower?.Interact(); return run(); }, label); b.disabled = !!disabled; return b; };
      actions.append(make('▲', '1つ前へ', () => api.queueReorder(index, index - 1), index === 0), make('▼', '1つ後ろへ', () => api.queueReorder(index, index + 1), index >= data.upcoming.length - 1), make('▶', 'この曲へ移る', () => PlaybackAction(() => api.queueJump(track.id))));
      line.append(actions);
    }
  }
  if (!data.upcoming.length) list.append(Element('p', 'form-note', 'この曲で再生リストが終了します。'));
  if (focusNext && first) list.scrollTop += first.getBoundingClientRect().top - list.getBoundingClientRect().top;
  else list.scrollTop = previousTop;
}
function ClearDropMarks() { for (const e of document.querySelectorAll('.drop-before, .drop-after, .playlist-entry.drop-child')) e.classList.remove('drop-before', 'drop-after', 'drop-child'); }
// 曲の並べ替え・絞り込み（リストごと。規則は ui/entry-view.js。材料は main の list:stats）。選んでいる間は、手動の並べ替え（ドラッグ）は使えない。
const listViewStats = new Map();
const ListView = playlistId => (window.FavecusEntryView && listViews[playlistId]) || null;
function ViewStatsFor(playlistId) {
  if (listViewStats.has(playlistId)) return listViewStats.get(playlistId);
  listViewStats.set(playlistId, null); // 取得中
  api.listStats?.(playlistId).then(value => { listViewStats.set(playlistId, value || {}); RenderEntries(); }).catch(() => listViewStats.set(playlistId, {}));
  return null;
}
function ArrangeRows(playlist, rows) {
  const view = ListView(playlist.id);
  if (!view || allListsView) return rows;
  const stats = ViewStatsFor(playlist.id);
  if (!stats) return rows; // 材料が届くまでは、保存した順（届いたら、描き直す）
  const ctx = { count: entry => stats[entry.id]?.count || 0, favorite: entry => stats[entry.id]?.favorite === true || IsFavorite(entry.id), saved: entry => stats[entry.id]?.saved === true };
  return window.FavecusEntryView.Apply(rows, view, ctx, row => row.entry);
}
function DisplayRows(filter) {
  return tree.Rows(state, ViewScope(), expandedEntryLists, filter, ArrangeRows);
}
function RenderViewButton() {
  const button = $('view-open'); if (!button) return;
  const on = !!ListView(ViewScope()) && !allListsView;
  button.classList.toggle('enabled', on); button.textContent = on ? '曲の表示 ●' : '曲の表示';
  button.title = on ? '曲の並べ替え・絞り込みを選んでいます（押すと変更）' : '曲の並べ替え・絞り込み';
  button.classList.toggle('hidden', allListsView);
}
function ViewSettings() {
  const playlistId = ViewScope(), EV = window.FavecusEntryView; if (!EV || allListsView) return;
  const current = EV.Normalize(listViews[playlistId]);
  const groups = [['sort', '並べ替え', EV.SORTS], ['favorite', 'お気に入り', EV.FILTERS.favorite], ['saved', '保存', EV.FILTERS.saved], ['source', '種類', EV.FILTERS.source], ['played', '再生', EV.FILTERS.played]];
  const html = '<p class="form-note">この再生リストの曲の、並べ替えと絞り込みです。選んだ順で、このリストを再生します（保存した順は変わりません）。</p>' + groups.map(([key, label]) => `<label class="field">${label}<select data-view="${key}">${(key === 'sort' ? EV.SORTS : EV.FILTERS[key]).map(value => `<option value="${value}"${current[key] === value ? ' selected' : ''}>${EV.Labels[key][value]}</option>`).join('')}</select></label>`).join('');
  OpenModal('曲の並べ替え・絞り込み', html, async () => {
    const view = {}; for (const select of $('modal-body').querySelectorAll('select[data-view]')) view[select.dataset.view] = select.value;
    listViews = { ...listViews }; const saved = await api.listViewSet(playlistId, view);
    if (saved) listViews[playlistId] = saved; else delete listViews[playlistId];
    listViewStats.clear(); RenderViewButton(); RenderEntries();
  }, '決定');
  const reset = Button('元に戻す', 'button secondary', () => { for (const select of $('modal-body').querySelectorAll('select[data-view]')) select.value = EV.DEFAULT[select.dataset.view]; }); $('modal-body').append(reset);
}
function PlayEntry(entry) {
  const selected = allListsView ? PlaybackEntries().find(e => e.id === entry.id || (entry.type === 'local' ? e.fileName === entry.fileName : e.url === entry.url)) : entry;
  return PlaybackAction(() => api.play(allListsView && !selected ? entry.playlistId : ViewScope(), selected?.id || entry.id));
}
function MakePlaylistRow(item) {
  const child = item.playlist, row = Element('div', 'playlist-entry'); row.dataset.playlistId = child.id; row.style.marginLeft = `${Math.min(item.depth * 18, 90)}px`;
  const open = Button('', 'playlist-entry-open', () => { allListsView = false; tree.ExpandTo(state, child.id, expandedLists); return Action({ type: 'select', playlistId: child.id }); }, `${child.name}を開く`);
  open.append(Element('span', 'playlist-entry-icon', '≡'), Element('strong', '', child.name), Element('small', '', `${tree.Entries(state, child.id).length}曲`));
  const expand = Button('', 'icon-button playlist-entry-expand', () => {
    queueFollower?.Interact(); item.expanded ? expandedEntryLists.delete(item.path) : expandedEntryLists.add(item.path);
    RenderEntries(); playlistExpandButtons.get(item.path)?.focus({ preventScroll: true });
  }, `${child.name}を${item.expanded ? '折りたたむ' : '展開する'}`);
  expand.innerHTML = '<svg aria-hidden="true"><use href="icons.svg#down"/></svg>'; expand.setAttribute('aria-expanded', String(item.expanded));
  expand.disabled = !!$('filter').value.trim();
  row.append(open, expand); if (!playlistRows.has(child.id)) playlistRows.set(child.id, row); playlistExpandButtons.set(item.path, expand);
  if (allListsView) {
    const label = Element('label', 'all-play-property'), check = Element('input'); check.type = 'checkbox'; check.checked = child.includeInAll !== false; check.setAttribute('aria-label', `${child.name}を全体再生に含める`);
    check.onchange = () => Run(() => Action({ type: 'playlist-properties', playlistId: child.id, includeInAll: check.checked })); label.append(check, Element('span', '', '全体再生')); row.append(label);
  }
  return row;
}
// 一覧の行の遅延作成：近くに来た行から、中身を作る（EAGER_ROWS 行は、最初から作る）。
const EAGER_ROWS = 80, pendingRows = new Map();
let fillObserver = null;
if (typeof IntersectionObserver !== 'undefined') {
  fillObserver = new IntersectionObserver(changes => {
    for (const change of changes) {
      if (!change.isIntersecting) continue;
      const row = change.target, build = pendingRows.get(row);
      fillObserver.unobserve(row); pendingRows.delete(row);
      if (build) { build(); row.classList.remove('pending'); }
    }
  }, { root: $('entries'), rootMargin: '900px 0px' });
}
function RenderEntries() {
  queueDrag?.Cancel(); fillObserver?.disconnect(); pendingRows.clear();
  const filter = $('filter').value.toLowerCase().trim(), items = allListsView ? [] : DisplayRows(filter);
  listArtwork?.Reset(); listArtwork?.SetEnabled(foreground); durationObserver?.disconnect(); durationQueue.clear();
  const list = $('entries'), scrollTop = list.scrollTop; list.replaceChildren(); entryRows.clear(); playlistRows.clear(); playlistExpandButtons.clear(); highlightedRow = null;
  if (allListsView) return;
  if (!items.length) {
    const empty = Element('div', 'empty-list'); empty.append(Element('strong', '', '＋'), Element('span', '', filter ? '一致する動画がありません。' : '動画を追加すると、ここに再生リストが表示されます。')); list.append(empty);
  }
  let lazyCount = 0;
  for (const item of items) {
    if (item.playlist) { list.append(MakePlaylistRow(item)); continue; }
    const { entry, index } = item, ownerId = entry.playlistId;
    const row = Element('div', `entry ${entry.type}${entry.missing ? ' missing' : ''}`);
    if (selectionMode) row.classList.add('selecting');
    row.dataset.entryId = entry.id; row.dataset.ownerId = ownerId; row.style.marginLeft = `${Math.min(item.depth * 18, 90)}px`; if (!entryRows.has(entry.id)) entryRows.set(entry.id, row);
    // 行の中身は、画面の近くに来てから作る（先頭の80行は、すぐ）。多い曲数でも、最初の描画が重くならない。
    const build = () => {
      const handle = Button(String(index + 1).padStart(2, '0'), 'entry-number', () => {}, 'ドラッグで並べ替え（Alt＋↑/↓でも移動）');
      handle.addEventListener('keydown', event => { if (!allListsView && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); Run(() => Action({ type: 'move', playlistId: ownerId, entryId: entry.id, direction: event.key === 'ArrowUp' ? -1 : 1 })); } });
      if (!ListView(ownerId) && !selectionMode) queueDrag?.Bind(handle, row, { playlistId: ownerId, entryId: entry.id }, true); // 並べ替え・絞り込みの間は、ドラッグでの手動の並べ替えは使わない
      row.append(handle);
      const cover = Element('img', 'entry-cover'); cover.alt = ''; cover.draggable = false; cover.width = 56; cover.height = 34; cover.src = 'music.png';
      row.append(cover); listArtwork?.Add(cover, ownerId, entry.id);
      const play = Button('', 'icon-button', () => PlayEntry(entry), `${EntryTitle(entry)}を再生する`);
      play.innerHTML = '<svg aria-hidden="true"><use href="icons.svg#play"/></svg>'; row.append(play);
      const info = Button('', 'entry-info', () => PlayEntry(entry), `${EntryTitle(entry)}を再生`);
      info.append(Element('strong', '', EntryTitle(entry)), Element('small', '', entry.type !== 'local' ? `${EntryDuration(entry)} · ${entry.videoId} · P${entry.part || 1}` : `${EntryDuration(entry)} · このPCに保存したファイル`));
      info.dataset.durationEntry = entry.id;
      const badge = Element('span', 'entry-type'); PaintSavedBadge(badge, entry); row.append(info, badge);
      row.append(Button('•••', 'icon-button', () => EntryMenu(entry), `${EntryTitle(entry)}を編集`));
      if (selectionMode) BindSelection(row, entry); // 選んでいる間は、チェックと、行を押して選ぶ動きを付ける
    };
    if (!entry.duration) { row.durationEntry = entry; durationObserver?.observe(row); }
    if (fillObserver && lazyCount++ >= EAGER_ROWS) { row.classList.add('pending'); pendingRows.set(row, build); fillObserver.observe(row); } else build();
    list.append(row);
  }
  if (items.length) { const tail = Element('div', 'queue-tail'); tail.setAttribute('aria-hidden', 'true'); list.append(tail); UpdateQueueTail(); }
  list.scrollTop = scrollTop;
  UpdateCurrentRows(); RenderViewButton();
  $('play-all').disabled = PlaybackEntries().length === 0;
}
async function OpenPlaylist(id) {
  const result = await api.action({ type: 'select', playlistId: id });
  state = result; allListsView = false; $('filter').value = ''; tree.ExpandTo(state, id, expandedLists); Render();
}
function RenderHome() {
  searchArtwork?.Reset(); searchArtwork?.SetEnabled(false); homeArtwork?.Reset(); homeArtwork?.SetEnabled(false); homeSearchBadges.clear();
  if (!allListsView) return;
  const searching = !!$('home-query').value.trim(); $('home-search-clear').disabled = !$('home-query').value;
  if (searching && !homeSearchActive) homeScrollTop = $('home').scrollTop;
  const restore = homeSearchActive && !searching; homeSearchActive = searching;
  if (searching) { RenderHomeSearch(); return; }
  const view = window.FavecusHome.Render($('home'), state, {
    path: homePath, page: homePage,
    onNavigate: (path, page) => { homePath = path; homePage = page; RenderHome(); $('home').scrollTop = 0; $('home').querySelector('h1')?.focus(); },
    artwork: homeArtwork,
    onOpen: id => Run(() => OpenPlaylist(id)), onPlay: id => PlaybackAction(() => api.play(id)),
    // シャッフル再生：既存のシャッフルと同じく、全体のシャッフル設定をオンにして、このリストをシャッフルで再生する
    onShuffle: id => PlaybackAction(() => api.shufflePlay(id)),
    onSort: SortLists, onCreate: NewList,
    onInclude: (id, value) => Run(async () => { try { await Action({ type: 'playlist-properties', playlistId: id, includeInAll: value }); } finally { RenderHome(); } })
  });
  homePath = view.path.map(p => p.id); homePage = view.page;
  if (!homePath.length) { const auto = MakeAutoLists(); if (auto) $('home').append(auto); } // 自分のプレイリストの下に、自動リスト
  homeArtwork?.SetEnabled(foreground && !$('modal').open);
  if (restore) $('home').scrollTop = homeScrollTop;
}
function RenderHomeSearch() {
  if (homeSearchState !== state) { homeSearchIndex = window.FavecusSearch.Index(state); homeSearchState = state; }
  const query = $('home-query').value, view = window.FavecusSearch.Page(homeSearchIndex, query, homeSearchPage);
  homeSearchPage = view.page;
  const box = $('home'), scrollTop = box.scrollTop; box.replaceChildren();
  box.append(Element('h1', 'home-search-title', '検索結果'));
  const summary = Element('p', 'home-search-summary', `「${query}」 · ${view.total}件の登録（同じ動画も所属リストごとに表示）`); summary.setAttribute('role', 'status'); box.append(summary);
  const results = Element('div', 'home-results'); results.setAttribute('aria-label', '全登録曲の検索結果');
  for (const item of view.items) {
    const { entry, playlistId } = item, row = Element('article', 'home-result'); row.dataset.ownerId = playlistId; row.dataset.entryId = entry.id;
    const image = Element('img', 'home-result-cover'); image.alt = ''; image.width = image.height = 56; image.src = 'music.png'; image.draggable = false;
    searchArtwork?.Add(image, playlistId, entry.id);
    const play = () => PlaybackAction(() => api.play(playlistId, entry.id));
    const info = Button('', 'home-result-info', play, `${EntryTitle(entry)}を${item.playlistName}から再生`);
    const path = Element('small', 'home-result-path', item.pathText); path.title = item.pathText;
    info.append(Element('strong', '', EntryTitle(entry)), path, Element('small', 'home-result-source', entry.type === 'local' ? 'ローカルファイル' : `${entry.videoId} · P${entry.part || 1}`));
    const badge = Element('span', 'entry-type home-result-saved'); PaintSavedBadge(badge, entry); homeSearchBadges.set(badge, entry);
    row.append(image, info, badge, Button('▶ 再生', 'button play-button', play, `${EntryTitle(entry)}を再生`), Button('所属リストを開く', 'button secondary home-result-open', () => OpenPlaylist(playlistId), `${item.pathText}を開く`));
    results.append(row);
  }
  if (!view.total) results.append(Element('p', 'home-empty', '一致する登録曲がありません。曲名・リスト名・動画ID・URLを変えて検索してください。'));
  const pager = Element('div', 'home-pager'); pager.setAttribute('aria-label', '検索結果のページ');
  const turn = page => { homeSearchPage = page; RenderHome(); box.scrollTop = 0; box.querySelector('h1')?.focus(); };
  const previous = Button('← 前へ', 'button secondary', () => turn(view.page - 1)); previous.disabled = !view.page;
  const next = Button('次へ →', 'button secondary', () => turn(view.page + 1)); next.disabled = view.page + 1 >= view.pages;
  pager.append(previous, Element('span', 'home-page-status', `${view.total ? view.page * window.FavecusSearch.PAGE_SIZE + 1 : 0}–${Math.min(view.total, (view.page + 1) * window.FavecusSearch.PAGE_SIZE)} / ${view.total} 件 · ${view.page + 1} / ${view.pages} ページ`), next);
  box.append(results, pager); box.querySelector('h1').tabIndex = -1; box.scrollTop = scrollTop;
  searchArtwork?.SetEnabled(foreground && !$('modal').open);
}
function Render() {
  if (!state) return;
  document.body.style.setProperty('--sidebar-width', `${state.settings.sidebarWidth || 218}px`);
  window.FavecusTreeView($('playlists'), state, { expanded: expandedLists, activeId: allListsView ? null : state.activePlaylistId, drag: playlistDrag, onSelect: id => { allListsView = false; return Run(() => Action({ type: 'select', playlistId: id })); }, onDrop: !state.settings.playlistSort || state.settings.playlistSort === 'manual' ? DropPlaylist : null });
  $('all-count').textContent = `${state.playlists.reduce((n, p) => n + p.entries.length, 0)}曲`;
  $('all-count').title = `${state.playlists.length}リストの登録曲数（重複登録を含む）`;
  $('all-lists').setAttribute('aria-pressed', String(allListsView));
  $('home').classList.toggle('hidden', !allListsView);
  $('home-search').classList.toggle('hidden', !allListsView);
  $('home-notice').classList.toggle('hidden', !allListsView);
  (allListsView ? $('home-notice') : $('player-area')).append($('toast'));
  $('workspace').classList.toggle('hidden', allListsView); $('bili-heading').classList.toggle('hidden', allListsView);
  const p = List(), count = PlaybackEntries().length;
  const parentId = allListsView ? null : tree.Parent(state, p.id);
  $('playlist-up').classList.toggle('hidden', !parentId);
  $('playlist-up').title = parentId ? `親「${state.playlists.find(list => list.id === parentId).name}」へ戻る` : '親プレイリストへ戻る';
  $('shuffle-play').disabled = !count; $('play-all').disabled = !count; $('list-title').textContent = allListsView ? 'ホーム' : p.name; $('list-menu').classList.toggle('hidden', allListsView); $('entry-count').textContent = allListsView ? `${state.playlists.length} リスト · ${state.playlists.reduce((n, list) => n + list.entries.length, 0)} 曲（再生対象 ${count} 曲）` : `${count} 曲`; $('queue-count').textContent = count;
  $('new-child-list').classList.toggle('hidden', allListsView);
  $('all-normal').disabled = $('all-shuffle').disabled = !tree.Entries(state, '*').length;
  $('shuffle').setAttribute('aria-pressed', String(state.settings.shuffle));
  const repeatLabel = `リピート ${ { off: 'オフ', all: '全体', one: '1曲' }[state.settings.repeat] }`;
  $('repeat').textContent = state.settings.repeat === 'one' ? '↻¹' : '↻';
  $('repeat').title = repeatLabel; $('repeat').setAttribute('aria-label', repeatLabel); $('repeat').setAttribute('aria-pressed', String(state.settings.repeat !== 'off'));
  $('empty-add').textContent = count ? '最初の動画から再生' : '最初の動画を追加';
  $('empty-title').textContent = count ? '再生リストの準備ができました。' : '好きな動画から、はじめよう。';
  $('empty-description').textContent = count ? `${count}本の動画を、選んだ順番で再生できます。` : 'Bilibiliの動画URLや音楽ファイルを追加して、あなただけの再生リストをつくれます。';
  $('repeat').classList.toggle('enabled', state.settings.repeat !== 'off');
  $('breadcrumb').textContent = 'マイライブラリ / プレイリスト';
  SyncVolume(state.settings.volume);
  if (typeof SyncSelectionScope === 'function') SyncSelectionScope();
  RenderEntries(); RenderHome(); RenderPlayer(); RenderNext(); UpdateStatus(); UpdateAccounts(); BackgroundInteractive(foreground);
}
