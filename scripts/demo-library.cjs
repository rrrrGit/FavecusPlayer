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
// 保存済みの表示の確認用（第3引数：downloads.json の出力先。実際のファイルは作らないので、CIのスクリーンショット用のファイルを別に用意する）
// 第4引数：サムネイルの出力先フォルダー（模擬の単色グラデーションのPNG。実在の画像は使わない）
if (process.argv[4]) {
  const zlib = require('node:zlib'), path = require('node:path');
  const crc = buffer => zlib.crc32(buffer) >>> 0;
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4); return out; };
  const png = (w, h, color) => {
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const t = (x / w + y / h) / 2, o = y * (w * 3 + 1) + 1 + x * 3; for (let c = 0; c < 3; c++) raw[o + c] = Math.round(color[c] * (1 - 0.55 * t)); } }
    const header = Buffer.alloc(13); header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };
  fs.mkdirSync(process.argv[4], { recursive: true });
  const palette = [[200, 110, 90], [90, 150, 210], [110, 190, 140], [210, 170, 80], [170, 110, 200], [90, 190, 200], [220, 120, 160], [130, 130, 220], [180, 200, 90]];
  for (let n = 1; n <= 9; n++) fs.writeFileSync(path.join(process.argv[4], `bili_BV1${String(n).padStart(9, 'd')}_p1.jpg`), png(320, 180, palette[n - 1]));
}
if (process.argv[3]) {
  const record = (n, kind) => ({ key: `bili:BV1${String(n).padStart(9, 'd')}:p1`, kind, quality: 720, state: 'Completed', fileName: `demo-${kind}-${n}.${kind === 'video' ? 'mp4' : 'm4a'}`, bytes: 1048576, duration: 200, updatedAt: 1760000000 });
  // 保存タブの確認用（v0.7.1）：失敗・取り消し（新しい記録は一覧に出る）／音声が保存済みの動画の失敗（行に「保存に失敗」を出さない）
  const now = Math.floor(Date.now() / 1000);
  const problem = (n, kind, state, message) => ({ key: `bili:BV1${String(n).padStart(9, 'd')}:p1`, kind, quality: 720, state, bytes: 0, duration: 0, message, updatedAt: now - 60 });
  fs.writeFileSync(process.argv[3], JSON.stringify({ version: 1, records: [record(1, 'audio'), record(2, 'video'), record(5, 'audio'), problem(3, 'video', 'Failed', '保存したファイルの長さが、動画の長さと一致しません（期待 257秒・実際 241秒）。'), problem(4, 'audio', 'Cancelled', '取り消しました。'), problem(5, 'video', 'Failed', '結合に失敗しました。')] }, null, 2));
}
console.log('wrote', process.argv[2] || 'demo-library.json');
