'use strict';
// IPC：保存（オフライン）
// main.cjs から分けたもの（動作は同じ）。状態（store・current など）は、ctx 経由で、その都度読む（S.store など）。
module.exports = function RegisterDownloads(ctx) {
  const S = ctx;
  const { Handle, ParseBilibili, dialog, fs, shell } = ctx;
  Handle('downloads:state', () => S.offline.Snapshot());
  const downloadTarget = options => {
    if (!options || typeof options.includeChildren !== 'boolean') throw new Error('保存対象を指定してください。');
    const list = S.store.Playlist(options.playlistId), selected = { kind: options.kind, height: options.height, playlistId: list.id, playlistName: list.name, estimateId: options.estimateId };
    if (Object.hasOwn(options, 'entryId') || Object.hasOwn(options, 'entryURL')) {
      if (options.includeChildren || typeof options.entryId !== 'string' || typeof options.entryURL !== 'string') throw new Error('保存する1曲を指定してください。');
      const entry = S.store.Entry(list.id, options.entryId);
      if (entry.type !== 'bilibili' || ParseBilibili(options.entryURL).url !== entry.url) throw new Error('保存対象が変更されました。動画の編集を開き直してください。');
      return { entries: [{ ...entry, playlistId: list.id }], options: { ...selected, entryId: entry.id, entryURL: entry.url } };
    }
    return { entries: options.includeChildren ? S.store.Entries(list.id) : list.entries.map(e => ({ ...e, playlistId: list.id })), options: selected };
  };
  // 選んだ曲（Bilibili）を、まとめて保存する（音声。見積もりの確認は省く）。曲を持つリストは、まちまち。
  Handle('downloads:save-selected', options => {
    if (!options || !Array.isArray(options.entries) || !options.entries.length || options.entries.length > 10000) throw new Error('保存する曲を選んでください。');
    const entries = [];
    for (const ref of options.entries) { const entry = S.store.Entry(String(ref?.playlistId), String(ref?.entryId)); if (entry.type === 'bilibili') entries.push({ ...entry, playlistId: String(ref.playlistId) }); }
    if (!entries.length) throw new Error('保存できるBilibiliの曲がありません。');
    return S.offline.Start(entries, { kind: options.kind === 'video' ? 'video' : 'audio', height: Number(options.height) || 720, playlistId: entries[0].playlistId, playlistName: '選んだ曲' });
  });
  Handle('downloads:estimate', options => { const target = downloadTarget(options); return S.offline.Estimate(target.entries, target.options); });
  Handle('downloads:estimate-cancel', () => S.offline.CancelEstimate());
  Handle('downloads:start', options => { const target = downloadTarget(options); return S.offline.Start(target.entries, target.options); });
  Handle('downloads:cancel', () => S.offline.Cancel());
  Handle('downloads:prefer', value => S.offline.PreferSaved(value));
  Handle('downloads:directory', async () => { if (S.offline.controller) throw new Error('保存中は保存先を変更できません。'); const result = await dialog.showOpenDialog(S.win, { title: '動画・音声の保存先', defaultPath: S.offline.directory, properties: ['openDirectory', 'createDirectory'] }); return result.canceled || !result.filePaths?.[0] ? S.offline.Snapshot() : S.offline.SetDirectory(result.filePaths[0]); });
  Handle('downloads:open', async () => { fs.mkdirSync(S.offline.directory, { recursive: true }); if (await shell.openPath(S.offline.directory)) throw new Error('保存先を開けませんでした。'); return true; });
};
