'use strict';
// 画面（app.js）を、読み込み順に分けたもの：曲・リストの追加、既存の曲、リストの操作メニュー。全体は、classic script として順に読み込む（index.html）。
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
    return await finish([]);
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
  const optionalDestinations = () => { try { return destinations(); } catch { return []; } };
  $('url-input').value = prefill.url || ''; $('url-title').value = prefill.title || ''; $('modal-submit').disabled = true;
  const analyze = async () => {
    const value = $('url-input').value.trim(), token = ++request; $('url-load').disabled = true; $('modal-submit').disabled = true;
    $('url-analysis').textContent = 'URLを確認しています…';
    try {
      const result = await api.resolveURL(value);
      if (epoch !== modalEpoch || token !== request || value !== $('url-input').value.trim()) return;
      resolved = result; readInput = value;
      if (result.kind === 'playlist') { PlaylistURL({ url: value, sources: result.sources, destinationIds: optionalDestinations() }); return; }
      if (result.kind === 'videos') { $('url-single').classList.add('hidden'); $('url-related').classList.add('hidden'); $('url-analysis').textContent = `単体動画 ${result.videos.length}件を読み込みました。`; $('modal-submit').disabled = false; return; }
      $('url-single').classList.remove('hidden'); $('url-analysis').textContent = `単体動画 · ${result.video.videoId} · P${result.video.part}`;
      if (!$('url-title').value) $('url-title').value = result.video.title || '';
      $('modal-submit').disabled = false; $('url-related').replaceChildren();
      $('url-related').classList.toggle('hidden', !result.sources.length);
      if (result.sources.length) $('url-related').append(Button('この動画の全パート・再生リストを開く', 'button secondary', () => PlaylistURL({ url: value, sources: result.sources, destinationIds: optionalDestinations() })));
    } catch (error) { if (epoch === modalEpoch && token === request) { resolved = null; $('url-analysis').textContent = error.message; } }
    finally { if (epoch === modalEpoch && token === request) $('url-load').disabled = false; }
  };
  $('url-load').onclick = () => Run(analyze);
  $('url-get-title').onclick = () => Run(async () => { const token = request, url = readInput; const result = await api.resolveURL(url); if (epoch === modalEpoch && token === request && result.video) $('url-title').value = result.video.title || ''; });
  $('url-input').oninput = () => { request++; resolved = null; $('modal-submit').disabled = true; $('url-load').disabled = false; $('url-single').classList.add('hidden'); $('url-related').classList.add('hidden'); };
  if (prefill.analyze) void analyze();
}
// フォルダから追加：フォルダの中の動画・音楽（サブフォルダも。最大2000件）を、埋め込みのタグ（曲名・アーティスト）つきで、まとめて追加する。
function AddLocalFolder() {
  let destinations;
  OpenModal('フォルダから追加', '<p class="form-note">追加先を選んでから、フォルダを選びます。フォルダの中の動画・音楽ファイル（サブフォルダも。最大2000件）を、PC内に1回だけ取り込みます（元のファイルは変えません）。ファイルに曲名・アーティストのタグがあれば、曲名に使い、アーティストは「曲の情報」に入れます。</p>', async () => {
    const epoch = modalEpoch, ids = destinations();
    Toast('フォルダの中のファイルを調べています…');
    const plan = await api.prepareFolder(ids);
    return ReviewAddition(plan, epoch);
  }, 'フォルダを選んで追加');
  destinations = AddDestinations();
}
function AddLocalFiles() {
  let destinations;
  OpenModal('ファイルを追加', '<p class="form-note">追加先を選んでから、動画・音楽ファイルを選択します。ファイルはPC内に1回だけ取り込み、チェックしたリストで共通のファイルを使います。</p>', async () => {
    const epoch = modalEpoch, ids = destinations();
    const plan = await api.prepareFiles(ids);
    return ReviewAddition(plan, epoch);
  }, 'ファイルを選んで追加');
  destinations = AddDestinations();
  $('modal-body').append(Button('フォルダごと追加…（サブフォルダも・タグを読む）', 'button secondary', () => { CloseModal(); AddLocalFolder(); }));
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
