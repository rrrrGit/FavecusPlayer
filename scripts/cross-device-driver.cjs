'use strict';
// Windows版とiPhone版の端末間同期の確認（CI用）。Windows側＝Node（実際のStore＋SyncService）、iPhone側＝iOSシミュレーターのXCTest。
// どちらも同じ偽のSupabase（scripts/fake-supabase-server.cjs）へHTTPでつなぐ。順番は、フォルダ内のファイルで受け渡す。
//   windows-1（Windowsが深い階層・共有の子リストを作って同期）→ iOSが取り込んで検証、オフラインで編集（ios-A.done）
//   → windows-2（Windowsが同時に編集して同期、windows-2.done）→ iOSが再接続して同期（ios-B.done）→ windows-3（Windowsが同期して比較）
// 使い方: node scripts/cross-device-driver.cjs <フォルダ> <サーバーURL>
// 最終的に、両端末の見た目（階層・名前・曲の並び）が一致し、双方の編集が残っていなければ失敗する。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Store, ValidateLibrary } = require('../src/core/store.cjs');
const { SyncService, StoreAdapter } = require('../src/core/sync-service.cjs');
const Storage = require('../src/core/sync-storage.cjs');
const { KEY } = require('../test/fake-supabase.cjs');

const dir = path.resolve(process.argv[2] || ''), serverURL = process.argv[3];
if (!dir || !serverURL) { console.error('使い方: node scripts/cross-device-driver.cjs <フォルダ> <サーバーURL>'); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });
const FakeSafe = () => ({ isEncryptionAvailable: () => true, encryptString: t => Buffer.from(t), decryptString: b => b.toString() });
const Pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function WaitFor(name, seconds = 600) {
  const file = path.join(dir, name), end = Date.now() + seconds * 1000;
  while (Date.now() < end) { if (fs.existsSync(file)) return; await Pause(500); }
  throw new Error(`${name} が作られませんでした（iOS側のテストが進んでいません）`);
}
// 階層・名前・曲の並びだけの、端末に依存しない見た目（共有の子リストは、どの親の下にも現れる）。
const Canon = library => {
  const by = new Map(library.playlists.map(p => [p.id, p]));
  const walk = ids => ids.map(id => { const p = by.get(id); return { name: p.name, includeInAll: p.includeInAll !== false, entries: p.entries.map(e => e.title), children: walk(p.childIds) }; });
  return walk(library.rootPlaylistIds);
};
const Write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 1));
const Names = tree => tree.flatMap(n => [n.name, ...Names(n.children)]);

async function Request(method, url, { headers, body }) {
  const clean = Object.fromEntries(Object.entries(headers || {}).filter(([, v]) => v !== undefined && v !== null));
  const response = await fetch(url, { method, headers: clean, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  let json = null; try { json = await response.json(); } catch { /* 本文なし */ }
  return { status: response.status, json };
}
function WindowsDevice() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-cross-')), data = path.join(root, 'data'), syncDir = path.join(data, 'sync');
  fs.mkdirSync(data, { recursive: true });
  const store = new Store(data, { committed: () => service.Changed() });
  const service = new SyncService({ directory: syncDir, adapter: StoreAdapter(store, { validateLibrary: input => ValidateLibrary(input) }), vault: new Storage.SessionVault(syncDir, FakeSafe()), request: Request, now: Date.now, timers: { set: () => ({ unref() {} }), clear() {} } });
  return { store, service };
}
const Id = (store, name) => store.data.playlists.find(p => p.name === name).id;
const Add = (store, name, n, title) => store.Apply({ type: 'add', playlistId: Id(store, name), urls: `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'x')}/`, title });

async function main() {
  const w = WindowsDevice(), { store, service } = w;
  // ---- windows-1：深い階層と共有の子リスト
  store.Apply({ type: 'rename', playlistId: store.data.playlists[0].id, name: '独立' });
  for (const name of ['親A', '親B']) store.Apply({ type: 'create', name, select: false });
  store.Apply({ type: 'create', name: '共有子', parentId: Id(store, '親A'), select: false });
  store.Apply({ type: 'playlist-attach', playlistId: Id(store, '親B'), ids: [Id(store, '共有子')], removeOriginal: false });
  store.Apply({ type: 'create', name: '子A2', parentId: Id(store, '親A'), select: false });
  store.Apply({ type: 'create', name: '孫A2', parentId: Id(store, '子A2'), select: false });
  Add(store, '親A', 1, '曲A1'); Add(store, '親A', 2, '曲A2'); Add(store, '親B', 3, '曲B1'); Add(store, '共有子', 4, '曲S1'); Add(store, '共有子', 5, '曲S2'); Add(store, '孫A2', 6, '曲G1');
  service.Configure({ url: serverURL, anonKey: KEY }); await service.SendCode('driver@example.com'); await service.VerifyCode('driver@example.com', '123456'); service.Start();
  let result = await service.Enable(); assert.equal(result.ok, true, JSON.stringify(result));
  Write('windows-1.json', Canon(store.data)); fs.writeFileSync(path.join(dir, 'windows-1.done'), '1');
  console.log('windows-1 done');

  // ---- iOSが取り込み、オフラインで編集するのを待つ
  await WaitFor('ios-A.done');
  // ---- windows-2：同時の編集
  store.Apply({ type: 'rename', playlistId: Id(store, '親B'), name: '親B(W改名)' });
  Add(store, '独立', 7, '曲W1');
  store.Apply({ type: 'remove', playlistId: Id(store, '共有子'), entryId: store.data.playlists.find(p => p.name === '共有子').entries.find(e => e.title === '曲S2').id });
  store.Apply({ type: 'move', playlistId: Id(store, '親A'), entryId: store.data.playlists.find(p => p.name === '親A').entries[0].id, direction: 1 });
  result = await service.SyncNow(); assert.equal(result.ok, true, JSON.stringify(result));
  fs.writeFileSync(path.join(dir, 'windows-2.done'), '1'); console.log('windows-2 done');

  // ---- iOSが再接続して同期するのを待つ
  await WaitFor('ios-B.done');
  result = await service.SyncNow(); assert.equal(result.ok, true, JSON.stringify(result));
  result = await service.SyncNow(); assert.equal(result.ok, true, JSON.stringify(result));
  const windows = Canon(store.data), ios = JSON.parse(fs.readFileSync(path.join(dir, 'ios-final.json'), 'utf8'));
  Write('windows-final.json', windows);
  assert.deepEqual(ios, windows, '両端末の見た目が一致しません');
  const names = Names(windows);
  for (const expected of ['親B(W改名)', 'iOS新規', '共有子(iOS改名)']) assert.ok(names.includes(expected), `${expected} が残っていません: ${names}`);
  assert.ok(!names.includes('お気に入り'), '既定リストが重複しています');
  const flat = JSON.stringify(windows);
  assert.ok(flat.includes('曲W1') && flat.includes('曲B1(iOS)'), '双方の編集が残っていません');
  assert.ok(!flat.includes('曲S2'), 'Windowsの削除が反映されていません');
  const shared = windows.flatMap(function find(n) { return [n, ...n.children.flatMap(find)]; }).filter(n => n.name === '共有子(iOS改名)');
  assert.equal(shared.length, 2, '共有の子リストが両方の親の下にあること');
  console.log('cross-device sync verified: lists=' + names.length);
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
