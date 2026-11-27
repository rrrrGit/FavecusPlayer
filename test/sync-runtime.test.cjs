'use strict';
// v0.7.0 Step11-2：iPhone版（JavaScriptCore）の同期の入口を、Nodeで、偽のhost（Swiftの代わり）と偽のSupabaseで確認する。
// Windows版の実際の同期（SyncService＋Store）と同じサーバーで同期させ、端末間で内容が一致することも確認する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, ValidateLibrary } = require('../src/core/store.cjs');
const { SyncService, StoreAdapter } = require('../src/core/sync-service.cjs');
const Storage = require('../src/core/sync-storage.cjs');
const Runtime = require('../src/core/sync-runtime.cjs');
const Actions = require('../src/core/library-actions.cjs');
const { KEY, FakeServer, T0 } = require('./fake-supabase.cjs');

const URL_ = 'https://abcdefgh.supabase.co';
const Pretty = value => JSON.stringify(value, null, 2);
const FakeSafe = () => ({ isEncryptionAvailable: () => true, encryptString: t => Buffer.from(t), decryptString: b => b.toString() });
let counter = 0;
const ctx = { createId: () => `dddddddd-0000-4000-8000-${String(++counter).padStart(12, '0')}`, now: () => '2026-11-14T00:00:00.000Z', cleanTitle: v => String(v).trim() };
const EmptyLibrary = () => { const first = Actions.NewPlaylist(ctx); return { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: first.id, rootPlaylistIds: [first.id], playlists: [first] }; };

// iPhone版のhostの代わり：ライブラリ・同期状態をメモリに持ち、通信は偽のSupabaseへ。
function IosDevice(server, library = EmptyLibrary()) {
  const d = { text: Pretty(library), state: null, session: null, written: 0, recovered: false, backups: 0 };
  globalThis.__favecusHost = {
    library: async () => d.text,
    write: async json => { const { base, text } = JSON.parse(json); if (base !== d.text) throw new Error('取り込み中に保存データが変更されました。'); d.text = text; d.written++; },
    persist: async text => { d.state = text; },
    backup: async () => { d.backups++; return 'backup'; },
    recovered: async () => d.recovered,
    request: async (method, url, init) => { const { headers, body } = JSON.parse(init); return JSON.stringify(await server.request(method, url, { headers, body: body === null ? undefined : body })); },
    saveSession: async json => { d.session = JSON.parse(json); }
  };
  d.config = { url: URL_, anonKey: KEY };
  d.library = () => JSON.parse(d.text);
  d.edit = action => { const lib = d.library(); assert.ok(Actions.Apply(lib, action, ctx)); d.text = Pretty(lib); Runtime.Changed(); };
  d.names = () => d.library().playlists.map(p => p.name).sort();
  return d;
}
async function SignIn(server, d) {
  assert.equal((await Runtime.SendCode({ config: d.config, email: 'me@example.com' })).ok, true);
  const verified = await Runtime.VerifyCode({ config: d.config, email: 'me@example.com', code: '123456' });
  assert.equal(verified.ok, true); d.session = verified.session; return verified.session;
}
async function Join(server, d, deviceId = 'ios-test') {
  const session = await SignIn(server, d);
  const opened = await Runtime.Open({ stateText: null, config: d.config, session, deviceId });
  assert.equal(opened.status, 'none');
  assert.equal((await Runtime.Enable({ origin: { url: URL_, userId: session.userId } })).ok, true);
  return Runtime.Cycle();
}
function WindowsDevice(server) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-rt-')), data = path.join(dir, 'data'), syncDir = path.join(data, 'sync');
  fs.mkdirSync(data, { recursive: true });
  const store = new Store(data, { committed: () => service.Changed() });
  const service = new SyncService({ directory: syncDir, adapter: StoreAdapter(store, { validateLibrary: input => ValidateLibrary(input) }), vault: new Storage.SessionVault(syncDir, FakeSafe()), request: server.request, now: () => server.now, timers: { set: () => ({ unref() {} }), clear() {} } });
  return { store, service, names: () => store.data.playlists.map(p => p.name).sort() };
}
async function WindowsJoin(w) {
  w.service.Configure({ url: URL_, anonKey: KEY }); await w.service.SendCode('me@example.com'); await w.service.VerifyCode('me@example.com', '123456'); w.service.Start();
  return w.service.Enable();
}

