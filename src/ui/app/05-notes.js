'use strict';
// 画面（app.js）を、読み込み順に分けたもの：曲の情報（アーティスト・タグ・メモ・チャプター）。全体は、classic script として順に読み込む（index.html）。
// 規則と保存は main 側（core/song-notes.cjs・song-notes-store.cjs。この端末内だけ。同期しない）。

let currentChapters = []; // 再生中の曲のチャプター（時刻順）

// 曲の情報の編集。チャプターは、1行に「時刻 題名」（動画の説明欄の目次を、そのまま貼り付けて取り込める）。
async function SongInfoDialog(playlistId, entry) {
  const info = await api.notesGet(playlistId, entry.id);
  if (!info.identified) { Toast('この曲は、まだ識別できないため、情報を保存できません。再生などで動画の情報を取得してから、もう一度お試しください。'); return; }
  const record = info.record || { artist: '', tags: [], memo: '', chapters: [] };
  OpenModal('曲の情報', `<p class="form-note" id="notes-title"></p><p class="form-note">この曲の情報は、このPCだけに保存します（同期・ZIPには含めません）。同じ動画・同じファイルの曲は、どのリストでも共通です。</p>
    <label class="field">アーティスト<input id="notes-artist" maxlength="100"></label>
    <label class="field">タグ（カンマ・読点で区切る）<input id="notes-tags" placeholder="歌枠, 雑談"></label>
    <label class="field">メモ<textarea id="notes-memo" rows="3" maxlength="2000"></textarea></label>
    <label class="field">チャプター（1行に「1:23 題名」。説明欄の目次を貼り付けられます）<textarea id="notes-chapters" rows="6" placeholder="0:00 オープニング&#10;3:15 一曲目"></textarea></label>`, async () => {
    const tags = $('notes-tags').value.split(/[,、，\n]/).map(tag => tag.trim()).filter(Boolean);
    const saved = await api.notesSet(playlistId, entry.id, { artist: $('notes-artist').value, tags, memo: $('notes-memo').value, chapterText: $('notes-chapters').value });
    Toast(saved ? '曲の情報を保存しました。' : '曲の情報を消しました。');
    if (current && current.entryId === entry.id) await RefreshChapters();
  }, '保存する');
  $('notes-title').textContent = EntryTitle(entry);
  $('notes-artist').value = record.artist; $('notes-tags').value = record.tags.join(', '); $('notes-memo').value = record.memo; $('notes-chapters').value = record.chapterText || '';
}

// 再生中の曲のチャプターを取り直し、ボタンの表示を合わせる。
async function RefreshChapters() {
  const button = $('chapters');
  currentChapters = [];
  if (current && api.notesGet) { try { const info = await api.notesGet(current.playlistId, current.entryId); currentChapters = info.record?.chapters || []; } catch { currentChapters = []; } }
  if (button) { button.classList.toggle('hidden', !currentChapters.length); button.title = `チャプター（${currentChapters.length}）`; button.setAttribute('aria-label', button.title); }
}
function ChapterList() {
  if (!currentChapters.length) return;
  OpenModal('チャプター', '<div id="chapter-rows" class="chapter-rows"></div>', null);
  const box = $('chapter-rows'), now = playback?.position || 0;
  currentChapters.forEach((chapter, index) => {
    const next = currentChapters[index + 1], active = chapter.at <= now && (!next || now < next.at);
    const row = Button(`${Time(chapter.at)}　${chapter.title}`, `button secondary chapter-row${active ? ' enabled' : ''}`, () => { CloseModal(); void api.command('seek', chapter.at); });
    box.append(row);
  });
}
