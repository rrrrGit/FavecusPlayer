'use strict';
// v0.7.0 Step7-3：Windows版の同期の運用（実際のStore＋偽のSupabase）。実Electron・実Supabaseは別の確認項目。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, ValidateLibrary } = require('../src/core/store.cjs');
const { LibraryMediaKey } = require('../src/core/library-identity.cjs');
const { SyncService, StoreAdapter } = require('../src/core/sync-service.cjs');
const Storage = require('../src/core/sync-storage.cjs');
const { KEY, FakeServer, T0 } = require('./fake-supabase.cjs');

// 暗号化の代わりに可逆の変換を使う偽のsafeStorage（平文のままファイルへ書かれないことの確認用）。
const FakeSafe = available => ({ isEncryptionAvailable: () => available, encryptString: text => Buffer.from(Buffer.from(text).toString('base64').split('').reverse().join('')), decryptString: buffer => Buffer.from(buffer.toString().split('').reverse().join(''), 'base64').toString() });
const Temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-sync-'));
const URL_ = 'https://abcdefgh.supabase.co';

function Device(server, { safe = FakeSafe(true) } = {}) {
  const root = Temp(), data = path.join(root, 'data'), syncDir = path.join(data, 'sync');
  fs.mkdirSync(data, { recursive: true });
  const store = new Store(data, { committed: () => service.Changed() });
  const adapter = StoreAdapter(store, { validateLibrary: input => ValidateLibrary(input), mediaKey: LibraryMediaKey });
  const applied = [], statuses = [];
  const service = new SyncService({ directory: syncDir, adapter, vault: new Storage.SessionVault(syncDir, safe), request: server.request, now: () => server.now, timers: { set: () => ({ unref() {} }), clear() {} }, onStatus: s => statuses.push(s.state), onApplied: () => applied.push(1) });
  return { root, data, syncDir, store, service, applied, statuses };
}
async function SignIn(d) { d.service.Configure({ url: URL_, anonKey: KEY }); await d.service.SendCode('me@example.com'); await d.service.VerifyCode('me@example.com', '123456'); }
async function Join(d) { await SignIn(d); d.service.Start(); return d.service.Enable(); }
const Names = d => d.store.data.playlists.map(p => p.name).sort();
const Playlist = (d, name) => d.store.data.playlists.find(p => p.name === name);
const Create = (d, name, parentId) => d.store.Apply({ type: 'create', name, parentId, select: false });
const Add = (d, playlistId, n) => d.store.Apply({ type: 'add', playlistId, urls: `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'a')}/`, title: `曲${n}` });

test('enabling sync backs up library.json first, never stores tokens in plain text, and merges two devices both ways', async () => {
  const server = FakeServer(), a = Device(server), b = Device(server);
  Create(a, 'Aのリスト'); Add(a, Playlist(a, 'Aのリスト').id, 1);
  const before = fs.readFileSync(path.join(a.data, 'library.json'), 'utf8');
  assert.equal((await Join(a)).ok, true);
  assert.ok(fs.readdirSync(a.data).some(f => f.startsWith('library.pre-sync-')), '有効化前のバックアップ'); assert.equal(fs.readFileSync(path.join(a.data, fs.readdirSync(a.data).find(f => f.startsWith('library.pre-sync-'))), 'utf8'), before);
  const sessionFile = fs.readFileSync(path.join(a.syncDir, 'session.bin'), 'utf8'); assert.ok(!sessionFile.includes('acc-') && !sessionFile.includes('ref-') && !sessionFile.includes('accessToken'));
  for (const f of ['state.json', 'config.json']) { const text = fs.readFileSync(path.join(a.syncDir, f), 'utf8'); assert.ok(!text.includes('acc-') && !text.includes('ref-')); }
  Create(b, 'Bのリスト'); const rb = await Join(b); assert.equal(rb.ok, true, JSON.stringify(rb)); assert.equal((await a.service.SyncNow()).ok, true);
  assert.ok(Names(a).includes('Bのリスト') && Names(b).includes('Aのリスト')); assert.equal(Playlist(b, 'Aのリスト').entries.length, 1);
  assert.equal(JSON.stringify(Names(a)), JSON.stringify(Names(b)));
});

test('a stale renderer-style edit never deletes what another device added (the edit is a diff against the last synced view)', async () => {
  const server = FakeServer(), a = Device(server), b = Device(server);
  await Join(a); await Join(b); await a.service.SyncNow(); await b.service.SyncNow();
  Create(b, 'Bの追加'); await b.service.SyncNow();
  // aはBの追加をまだ受け取っていない状態で、別の編集をする
  Create(a, 'Aの編集'); await a.service.SyncNow(); await b.service.SyncNow(); await a.service.SyncNow();
  assert.ok(Names(a).includes('Bの追加') && Names(a).includes('Aの編集')); assert.equal(JSON.stringify(Names(a)), JSON.stringify(Names(b)));
});