test('an unannounced local edit during network sync is merged with remote additions', async () => {
  const server = FakeServer({ now: Date.now() }), w = WindowsDevice(server), ios = IosDevice(server);
  await WindowsJoin(w); await Join(server, ios);
  w.store.Apply({ type: 'create', name: '通信前のリモート追加', select: false }); await w.service.SyncNow();
  const host = globalThis.__favecusHost, request = host.request;
  let injected = false;
  host.request = async (...args) => {
    if (!injected && args[0] === 'GET' && args[1].includes('/sync_changes')) {
      injected = true;
      const local = ios.library();
      assert.ok(Actions.Apply(local, { type: 'create', name: '通知なしの並行編集', select: false }, ctx));
      ios.text = Pretty(local); // Changed()を呼ばない。
    }
    return request(...args);
  };
  const result = await Runtime.Cycle();
  assert.equal(result.ok, true, JSON.stringify(result)); assert.ok(injected);
  assert.ok(ios.names().includes('通信前のリモート追加'));
  assert.ok(ios.names().includes('通知なしの並行編集'));
  assert.equal((await Runtime.Cycle()).ok, true);
  assert.equal((await w.service.SyncNow()).ok, true);
  assert.ok(w.names().includes('通知なしの並行編集'));
});

test('runtime waits for session persistence and propagates Keychain failures', async () => {
  const server = FakeServer({ now: Date.now() }), ios = IosDevice(server);
  await Join(server, ios);
  await Runtime.Open({ stateText: ios.state, config: ios.config, session: { ...ios.session, expiresAt: 0 }, deviceId: 'ios-test' });
  let release, started;
  const saving = new Promise(resolve => { started = resolve; });
  globalThis.__favecusHost.saveSession = async () => { started(); await new Promise(resolve => { release = resolve; }); throw new Error('Keychain failure'); };
  let done = false;
  const cycle = Runtime.Cycle().then(result => { done = true; return result; });
  await saving;
  assert.equal(done, false);
  release();
  const result = await cycle;
  assert.equal(result.ok, false); assert.match(result.error, /Keychain failure/);
});

test('an iPhone device starting from the untouched default library adopts the Windows lists and never duplicates the default list', async () => {
  const server = FakeServer({ now: Date.now() }), w = WindowsDevice(server), ios = IosDevice(server);
  w.store.Apply({ type: 'create', name: 'Windowsのリスト', select: false }); w.store.Apply({ type: 'delete', playlistId: w.store.data.playlists.find(p => p.name === 'お気に入り').id });
  assert.equal((await WindowsJoin(w)).ok, true);
  const first = await Join(server, ios);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(ios.names(), ['Windowsのリスト']); assert.equal(ios.backups, 1);
  assert.ok(ios.state && JSON.parse(ios.state).syncVersion === 1);
});

test('edits on both devices converge, including a concurrent edit while the other side is away', async () => {
  const server = FakeServer({ now: Date.now() }), w = WindowsDevice(server), ios = IosDevice(server);
  w.store.Apply({ type: 'create', name: 'W親', select: false }); await WindowsJoin(w); await w.service.SyncNow();
  await Join(server, ios);
  const parent = ios.library().playlists.find(p => p.name === 'W親');
  ios.edit({ type: 'create', name: 'iOSの子', parentId: parent.id, select: false });
  w.store.Apply({ type: 'create', name: 'Wの追加', select: false });
  assert.equal((await Runtime.Cycle()).ok, true); assert.equal((await w.service.SyncNow()).ok, true); assert.equal((await Runtime.Cycle()).ok, true);
  assert.deepEqual(ios.names(), w.names());
  assert.ok(ios.names().includes('iOSの子') && ios.names().includes('Wの追加'));
  const lib = ios.library(), p = lib.playlists.find(x => x.name === 'W親'); assert.ok(p.childIds.includes(lib.playlists.find(x => x.name === 'iOSの子').id));
});

test('state written by the runtime restores the device after a restart, and an unknown version or broken text blocks without touching anything', async () => {
  const server = FakeServer({ now: Date.now() }), ios = IosDevice(server, (() => { const l = EmptyLibrary(); l.playlists[0].name = '旅行'; return l; })());
  await Join(server, ios);
  const saved = ios.state, session = ios.session;
  const reopened = await Runtime.Open({ stateText: saved, config: ios.config, session, deviceId: 'ios-test' });
  assert.equal(reopened.status, 'ok'); assert.equal(reopened.pending, 0);
  const future = JSON.stringify({ ...JSON.parse(saved), syncVersion: 99 });
  assert.equal((await Runtime.Open({ stateText: future, config: ios.config, session, deviceId: 'ios-test' })).status, 'blocked');
  assert.equal((await Runtime.Open({ stateText: '{broken', config: ios.config, session, deviceId: 'ios-test' })).status, 'blocked');
  assert.equal(ios.state, saved, '状態を上書きしない');
});

