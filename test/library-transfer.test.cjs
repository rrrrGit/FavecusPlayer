'use strict';
// v0.7.0 Step10-1：出力・取り込みの共通規則（library-transfer.cjs）が、Windows版の実際のアーカイブ処理（library-archive.cjs）と同じ結果になること。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDecipheriv } = require('node:crypto');
const { Store } = require('../src/core/store.cjs');
const { LibraryArchive } = require('../src/core/library-archive.cjs');
const { ZipReader } = require('../src/core/zip.cjs');
const { ReadJSON } = require('../src/core/library-json.cjs');
const T = require('../src/core/library-transfer.cjs');

const Temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-transfer-'));
const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pid = n => id(1, n);
let counter = 0;
const createId = () => `bbbbbbbb-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const url = n => `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'e')}/`;

// 元のストア：親・子・ローカル曲（実体あり1つ・なし1つ）を持つ。
function MakeSource() {
  const dir = Temp(), store = new Store(dir, {});
  const localA = `${id(4, 1)}.mp3`, localB = `${id(4, 2)}.flac`;
  fs.writeFileSync(path.join(store.media, localA), Buffer.from('audio-a'));
  const lists = [
    { id: pid(1), name: '親', icon: '', createdAt: '2026-11-01T00:00:00.000Z', lastAddedAt: '', includeInAll: true, childIds: [pid(2)], entries: [{ id: id(2, 1), mediaId: id(3, 1), type: 'bilibili', title: '曲1', addedAt: '', url: url(1) }, { id: id(2, 2), mediaId: id(3, 2), type: 'local', title: 'ローカルA', addedAt: '', fileName: localA }] },
    { id: pid(2), name: '子', icon: '', createdAt: '2026-11-02T00:00:00.000Z', lastAddedAt: '', includeInAll: false, childIds: [], entries: [{ id: id(2, 3), mediaId: id(3, 3), type: 'local', title: 'ローカルB', addedAt: '', fileName: localB }, { id: id(2, 4), mediaId: id(3, 4), type: 'bilibili', title: '曲4', addedAt: '', url: url(4) }] },
    { id: pid(3), name: '独立', icon: '', createdAt: '2026-11-03T00:00:00.000Z', lastAddedAt: '', includeInAll: true, childIds: [], entries: [] }
  ];
  store.data = { ...store.data, playlists: lists, rootPlaylistIds: [pid(1), pid(3)], activePlaylistId: pid(1) };
  store.Save();
  return { dir, store, localA, localB };
}
// Windows版のZIPから、内側のZIPの内容（identity.jsonと各プレイリスト）を読む。
async function ReadWindowsZip(file) {
  const outer = await new ZipReader().Open(file), outerNames = [...outer.entries.keys()];
  const bytes = await outer.Content('playlists.fvpa', null, 33 * 1024 * 1024), header = bytes.subarray(0, 52);
  assert.equal(header.subarray(0, 8).toString(), 'FVPA0002');
  const decipher = createDecipheriv('aes-256-gcm', header.subarray(8, 40), header.subarray(40, 52)); decipher.setAAD(header); decipher.setAuthTag(bytes.subarray(52, 68));
  const plain = Buffer.concat([decipher.update(bytes.subarray(68)), decipher.final()]), temp = path.join(Temp(), 'inner.zip'); fs.writeFileSync(temp, plain);
  const inner = await new ZipReader().Open(temp), texts = new Map();
  for (const name of inner.entries.keys()) texts.set(name, (await inner.Content(name)).toString('utf8'));
  const innerNames = [...inner.entries.keys()]; await inner.Close();
  const media = new Map(); for (const name of outerNames) if (name.startsWith('media/')) media.set(name, (await outer.Content(name)).toString());
  await outer.Close();
  return { outerNames, innerNames, texts, media };
}

test('Export content is byte-identical to what the Windows archive writes, and the entry names pass the shared checks', async () => {
  const { dir, store, localA, localB } = MakeSource();
  const file = path.join(Temp(), 'out.zip');
  const windows = await new LibraryArchive(store, null).Export(file, undefined, { mode: 'media' });
  assert.equal(windows.missing, 1);
  const zip = await ReadWindowsZip(file);
  const shared = T.Export({ library: store.data, mode: 'media', available: [localA] });
  assert.equal(zip.texts.get('identity.json'), shared.identity);
  for (const record of shared.records) assert.equal(zip.texts.get(record.name), record.text, record.name);
  assert.deepEqual(shared.locals, [{ fileName: localA, included: true }, { fileName: localB, included: false }]);
  assert.equal(shared.missing, 1);
  for (const name of [...zip.outerNames, ...zip.innerNames]) assert.ok(T.SafeName(name), name);
  T.CheckInnerNames(zip.innerNames);
  assert.ok(zip.media.has(`media/${localA}`) && !zip.media.has(`media/${localB}`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('information-only export marks every local track as omitted', () => {
  const { dir, store } = MakeSource();
  const shared = T.Export({ library: store.data, mode: 'information', available: [] });
  assert.equal(shared.omitted, 2); assert.equal(shared.missing, 0); assert.ok(shared.locals.every(l => !l.included));
  fs.rmSync(dir, { recursive: true, force: true });
});

// 取り込み先の検証用の既存ライブラリ（同名リスト・同じ動画を含む）。
function MakeDestination() {
  const dir = Temp(), store = new Store(dir, {});
  const own = { id: id(1, 90), name: '親', icon: '', createdAt: '', lastAddedAt: '', includeInAll: true, childIds: [], entries: [{ id: id(2, 90), mediaId: id(3, 90), type: 'bilibili', title: '既存', addedAt: '', url: url(1) }] };
  store.data = { ...store.data, playlists: [own], rootPlaylistIds: [own.id], activePlaylistId: own.id };
  store.Save();
  return { dir, store };
}
// IDを除いた、構造と内容の比較用の形。
function Shape(library) {
  const lists = new Map(library.playlists.map(p => [p.id, p]));
  const walk = ids => ids.map(listId => { const p = lists.get(listId); return { name: p.name, includeInAll: p.includeInAll, entries: p.entries.map(e => [e.type, e.title, e.type === 'bilibili' ? e.url : require('node:path').extname(e.fileName)]), children: walk(p.childIds) }; });
  return walk(library.rootPlaylistIds);
}

test('shared Prepare and Import give the same library as the Windows Prepare and Commit', async () => {
  const source = MakeSource(), file = path.join(Temp(), 'out.zip');
  await new LibraryArchive(source.store, null).Export(file, undefined, { mode: 'media' });
  const zip = await ReadWindowsZip(file);
  // Windows版
  const win = MakeDestination(), archive = new LibraryArchive(win.store, null), plan = await archive.Prepare(file);
  assert.equal(plan.mode, 'media');
  const committed = await archive.Commit(plan.id, plan.playlists.map(p => p.id));
  // 共通
  const records = [...zip.texts].filter(([name]) => name !== 'identity.json').map(([, text]) => ReadJSON(Buffer.from(text)));
  const input = T.BuildShareInput(ReadJSON(Buffer.from(zip.texts.get('identity.json'))), records);
  const prepared = T.Prepare(input);
  assert.deepEqual(prepared.lists.map(l => l.name).sort(), plan.playlists.map(p => p.name).sort());
  T.CheckOuterNames(prepared.plan.share, zip.outerNames.map(String));
  const base = MakeDestination();
  const result = T.Import({ library: JSON.parse(JSON.stringify(base.store.data)), plan: prepared.plan, ids: prepared.lists.map(l => l.id), available: [...zip.media.keys()].map(n => n.slice(6)), createId });
  assert.deepEqual(Shape(result.library), Shape(win.store.data));
  assert.equal(result.imported, committed.imported); assert.equal(result.missing, committed.missing); assert.equal(result.omitted, committed.omitted);
  // 実体のあるローカル曲だけがコピー対象で、名前は元のIDではなく新しく付く（衝突しない）
  assert.equal(result.files.length, 1); assert.notEqual(result.files[0].to, result.files[0].from); assert.ok(result.files[0].to.endsWith('.mp3'));
  assert.ok(result.library.playlists.some(p => p.name.startsWith('親（取り込み')), '同名のリストは（取り込みN）を付ける');
  for (const dir of [source.dir, win.dir, base.dir]) fs.rmSync(dir, { recursive: true, force: true });
});

test('Import rejects invalid choices and a media archive that lacks a declared file', () => {
  const { dir, store } = MakeSource();
  const exported = T.Export({ library: store.data, mode: 'media', available: [`${id(4, 1)}.mp3`, `${id(4, 2)}.flac`] });
  const input = T.BuildShareInput(JSON.parse(exported.identity), exported.records.map(r => JSON.parse(r.text)));
  const prepared = T.Prepare(input), library = { version: 3, identityVersion: 2, videoAliases: [], rootPlaylistIds: [], playlists: [], activePlaylistId: null };
  assert.throws(() => T.Import({ library, plan: prepared.plan, ids: [], available: [], createId }), /選んでください/);
  assert.throws(() => T.Import({ library, plan: prepared.plan, ids: ['nope'], available: [], createId }), /選んでください/);
  assert.throws(() => T.Import({ library, plan: prepared.plan, ids: [pid(1)], available: [], createId }), /同梱されたローカル曲/);
  assert.throws(() => T.CheckOuterNames(prepared.plan.share, ['playlists.fvpa']), /一致しません/);
  assert.throws(() => T.CheckOuterNames({ mode: 'information', locals: [] }, ['playlists.fvpa', 'media/x.mp3']), /メディアが含まれています/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SafeName and the inner entry checks reject traversal and unexpected names', () => {
  for (const bad of ['', '/abs.json', '../x', 'a/../b', 'a//b', './a', 'a b', 'あ.mp3', 'x'.repeat(201)]) assert.equal(T.SafeName(bad), false, bad);
  for (const good of ['playlists.fvpa', 'media/abc.mp3', 'a_b-c.d/e']) assert.equal(T.SafeName(good), true, good);
  assert.throws(() => T.CheckInnerNames(['identity.json', 'playlists/..json']), /ファイル構成/);
  assert.deepEqual(T.CheckInnerNames(['identity.json', `playlists/${pid(1)}.json`]), [`playlists/${pid(1)}.json`]);
});
