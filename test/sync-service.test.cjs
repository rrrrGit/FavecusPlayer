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
  s2.Start(); assert.equal((await s2.SyncNow()).ok, false); assert.equal(s2.Status().state, 'blocked');
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

test('a device that starts from the untouched default library adopts the remote lists and never duplicates the default list', async () => {
  const server = FakeServer(), a = Device(server), b = Device(server);
  Create(a, 'Aのリスト'); Add(a, Playlist(a, 'Aのリスト').id, 1); await Join(a);
  assert.equal((await Join(b)).ok, true);
  assert.equal(JSON.stringify(Names(a)), JSON.stringify(Names(b)));
  assert.equal(b.store.data.playlists.filter(p => p.name === 'お気に入り').length, a.store.data.playlists.filter(p => p.name === 'お気に入り').length);
  assert.equal(Playlist(b, 'Aのリスト').entries.length, 1);
  // 空のサーバーで両方が既定のライブラリから始めても、既定リストは共通の1つになる
  const empty = FakeServer(), c = Device(empty), d = Device(empty); await Join(c); await Join(d); await c.service.SyncNow();
  assert.equal(c.store.data.playlists.length, 1); assert.equal(d.store.data.playlists.length, 1); assert.equal(c.store.data.playlists[0].id, d.store.data.playlists[0].id);
});

test('a library that looks empty while sync state exists blocks sync and sends no deletions', async () => {
  const server = FakeServer(), a = Device(server), b = Device(server);
  Create(a, '消えてはいけない'); await Join(a); await Join(b); await a.service.SyncNow(); await b.service.SyncNow();
  assert.ok(Names(b).includes('消えてはいけない'));
  a.service.Dispose();
  fs.rmSync(path.join(a.data, 'library.json'), { force: true }); fs.rmSync(path.join(a.data, 'library.json.bak'), { force: true });
  const store2 = new Store(a.data, {}), s2 = new SyncService({ directory: a.syncDir, adapter: StoreAdapter(store2, { validateLibrary: input => ValidateLibrary(input), mediaKey: LibraryMediaKey }), vault: new Storage.SessionVault(a.syncDir, FakeSafe(true)), request: server.request, now: () => server.now, timers: { set: () => ({ unref() {} }), clear() {} } });
  s2.Start(); const r = await s2.SyncNow();
  assert.equal(r.ok, false); assert.equal(s2.Status().state, 'blocked'); assert.match(s2.Status().error, /空の状態/);
  await b.service.SyncNow(); assert.ok(Names(b).includes('消えてはいけない'), '他の端末から削除されない');
});

test('a recovered library stays blocked after a restart and is lifted only by the user, never by a plain restart', async () => {
  const server = FakeServer(), a = Device(server), b = Device(server);
  Create(b, 'Bの作ったリスト'); await Join(b); await Join(a); await a.service.SyncNow(); await b.service.SyncNow(); assert.ok(Names(a).includes('Bの作ったリスト'));
  a.service.Dispose();
  // 受信する前の内容（.bak）へ戻った状態を再現する：libraryを壊し、受信前の.bakだけが残る
  const stale = JSON.parse(fs.readFileSync(path.join(a.data, 'library.json'), 'utf8')); stale.playlists = stale.playlists.filter(p => p.name !== 'Bの作ったリスト'); stale.rootPlaylistIds = stale.rootPlaylistIds.filter(id => stale.playlists.some(p => p.id === id));
  fs.writeFileSync(path.join(a.data, 'library.json.bak'), JSON.stringify(stale)); fs.writeFileSync(path.join(a.data, 'library.json'), '{broken');
  const make = () => { const store = new Store(a.data, {}); return { store, service: new SyncService({ directory: a.syncDir, adapter: StoreAdapter(store, { validateLibrary: input => ValidateLibrary(input) }), vault: new Storage.SessionVault(a.syncDir, FakeSafe(true)), request: server.request, now: () => server.now, timers: { set: () => ({ unref() {} }), clear() {} } }) }; };
  let run = make(); assert.ok(run.store.recovered); run.service.Start(); assert.equal((await run.service.SyncNow()).ok, false); assert.equal(run.service.Status().state, 'blocked');
  // 再起動（今度はlibraryは正常に読める）：それでも停止のまま
  run.service.Dispose(); run = make(); assert.equal(run.store.recovered, false); run.service.Start();
  assert.equal(run.service.Status().state, 'blocked'); assert.equal((await run.service.SyncNow()).ok, false);
  await b.service.SyncNow(); assert.ok(Names(b).includes('Bの作ったリスト'), '他の端末から削除されない');
  // 利用者が「サーバーの内容で復元」を選ぶ
  const result = await run.service.Unblock('restore'); assert.equal(result.ok, true);
  assert.ok(run.store.data.playlists.some(p => p.name === 'Bの作ったリスト'), '復元された'); assert.equal(run.service.Status().state, 'idle');
  await b.service.SyncNow(); assert.ok(Names(b).includes('Bの作ったリスト'));
});