test('a recovered store or a library that suddenly looks empty blocks sync instead of sending deletions', async () => {
  const server = FakeServer({ now: Date.now() }), w = WindowsDevice(server), ios = IosDevice(server, (() => { const l = EmptyLibrary(); l.playlists[0].name = '旅行'; return l; })());
  await Join(server, ios);
  const saved = ios.state, session = ios.session;
  ios.edit({ type: 'create', name: '二つ目', select: false }); assert.equal((await Runtime.Cycle()).ok, true);
  await WindowsJoin(w); assert.ok(w.names().includes('旅行'));
  const before = ios.state;
  // 復旧した状態
  await Runtime.Open({ stateText: before, config: ios.config, session, deviceId: 'ios-test' }); ios.recovered = true;
  let r = await Runtime.Cycle(); assert.equal(r.ok, false); assert.ok(r.blocked);
  ios.recovered = false;
  // ライブラリが既定の空に見える（ファイルが消えた等）
  ios.text = Pretty(EmptyLibrary()); await Runtime.Open({ stateText: before, config: ios.config, session, deviceId: 'ios-test' });
  r = await Runtime.Cycle(); assert.equal(r.ok, false); assert.match(r.blocked, /空の状態/);
  assert.equal((await w.service.SyncNow()).ok, true); assert.ok(w.names().includes('旅行') && w.names().includes('二つ目'), '他の端末から削除されない');
  void saved;
});

test('a library change during the sync is kept and applied together with the received changes', async () => {
  const server = FakeServer({ now: Date.now() }), w = WindowsDevice(server), ios = IosDevice(server);
  w.store.Apply({ type: 'create', name: 'Wの先', select: false }); await WindowsJoin(w); await w.service.SyncNow();
  await Join(server, ios);
  w.store.Apply({ type: 'create', name: 'リモートの追加', select: false }); await w.service.SyncNow();
  const original = globalThis.__favecusHost.request; let fired = false;
  globalThis.__favecusHost.request = async (...args) => { if (!fired && args[0] === 'GET' && args[1].includes('sync_changes')) { fired = true; ios.edit({ type: 'create', name: '同期中の編集', select: false }); } return original(...args); };
  assert.equal((await Runtime.Cycle()).ok, true); globalThis.__favecusHost.request = original;
  assert.ok(ios.names().includes('リモートの追加') && ios.names().includes('同期中の編集'), JSON.stringify(ios.names()));
  assert.equal((await Runtime.Cycle()).ok, true); assert.equal((await w.service.SyncNow()).ok, true); assert.deepEqual(w.names(), ios.names());
});

test('sign-in errors and offline failures are reported without changing the library or losing the outbox', async () => {
  const server = FakeServer({ now: Date.now() }), ios = IosDevice(server);
  assert.equal((await Runtime.SendCode({ config: ios.config, email: 'bad' })).error !== undefined, true);
  const session = await SignIn(server, ios);
  await Runtime.Open({ stateText: null, config: ios.config, session, deviceId: 'ios-test' }); await Runtime.Enable({ origin: { url: URL_, userId: session.userId } });
  ios.edit({ type: 'create', name: 'オフライン中', select: false }); server.online = false;
  const failed = await Runtime.Cycle(); assert.equal(failed.ok, false); assert.ok(failed.pending > 0); assert.ok(ios.names().includes('オフライン中'));
  server.online = true; assert.equal((await Runtime.Cycle()).ok, true); assert.equal((await Runtime.Cycle()).pending, 0);
  void T0;
});

