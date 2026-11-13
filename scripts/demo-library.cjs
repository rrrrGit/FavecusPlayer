'use strict';
// 画面確認用の模擬ライブラリ（iOSシミュレーターのスクリーンショット用）。実データ・実在の動画は含まない。
// 使い方: node scripts/demo-library.cjs <出力先.json>   固定IDなので、-FavecusDemoPath へ渡す階層も決まっている。
const fs = require('node:fs');
const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pid = n => id(1, n);
const entry = (n, title) => ({ id: id(2, n), mediaId: id(3, n), type: 'bilibili', title, addedAt: '2026-11-13T00:00:00.000Z', url: `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'd')}/` });
const list = (n, name, entries, childIds) => ({ id: pid(n), name, icon: '', entries, childIds, createdAt: '2026-11-01T00:00:00.000Z', lastAddedAt: '', includeInAll: true });
const library = {
  version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: pid(1), rootPlaylistIds: [pid(1), pid(5), pid(6)],
  playlists: [
    list(1, '作業用BGM', [entry(1, '朝のピアノ'), entry(2, 'Lo-fi ビート 1時間'), entry(3, '雨の日のジャズ')], [pid(2), pid(3)]),
    list(2, '集中', [entry(4, 'Deep Focus'), entry(5, '静かなストリングス')], [pid(4)]),
    list(3, 'リラックス', [entry(6, '夜の海辺')], []),
    list(4, '試験前', [entry(7, 'ノイズカット 8時間')], []),
    list(5, 'ゲーム音楽', [entry(8, 'フィールド曲メドレー'), entry(9, 'ボス戦 総集編')], []),
    list(6, 'お気に入り', [], [])
  ]
};
fs.writeFileSync(process.argv[2] || 'demo-library.json', JSON.stringify(library, null, 2));
console.log('wrote', process.argv[2] || 'demo-library.json');