test('SyncService SuppressChanged resets, ResetLink aborts active Cycle/Extras cleanly, and SignOut blocks stale session.set', async t => {
  const S = require('../src/core/sync-state.cjs');
  const E = require('../src/core/sync-engine.cjs');
  const { SupabaseSyncRepository, SendCode, VerifyCode } = require('../src/core/sync-supabase.cjs');
  const { SyncSession } = require('../src/core/sync-session.cjs');
  const { SyncExtras } = require('../src/core/sync-counts.cjs');
  const { CONFIG } = require('./fake-supabase.cjs');

  const server = FakeServer({ now: T0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-sync-abort-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data'), syncDir = path.join(data, 'sync');
  fs.mkdirSync(data, { recursive: true });

  await SendCode(CONFIG, server.request, 'me@example.com');
  let peerSession = await VerifyCode(CONFIG, server.request, 'me@example.com', '123456', () => server.now);
  const peerRepo = new SupabaseSyncRepository({
    config: CONFIG, request: server.request, now: () => server.now,
    session: { get: () => peerSession, set: v => { peerSession = v; } },
  });

  let service, resetExtrasCount = 0;
  const statuses = [];
  const store = new Store(data, { committed: () => service?.Changed() });
  const adapter = StoreAdapter(store, { validateLibrary: input => ValidateLibrary(input), mediaKey: LibraryMediaKey });
  service = new SyncService({
    directory: syncDir, adapter, vault: new Storage.SessionVault(syncDir, FakeSafe(true)),
    request: server.request, now: () => server.now, timers: { set: () => ({ unref() {} }), clear() {} },
    onStatus: s => statuses.push(s.state),
  });
  service.onResetExtras = () => { resetExtrasCount++; };

  assert.throws(() => service.SuppressChanged(() => { throw new Error('boom'); }), /boom/);
  assert.equal(service.suppressChanged, false);

  service.Configure({ url: URL_, anonKey: KEY });
  await service.SendCode('me@example.com');
  await service.VerifyCode('me@example.com', '123456');
  service.Start();
  assert.equal((await service.Enable()).ok, true);

  const pid9 = '00000001-0000-4000-8000-000000000009', tid9 = '00000002-0000-4000-8000-000000000009';
  const peer = E.NewDevice('peer-dev');
  E.Initialize(peer, {
    version: 3, identityVersion: 2, videoAliases: [], rootPlaylistIds: [pid9],
    playlists: [{ id: pid9, name: '旧アカウントのリスト', icon: '', childIds: [], createdAt: '2026-11-13T00:00:00.000Z', lastAddedAt: '', includeInAll: true, entries: [{ id: tid9, title: '曲9', addedAt: '2026-11-13T00:00:00.000Z', type: 'bilibili', url: 'https://www.bilibili.com/video/BV1000000009/' }] }],
  }, T0);
  assert.equal((await E.Sync(peer, peerRepo, T0)).ok, true);
  await peerRepo.PushFavorites('peer-dev', [{ key: 'bili:BV1oldaccount:p1', fav: true, at: T0 + 100 }]);

  let appliedFavorites = 0, aborted = false;
  const extraAborted = await SyncExtras(
    { favorites: { Read: async () => ({ deviceId: 'dev-local', cursor: 0, rows: [] }), Apply: async () => { appliedFavorites++; }, Pushed: async () => {} } },
    { ...peerRepo, PullFavorites: async cursor => { aborted = true; return peerRepo.PullFavorites(cursor); } },
    { isAborted: () => aborted }
  );
  assert.equal(extraAborted.aborted, true);
  assert.equal(appliedFavorites, 0);

  let holdPull, held = false;
  const pulling = new Promise(resolve => {
    const orig = server.request;
    service.request = async (method, url, init) => {
      if (!held && method === 'GET' && String(url).includes('sync_changes')) {
        held = true;
        const res = await orig(method, url, init);
        resolve();
        await new Promise(done => { holdPull = done; });
        return res;
      }
      return orig(method, url, init);
    };
  });
  const cyclePromise = service.SyncNow();
  await pulling;
  service.ResetLink();
  assert.equal(resetExtrasCount, 0);
  assert.equal(service.pendingReset, true);
  holdPull();
  const res = await cyclePromise;
  assert.equal(res.ok, false);
  assert.match(res.error, /中断/);
  assert.equal(resetExtrasCount, 1);
  assert.equal(service.pendingReset, false);
  assert.equal(service.device, null);
  assert.equal(statuses.at(-1), 'off');
  assert.equal(store.data.playlists.some(p => p.name === '旧アカウントのリスト'), false);

  let sessionApplied = false, stopNow = false;
  const syncSession = new SyncSession({
    adapter: {
      Library: async () => ({ version: 3, identityVersion: 2, videoAliases: [], rootPlaylistIds: [], playlists: [] }),
      Context: async () => ({ aliases: [] }),
      Apply: async () => { sessionApplied = true; return true; },
    },
    repository: () => ({
      Pull: async () => { stopNow = true; sessionApplied = false; return { changes: [{ id: S.PlaylistId(pid9), f: { name: ['X', 100, 'p', 0] } }], cursor: 1 }; },
      Push: async () => {},
      Compact: async () => {},
    }),
    persist: async () => {},
    deviceId: () => 'dev-1',
    now: () => 200,
  });
  await syncSession.Enable({ url: 'u', userId: 'me' });
  sessionApplied = false;
  stopNow = false;
  const sRes = await syncSession.Cycle({ isAborted: () => stopNow });
  assert.equal(sRes.aborted, true);
  assert.equal(sessionApplied, false);

  let saved = { accessToken: 'old', refreshToken: 'r', expiresAt: 0, userId: 'u1' };
  const vault = { Available: () => true, Get: () => saved, Set: v => { saved = v; }, Clear: () => { saved = null; } };
  const svc2 = new SyncService({ directory: path.join(dir, 'signout'), adapter: { Library: () => ({}), Context: () => ({}), Apply: () => false }, vault, request: async () => ({ status: 200, json: {} }) });
  svc2.Configure({ url: 'https://demo.supabase.co', anonKey: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig' });
  const repo = svc2.Repository();
  svc2.SignOut();
  assert.equal(saved, null);
  repo.session.set({ accessToken: 'resurrected', refreshToken: 'r2', expiresAt: 9999999999, userId: 'u1' });
  assert.equal(saved, null);
});