test('a block survives a restart and an edit, and is lifted only by the user: restore from the server, or keep this device', async () => {
  const server = FakeServer({ now: Date.now() }), w = WindowsDevice(server), ios = IosDevice(server, (() => { const l = EmptyLibrary(); l.playlists[0].name = '旅行'; return l; })());
  await Join(server, ios); ios.edit({ type: 'create', name: '二つ目', select: false }); assert.equal((await Runtime.Cycle()).ok, true);
  await WindowsJoin(w);
  const session = ios.session, synced = ios.state;
  // ファイルが消えて既定の空になる → 停止 → リストを1つ作る → 再起動しても停止したまま（他の端末の内容を消さない）
  ios.text = Pretty(EmptyLibrary()); await Runtime.Open({ stateText: synced, config: ios.config, session, deviceId: 'ios-test' });
  let r = await Runtime.Cycle(); assert.ok(r.blocked); const persisted = JSON.parse(ios.state); assert.ok(persisted.blocked, '停止の理由が同期状態に保存される');
  ios.edit({ type: 'create', name: '新しく作った', select: false });
  await Runtime.Open({ stateText: ios.state, config: ios.config, session, deviceId: 'ios-test' });
  r = await Runtime.Cycle(); assert.ok(r.blocked, '再起動後も停止のまま');
  assert.equal((await w.service.SyncNow()).ok, true); assert.ok(w.names().includes('旅行') && w.names().includes('二つ目'), '他の端末から削除されない');
  // 「サーバーの内容で復元」
  const restored = await Runtime.Unblock({ mode: 'restore' }); assert.equal(restored.ok, true);
  assert.ok(ios.names().includes('旅行') && ios.names().includes('二つ目')); assert.equal(JSON.parse(ios.state).blocked, '');
  assert.equal((await Runtime.Cycle()).ok, true);
});

test('keeping this device after a block sends the deletions only because the user chose it', async () => {
  const server = FakeServer({ now: Date.now() }), w = WindowsDevice(server), ios = IosDevice(server, (() => { const l = EmptyLibrary(); l.playlists[0].name = '作業用'; return l; })());
  await Join(server, ios); ios.edit({ type: 'create', name: '作業用2', select: false }); assert.equal((await Runtime.Cycle()).ok, true); await WindowsJoin(w);
  const session = ios.session, synced = ios.state;
  ios.text = Pretty(EmptyLibrary()); await Runtime.Open({ stateText: synced, config: ios.config, session, deviceId: 'ios-test' });
  assert.ok((await Runtime.Cycle()).blocked);
  assert.equal((await Runtime.Unblock({ mode: 'keep' })).ok, true);
  assert.equal((await Runtime.Cycle()).ok, true); assert.equal((await w.service.SyncNow()).ok, true);
  assert.ok(!w.names().includes('作業用'), '意図した削除は反映される');
});

test('an edit that lands between reading the library and applying the result is not lost', async () => {
  const server = FakeServer({ now: Date.now() }), w = WindowsDevice(server), ios = IosDevice(server);
  w.store.Apply({ type: 'create', name: 'W親', select: false }); await WindowsJoin(w); await w.service.SyncNow();
  await Join(server, ios);
  w.store.Apply({ type: 'create', name: 'リモートの追加', select: false }); await w.service.SyncNow();
  const original = globalThis.__favecusHost.library; let calls = 0, injected = false;
  globalThis.__favecusHost.library = async () => {
    const text = await original(); calls++;
    if (calls === 3 && !injected) { injected = true; ios.edit({ type: 'create', name: '読み取り直後の編集', select: false }); }
    return text;
  };
  const r = await Runtime.Cycle(); globalThis.__favecusHost.library = original;
  assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(injected);
  assert.ok(ios.names().includes('読み取り直後の編集') && ios.names().includes('リモートの追加'), JSON.stringify(ios.names()));
  assert.equal((await Runtime.Cycle()).ok, true); assert.equal((await w.service.SyncNow()).ok, true);
  assert.ok(w.names().includes('読み取り直後の編集'), 'サーバーにも送られる');
});

test('a changed connection or account stops the cycle before any network request', async () => {
  const server = FakeServer({ now: Date.now() }), ios = IosDevice(server);
  await Join(server, ios);
  const before = server.requests.length;
  let r = await Runtime.Cycle({ origin: { url: 'https://zzzzzzzz.supabase.co', userId: ios.session.userId } });
  assert.equal(r.ok, false); assert.equal(r.mismatch, true); assert.equal(server.requests.length, before, '通信しない');
  r = await Runtime.Cycle({ origin: { url: URL_, userId: 'someone-else' } });
  assert.equal(r.mismatch, true); assert.equal(server.requests.length, before);
  r = await Runtime.Cycle({ origin: { url: URL_, userId: ios.session.userId } }); assert.equal(r.ok, true);
});

