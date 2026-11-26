'use strict';
// ライブラリの点検（v0.7.4）：重複とリンク切れを調べて「報告するだけ」。自動では、何も消さない・直さない。PC版・iPhone版で同じ規則（共通JS）。
// ・重複：同じプレイリストの中に、同じメディア（同じ動画・パート、または同じファイル）の曲が2つ以上ある。別のリストに同じ曲があるのは、普通の使い方なので、重複とは数えない。
// ・リンク切れ：ローカルの曲で、メディアのファイルが、この端末にない（existingFiles に名前がない）。
// 外すのは、利用者が選んで、通常の「リストから外す」（最近削除へ保管される）で行う。
const { LibraryMediaKey } = require('./library-identity.cjs');

// library：ライブラリ（playlists[].entries[]）。existingFiles：メディアの置き場にあるファイル名の一覧（配列）。
// 戻り値：{ duplicates: [{ playlistId, playlistName, title, entries: [{ id, title }] }], missing: [{ playlistId, playlistName, entryId, title, fileName }], checked: 点検した曲の数 }
function Audit(library, existingFiles = []) {
  const files = new Set(existingFiles), keyOf = LibraryMediaKey(Array.isArray(library?.videoAliases) ? library.videoAliases : []);
  const duplicates = [], missing = [];
  let checked = 0;
  for (const list of Array.isArray(library?.playlists) ? library.playlists : []) {
    const groups = new Map();
    for (const entry of Array.isArray(list?.entries) ? list.entries : []) {
      if (!entry || typeof entry.id !== 'string') continue;
      checked++;
      let key = ''; try { key = keyOf(entry) || ''; } catch { key = ''; }
      if (key) { let group = groups.get(key); if (!group) { group = []; groups.set(key, group); } group.push(entry); }
      if (entry.type === 'local' && typeof entry.fileName === 'string' && !files.has(entry.fileName)) missing.push({ playlistId: list.id, playlistName: list.name, entryId: entry.id, title: entry.title || entry.fileName, fileName: entry.fileName });
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      duplicates.push({ playlistId: list.id, playlistName: list.name, title: group[0].title || group[0].videoId || group[0].fileName || '', entries: group.map(e => ({ id: e.id, title: e.title || '' })) });
    }
  }
  return { duplicates, missing, checked };
}

module.exports = { Audit };
