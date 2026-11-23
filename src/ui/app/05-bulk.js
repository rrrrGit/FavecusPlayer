'use strict';
// 画面（app.js）を、読み込み順に分けたもの：曲の複数選択と一括操作（移動・追加・お気に入り・保存・外す）。全体は、classic script として順に読み込む（index.html）。
// 選択は、曲のIDの集まりとして持つ（行は、画面の近くに来てから作るため、行の部品には持たない）。

let selectionMode = false, selectionPlaylistId = null;
const selectedEntries = new Map(); // 曲のID → { playlistId（その曲を持つリスト）, entryId }

const EntryRefOf = entry => ({ playlistId: entry.playlistId, entryId: entry.id });
const SelectedRefs = () => [...selectedEntries.values()];
// 画面に出ている曲（絞り込み・並べ替えのあと）
function DisplayedEntries() { return DisplayRows($('filter').value.toLowerCase().trim()).filter(row => row.entry).map(row => row.entry); }

function SyncSelectionModeUI() {
  const button = $('select-mode'); if (button) { button.classList.toggle('enabled', selectionMode); button.textContent = selectionMode ? '選択を終わる' : '選択'; button.setAttribute('aria-pressed', String(selectionMode)); }
  UpdateBulkBar();
}
function SyncSelectionScope() {
  if (!selectionMode) return;
  if (allListsView || (selectionPlaylistId && state?.activePlaylistId !== selectionPlaylistId)) {
    selectionMode = false; selectionPlaylistId = null; selectedEntries.clear();
    SyncSelectionModeUI();
  } else {
    UpdateBulkBar();
  }
}
function SetSelectionMode(on) {
  selectionMode = !!on && !allListsView;
  selectionPlaylistId = selectionMode ? state?.activePlaylistId || null : null;
  if (!selectionMode) selectedEntries.clear();
  SyncSelectionModeUI(); RenderEntries();
}
// 行の中身を作るとき（selectionMode のとき）：チェックと、行を押して選ぶ動き。
function BindSelection(row, entry) {
  const box = document.createElement('input'); box.type = 'checkbox'; box.className = 'entry-check'; box.checked = selectedEntries.has(entry.id); box.setAttribute('aria-label', `${EntryTitle(entry)}を選ぶ`);
  row.prepend(box);
  const toggle = () => {
    if (selectedEntries.has(entry.id)) selectedEntries.delete(entry.id); else selectedEntries.set(entry.id, EntryRefOf(entry));
    box.checked = selectedEntries.has(entry.id); row.classList.toggle('selected', box.checked); UpdateBulkBar();
  };
  box.addEventListener('click', event => { event.stopPropagation(); toggle(); });
  // 選んでいる間は、行のどこを押しても、再生せず、選ぶ・外すだけ（中の再生・メニューのボタンより先に受ける）
  row.addEventListener('click', event => { if (event.target === box) return; event.preventDefault(); event.stopPropagation(); toggle(); }, true);
  row.classList.toggle('selected', box.checked);
}

function UpdateBulkBar() {
  let bar = $('bulk-bar');
  if (!bar) {
    bar = Element('div', 'bulk-bar hidden'); bar.id = 'bulk-bar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '選んだ曲の操作');
    const actions = [['bulk-all', 'すべて選ぶ', () => BulkSelectAll()], ['bulk-none', '選びなおす', () => { selectedEntries.clear(); UpdateBulkBar(); RenderEntries(); }],
      ['bulk-move', '移動', () => BulkTransfer('move')], ['bulk-copy', '追加', () => BulkTransfer('copy')], ['bulk-like', '♡ お気に入り', () => BulkFavorite(true)], ['bulk-unlike', '♥ 外す', () => BulkFavorite(false)],
      ['bulk-save', '保存', () => BulkSave()], ['bulk-remove', 'リストから外す', () => BulkRemove()]];
    bar.append(Element('span', 'bulk-count', ''));
    for (const [id, label, run] of actions) { const b = Button(label, `button secondary${id === 'bulk-remove' ? ' danger' : ''}`, () => Run(run)); b.id = id; bar.append(b); }
    $('entries').before?.(bar);
  }
  // 無くなった曲（外した・移した）は、選びから外す
  const existing = new Set(state.playlists.flatMap(p => p.entries.map(e => e.id)));
  for (const id of [...selectedEntries.keys()]) if (!existing.has(id)) selectedEntries.delete(id);
  const count = selectedEntries.size;
  bar.classList.toggle('hidden', !selectionMode);
  bar.querySelector('.bulk-count').textContent = `${count}曲を選択中`;
  for (const id of ['bulk-none', 'bulk-move', 'bulk-copy', 'bulk-like', 'bulk-unlike', 'bulk-save', 'bulk-remove']) $(id).disabled = count === 0;
}
function BulkSelectAll() {
  for (const entry of DisplayedEntries()) selectedEntries.set(entry.id, EntryRefOf(entry));
  UpdateBulkBar(); RenderEntries();
}