test('iPhone runtime syncs play counts, preference, favorites, and play history both ways with Windows', async t => {
  const App = require('../src/core/library-app.cjs');
  const { PlayCounts } = require('../src/core/play-counts.cjs');
  const { FavoriteStore } = require('../src/core/favorites.cjs');
  const { HistoryStore } = require('../src/core/play-history-store.cjs');
  const { ParseBilibili } = require('../src/core/urls.cjs');
  const { SyncExtras } = require('../src/core/sync-counts.cjs');
  const X = require('../src/core/sync-supabase.cjs');
  const { CONFIG } = require('./fake-supabase.cjs');

  const server = FakeServer({ now: Date.now() });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-rtc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const song = ParseBilibili('https://www.bilibili.com/video/BV1aaaaaaaaa/');
  const keyA = 'bili:BV1aaaaaaaaa:p1', keyB = 'bili:BV1bbbbbbbbb:p1';

  const pc = new PlayCounts(path.join(root, 'pc.json'));
  const pcFavs = new FavoriteStore(path.join(root, 'pc-favs.json'));
  const pcHist = new HistoryStore(path.join(root, 'pc-hist.json'));
  let now = 1000;
  pc.now = () => now;
  for (let r = 0; r < 3; r++) { pc.Begin(song); for (let i = 0; i < 6; i++) { now += 1000; pc.Observe({ position: i, duration: 200, paused: false }); } }
  pcFavs.Set(keyA, true);
  pcHist.Add(keyA, Date.now());
  const pcAdapter = {
    Read: async () => pc.SyncRead({ weighted: false, at: 500 }),
    Apply: async ({ rows, epoch, cursor }) => { pc.SyncApply({ rows, epoch, cursor }); },
    Pushed: async () => pc.SyncPushed(),
    favorites: { Read: async () => pcFavs.SyncRead(pc.ledger.deviceId), Apply: async v => pcFavs.SyncApply(v), Pushed: async () => pcFavs.SyncPushed() },
    history: { Read: async () => pcHist.SyncRead(pc.ledger.deviceId), Apply: async v => pcHist.SyncApply(v), Pushed: async () => pcHist.SyncPushed() },
  };
  await X.SendCode(CONFIG, server.request, 'me@example.com');
  let pcSession = await X.VerifyCode(CONFIG, server.request, 'me@example.com', '123456', () => server.now);
  const pcRepo = new X.SupabaseSyncRepository({ config: CONFIG, request: server.request, session: { get: () => pcSession, set: v => { pcSession = v; } }, now: () => server.now });
  assert.equal((await SyncExtras(pcAdapter, pcRepo)).ok, true);

  const phone = {
    ledger: App.LedgerOpen({ deviceId: 'phone1' }).text, prefs: { weighted: true, at: 0 }, dirty: new Set(), pushedOnce: false, applied: 0, pushed: 0,
    favText: App.FavoritesOpen({}).text, favDirty: new Set(), favPushedOnce: false,
    histText: App.HistoryOpen({}).text, histDirty: new Set(), histPushedOnce: false,
  };
  let libraryText = Pretty(EmptyLibrary()), session = null;
  globalThis.__favecusHost = {
    library: async () => libraryText, write: async json => { libraryText = JSON.parse(json).text; }, persist: async () => {}, backup: async () => 'b', recovered: async () => false,
    request: async (method, url, init) => { const { headers, body } = JSON.parse(init); return JSON.stringify(await server.request(method, url, { headers, body: body === null ? undefined : body })); },
    saveSession: async json => { session = JSON.parse(json); },
    countsRead: async () => {
      const s = App.LedgerSyncState({ text: phone.ledger });
      const rows = s.rows.filter(row => !phone.pushedOnce || phone.dirty.has(row.id)).map(({ epoch, month, key, n }) => ({ epoch, month, key, n }));
      return JSON.stringify({ deviceId: s.deviceId, epoch: s.epoch, cursor: s.cursor, rows, prefs: phone.prefs });
    },
    countsApply: async json => {
      const v = JSON.parse(json), merged = App.LedgerMerge({ text: phone.ledger, rows: v.rows, epoch: v.epoch, cursor: v.cursor });
      phone.ledger = merged.text; if (v.prefs) phone.prefs = v.prefs; phone.applied++;
    },
    countsPushed: async () => { phone.dirty.clear(); phone.pushedOnce = true; phone.pushed++; },
    favoritesRead: async () => {
      const s = App.FavoritesSyncState({ text: phone.favText, keys: phone.favPushedOnce ? [...phone.favDirty] : null });
      return JSON.stringify({ deviceId: 'phone1', cursor: s.cursor, rows: s.rows });
    },
    favoritesApply: async json => {
      const v = JSON.parse(json);
      phone.favText = App.FavoritesMerge({ text: phone.favText, rows: v.rows, cursor: v.cursor, now: Date.now() }).text;
    },
    favoritesPushed: async () => { phone.favDirty.clear(); phone.favPushedOnce = true; },
    historyRead: async () => {
      const s = App.HistorySyncState({ text: phone.histText, keys: phone.histPushedOnce ? [...phone.histDirty] : null });
      return JSON.stringify({ deviceId: 'phone1', cursor: s.cursor, clearedAt: s.clearedAt, rows: s.rows });
    },
    historyApply: async json => {
      const v = JSON.parse(json);
      phone.histText = App.HistoryMerge({ text: phone.histText, rows: v.rows, clearedAt: v.clearedAt, cursor: v.cursor, now: Date.now() }).text;
    },
    historyPushed: async () => { phone.histDirty.clear(); phone.histPushedOnce = true; },
  };
  const config = { url: URL_, anonKey: KEY };
  assert.equal((await Runtime.SendCode({ config, email: 'me@example.com' })).ok, true);
  session = (await Runtime.VerifyCode({ config, email: 'me@example.com', code: '123456' })).session;
  assert.equal((await Runtime.Open({ stateText: null, config, session, deviceId: 'ios-test' })).status, 'none');
  assert.equal((await Runtime.Enable({ origin: { url: URL_, userId: session.userId } })).ok, true);
  const cycle = await Runtime.Cycle();
  assert.equal(cycle.ok, true, JSON.stringify(cycle));
  assert.equal(cycle.extras.ok, true, JSON.stringify(cycle.extras));
  assert.equal(phone.applied, 1);
  assert.equal(phone.pushed, 1);
  assert.equal(App.LedgerCounts({ text: phone.ledger, keys: [keyA] }).counts[keyA], 3);
  assert.deepEqual(phone.prefs, { weighted: false, at: 500 });
  assert.deepEqual(JSON.parse(phone.favText).keys, [keyA]);
  assert.deepEqual(App.HistoryKeys({ items: JSON.parse(phone.histText).items, limit: 10 }).keys, [keyA]);

  phone.ledger = App.LedgerIncrement({ text: phone.ledger, key: keyA, now: Date.now() }).text;
  phone.dirty.add(App.LedgerSyncState({ text: phone.ledger }).rows.find(r => r.n === 1 && r.id.startsWith('phone1')).id);
  phone.favText = App.FavoritesSet({ text: phone.favText, key: keyB, value: true, now: Date.now() }).text;
  phone.favDirty.add(keyB);
  phone.histText = App.HistoryAddState({ text: phone.histText, key: keyB, at: Date.now() + 5000 }).text;
  phone.histDirty.add(keyB);
  assert.equal((await Runtime.Cycle()).extras.ok, true);
  assert.equal((await SyncExtras(pcAdapter, pcRepo)).ok, true);
  assert.equal(pc.Count(song), 4);
  assert.equal(pcFavs.Has(keyB), true);
  assert.equal(pcHist.Keys(10)[0], keyB);
});

