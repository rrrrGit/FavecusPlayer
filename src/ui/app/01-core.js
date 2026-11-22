'use strict';
// 画面（app.js）を、読み込み順に分けたもの：状態・おやすみタイマー・お気に入り・自動リスト・モーダルの基本。全体は、classic script として順に読み込む（index.html）。
const $ = id => document.getElementById(id);
let state, current = null, playback = null, thumbnail = null, statuses = {}, queueInfo = null, foreground = false;
let submitModal = null, toastTimer, loaded = false, seeking = false, accounts = {}, dragged = null, lastVolume = 1, modalEpoch = 0, pendingModal = null, cancelModal = null;
const { HasPlayback, TransportState } = window.FavecusTransport;
const api = window.favecusApp;
// おやすみタイマー（規則は core/sleep-timer.cjs。ここは表示と、押したときの次の指定だけ）。
let sleepState = { mode: 'off' };
// 再生速度（0.5〜2.0倍。ボタンを押すたびに、次の段階へ。段階と保存は main 側＝core/playback-speed.cjs）
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
let playbackSpeed = 1;
function NextSpeed(value) { const at = SPEED_OPTIONS.indexOf(value); return SPEED_OPTIONS[(at + 1) % SPEED_OPTIONS.length]; }
function RenderSpeed() {
  const button = $('speed'); if (!button) return;
  const text = `${playbackSpeed}x`, label = `再生速度 ${text}（押すと${NextSpeed(playbackSpeed)}x）`;
  button.textContent = text; button.title = label; button.setAttribute('aria-label', label); button.classList.toggle('enabled', playbackSpeed !== 1);
}
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
let listViews = {}; // プレイリストごとの、曲の並べ替え・絞り込みの選択（main に保存）
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
  { kind: 'unplayed', title: '未再生', note: 'まだ聴いていない曲（登録の新しい順）' },
  { kind: 'favorites', title: 'お気に入り', note: 'お気に入りにした曲（登録の新しい順）' },
  { kind: 'history', title: '最近聴いた曲', note: '最近再生した曲（新しい順）' }
];
let autoListCounts = null;
function RefreshAutoLists() {
  if (!api?.autoList || !autoListCounts || $('home')?.classList.contains('hidden')) return;
  const targets = autoListCounts;
  void api.autoList().then(result => {
    if (targets !== autoListCounts) return;
    for (const meta of AUTO_LIST_KINDS) { const el = targets.get(meta.kind); if (el) el.textContent = `${result?.[meta.kind] ?? 0}曲`; }
  }).catch(() => {});
}
function MakeAutoLists() {
  if (!api?.autoList || !api?.autoPlay) return null;
  const section = Element('section', 'auto-lists'); section.setAttribute('aria-label', '自動リスト');
  section.append(Element('h2', '', '自動リスト'));
  const cards = Element('div', 'auto-cards'); section.append(cards);
  const counts = new Map();
  autoListCounts = counts;
  for (const meta of AUTO_LIST_KINDS) {
    const card = Element('button', 'auto-card'); card.type = 'button';
    const name = Element('strong', '', meta.title), note = Element('span', 'auto-note', meta.note), count = Element('span', 'auto-count', '');
    card.append(name, note, count); counts.set(meta.kind, count);
    card.addEventListener('click', () => Run(() => OpenAutoList(meta)));
    cards.append(card);
  }
  RefreshAutoLists();
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

// 通知は、7秒以内の新しいものを、最大3件まで重ねて出す（続けて起きたエラーで、前のものが消えない）。同じ内容は、1つにまとめる。
const toastLog = [];
function Toast(message) {
  const now = Date.now();
  while (toastLog.length && (now - toastLog[0].at > 7000 || toastLog.length >= 3)) toastLog.shift();
  const last = toastLog.at(-1);
  if (last && last.message === message) last.at = now; else toastLog.push({ message, at: now });
  const text = toastLog.map(item => item.message).join('\n');
  if ($('modal').open) { $('modal-notice').textContent = text; $('modal-notice').classList.remove('hidden'); }
  $('toast').textContent = text; $('toast').classList.remove('hidden');
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
function CloseModal() { CancelModalTask(); modalEpoch++; $('modal').close(); BackgroundInteractive(true); SendBounds(); RunAfterModal(); }
// 画面が開いているあいだに来た操作は、断らずに覚えておき、閉じたあとに続ける（最後の1件だけ）。
let afterModal = null;
function AfterModal(run) { afterModal = run; }
function RunAfterModal() { const next = afterModal; afterModal = null; if (next) setTimeout(() => { if ($('modal').open) afterModal ??= next; else next(); }, 0); }
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