// 移動・追加（別のリストへ）。追加は、既存の「重複の確認」を通す。移動は、元のリストから外し、同じ動画のあるリストへは重複登録しない。
function BulkTransfer(mode) {
  const refs = SelectedRefs(); if (!refs.length) return;
  const owners = [...new Set(refs.map(ref => ref.playlistId))];
  OpenModal(mode === 'move' ? '選んだ曲を、別のリストへ移動' : '選んだ曲を、別のリストへ追加',
    `<p class="form-note">${refs.length}曲を、${mode === 'move' ? '移動' : '追加（元のリストにも残す）'}します。移動・追加先は複数選べます。</p>`, async () => {
      const destinationIds = choose();
      if (mode === 'copy') { const result = await AddSelected({ type: 'add-existing', entries: refs }, destinationIds); if (result !== false) { selectedEntries.clear(); UpdateBulkBar(); RenderEntries(); } return result; }
      const result = await api.moveTracks({ entries: refs, destinationIds });
      state = result.state; selectedEntries.clear(); Render(); UpdateBulkBar();
      Toast(`${refs.length}曲を移動しました。`);
    }, mode === 'move' ? '移動する' : '確認へ進む');
  const choose = AddDestinations({ exclude: owners.length === 1 ? owners : [] });
}

async function BulkFavorite(value) {
  const refs = SelectedRefs(); if (!refs.length) return;
  favoriteIds = new Set(await api.favoriteMany(refs, value)); RenderFavorite(); listViewStats.clear();
  Toast(value ? `${refs.length}曲をお気に入りにしました。` : `${refs.length}曲をお気に入りから外しました。`);
}

// 保存：選んだ曲のうち、Bilibiliの曲を、音声で保存する（画質・動画の保存は、1曲ごとの画面から）。
async function BulkSave() {
  const refs = SelectedRefs(); if (!refs.length) return;
  const targets = refs.filter(ref => state.playlists.find(p => p.id === ref.playlistId)?.entries.find(e => e.id === ref.entryId)?.type === 'bilibili');
  if (!targets.length) { Toast('選んだ曲に、保存できるBilibiliの曲がありません。'); return; }
  if (!confirm(`選んだ${targets.length}曲を、音声で、このPCに保存します。`)) return;
  await api.saveSelected({ entries: targets, kind: 'audio' });
  Toast('保存を始めました。進み具合は、保存の表示で確認できます。');
}

// リストから外す：曲ごとに、最近削除へ保管する（30日間、元に戻せる）。曲を持つリストごとに、まとめて外す。
async function BulkRemove() {
  const refs = SelectedRefs(); if (!refs.length) return;
  if (!confirm(`選んだ${refs.length}曲を、リストから外します。「最近削除」から、30日間、元に戻せます。`)) return;
  const byList = new Map();
  for (const ref of refs) byList.set(ref.playlistId, [...(byList.get(ref.playlistId) || []), ref.entryId]);
  for (const [playlistId, entryIds] of byList) await Action({ type: 'remove-many', playlistId, entryIds });
  selectedEntries.clear(); UpdateBulkBar(); RenderEntries();
  Toast(`${refs.length}曲をリストから外しました。`);
}