test('a missing counts table is reported in the cycle result without failing the library sync', async () => {
  const server = FakeServer({ now: Date.now() });
  server.countsTable = false;
  let libraryText = Pretty(EmptyLibrary()), session = null;
  globalThis.__favecusHost = {
    library: async () => libraryText, write: async json => { libraryText = JSON.parse(json).text; }, persist: async () => {}, backup: async () => 'b', recovered: async () => false,
    request: async (method, url, init) => { const { headers, body } = JSON.parse(init); return JSON.stringify(await server.request(method, url, { headers, body: body === null ? undefined : body })); },
    saveSession: async json => { session = JSON.parse(json); },
    countsRead: async () => JSON.stringify({ deviceId: 'p', epoch: 0, cursor: 0, rows: [], prefs: { weighted: true, at: 0 } }),
    countsApply: async () => {},
    countsPushed: async () => {},
  };
  const config = { url: URL_, anonKey: KEY };
  await Runtime.SendCode({ config, email: 'me@example.com' });
  session = (await Runtime.VerifyCode({ config, email: 'me@example.com', code: '123456' })).session;
  await Runtime.Open({ stateText: null, config, session, deviceId: 'ios-test-2' });
  await Runtime.Enable({ origin: { url: URL_, userId: session.userId } });
  const cycle = await Runtime.Cycle();
  assert.equal(cycle.ok, true);
  assert.equal(cycle.extras.ok, false);
  assert.equal(cycle.extras.missing, true);
});
