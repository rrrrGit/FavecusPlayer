'use strict';
// iPhone版の取り込みテスト用に、Windows版の実際の出力処理（LibraryArchive.Export）でZIPを作る（CIのテスト前に実行）。
// 実データ・実在の動画は含まない。ローカル曲の音声は、ここで作る短いWAVだけ。
// 使い方: node scripts/make-test-archive.cjs <出力フォルダ>
// 出力: windows-media.zip（メディア付き）、windows-info.zip（情報のみ）、corrupt-media.zip（メディアの1バイトを変えたもの）、expected.json
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { LibraryArchive } = require('../src/core/library-archive.cjs');

const out = path.resolve(process.argv[2] || 'transfer-out');
fs.mkdirSync(out, { recursive: true });
const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pid = n => id(1, n);
function Wav(seconds) { // 8kHz・16bit・モノラルの無音
  const samples = 8000 * seconds, data = Buffer.alloc(samples * 2), header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i / 8) * 3000), i * 2);
  return Buffer.concat([header, data]);
}
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-make-zip-')), store = new Store(dir, {});
  const localA = `${id(4, 1)}.wav`, localB = `${id(4, 2)}.wav`;
  const wavA = Wav(1), wavB = Wav(2);
  fs.writeFileSync(path.join(store.media, localA), wavA); fs.writeFileSync(path.join(store.media, localB), wavB);
  const entry = (n, title) => ({ id: id(2, n), mediaId: id(3, n), type: 'bilibili', title, addedAt: '', url: `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'g')}/` });
  const local = (n, title, fileName) => ({ id: id(2, n), mediaId: id(3, n), type: 'local', title, addedAt: '', fileName });
  const list = (n, name, entries, childIds, includeInAll = true) => ({ id: pid(n), name, icon: '', entries, childIds, createdAt: '2026-11-01T00:00:00.000Z', lastAddedAt: '', includeInAll });
  store.data = {
    ...store.data, activePlaylistId: pid(1), rootPlaylistIds: [pid(1), pid(3)],
    playlists: [list(1, '親', [entry(1, '曲1'), local(2, 'ローカルA', localA)], [pid(2)]), list(2, '子', [local(3, 'ローカルB', localB), entry(4, '曲4')], [], false), list(3, '独立', [], [])]
  };
  store.Save();
  const archive = new LibraryArchive(store, null);
  await archive.Export(path.join(out, 'windows-media.zip'), undefined, { mode: 'media' });
  await archive.Export(path.join(out, 'windows-info.zip'), undefined, { mode: 'information' });
  // メディアの実体を1バイトだけ変えたZIP（CRC不一致の確認用）。実体の先頭はWAVのRIFFなので、その位置を探す。
  const bytes = Buffer.from(fs.readFileSync(path.join(out, 'windows-media.zip'))), at = bytes.indexOf(Buffer.from('RIFF'));
  if (at < 0) throw new Error('メディアの位置が見つかりません。');
  bytes[at + 100] ^= 0xff; fs.writeFileSync(path.join(out, 'corrupt-media.zip'), bytes);
  fs.writeFileSync(path.join(out, 'expected.json'), JSON.stringify({ lists: ['親', '子', '独立'], rootLists: ['親', '独立'], localSizes: { A: wavA.length, B: wavB.length }, mediaZipLocals: [localA] }, null, 2));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('wrote', out);
}
main().catch(error => { console.error(error); process.exit(1); });
