'use strict';
const $ = id => document.getElementById(id);
let state, current = null, playback = null, thumbnail = null, statuses = {}, queueInfo = null, foreground = false;
let submitModal = null, toastTimer, loaded = false, seeking = false, accounts = {}, dragged = null, lastVolume = 1, modalEpoch = 0, pendingModal = null, cancelModal = null;
const { HasPlayback, TransportState } = window.FavecusTransport;
const api = window.favecusApp;
// おやすみタイマー（規則は core/sleep-timer.cjs。ここは表示と、押したときの次の指定だけ）。
let sleepState = { mode: 'off' };
const SLEEP_MINUTES = [15, 30, 45, 60, 90];
function NextSleepCommand(value) {
  const index = value?.mode === 'minutes' ? SLEEP_MINUTES.indexOf(value.minutes) : value?.mode === 'song' ? SLEEP_MINUTES.length : SLEEP_MINUTES.length + 1;
  const next = (index + 1) % (SLEEP_MINUTES.length + 2);
  return next < SLEEP_MINUTES.length ? { minutes: SLEEP_MINUTES[next] } : next === SLEEP_MINUTES.length ? { song: true } : { cancel: true };
}
function SleepDescription(value) {
  if (value?.mode === 'minutes') { const left = Math.max(0, Math.ceil((value.deadline - Date.now()) / 60000)); return `おやすみタイマー ${value.minutes}分（残り約${left}分）`; }
  if (value?.mode === 'song') return 'おやすみタイマー この曲の終わりまで';
  return 'おやすみタイマー オフ';
}
function RenderSleep() {
  const button = $('sleep'); if (!button) return;
  const on = sleepState?.mode === 'minutes' || sleepState?.mode === 'song', next = NextSleepCommand(sleepState);
  const nextText = next.cancel ? 'オフ' : next.song ? 'この曲の終わりまで' : `${next.minutes}分`;
  const label = `${SleepDescription(sleepState)}（押すと${nextText}）`;
  button.textContent = sleepState?.mode === 'minutes' ? `☾${Math.max(0, Math.ceil((sleepState.deadline - Date.now()) / 60000))}` : sleepState?.mode === 'song' ? '☾曲' : '☾';
  button.title = label; button.setAttribute('aria-label', label); button.setAttribute('aria-pressed', String(on)); button.classList.toggle('enabled', on);
  clearTimeout(sleepRefresh); sleepRefresh = sleepState?.mode === 'minutes' ? setTimeout(RenderSleep, 1000) : null;
}
// お気に入り：お気に入りの曲は、シャッフル再生で、少しだけ選ばれやすくなる。曲のメディア単位（同じ動画・パートは共通）。この端末内だけ。
let favoriteIds = new Set();
const IsFavorite = entryId => favoriteIds.has(entryId);
async function SetFavorite(playlistId, entryId, value) {
  favoriteIds = new Set(await api.favorite(playlistId, entryId, value)); RenderFavorite();
}
function RenderFavorite() {
  const button = $('favorite'); if (!button) return;
  const entryId = current?.entryId, show = !!entryId && !!current?.playlistId;
  button.classList.toggle('hidden', !show);
  if (!show) return;
  const on = IsFavorite(entryId), label = on ? 'お気に入りから外す' : 'お気に入りにする';
  button.textContent = on ? '♥' : '♡'; button.title = label; button.setAttribute('aria-label', label); button.setAttribute('aria-pressed', String(on)); button.classList.toggle('enabled', on);
}
// 最近削除（設定の中）。削除したプレイリスト・曲を30日間保管し、元に戻せる。規則は共通（core/trash.cjs）、ここは表示と操作だけ。
function TrashSettings() {
  OpenModal('最近削除', `<p class="form-note">削除したプレイリストと、「このリストから外す」で外した曲を、30日間、このPCに保管します（同期はしません）。元に戻すと、元の場所へ戻り、ほかの端末にも反映されます。保管中は、保存済みの動画・音声も残します。</p><div class="trash-list"></div><div class="settings-actions"><button type="button" class="button secondary trash-clear">すべて完全に削除</button></div>`, null, '保存', () => Settings());
  const body = $('modal-body'), listElement = body.querySelector('.trash-list'), clear = body.querySelector('.trash-clear');
  const paint = items => {
    listElement.replaceChildren(); clear.disabled = !items.length;
    if (!items.length) listElement.append(Element('p', 'form-note', '削除した項目は、ありません。'));
    for (const item of items) {
      const row = Element('div', 'trash-row'), text = Element('div', 'trash-text');
      text.append(Element('strong', '', item.label), Element('span', 'auto-note', `${new Date(item.deletedAt).toLocaleDateString('ja-JP')}に削除・残り${item.daysLeft}日`));
      row.append(text,
        Button('元に戻す', 'button primary', async () => { paint(await api.trashRestore(item.id)); Toast('元に戻しました。'); }),
        Button('完全に削除', 'button secondary', async () => { paint(await api.trashDelete(item.id)); }));
      listElement.append(row);
    }
  };
  clear.addEventListener('click', () => Run(async () => { if (confirm('保管中の項目をすべて完全に削除します。元に戻せません。')) { await api.trashClear(); paint([]); } }));
  Run(async () => paint(await api.trashList()));
}
// 自動リスト（ホームの、自分のプレイリストの下）。曲の選び方は main 側（共通の規則）。ここは表示と、押したときの操作だけ。
const AUTO_LIST_KINDS = [
  { kind: 'frequent', title: 'よく聴く曲', note: '再生回数の多い順（上位50曲）' },
  { kind: 'recent', title: '最近追加した曲', note: '登録の新しい順（50曲）' },
  { kind: 'unplayed', title: '未再生', note: 'まだ聴いていない曲（登録の新しい順）' }
];
function MakeAutoLists() {
  if (!api?.autoList || !api?.autoPlay) return null;
  const section = Element('section', 'auto-lists'); section.setAttribute('aria-label', '自動リスト');
  section.append(Element('h2', '', '自動リスト'));
  const cards = Element('div', 'auto-cards'); section.append(cards);
  const counts = new Map();
  for (const meta of AUTO_LIST_KINDS) {
    const card = Element('button', 'auto-card'); card.type = 'button';
    const name = Element('strong', '', meta.title), note = Element('span', 'auto-note', meta.note), count = Element('span', 'auto-count', '');
    card.append(name, note, count); counts.set(meta.kind, count);
    card.addEventListener('click', () => Run(() => OpenAutoList(meta)));
    cards.append(card);
  }
  void api.autoList().then(result => { for (const meta of AUTO_LIST_KINDS) { const n = result?.[meta.kind] ?? 0; counts.get(meta.kind).textContent = `${n}曲`; } }).catch(() => {});
  return section;
}
async function OpenAutoList(meta) {
  const rows = await api.autoList(meta.kind);
  OpenModal(meta.title, `<p class="form-note"></p><div class="auto-actions"></div><ol class="auto-rows"></ol>`, null);
  const body = $('modal-body'); body.querySelector('.form-note').textContent = `${meta.note}。曲を押すと、この一覧の順で再生します。`;
  const actions = body.querySelector('.auto-actions'), list = body.querySelector('.auto-rows');
  actions.append(
    Button('▶ 再生', 'button', async () => { CloseModal(); await PlaybackAction(() => api.autoPlay(meta.kind, null, false)); }),
    Button('⤨ シャッフル再生', 'button secondary', async () => { CloseModal(); await PlaybackAction(() => api.autoPlay(meta.kind, null, true)); })
  );
  actions.querySelectorAll('button').forEach(b => { b.disabled = !rows.length; });
  if (!rows.length) list.append(Element('li', 'form-note', 'まだ曲がありません。'));
  rows.forEach((row, index) => {
    const item = Element('li', 'auto-row'), button = Element('button', 'auto-row-button'); button.type = 'button';
    button.append(Element('span', 'auto-row-number', String(index + 1).padStart(2, '0')), Element('span', 'auto-row-title', row.title));
    if (meta.kind === 'frequent') button.append(Element('span', 'auto-row-count', `${row.count}回`));
    button.addEventListener('click', () => { CloseModal(); void PlaybackAction(() => api.autoPlay(meta.kind, row.id, false)); });
    item.append(button); list.append(item);
  });
}
// 前回の続きから（保存した曲があり、再生中でないときだけ、再生バーに出す）
let resumeOffer = null;
function RenderResume() {
  const button = $('resume-last'); if (!button) return;
  const show = !!resumeOffer && !current;
  button.classList.toggle('hidden', !show);
  if (show) { const text = `前回の続きから：${resumeOffer.title}（${Time(resumeOffer.position)}～）`; button.textContent = text; button.title = text; button.setAttribute('aria-label', text); }
}
let sleepRefresh = null; // 残り時間の表示を、1秒ごとに更新する（タイマーが動いている間だけ）
const tree = window.FavecusTree;
const expandedLists = new Set(), expandedEntryLists = new Set(), playlistDrag = { value: null };
let allListsView = false, timelineManual = false, timelineOpen = false, playingLocation = null;
let homePath = [], homePage = 0;
let homeSearchState = null, homeSearchIndex = null, homeSearchPage = 0, homeSearchActive = false, homeScrollTop = 0;
const homeSearchBadges = new Map();
let downloadInfo = {}, savedKinds = new Map(), downloadEstimate = null, downloadPicker = null, refreshDownloadEstimate = null, downloadPanelTimer, downloadTargetCount = 0, downloadStarting = false, downloadSingle = null;
const ViewScope = () => allListsView ? '*' : List().id;
const PlaybackEntries = () => tree.Entries(state, ViewScope());
const entryRows = new Map(), playlistRows = new Map(), playlistExpandButtons = new Map();
let highlightedRow = null;
let durationObserver, durationPending = 0;
const durationQueue = new Map(), durationFailures = new Set();
const listArtwork = window.FavecusListArtwork && api?.entryThumbnail && typeof IntersectionObserver !== 'undefined' ? new window.FavecusListArtwork.ListArtwork({
  root: $('entries'), load: (playlistId, entryId) => api.entryThumbnail(playlistId, entryId, ViewScope()), observe: (callback, options) => new IntersectionObserver(callback, options)
}) : null;
const homeArtwork = window.FavecusListArtwork && api?.entryThumbnail && typeof IntersectionObserver !== 'undefined' ? new window.FavecusListArtwork.ListArtwork({
  root: $('home'), load: (playlistId, entryId) => api.entryThumbnail(playlistId, entryId, '*', 'cover'), observe: (callback, options) => new IntersectionObserver(callback, options)
}) : null;
const searchArtwork = window.FavecusListArtwork && api?.entryThumbnail && typeof IntersectionObserver !== 'undefined' ? new window.FavecusListArtwork.ListArtwork({
  root: $('home'), load: (playlistId, entryId) => api.entryThumbnail(playlistId, entryId, '*'), observe: (callback, options) => new IntersectionObserver(callback, options)
}) : null;