test('edits made in the store while a sync is in flight are kept and applied together with the received changes', async () => {
  const server = FakeServer(), a = Device(server), b = Device(server);
  await Join(a); await Join(b); await a.service.SyncNow(); await b.service.SyncNow();
  Create(b, 'リモートの追加'); await b.service.SyncNow();
  const original = server.request; let fired = false;
  server.request = async (...args) => { if (!fired && String(args[1]).includes('/rest/v1/sync_changes') && args[0] === 'GET') { fired = true; Create(a, '同期中のローカル編集'); } return original(...args); };
  a.service.request = server.request;
  assert.equal((await a.service.SyncNow()).ok, true); server.request = original; a.service.request = original;
  assert.ok(Names(a).includes('リモートの追加') && Names(a).includes('同期中のローカル編集'), JSON.stringify(Names(a)));
  await a.service.SyncNow(); await b.service.SyncNow(); assert.equal(JSON.stringify(Names(a)), JSON.stringify(Names(b)));
});

test('received changes keep device-only data: icons, local file names and existing media ids', async () => {
  const server = FakeServer(), a = Device(server), b = Device(server);
  Create(a, '共有'); Add(a, Playlist(a, '共有').id, 5); await Join(a);
  Create(b, '共有2'); Add(b, Playlist(b, '共有2').id, 5); const mediaId = Playlist(b, '共有2').entries[0].mediaId; assert.ok(mediaId);
  await Join(b); await a.service.SyncNow(); await b.service.SyncNow();
  assert.equal(Playlist(b, '共有2').entries[0].mediaId, mediaId, '既存のmediaIdは保持');
  assert.ok(b.store.data.playlists.every(p => typeof p.icon === 'string'));
});

test('failures keep the outbox and the library: offline, paused, signed out', async () => {
  const server = FakeServer(), a = Device(server); await Join(a);
  Create(a, 'オフライン中の追加'); server.online = false; let r = await a.service.SyncNow(); assert.equal(r.ok, false); assert.ok(a.service.Status().pending > 0); assert.ok(Names(a).includes('オフライン中の追加'));
  server.online = true; server.down = 503; r = await a.service.SyncNow(); assert.equal(r.ok, false); assert.match(a.service.Status().error, /一時停止/); server.down = 0;
  a.service.SignOut(); r = await a.service.SyncNow(); assert.equal(r.ok, false); assert.ok(a.service.Status().pending > 0);
  await a.service.SendCode('me@example.com'); await a.service.VerifyCode('me@example.com', '123456'); r = await a.service.SyncNow(); assert.equal(r.ok, true); assert.equal(a.service.Status().pending, 0);
});

