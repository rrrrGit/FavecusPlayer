'use strict';
// iPhone版が出力したZIPを、Windows版の実際の取り込み処理（LibraryArchive.Prepare/Commit）で読めることを確認する（CIの、iOSテストの後に実行）。
// 使い方: node scripts/verify-ios-export.cjs <iOSテストの出力フォルダ>
// 入力: ios-media.zip、ios-info.zip、expected-ios.json（テストが書く：リスト名とメディアのサイズ）。無ければ失敗する（何も確認していない成功を防ぐ）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Store } = require('../src/core/store.cjs');
const { LibraryArchive } = require('../src/core/library-archive.cjs');

const dir = path.resolve(process.argv[2] || '');
const read = name => { const file = path.join(dir, name); assert.ok(fs.existsSync(file), `${name} がありません（iOSテストが出力していません）`); return file; };
async function importInto(file) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-verify-ios-')), store = new Store(temp, {}), archive = new LibraryArchive(store, null);
  const plan = await archive.Prepare(file), result = await archive.Commit(plan.id, plan.playlists.map(p => p.id));
  return { temp, store, plan, result };
}
async function main() {
  const expected = JSON.parse(fs.readFileSync(read('expected-ios.json'), 'utf8'));
  const media = await importInto(read('ios-media.zip'));
  assert.equal(media.plan.mode, 'media');
  const names = media.store.data.playlists.map(p => p.name);
  for (const name of expected.lists) assert.ok(names.includes(name), `リスト「${name}」が取り込まれていません: ${names}`);
  const locals = media.store.data.playlists.flatMap(p => p.entries).filter(e => e.type === 'local');
  assert.equal(locals.length, expected.localCount, 'ローカル曲の数');
  const sizes = locals.map(e => fs.statSync(path.join(media.store.media, e.fileName)).size).sort();
  assert.deepEqual(sizes, [...expected.localSizes].sort(), 'メディアのサイズ');
  assert.equal(media.result.missing, 0);
  const info = await importInto(read('ios-info.zip'));
  assert.equal(info.plan.mode, 'information');
  assert.equal(info.result.omitted, expected.localCount);
  for (const name of expected.lists) assert.ok(info.store.data.playlists.some(p => p.name === name), name);
  for (const x of [media, info]) fs.rmSync(x.temp, { recursive: true, force: true });
  console.log(`iPhone版の出力をWindows版で取り込めました（リスト${expected.lists.length}件、メディア${expected.localCount}件）。`);
}
main().catch(error => { console.error(error); process.exit(1); });