function Toast(message) {
  if ($('modal').open) { $('modal-notice').textContent = message; $('modal-notice').classList.remove('hidden'); }
  $('toast').textContent = message; $('toast').classList.remove('hidden');
  SendBounds();
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').classList.add('hidden'); SendBounds(); }, 7000);
}
async function Run(action) { try { return await action(); } catch (error) { Toast(error.message); return undefined; } }
function PlaybackAction(action) { queueFollower?.Resume(); return Run(action); }
const List = () => state.playlists.find(p => p.id === state.activePlaylistId) || state.playlists[0];
const EntryTitle = entry => entry.title || entry.videoId || 'ローカルファイル';
function Element(tag, className, text) { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; }
function Button(label, className, handler, ariaLabel) {
  const b = Element('button', className, label); b.type = 'button';
  if (ariaLabel) { b.setAttribute('aria-label', ariaLabel); b.title = ariaLabel; }
  b.addEventListener('click', () => Run(handler)); return b;
}
async function Action(action) { const result = await api.action(action); state = result; Render(); return result; }
function OpenModal(title, content, submit, submitLabel = '保存', back = null) {
  queueDrag?.Cancel(); CloseExistingPopup();
  CancelModalTask(); $('modal-actions').replaceChildren(); $('modal-cancel').textContent = '閉じる';
  modalEpoch++; $('modal-submit').disabled = false; $('modal-notice').classList.add('hidden');
  $('modal-title').textContent = title; $('modal-body').innerHTML = content;
  $('modal-submit').textContent = submitLabel; $('modal-submit').classList.toggle('hidden', !submit);
  $('modal-back').classList.toggle('hidden', !back); $('modal-back').disabled = false; $('modal-back').onclick = back ? () => PerformModal(back, false) : null;
  submitModal = submit; if (!$('modal').open) $('modal').showModal(); $('modal').scrollTop = 0; BackgroundInteractive(false); SendBounds();
}
function CancelModalTask() { const cancel = cancelModal; cancelModal = null; if (cancel) void cancel().catch(() => {}); }
function CloseModal() { CancelModalTask(); modalEpoch++; $('modal').close(); BackgroundInteractive(true); SendBounds(); }
function PerformModal(handler, close) {
  const epoch = modalEpoch;
  if (!handler || pendingModal === epoch) return;
  pendingModal = epoch; $('modal-submit').disabled = true; $('modal-back').disabled = true;
  return Run(async () => {
    try { const result = await handler(); if (close && result !== false && epoch === modalEpoch) CloseModal(); }
    finally {
      if (pendingModal === epoch) pendingModal = null;
      if (epoch === modalEpoch) { $('modal-submit').disabled = false; $('modal-back').disabled = false; }
    }
  });
}
function AddDestinations({ exclude = [], initialIds = null } = {}) {
  const excluded = () => typeof exclude === 'function' ? exclude() : exclude;
  const activeId = List().id, selected = new Set(initialIds || (excluded().includes(activeId) ? [] : [activeId])), box = Element('fieldset', 'add-destinations');
  box.append(Element('legend', '', '追加先のプレイリスト（複数選択可）'));
  const choices = Element('div', 'destination-choices'), expanded = new Set(), revealed = new Set(); let picker;
  for (const id of selected) tree.ExpandTo(state, id, expanded);
  const search = Element('input', 'destination-search'), trackSearch = Element('input', 'destination-track-search'), results = Element('div', 'destination-results');
  search.type = trackSearch.type = 'search'; search.placeholder = '追加先のプレイリスト名を検索'; trackSearch.placeholder = '選択した追加先の曲を検索（子も含む）';
  search.setAttribute('aria-label', search.placeholder); trackSearch.setAttribute('aria-label', trackSearch.placeholder);
  const inspect = () => {
    results.replaceChildren(); const query = trackSearch.value.trim(); if (!query) return;
    const ids = [...selected].filter(id => !excluded().includes(id)), lists = tree.RawWalk(state, ids), matches = lists.flatMap(p => p.entries.filter(e => tree.Matches(`${EntryTitle(e)} ${e.url || ''}`, query)).map(e => ({ p, e })));
    results.append(Element('p', 'form-note', `${matches.length}件${matches.length > 100 ? '（先頭100件を表示）' : ''}${!ids.length ? ' · 追加先にチェックしてください' : ''}`));
    for (const { p, e } of matches.slice(0, 100)) { const row = Element('p', 'destination-result'); row.append(Element('strong', '', EntryTitle(e)), Element('small', '', tree.Path(state, p.id).map(p => p.name).join('/'))); results.append(row); }
  };
  const render = () => {
    for (const id of excluded()) if (!revealed.has(id)) { tree.ExpandTo(state, id, expanded); revealed.add(id); }
    picker = window.FavecusTreeView(choices, state, { checkboxes: true, expanded, selected, query: search.value, disabled: id => excluded().includes(id), onChange: inspect }); inspect();
  };
  search.oninput = () => { picker?.get(); render(); }; trackSearch.oninput = inspect;
  const create = Button('＋ 新規プレイリストを作成', 'button secondary destination-create', () => CreateNestedPlaylist(id => { picker.get(); selected.add(id); tree.ExpandTo(state, id, expanded); render(); }));
  box.append(search, choices, create, Element('small', 'form-note', 'チェックしたリストだけに追加します。追加元は表示したまま選択不可にします。検索で隠れた選択も保持します。'), trackSearch, results);
  $('modal-body').append(box); render();
  const get = () => {
    const ids = picker.get().filter(id => !excluded().includes(id));
    if (!ids.length) throw new Error('追加先のプレイリストにチェックしてください。');
    return ids;
  };
  get.refresh = () => { picker.get(); for (const id of excluded()) selected.delete(id); render(); };
  return get;
}
function CreateNestedPlaylist(onCreated, excludeId = null) {
  const dialog = Element('dialog', 'create-playlist-dialog'), form = Element('form');
  const nameLabel = Element('label', 'field', '名前'), name = Element('input'); name.name = 'playlistName'; name.maxLength = 60; name.required = true; nameLabel.append(name);
  const parents = Element('div'), notice = Element('p', 'status-detail'), footer = Element('div', 'modal-footer'); notice.setAttribute('role', 'status');
  const cancel = Element('button', 'button secondary', 'キャンセル'); cancel.type = 'button';
  const submit = Element('button', 'button primary', '作成する'); submit.type = 'submit'; footer.append(cancel, submit);
  form.append(Element('h2', '', '新規プレイリストを作成'), nameLabel, parents, notice, footer);
  dialog.append(form); document.body.append(dialog);
  const picker = window.FavecusParentPicker(parents, state, { excludeId });
  const close = () => { dialog.close(); dialog.remove(); };
  cancel.onclick = close; dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  form.onsubmit = async event => {
    event.preventDefault(); if (submit.disabled) return; submit.disabled = true;
    const previous = new Set(state.playlists.map(p => p.id));
    try {
      await Action({ type: 'create', name: name.value, parentId: picker.get(), select: false });
      const created = state.playlists.find(p => !previous.has(p.id)); close(); if (created) await onCreated(created.id);
    } catch (error) { notice.textContent = error.message; submit.disabled = false; }
  };
  dialog.showModal(); name.focus();
}
async function ReviewAddition(plan, epoch) {
  if (!plan) return false;
  if (epoch !== modalEpoch || !$('modal').open) { await api.cancelAdd(plan.id); return false; }
  let reviewEpoch = epoch;
  const finish = async allowedIds => {
    const result = await api.commitAdd(plan.id, allowedIds);
    if (reviewEpoch === modalEpoch) {
      cancelModal = null; state = result.state; Render();
      Toast(`${result.added}曲を追加しました。${result.skipped ? `重複候補${result.skipped}件は追加しませんでした。` : ''}${plan.warnings.join(' ')}`);
    }
    return result;
  };
  if (!plan.conflicts.length) {
    cancelModal = () => api.cancelAdd(plan.id);
    await finish([]); return;
  }
  OpenModal('重複の可能性がある曲', `
    <p id="duplicate-summary" class="form-note"></p>
    <p class="form-note">チェックした候補は、重複していても追加します。チェックしない候補は追加しません。「追加を取りやめる」や×では、今回の追加全体を中止します。</p>
    <div class="selection-tools"><button id="duplicate-all" type="button" class="button secondary">候補をすべてチェック</button><button id="duplicate-none" type="button" class="button secondary">チェックをすべて外す</button><span id="duplicate-count" role="status"></span></div>
    <div id="duplicate-list" class="duplicate-list"></div>`, () => finish([...$('duplicate-list').querySelectorAll('input:checked')].map(input => input.value)), '選択内容で追加');
  reviewEpoch = modalEpoch; cancelModal = () => api.cancelAdd(plan.id);
  $('modal-cancel').textContent = '追加を取りやめる';
  $('duplicate-summary').textContent = `重複候補は${plan.conflicts.length}件です。それ以外の${plan.normalCount}件は追加対象です。追加先のリストごとに確認してください。${plan.warnings.join(' ')}`;
  const updateCount = () => { $('duplicate-count').textContent = `重複しても追加 ${$('duplicate-list').querySelectorAll('input:checked').length}件`; };
  for (const candidate of plan.conflicts) {
    const row = Element('div', 'duplicate-row'), label = Element('label', 'check-row'), input = Element('input'); input.type = 'checkbox'; input.value = candidate.id; input.checked = false; input.onchange = updateCount;
    label.append(input, Element('strong', '', candidate.title)); row.append(label);
    row.append(Element('small', '', `追加先：${candidate.playlistName} · ${candidate.reason}`));
    if (candidate.url) row.append(Element('small', 'duplicate-url', candidate.url));
    for (const match of candidate.matches) {
      row.append(Element('p', 'duplicate-match', `${match.origin}：${match.title}`));
      if (match.url) row.append(Element('small', 'duplicate-url', match.url));
    }
    $('duplicate-list').append(row);
  }
  for (const [id, checked] of [['duplicate-all', true], ['duplicate-none', false]]) $(id).onclick = () => { for (const input of $('duplicate-list').querySelectorAll('input')) input.checked = checked; updateCount(); };
  updateCount(); return false;
}
async function AddSelected(action, destinationIds) {
  const epoch = modalEpoch;
  Toast('追加する曲の名前と重複を確認しています…');
  const plan = await api.prepareAdd({ ...action, destinationIds });
  return ReviewAddition(plan, epoch);
}
function AddURL(prefill = {}) {
  let destinations, resolved = null, readInput = '', request = 0;
  OpenModal('URLから追加', `<label class="field">Bilibiliの共有文・動画URL・再生リストURL<textarea id="url-input" maxlength="8192" placeholder="https://www.bilibili.com/video/BV…/" required></textarea><small>「読み込み」で単体動画・再生リストを判定します。短縮URLは通常の動画URLへ置き換えてください。単体動画のURLは1行1件で最大100件まで読み込めます。</small></label>
    <button id="url-load" type="button" class="button secondary">読み込み</button><p id="url-analysis" class="status-detail" role="status">URLを入力して読み込んでください。</p>
    <div id="url-single" class="hidden"><label class="field">表示する名前（任意）<input id="url-title" maxlength="180"></label><button id="url-get-title" type="button" class="button secondary">動画タイトルを取得</button></div>
    <div id="url-related" class="settings-actions hidden"></div>`, async () => {
    if (!resolved || readInput !== $('url-input').value.trim()) { await analyze(); return false; }
    if (resolved.kind === 'videos') return AddSelected({ type: 'add-videos', videos: resolved.videos }, destinations());
    if (resolved.kind !== 'video') throw new Error('再生リストを開いて曲を選択してください。');
    return AddSelected({ type: 'add-videos', videos: [{ ...resolved.video, title: $('url-title').value }] }, destinations());
  }, '追加する');
  destinations = AddDestinations(); const epoch = modalEpoch;
  $('url-input').value = prefill.url || ''; $('url-title').value = prefill.title || ''; $('modal-submit').disabled = true;
  const analyze = async () => {
    const value = $('url-input').value.trim(), token = ++request; $('url-load').disabled = true; $('modal-submit').disabled = true;
    $('url-analysis').textContent = 'URLを確認しています…';
    try {
      const result = await api.resolveURL(value);
      if (epoch !== modalEpoch || token !== request || value !== $('url-input').value.trim()) return;
      resolved = result; readInput = value;
      if (result.kind === 'playlist') { PlaylistURL({ url: value, sources: result.sources, destinationIds: destinations() }); return; }
      if (result.kind === 'videos') { $('url-single').classList.add('hidden'); $('url-related').classList.add('hidden'); $('url-analysis').textContent = `単体動画 ${result.videos.length}件を読み込みました。`; $('modal-submit').disabled = false; return; }
      $('url-single').classList.remove('hidden'); $('url-analysis').textContent = `単体動画 · ${result.video.videoId} · P${result.video.part}`;
      if (!$('url-title').value) $('url-title').value = result.video.title || '';
      $('modal-submit').disabled = false; $('url-related').replaceChildren();
      $('url-related').classList.toggle('hidden', !result.sources.length);
      if (result.sources.length) $('url-related').append(Button('この動画の全パート・再生リストを開く', 'button secondary', () => PlaylistURL({ url: value, sources: result.sources, destinationIds: destinations() })));
    } catch (error) { if (epoch === modalEpoch && token === request) { resolved = null; $('url-analysis').textContent = error.message; } }
    finally { if (epoch === modalEpoch && token === request) $('url-load').disabled = false; }
  };
  $('url-load').onclick = () => Run(analyze);
  $('url-get-title').onclick = () => Run(async () => { const token = request, url = readInput; const result = await api.resolveURL(url); if (epoch === modalEpoch && token === request && result.video) $('url-title').value = result.video.title || ''; });
  $('url-input').oninput = () => { request++; resolved = null; $('modal-submit').disabled = true; $('url-load').disabled = false; $('url-single').classList.add('hidden'); $('url-related').classList.add('hidden'); };
  if (prefill.analyze) void analyze();
}
function AddLocalFiles() {
  let destinations;
  OpenModal('ファイルを追加', '<p class="form-note">追加先を選んでから、動画・音楽ファイルを選択します。ファイルはPC内に1回だけ取り込み、チェックしたリストで共通のファイルを使います。</p>', async () => {
    const epoch = modalEpoch, ids = destinations();
    const plan = await api.prepareFiles(ids);
    return ReviewAddition(plan, epoch);
  }, 'ファイルを選んで追加');
  destinations = AddDestinations();
}
function ExistingTracks() {
  const selected = new Map(); let destinations, sourcePicker;
  OpenModal('既存のプレイリストから追加', `<p class="form-note">曲を選んで、下の追加先にまとめて追加できます。元のリストにも残ります。</p>
    <div class="field"><span>追加元のプレイリスト</span><div id="existing-source"></div></div><p class="form-note">選択したリスト直属の曲を表示します。子リストは矢印で開いて選べます。「ライブラリ全体」ではすべての曲を表示します。</p>
    <label class="field">曲を検索<input id="existing-filter" type="search" placeholder="曲名・動画番号"></label>
    <div class="selection-tools"><button id="existing-all" type="button" class="button secondary">表示中の曲をすべて選択</button><button id="existing-none" type="button" class="button secondary">選択をすべて解除</button><span id="existing-count" role="status"></span></div>
    <div id="existing-tracks" class="favorite-list"></div><button id="existing-move" type="button" class="button secondary">既存のプレイリストから移動</button>`, () => AddSelected({ type: 'add-existing', entries: [...selected.values()] }, destinations()), '選択した曲を追加');
  $('modal-actions').append($('existing-move'));
  destinations = AddDestinations({ exclude: () => [...new Set([sourcePicker?.get(), ...[...selected.values()].map(e => e.playlistId)].filter(Boolean))] });
  $('existing-move').onclick = () => PerformModal(async () => { const result = await api.moveTracks({ entries: [...selected.values()], destinationIds: destinations() }); state = result.state; Render(); Toast(`${result.moved}曲を移動しました。`); }, true);
  let visible = [];
  const updateCount = () => { destinations.refresh(); $('existing-count').textContent = `${selected.size}曲を選択中`; $('modal-submit').disabled = !selected.size; if ($('existing-move')) $('existing-move').disabled = !selected.size; };
  const render = () => {
    const filter = $('existing-filter').value.trim().toLowerCase(), source = sourcePicker?.get(), seen = new Set(); visible = [];
    $('existing-tracks').replaceChildren();
    for (const p of state.playlists) if (!source || source === p.id) for (const entry of p.entries) {
      const key = `${p.id}:${entry.id}`;
      if (seen.has(key) || !`${EntryTitle(entry)} ${entry.videoId || ''}`.toLowerCase().includes(filter)) continue;
      seen.add(key); const ref = { playlistId: p.id, entryId: entry.id }; visible.push({ key, ref });
      const label = Element('label', 'favorite-row'), input = Element('input'); input.type = 'checkbox'; input.checked = selected.has(key);
      input.onchange = () => { input.checked ? selected.set(key, ref) : selected.delete(key); updateCount(); };
      const title = Element('span', '', EntryTitle(entry)); title.append(Element('small', '', `${p.name} · ${entry.type === 'local' ? 'ローカルファイル' : entry.videoId}${entry.part > 1 ? ` · パート ${entry.part}` : ''}`));
      label.append(input, title); $('existing-tracks').append(label);
    }
    if (!visible.length) $('existing-tracks').append(Element('p', 'form-note', '追加できる曲がありません。追加元や検索条件を変更してください。'));
    updateCount();
  };
  sourcePicker = window.FavecusParentPicker($('existing-source'), state, { selected: state.playlists.find(p => p.id !== List().id && p.entries.length)?.id || null, rootLabel: 'ライブラリ全体', label: '追加元のプレイリストを検索', onChange: render });
  $('existing-filter').oninput = render;
  $('existing-all').onclick = () => { for (const { key, ref } of visible) selected.set(key, ref); render(); };
  $('existing-none').onclick = () => { selected.clear(); render(); }; render();
}
function NewList(parentId = null) {
  let picker;
  OpenModal('新しいプレイリスト', '<label class="field">名前<input id="name-input" maxlength="60" required></label><div class="field"><span>親プレイリスト</span><div id="new-parent"></div></div>', async () => {
    await Action({ type: 'create', name: $('name-input').value, parentId: picker.get() }); tree.ExpandTo(state, state.activePlaylistId, expandedLists); allListsView = false; Render();
  }, '作成する'); picker = window.FavecusParentPicker($('new-parent'), state, { selected: parentId }); $('name-input').focus();
}
let existingPopup = null;
function CloseExistingPopup() { if (existingPopup) { existingPopup.remove(); existingPopup = null; } }
function ExistingMenu() {
  if (existingPopup) { CloseExistingPopup(); return; }
  existingPopup = Element('div', 'existing-popup'); existingPopup.setAttribute('role', 'menu');
  existingPopup.append(Button('既存のプレイリストから楽曲を追加', 'popup-item', () => { CloseExistingPopup(); ExistingTracks(); }), Button('プレイリスト単位で取り込む', 'popup-item', () => { CloseExistingPopup(); AttachPlaylists(); }));
  $('add-existing').parentElement.append(existingPopup); const bounds = $('add-existing').getBoundingClientRect();
  existingPopup.style.top = `${bounds.bottom + 6}px`; existingPopup.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - 300))}px`;
}
function AttachPlaylists() {
  const parent = List(), expanded = new Set(); tree.ExpandTo(state, parent.id, expanded); let picker;
  OpenModal('プレイリスト単位で取り込む', '<p class="form-note">参照として子に登録します。同じリストの曲を編集すると、参照している場所にも反映されます。自分自身や循環につながるリストは選択不可です。矢印で子を開けます。</p><div id="attach-lists" class="destination-choices"></div><label class="check-row"><input id="attach-remove" type="checkbox">取り込み元のプレイリストを削除する（この親へ移動）</label>', async () => {
    await Action({ type: 'playlist-attach', playlistId: parent.id, ids: picker.get(), removeOriginal: $('attach-remove').checked });
  }, '取り込む');
  picker = window.FavecusTreeView($('attach-lists'), state, { checkboxes: true, expanded, disabled: id => !tree.CanParent(state, id, parent.id) });
}
function MovePlaylist(id) {
  let picker;
  OpenModal('プレイリストを移動', '<div class="field"><span>新しい親プレイリスト</span><div id="move-parent"></div></div><p class="form-note">「最上位（親なし）」を選ぶと独立したリストに戻します。移動すると以前の親・最上位からの参照は外れます。自分自身と子孫は表示したまま選択不可にします。</p><button id="move-new-parent" type="button" class="button secondary">新しい親プレイリストを作成する</button>', () => Action({ type: 'playlist-move', playlistId: id, parentId: picker.get() }), '移動する');
  picker = window.FavecusParentPicker($('move-parent'), state, { excludeId: id });
  $('move-new-parent').onclick = () => CreateNestedPlaylist(async parentId => { await Action({ type: 'playlist-move', playlistId: id, parentId }); CloseModal(); }, id);
}
function DropPlaylist(item, targetId, mode, parentId) {
  if (mode === 'child') {
    if (!tree.CanParent(state, item.id, targetId)) { Toast('自分自身や子孫を親にはできません。'); return; }
    OpenModal('子プレイリストへ移動', '<p id="child-confirm" class="form-note"></p>', () => Action({ type: 'playlist-move', playlistId: item.id, parentId: targetId }), 'はい、子にする');
    $('child-confirm').textContent = `このプレイリストを「${state.playlists.find(p => p.id === targetId).name}」の子プレイリストにしますか？`; $('modal-cancel').textContent = 'いいえ';
  } else void Run(() => Action({ type: 'playlist-reorder', playlistId: item.id, parentId, targetId, after: mode === 'after' }));
}
function SortLists() {
  OpenModal('プレイリストの並べ替え', '<label class="field">順序<select id="playlist-sort"></select></label><p class="form-note">親子関係を保ち、同じ階層内で並べ替えます。全リスト一覧も同じ基準です。曲の手動順は保持します。古いリストに作成日時がない場合は登録順を使います。</p>', () => Action({ type: 'settings', settings: { playlistSort: $('playlist-sort').value } }));
  for (const [value, title] of [['manual','手動の順序'],['name','名前：数字 → アルファベット → かな50音'],['count-desc','曲数が多い順（子を含む）'],['count-asc','曲数が少ない順（子を含む）'],['added','新しい要素が追加された順'],['created-desc','作成が新しい順'],['created-asc','作成が古い順']]) { const option = Element('option', '', title); option.value = value; $('playlist-sort').append(option); }
  $('playlist-sort').value = state.settings.playlistSort || 'manual';
}
function ListMenu() {
  const p = List();
  OpenModal('プレイリストを編集', '<label class="field">名前<input id="name-input" maxlength="60" required></label><label class="check-row"><input id="include-in-all" type="checkbox">全体再生・全体シャッフルに含める</label><p class="form-note">オフにするとこのリストと配下を全体再生から外します。個別に選んだリストは再生できます。</p><div id="list-delete-area"></div>', () => Action({ type: 'playlist-properties', playlistId: p.id, name: $('name-input').value, includeInAll: $('include-in-all').checked }));
  $('name-input').value = p.name;
  $('include-in-all').checked = p.includeInAll !== false;
  $('list-delete-area').append(Button('プレイリストを移動', 'button secondary', () => MovePlaylist(p.id)));
  $('list-delete-area').append(Button('このプレイリストの動画・音声を保存', 'button secondary', DownloadsDialog));
  if (state.playlists.length > 1) $('list-delete-area').append(Button('このプレイリストを削除', 'button secondary danger', () => {
    CloseModal();
    OpenModal('プレイリストを削除', '<p class="form-note" id="delete-note"></p>', async () => { await Action({ type: 'delete', playlistId: p.id }); Toast('プレイリストを削除しました。取り込んだ動画ファイルはPCに残ります。'); }, '削除する');
    $('delete-note').textContent = `「${p.name}」を削除します。登録した一覧が失われます。`;
  }));
}
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
  const favorite = IsFavorite(entry.id);
  $('entry-actions').append(Button(favorite ? '♥ お気に入りから外す' : '♡ お気に入りにする', 'button secondary', async () => { await SetFavorite(p.id, entry.id, !favorite); CloseModal(); Toast(favorite ? 'お気に入りから外しました。' : 'お気に入りにしました。シャッフル再生で、少しだけ選ばれやすくなります。'); }));
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
function UpdateAccounts() {
  if ($('browse-bilibili')) { $('browse-bilibili').disabled = !accounts.bilibili?.loggedIn; $('browse-bilibili').title = accounts.bilibili?.loggedIn ? 'アプリ内で動画を検索し、表示中の動画を追加します' : '設定・連携からBilibiliにログインしてください'; }
  if ($('bili-account-state')) $('bili-account-state').textContent = accounts.bilibili?.loggedIn ? `ログイン済み: ${accounts.bilibili.name}` : accounts.bilibili?.error || '未ログイン';
}
function SetIcon(button, name) { button.querySelector('use').setAttribute('href', `icons.svg#${name}`); }
function SyncVolume(volume) {
  if (!state) return;
  state.settings.volume = volume; if (volume > 0) lastVolume = volume;
  const percent = Math.round(volume * 100);
  for (const id of ['transport-volume', 'master-volume']) if ($(id)) $(id).value = percent;
  for (const id of ['transport-volume-value', 'volume-value']) if ($(id)) $(id).textContent = `${percent}%`;
  SetIcon($('mute'), volume === 0 ? 'muted' : 'volume');
  const label = volume === 0 ? 'ミュートを解除' : 'ミュート'; $('mute').title = label; $('mute').setAttribute('aria-label', label); $('mute').setAttribute('aria-pressed', String(volume === 0));
}
function VolumeInput(element) { const volume = Number(element.value) / 100; SyncVolume(volume); Run(() => api.volume(volume)); }
function Settings() {
  OpenModal('設定・連携', `
    <section class="settings-block"><h3>音量</h3>
      <label class="volume-row"><span>音量</span><input id="master-volume" type="range" min="0" max="100" step="1" aria-label="アプリの音量"><output id="volume-value" for="master-volume"></output></label>
      <p class="form-note">変更はすぐに反映・保存されます。下部の音量バー、ミニプレイヤーと共通です。</p>
    </section>
    <section class="settings-block"><h3>bilibiliアカウント</h3>
      <div class="account-row"><p id="bili-account-state" class="status-detail">確認しています…</p><div class="settings-actions"><button id="bili-login" type="button" class="button secondary">ログイン・アカウントを開く</button><button id="bili-favorites" type="button" class="button secondary">保存リストから追加</button></div></div>
      <p class="form-note">公式サイトでログインすると、再生画面と保存リストに同じログイン状態を使用します。</p>
    </section>
    <nav id="settings-sections" class="settings-sections" aria-label="設定項目"></nav>`, null);
  // 新しい設定カテゴリはこの配列の末尾へ追加する。
  for (const [name, open] of [['プレイリストの出力', Transfer], ['使い方', () => api.help()], ['自動消去単語設定', TitleWordsSettings], ['Discordアクティビティ', DiscordSettings], ['ミニプレイヤー、タスクバー', TaskbarSettings], ['再生・表示', PlaybackSettings], ['キーコンフィグ', KeySettings], ['シャッフルの再生回数', ShuffleSettings], ['バージョン更新', ReleaseSettings], ['プレイリストの同期', SyncSettings], ['最近削除', TrashSettings]]) {
    const button = Button(name, 'settings-category', open); button.append(Element('span', '', '›')); $('settings-sections').append(button);
  }
  SyncVolume(state.settings.volume); $('master-volume').oninput = () => VolumeInput($('master-volume'));
  $('bili-login').onclick = () => Run(() => api.login('bilibili'));
  $('bili-favorites').onclick = () => { CloseModal(); Favorites(); };
  UpdateAccounts(); Run(async () => { accounts = await api.accounts(); UpdateAccounts(); });
}
async function SaveSettingsSection(settings, expectedEpoch = modalEpoch) {
  if (expectedEpoch !== modalEpoch) return false;
  if (!$('modal-form').reportValidity()) return false;
  const epoch = modalEpoch;
  await Action({ type: 'settings', settings });
  if (epoch === modalEpoch && $('modal').open) { Settings(); Toast('設定を保存しました。'); }
}
// ---- プレイリストの同期（設定）。接続先・サインイン・有効化。状態はmainからの 'sync' イベントで更新する。
let syncStatus = null;
function SyncLabel(status) {
  if (!status) return '確認しています…';
  const when = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('ja-JP') : '未同期';
  const extra = (status.pending ? `・未送信 ${status.pending}件` : '') + (status.conflicts ? `・保留した変更 ${status.conflicts}件` : '');
  if (status.state === 'blocked') return `同期を停止しています：${status.error}`;
  if (!status.enabled) return `同期：オフ${status.signedIn ? `（サインイン済み：${status.email}）` : ''}`;
  if (status.state === 'syncing') return '同期しています…';
  if (status.state === 'error') return `同期に失敗しました：${status.error}（変更は保持しています。つながると自動で再試行します）${extra}`;
  return `同期：オン・最終 ${when}${extra}`;
}
function PaintSync(status) {
  syncStatus = status;
  if (!$('sync-state') || !$('modal').open) return;
  $('sync-state').textContent = SyncLabel(status);
  const on = !!status?.enabled, ready = !!status?.configured, signed = !!status?.signedIn;
  $('sync-url').disabled = $('sync-key').disabled = $('sync-save').disabled = on;
  $('sync-send').disabled = !ready || !status?.encryption; $('sync-verify').disabled = !ready; $('sync-signout').disabled = !signed || on;
  $('sync-enable').disabled = on || !signed; $('sync-disable').disabled = !on; $('sync-reset').disabled = on; $('sync-now').disabled = !on || status?.state === 'syncing';
  $('sync-encryption').classList.toggle('hidden', !status || status.encryption);
  $('sync-blocked').classList.toggle('hidden', !(status && status.enabled && status.state === 'blocked' && status.canUnblock));
}
function SyncSettings() {
  OpenModal('プレイリストの同期', `
    <p class="form-note">自分のSupabaseプロジェクトを使って、プレイリストの構成と曲の登録情報をWindows版・iPhone版で同期します。曲のファイル・保存したメディア・ログイン情報は同期しません。既定はオフです。</p>
    <p id="sync-state" class="status-detail" role="status" aria-live="polite"></p>
    <p id="sync-encryption" class="status-detail hidden">この環境ではサインイン情報を安全に保存できないため、同期を使えません。</p>
    <section class="settings-block"><h3>1. 接続先</h3>
      <label class="field">Project URL<input id="sync-url" maxlength="100" placeholder="https://xxxx.supabase.co" autocomplete="off" spellcheck="false"></label>
      <label class="field">anon（publishable）キー<input id="sync-key" maxlength="4096" autocomplete="off" spellcheck="false"><small>公開してよいキーだけを入力します。service_role・secretキーは使えません。</small></label>
      <div class="settings-actions"><button id="sync-save" type="button" class="button secondary">接続先を保存</button></div>
    </section>
    <section class="settings-block"><h3>2. サインイン（メールのワンタイムコード）</h3>
      <label class="field">メールアドレス<input id="sync-email" type="email" maxlength="200" autocomplete="email"></label>
      <div class="settings-actions"><button id="sync-send" type="button" class="button secondary">コードを送る</button></div>
      <label class="field">届いたコード<input id="sync-code" inputmode="numeric" maxlength="10" autocomplete="one-time-code"></label>
      <div class="settings-actions"><button id="sync-verify" type="button" class="button secondary">サインイン</button><button id="sync-signout" type="button" class="button secondary">サインアウト</button></div>
    </section>
    <section class="settings-block"><h3>3. 同期</h3>
      <div class="settings-actions"><button id="sync-enable" type="button" class="button primary">同期を有効にする</button><button id="sync-now" type="button" class="button secondary">今すぐ同期</button><button id="sync-disable" type="button" class="button secondary">同期を止める</button><button id="sync-reset" type="button" class="button secondary">接続を初期化</button></div>
      <div id="sync-blocked" class="settings-actions hidden"><button id="sync-restore" type="button" class="button primary">サーバーの内容で復元</button><button id="sync-keep" type="button" class="button secondary">この端末の内容を正とする</button></div>
      <p class="form-note">有効にする前に、現在のlibrary.jsonのバックアップをデータフォルダーへ残します。止めても、プレイリストや同期データは消えません。Supabaseの無料枠は、1週間ほど使われないと一時停止します（ダッシュボードで再開でき、データは残ります）。</p>
    </section>`, null, '保存', Settings);
  const call = (command, message) => Run(async () => { const status = await api.sync(command); PaintSync(status); if (message) Toast(message); });
  $('sync-save').onclick = () => call({ action: 'configure', url: $('sync-url').value, anonKey: $('sync-key').value }, '接続先を保存しました。');
  $('sync-send').onclick = () => call({ action: 'send-code', email: $('sync-email').value }, 'コードをメールで送りました。届いた数字を入力してください。');
  $('sync-verify').onclick = () => call({ action: 'verify', email: $('sync-email').value, code: $('sync-code').value }, 'サインインしました。');
  $('sync-signout').onclick = () => call({ action: 'sign-out' }, 'サインアウトしました。');
  $('sync-enable').onclick = () => call({ action: 'enable' }, '同期を有効にしました。');
  $('sync-disable').onclick = () => call({ action: 'disable' }, '同期を止めました。');
  $('sync-restore').onclick = () => call({ action: 'unblock', mode: 'restore' }, '同期した内容で復元しました。');
  $('sync-keep').onclick = () => { if (confirm('この端末の内容を正として同期します。サーバーと他の端末にある、この端末にない内容は削除されます。よろしいですか？')) call({ action: 'unblock', mode: 'keep' }, '同期しました。'); };
  $('sync-reset').onclick = () => { if (confirm('別のプロジェクト・アカウントへ切り替えるため、同期の紐付けを初期化します。手元のプレイリストは変わりません。よろしいですか？')) call({ action: 'reset' }, '初期化しました。'); };
  $('sync-now').onclick = () => call({ action: 'now' }, '同期しました。');
  Run(async () => { const status = await api.sync({ action: 'status' }); PaintSync(status); $('sync-email').value = status.email || ''; $('sync-url').value = status.url || ''; });
}
function KeySettings() {
  const keys = window.FavecusKeys, draft = { ...keys.Validate(state.settings.keybindings) }, inputs = new Map();
  const save = () => SaveSettingsSection({ keybindings: keys.Validate(draft) });
  OpenModal('キーコンフィグ', '<p class="form-note">欄を選択して使用するキーを押してください。修飾キーとの組み合わせも使えます。Backspace・Deleteで解除します。アプリが前面のときだけ有効で、入力欄・設定画面では再生キーを動作させません。</p><div id="keybinding-fields"></div><button id="keybinding-reset" class="button secondary" type="button">初期設定に戻す</button>', save, '保存して戻る', save);
  const paint = () => { for (const [action, input] of inputs) input.value = keys.Display(draft[action]); };
  for (const [action, title] of Object.entries(keys.Labels)) {
    const label = Element('label', 'keybinding-row', title), input = Element('input'); input.type = 'text'; input.readOnly = true; input.setAttribute('aria-label', title);
    input.onkeydown = event => { event.preventDefault(); event.stopPropagation(); if (event.isComposing) return; const value = keys.Stroke(event); if (!value) return; draft[action] = ['Backspace', 'Delete'].includes(value) ? '' : value; paint(); };
    label.append(input); $('keybinding-fields').append(label); inputs.set(action, input);
  }
  $('keybinding-reset').onclick = () => { Object.assign(draft, keys.Defaults); paint(); }; paint();
}
function TitleWordsSettings() {
  OpenModal('自動消去単語設定', `
    <p class="form-note">登録した語句全体に一致する部分を、曲名から取り除きます。英字の大文字・小文字は区別しません。例えば「ニコカラ」を登録しても「ニ」「コ」など1文字ずつは消しません。</p>
    <label class="field">自動消去する語句<input id="title-word-input" maxlength="80" placeholder="例：ニコカラ、純k投屏（1回に1語句）"><small>括弧は [ と ] のように、左右を1つずつ登録します。括弧の中身は残ります。最大200語句。</small></label>
    <button id="title-word-add" type="button" class="button primary">単語を追加</button>
    <p id="title-word-count" class="status-detail"></p><div id="title-word-list" class="title-word-list"></div>
    <p class="form-note">追加・削除はすぐに保存します。追加した語句は、すべての既存プレイリストにも適用します。語句を削除しても、整理済みの曲名は元には戻りません。すべて削除すると今後の自動消去を止められます。</p>`, null, '保存', Settings);
  const epoch = modalEpoch; let busy = false;
  const render = () => {
    $('title-word-list').replaceChildren();
    const words = state.settings.titleCleanupWords;
    $('title-word-count').textContent = `${words.length} / 200語句を登録中`;
    for (const word of words) {
      const chip = Element('div', 'title-word'); chip.append(Element('span', '', word));
      const remove = Button('×', 'icon-button', () => save(state.settings.titleCleanupWords.filter(value => value !== word)), `${word}を自動消去の対象から外す`);
      remove.disabled = busy; chip.append(remove); $('title-word-list').append(chip);
    }
    $('title-word-add').disabled = busy; $('title-word-input').disabled = busy;
  };
  const save = async words => {
    if (busy) return; busy = true;
    const before = new Map(state.playlists.flatMap(p => p.entries.map(e => [e.id, e.title]))); render();
    try {
      await Action({ type: 'settings', settings: { titleCleanupWords: words } });
      if (epoch !== modalEpoch || !$('modal').open) return;
      $('title-word-input').value = '';
      const changed = state.playlists.flatMap(p => p.entries).filter(e => before.get(e.id) !== e.title).length;
      Toast(`語句を保存しました。${changed ? `既存の曲名${changed}件を整理しました。` : ''}`);
    } finally { busy = false; if (epoch === modalEpoch && $('modal').open) render(); }
  };
  const add = () => {
    const word = $('title-word-input').value.trim();
    if (!word) throw new Error('自動消去する語句を入力してください。');
    if (state.settings.titleCleanupWords.some(value => value.toLowerCase() === word.toLowerCase())) throw new Error('その語句は登録済みです。');
    return save([...state.settings.titleCleanupWords, word]);
  };
  $('title-word-add').onclick = () => Run(add);
  $('title-word-input').onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); Run(add); } };
  render();
}
function ReleaseSettings() {
  const save = () => SaveSettingsSection({ releaseDriveURL: $('release-drive-url').value.trim() });
  OpenModal('バージョン更新', '<label class="field">Google Driveの配布先<input id="release-drive-url" placeholder="https://drive.google.com/drive/folders/..."><small>配信元から案内されたフォルダーURLを指定してください。未設定の場合はマイドライブを開きます。</small></label><div class="settings-actions"><button id="release-open" type="button" class="button primary">Google Driveを開く ↗</button></div><p class="form-note">配布先のファイル名でバージョンを確認し、Patchを取得してください。アプリを終了（×ボタンでは通知領域に残るため、通知領域のアイコンを右クリックして「終了」）してから、既存のFavecusPlayerフォルダーへ適用します。</p>', save, '保存して戻る', save);
  $('release-drive-url').value = state.settings.releaseDriveURL || '';
  $('release-open').onclick = () => Run(async () => { await Action({ type: 'settings', settings: { releaseDriveURL: $('release-drive-url').value.trim() } }); await api.openRelease(); });
}
function DiscordSettings() {
  const s = state.settings;
  const save = () => SaveSettingsSection({ discordEnabled: $('discord-enabled').checked, discordClientId: $('discord-id').value.trim(), discordImageKey: $('discord-image-key').value.trim(), hideWhenPaused: $('hide-paused').checked, discordThumbnail: $('discord-thumbnail').checked, discordVideoLink: $('discord-video-link').checked, discordThumbnailSize: $('discord-size').value });
  OpenModal('Discordアクティビティ', `
    <p class="form-note">音楽アクティビティとして、メンバー一覧にも曲名を表示します。</p>
    <label class="check-row"><input id="discord-enabled" type="checkbox">Discordに再生中の内容を表示する</label>
    <label class="field">Application ID<input id="discord-id" inputmode="numeric" maxlength="22" placeholder="Developer PortalのApplication ID"><small>初回のみ、自分のDiscord Applicationを作成してIDを入力します。Bot TokenやClient Secretは使用しません。</small></label>
    <label class="field">Rich Presenceの画像名<input id="discord-image-key" maxlength="64" placeholder="favecus_player_music"><small>Rich Presence → Art Assetsに音楽アイコンを登録し、画像名を一致させます。General InformationのApp Iconとは別の設定です。</small></label>
    <label class="check-row"><input id="discord-thumbnail" type="checkbox">楽曲のサムネイルを表示</label>
    <label class="field">楽曲アイコンのサイズ<select id="discord-size"><option value="small">小：補助画像（アプリアイコンを大きく表示）</option><option value="large">大：メイン画像（アプリアイコンを補助表示）</option></select><small>アプリの登録アイコン自体は変更しません。</small></label>
    <p class="form-note">表示位置と細かな大きさはDiscord側で決まります。四隅の自由指定・任意サイズ・背景全体への設定には対応していません。</p>
    <label class="check-row"><input id="discord-video-link" type="checkbox">楽曲アイコンを押すと動画を開く</label><p class="form-note">楽曲の画像だけに動画リンクを設定します。曲名・アプリアイコンには動画リンクを設定しません。リンクを開く際の確認画面やアプリ名から開くDiscord固有の画面はDiscord側の動作です。</p><label class="check-row"><input id="hide-paused" type="checkbox">一時停止中はアクティビティを非表示</label>
    <p class="form-note">非表示をオフにすると、停止位置 / 総再生時間を文字で表示します。</p>
    <div class="settings-actions"><button type="button" id="portal-button" class="button secondary">Developer Portalを開く ↗</button><button type="button" id="discord-guide-button" class="button secondary">画像の設定手順</button><button type="button" id="discord-image-button" class="button secondary">登録するPNGを表示</button></div><p id="discord-detail" class="status-detail"></p>
    <p class="form-note">左上の「戻る」または「保存して戻る」で保存します。×・閉じるは変更を保存せず閉じます。</p>`, save, '保存して戻る', save);
  $('discord-size').value = s.discordThumbnailSize || 'small';
  const imageOptions = () => { $('discord-size').disabled = !$('discord-thumbnail').checked; $('discord-video-link').disabled = !$('discord-thumbnail').checked; };
  $('discord-thumbnail').onchange = imageOptions;
  $('discord-thumbnail').checked = s.discordThumbnail !== false; $('discord-video-link').checked = s.discordVideoLink !== false; imageOptions();
  $('discord-enabled').checked = s.discordEnabled; $('discord-id').value = s.discordClientId; $('hide-paused').checked = s.hideWhenPaused; $('discord-image-key').value = s.discordImageKey;
  $('portal-button').onclick = () => Run(() => api.discordPortal());
  $('discord-guide-button').onclick = () => Run(() => api.discordGuide());
  $('discord-image-button').onclick = () => Run(() => api.discordImage()); UpdateStatus();
}
function TaskbarSettings() {
  const s = state.settings;
  const save = () => SaveSettingsSection({ taskbarEmbed: $('taskbar-embed').checked, taskbarWidth: Number($('taskbar-width').value), taskbarOffset: Number($('taskbar-offset').value) });
  OpenModal('ミニプレイヤー、タスクバー', `
    <label class="check-row"><input id="taskbar-embed" type="checkbox">タスクバー内部への埋め込みを試す（Windows用）</label>
    <p class="form-note">右上の下向き矢印から、プライマリーモニターの横向きタスクバーへ表示します。試験的な機能です。接続できない場合は従来の小型画面を開きます。</p>
    <label class="field">表示の幅<input id="taskbar-width" type="number" min="260" max="520" step="1" required><small>260〜520。アイコンと重なる場合は小さくします。表示倍率に合わせて拡大されます。</small></label>
    <label class="field">左へ移動する量<input id="taskbar-offset" type="number" min="0" max="1200" step="1" required><small>0で通知領域のすぐ左。保存後、下向き矢印から表示し直すと反映されます。</small></label>
    <p id="taskbar-detail" class="status-detail"></p><div class="settings-actions"><button id="taskbar-guide" type="button" class="button secondary">埋め込みの使い方</button><button id="taskbar-log" type="button" class="button secondary">埋め込みの診断記録を開く</button></div>
    <p class="form-note">左上の「戻る」または「保存して戻る」で保存します。×・閉じるは変更を保存せず閉じます。</p>`, save, '保存して戻る', save);
  $('taskbar-embed').checked = s.taskbarEmbed; $('taskbar-width').value = s.taskbarWidth; $('taskbar-offset').value = s.taskbarOffset;
  $('taskbar-log').onclick = () => Run(() => api.taskbarLog());
  $('taskbar-guide').onclick = () => Run(() => api.taskbarGuide()); UpdateStatus();
}
function ShuffleSettings() {
  const save = () => SaveSettingsSection({ weightedShuffle: $('weighted-shuffle').checked });
  OpenModal('シャッフルの再生回数', '<label class="check-row"><input id="weighted-shuffle" type="checkbox">再生回数が少ない曲を優先する</label><p class="form-note">通常再生も含め、実際に3秒以上再生した回数を曲単位で保存します。同じ動画URL・パートや同じ保存ファイルは、別のリストでも共通の回数です。回数が多い曲ほど後に出やすくなりますが、順序は毎回変わります。</p><button type="button" id="reset-play-counts" class="button secondary">再生回数をリセット</button><p class="form-note">リセットは次にシャッフルを開始すると反映されます。現在の再生予定は変更しません。</p>', save, '保存して戻る', save);
  $('weighted-shuffle').checked = state.settings.weightedShuffle !== false;
  $('reset-play-counts').onclick = () => OpenModal('再生回数をリセット', '<p class="form-note">全楽曲の再生回数を0に戻します。プレイリストや保存ファイルは残ります。</p>', async () => { await api.resetPlayCounts(); ShuffleSettings(); Toast('再生回数をリセットしました。'); }, 'リセットする');
}
function PlaybackSettings() {
  const s = state.settings;
  const save = async () => {
    if (!$('modal-form').reportValidity()) return false;
    const epoch = modalEpoch, settings = { volumeLeveling: $('volume-leveling').checked, autoThumbnailEnabled: $('auto-thumbnail').checked, autoThumbnailMinutes: Number($('auto-thumbnail-minutes').value) };
    UpdateDownloads(await api.preferSaved($('playback-source').value === 'saved'));
    return SaveSettingsSection(settings, epoch);
  };
  OpenModal('再生・表示', `
    <label class="field">再生するデータの優先<select id="playback-source"><option value="saved">保存済みの動画・音声を優先</option><option value="online">オンラインを優先</option></select><small>保存済みを優先すると、対応するファイルがある曲はPCから再生します。変更は次の曲の読み込みから反映します。</small></label>
    <label class="field">プレイリスト欄の幅<input id="sidebar-width" type="range" min="170" max="400" step="1"><output id="sidebar-width-value"></output><small>変更はすぐに反映・保存されます。</small></label>
    <label class="check-row"><input id="volume-leveling" type="checkbox">曲ごとの音量差を自動で揃える（大きい曲を下げます）</label>
    <p class="form-note">保存済みの音声・動画と、ローカルの曲が対象です（オンライン再生は対象外）。初めて再生する曲は、音量を測るため、数秒だけ遅れて反映されます。曲を上げることはしません。</p>
    <label class="check-row"><input id="auto-thumbnail" type="checkbox">アプリを前面で使っていない間は、自動で曲モードにする</label>
    <label class="field">切り替えまでの時間（分）<input id="auto-thumbnail-minutes" type="number" min="1" max="120" step="1" required><small>初期値5分。最小化・タスクバー表示中や、別のアプリを操作している間を数えます。前面に戻すと待ち時間をリセットします。</small></label>
    <p class="form-note">音声と再生位置は保ちます。自動切り替え後は「動画」で戻せます。同じ再生画面を再表示・再描画し、通常はページを再読み込みしません。</p>
    <p class="form-note">左上の「戻る」または「保存して戻る」で保存します。×・閉じるは変更を保存せず閉じます。</p>`, save, '保存して戻る', save);
  $('playback-source').value = downloadInfo.preferSaved === false ? 'online' : 'saved';
  $('volume-leveling').checked = s.volumeLeveling !== false;
  $('sidebar-width').value = s.sidebarWidth; $('sidebar-width-value').textContent = `${s.sidebarWidth}px`;
  $('sidebar-width').oninput = () => { const width = Number($('sidebar-width').value); $('sidebar-width-value').textContent = `${width}px`; document.body.style.setProperty('--sidebar-width', `${width}px`); Run(() => Action({ type: 'settings', settings: { sidebarWidth: width } })); };
  $('auto-thumbnail').checked = s.autoThumbnailEnabled; $('auto-thumbnail-minutes').value = s.autoThumbnailMinutes;
}
function Favorites() {
  const selected = new Map(); let page = 1, request = 0, destinations;
  OpenModal('Bilibiliの保存リストから追加', `<p class="form-note">ログインしたアカウントの「收藏夹」から、追加したい動画を選べます。</p><select id="favorite-folders" aria-label="保存リスト" disabled><option>読み込んでいます…</option></select><p id="favorite-message" class="status-detail"></p><div id="favorite-list" class="favorite-list"></div><div class="favorite-pages"><button id="favorite-prev" type="button" class="button secondary" disabled>前へ</button><span id="favorite-page">1</span><button id="favorite-next" type="button" class="button secondary" disabled>次へ</button></div><div class="settings-actions"><button id="favorite-login" type="button" class="button secondary">ログイン</button><button id="favorite-refresh" type="button" class="button secondary">リストを再取得</button><button id="favorite-official" type="button" class="button secondary">公式の保存リストを開く</button></div>`, async () => {
    if (!selected.size) throw new Error('追加する動画にチェックしてください。');
    await AddSelected({ type: 'add-videos', videos: [...selected].map(([url, title]) => ({ url, title, duration: videoDetails.get(url)?.duration })) }, destinations());
  }, '選択した動画を追加');
  destinations = AddDestinations();
  const videoDetails = new Map();
  const epoch = modalEpoch, active = key => epoch === modalEpoch && request === key && $('modal').open;
  const loadPage = async () => {
    const id = $('favorite-folders').value, key = ++request, requestedPage = page;
    $('favorite-message').textContent = '動画を読み込んでいます…'; $('favorite-prev').disabled = true; $('favorite-next').disabled = true;
    $('favorite-list').replaceChildren();
    try {
      const result = await api.favoriteVideos(id, requestedPage);
      if (!active(key)) return;
      $('favorite-list').replaceChildren(); $('favorite-page').textContent = String(requestedPage);
      for (const video of result.videos) {
        videoDetails.set(video.url, video);
        const label = Element('label', 'favorite-row'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected.has(video.url);
        input.onchange = () => { input.checked ? selected.set(video.url, video.title) : selected.delete(video.url); $('favorite-message').textContent = `${selected.size}本を選択中`; };
        const info = Element('span', '', video.title || video.videoId); info.append(Element('small', '', video.artist)); label.append(input, info); $('favorite-list').append(label);
      }
      $('favorite-message').textContent = result.videos.length ? `${selected.size}本を選択中` : 'このページに追加できる動画はありません。';
      $('favorite-prev').disabled = requestedPage <= 1; $('favorite-next').disabled = !result.hasMore;
    } catch (error) { if (active(key)) { $('favorite-message').textContent = `${error.message} リストを取得できない場合は公式画面から動画URLを追加できます。`; $('favorite-prev').disabled = requestedPage <= 1; } }
  };
  const loadFolders = async () => {
    const key = ++request;
    $('favorite-folders').disabled = true; $('favorite-refresh').disabled = true;
    $('favorite-prev').disabled = true; $('favorite-next').disabled = true; $('favorite-list').replaceChildren();
    try {
      const folders = await api.favoriteFolders(); if (!active(key)) return;
      $('favorite-folders').replaceChildren();
      for (const f of folders) { const option = Element('option', '', `${f.title} (${f.count})`); option.value = f.id; $('favorite-folders').append(option); }
      $('favorite-folders').disabled = !folders.length;
      $('favorite-refresh').disabled = false;
      if (folders.length) { page = 1; await loadPage(); } else $('favorite-message').textContent = '保存リストがありません。';
    } catch (error) { if (active(key)) { $('favorite-message').textContent = error.message; $('favorite-refresh').disabled = false; } }
  };
  $('favorite-folders').onchange = () => { page = 1; void loadPage(); };
  $('favorite-prev').onclick = () => { page--; void loadPage(); }; $('favorite-next').onclick = () => { page++; void loadPage(); };
  $('favorite-login').onclick = () => Run(() => api.login('bilibili'));
  $('favorite-official').onclick = () => Run(() => api.login('bilibili', true));
  $('favorite-refresh').onclick = loadFolders; void loadFolders();
}
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
    await AddSelected({ type: 'add-videos', videos: [...browser.selected].map(([url, title]) => ({ url, title, duration: browser.metadata?.get(url)?.duration })) }, destinations());
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
    importing = true; $('archive-import-all').disabled = true;
    try {
      const result = await api.commitImport(plan.id, ids, { parentId: destination.get() });
      cancelModal = null; state = result.state; allListsView = false; tree.ExpandTo(state, state.activePlaylistId, expandedLists); Render();
      Toast(`${result.imported}リストを親子関係を保って取り込みました。${result.ancestors ? `祖先 ${result.ancestors}リストは階層を保つために追加しました。` : ''}${result.downloaded ? `保存済み動画・音声 ${result.downloaded}件を復元しました。` : ''}${result.missing ? `ファイル不足：${result.missing}件。` : ''}${result.omitted ? `ローカル曲 ${result.omitted}件は登録情報のみ取り込みました。` : ''}`);
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
function DisplayRows(filter) {
  return tree.Rows(state, ViewScope(), expandedEntryLists, filter);
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
function RenderEntries() {
  queueDrag?.Cancel();
  const filter = $('filter').value.toLowerCase().trim(), items = allListsView ? [] : DisplayRows(filter);
  listArtwork?.Reset(); listArtwork?.SetEnabled(foreground); durationObserver?.disconnect(); durationQueue.clear();
  const list = $('entries'), scrollTop = list.scrollTop; list.replaceChildren(); entryRows.clear(); playlistRows.clear(); playlistExpandButtons.clear(); highlightedRow = null;
  if (allListsView) return;
  if (!items.length) {
    const empty = Element('div', 'empty-list'); empty.append(Element('strong', '', '＋'), Element('span', '', filter ? '一致する動画がありません。' : '動画を追加すると、ここに再生リストが表示されます。')); list.append(empty);
  }
  for (const item of items) {
    if (item.playlist) { list.append(MakePlaylistRow(item)); continue; }
    const { entry, index } = item, ownerId = entry.playlistId;
    const row = Element('div', `entry ${entry.type}${entry.missing ? ' missing' : ''}`);
    row.dataset.entryId = entry.id; row.dataset.ownerId = ownerId; row.style.marginLeft = `${Math.min(item.depth * 18, 90)}px`; if (!entryRows.has(entry.id)) entryRows.set(entry.id, row);
    const handle = Button(String(index + 1).padStart(2, '0'), 'entry-number', () => {}, 'ドラッグで並べ替え（Alt＋↑/↓でも移動）');
    handle.addEventListener('keydown', event => { if (!allListsView && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); Run(() => Action({ type: 'move', playlistId: ownerId, entryId: entry.id, direction: event.key === 'ArrowUp' ? -1 : 1 })); } });
    queueDrag?.Bind(handle, row, { playlistId: ownerId, entryId: entry.id }, true);
    row.append(handle);
    const cover = Element('img', 'entry-cover'); cover.alt = ''; cover.draggable = false; cover.width = 56; cover.height = 34; cover.src = 'music.png';
    row.append(cover); listArtwork?.Add(cover, ownerId, entry.id);
    const play = Button('', 'icon-button', () => PlayEntry(entry), `${EntryTitle(entry)}を再生する`);
    play.innerHTML = '<svg aria-hidden="true"><use href="icons.svg#play"/></svg>'; row.append(play);
    const info = Button('', 'entry-info', () => PlayEntry(entry), `${EntryTitle(entry)}を再生`);
    info.append(Element('strong', '', EntryTitle(entry)), Element('small', '', entry.type !== 'local' ? `${EntryDuration(entry)} · ${entry.videoId} · P${entry.part || 1}` : `${EntryDuration(entry)} · このPCに保存したファイル`));
    info.dataset.durationEntry = entry.id;
    if (!entry.duration) { row.durationEntry = entry; durationObserver?.observe(row); }
    const badge = Element('span', 'entry-type'); PaintSavedBadge(badge, entry); row.append(info, badge);
    row.append(Button('•••', 'icon-button', () => EntryMenu(entry), `${EntryTitle(entry)}を編集`));
    list.append(row);
  }
  if (items.length) { const tail = Element('div', 'queue-tail'); tail.setAttribute('aria-hidden', 'true'); list.append(tail); UpdateQueueTail(); }
  list.scrollTop = scrollTop;
  UpdateCurrentRows();
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
  RenderEntries(); RenderHome(); RenderPlayer(); RenderNext(); UpdateStatus(); UpdateAccounts(); BackgroundInteractive(foreground);
}
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
  for (const p of state.playlists) for (const e of p.entries) if (e.id === id) e.duration = duration;
  for (const info of $('entries').querySelectorAll('.entry-info')) if (info.dataset.durationEntry === id) {
    const entry = state.playlists.flatMap(p => p.entries).find(e => e.id === id);
    info.querySelector('small').textContent = entry.type === 'bilibili' ? `${EntryDuration(entry)} · ${entry.videoId} · P${entry.part || 1}` : `${EntryDuration(entry)} · このPCに保存したファイル`;
  }
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