test('restart: state.json restores the device; a local edit made while the app was closed is picked up; unknown syncVersion blocks without overwriting', async () => {
  const server = FakeServer(), a = Device(server); await Join(a);
  Create(a, '再起動前'); await a.service.SyncNow();
  a.service.Dispose();
  Create(a, '終了中の編集'); // 同期は止まっている（アプリ終了中）想定：storeだけ変わる
  const store2 = new Store(a.data, {}), adapter2 = StoreAdapter(store2, { validateLibrary: input => ValidateLibrary(input), mediaKey: LibraryMediaKey });
  const s2 = new SyncService({ directory: a.syncDir, adapter: adapter2, vault: new Storage.SessionVault(a.syncDir, FakeSafe(true)), request: server.request, now: () => server.now, timers: { set: () => ({ unref() {} }), clear() {} } });
  s2.Start(); assert.equal(s2.Status().state, 'idle'); assert.equal((await s2.SyncNow()).ok, true);
  const b = Device(server); await Join(b); assert.ok(Names(b).includes('終了中の編集') && Names(b).includes('再起動前'));
  // 未知の版
  const file = path.join(a.syncDir, 'state.json'), text = fs.readFileSync(file, 'utf8'), future = JSON.stringify({ ...JSON.parse(text), syncVersion: 99 });
  fs.writeFileSync(file, future);
  const s3 = new SyncService({ directory: a.syncDir, adapter: adapter2, vault: new Storage.SessionVault(a.syncDir, FakeSafe(true)), request: server.request, now: () => server.now, timers: { set: () => ({ unref() {} }), clear() {} } });
  s3.Start(); assert.equal(s3.Status().state, 'blocked'); assert.equal((await s3.SyncNow()).ok, false); assert.equal(fs.readFileSync(file, 'utf8'), future, '上書きしない');
  fs.writeFileSync(file, '{broken'); const s4 = new SyncService({ directory: a.syncDir, adapter: adapter2, vault: new Storage.SessionVault(a.syncDir, FakeSafe(true)), request: server.request, now: () => server.now, timers: { set: () => ({ unref() {} }), clear() {} } });
  s4.Start(); assert.equal(s4.Status().state, 'blocked'); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('crash between applying library.json and saving state.json never deletes anything on the next run', async () => {
  const server = FakeServer(), a = Device(server), b = Device(server); await Join(a); await Join(b);
  Create(b, 'リモート'); await b.service.SyncNow();
  // aの反映は行うが、state.jsonの保存の直前に止まる
  const real = Storage.WriteState; let armed = false, calls = 0; const write = Storage.WriteState;
  Storage.WriteState = (...args) => { if (armed && ++calls >= 2) throw new Error('crash'); return write(...args); };
  armed = true; await a.service.SyncNow(); armed = false; Storage.WriteState = real;
  assert.ok(Names(a).includes('リモート'), 'library.jsonには反映済み');
  const store2 = new Store(a.data, {}), s2 = new SyncService({ directory: a.syncDir, adapter: StoreAdapter(store2, { validateLibrary: input => ValidateLibrary(input), mediaKey: LibraryMediaKey }), vault: new Storage.SessionVault(a.syncDir, FakeSafe(true)), request: server.request, now: () => server.now, timers: { set: () => ({ unref() {} }), clear() {} } });
  s2.Start(); assert.equal((await s2.SyncNow()).ok, true);
  assert.ok(store2.data.playlists.some(p => p.name === 'リモート'), '再開後も残る'); await b.service.SyncNow(); assert.ok(Names(b).includes('リモート'));
});

test('without OS encryption nothing is stored and sign-in is refused', async () => {
  const server = FakeServer(), a = Device(server, { safe: FakeSafe(false) });
  a.service.Configure({ url: URL_, anonKey: KEY });
  await assert.rejects(() => a.service.SendCode('me@example.com'), /安全に保存できない/);
  assert.ok(!fs.existsSync(path.join(a.syncDir, 'session.bin'))); assert.equal(a.service.Status().encryption, false);
});

test('configuration rejects secret keys and disabling stops syncing without deleting data', async () => {
  const server = FakeServer(), a = Device(server);
  assert.throws(() => a.service.Configure({ url: URL_, anonKey: 'sb_secret_abcdefghijklmnopqrstuvwxyz' }), /秘密/);
  await Join(a); Create(a, '無効化の前'); a.service.Disable(); const count = a.store.data.playlists.length;
  assert.equal(a.service.Status().state, 'off'); assert.equal((await a.service.SyncNow()).ok, false); assert.equal(a.store.data.playlists.length, count);
  assert.ok(fs.existsSync(path.join(a.syncDir, 'state.json')));
});

test('a library recovered from damage blocks sync instead of sending deletions for everything', async () => {
  const server = FakeServer(), a = Device(server), b = Device(server); await Join(a); await Join(b);
  Create(a, '消えてはいけない'); await a.service.SyncNow(); await b.service.SyncNow(); assert.ok(Names(b).includes('消えてはいけない'));
  a.service.Dispose(); fs.writeFileSync(path.join(a.data, 'library.json'), '{broken'); fs.rmSync(path.join(a.data, 'library.json.bak'), { force: true });
  const store2 = new Store(a.data, {}); assert.ok(store2.recovered);
  const s2 = new SyncService({ directory: a.syncDir, adapter: StoreAdapter(store2, { validateLibrary: input => ValidateLibrary(input), mediaKey: LibraryMediaKey }), vault: new Storage.SessionVault(a.syncDir, FakeSafe(true)), request: server.request, now: () => server.now, timers: { set: () => ({ unref() {} }), clear() {} } });
  s2.Start(); assert.equal(s2.Status().state, 'blocked'); assert.equal((await s2.SyncNow()).ok, false);
  await b.service.SyncNow(); assert.ok(Names(b).includes('消えてはいけない'), '他の端末から削除されない');
});

test('switching project or account is detected; reset keeps the old sync data aside and starts from the local library', async () => {
  const server = FakeServer(), a = Device(server); await Join(a); Create(a, 'ローカル'); await a.service.SyncNow();
  a.service.Disable(); a.service.Configure({ url: 'https://zzzzzzzz.supabase.co', anonKey: KEY });
  assert.equal(a.service.Status().signedIn, false, '接続先を変えると古いトークンは消える');
  await a.service.SendCode('me@example.com').catch(() => {}); // 偽サーバーは別URLでも応答する
  await a.service.VerifyCode('me@example.com', '123456'); a.service.config.enabled = true;
  const r = await a.service.SyncNow(); assert.equal(r.ok, false); assert.match(a.service.Status().error, /異なります/);
  a.service.ResetLink(); assert.ok(fs.readdirSync(a.syncDir).some(f => f.startsWith('state.replaced-')));
  assert.ok(Names(a).includes('ローカル')); assert.equal((await a.service.Enable()).ok, true);
});

test('enabling before Start still reads existing sync data and refuses an unknown version without overwriting', async () => {
  const server = FakeServer(), a = Device(server); await Join(a); a.service.Dispose();
  const file = path.join(a.syncDir, 'state.json'), future = JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), syncVersion: 99 }); fs.writeFileSync(file, future);
  const s2 = new SyncService({ directory: a.syncDir, adapter: StoreAdapter(new Store(a.data, {}), { validateLibrary: input => ValidateLibrary(input), mediaKey: LibraryMediaKey }), vault: new Storage.SessionVault(a.syncDir, FakeSafe(true)), request: server.request, now: () => server.now, timers: { set: () => ({ unref() {} }), clear() {} } });
  await assert.rejects(() => s2.Enable(), /新しい版/); assert.equal(fs.readFileSync(file, 'utf8'), future);
});
