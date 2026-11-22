'use strict';
// v0.7.1 Step4：再生回数と設定の端末間同期。PC役・iPhone役の2つの台帳を、偽のSupabase（schema.sqlと同じ規則）で接続して確かめる。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const X = require('../src/core/sync-supabase.cjs');
const { SyncExtras } = require('../src/core/sync-counts.cjs');
const { PlayCounts } = require('../src/core/play-counts.cjs');
const { FavoriteStore } = require('../src/core/favorites.cjs');
const { HistoryStore } = require('../src/core/play-history-store.cjs');
const FavCore = require('../src/core/favorites-core.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');
const { CONFIG, FakeServer } = require('./fake-supabase.cjs');

const song = ParseBilibili('https://www.bilibili.com/video/BV1aaaaaaaaa/'), other = ParseBilibili('https://www.bilibili.com/video/BV1bbbbbbbbb/');
const local = { type: 'local', fileName: '0a0b0c0d-0000-4000-8000-000000000001.mp3' };
function Temp(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-counts-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }
async function Repo(server) {
  await X.SendCode(CONFIG, server.request, 'me@example.com');
  let session = await X.VerifyCode(CONFIG, server.request, 'me@example.com', '123456', () => server.now);
  return new X.SupabaseSyncRepository({ config: CONFIG, request: server.request, session: { get: () => session, set: value => { session = value; } }, now: () => server.now });
}
// 端末役：台帳（PlayCounts）と設定（優先する・変更時刻）
function Device(root, name, server) {
  const device = { counts: new PlayCounts(path.join(root, `${name}.json`)), prefs: { weighted: true, at: 0 }, now: 1000 };
  device.counts.now = () => device.now;
  device.play = entry => { device.counts.Begin(entry); for (let i = 0; i < 6; i++) { device.now += 1000; device.counts.Observe({ position: i, duration: 200, paused: false }); } };
  device.setWeighted = (value, at) => { device.prefs = { weighted: value, at }; };
  device.adapter = {
    Read: async () => device.counts.SyncRead({ ...device.prefs }),
    Apply: async ({ rows, epoch, cursor, prefs }) => { device.counts.SyncApply({ rows, epoch, cursor }); if (prefs) device.prefs = { ...prefs }; },
    Pushed: async () => device.counts.SyncPushed()
  };
  device.sync = async () => SyncExtras(device.adapter, await Repo(server));
  return device;
}

test('plays on two devices add up on both after syncing, and syncing again never counts anything twice', async t => {
  const server = FakeServer(), root = Temp(t), pc = Device(root, 'pc', server), phone = Device(root, 'phone', server);
  for (let i = 0; i < 3; i++) pc.play(song);
  for (let i = 0; i < 2; i++) phone.play(song);
  phone.play(other);
  assert.equal((await pc.sync()).ok, true); assert.equal((await phone.sync()).ok, true); assert.equal((await pc.sync()).ok, true);
  for (let i = 0; i < 3; i++) { await pc.sync(); await phone.sync(); }
  assert.equal(pc.counts.Count(song), 5); assert.equal(phone.counts.Count(song), 5);
  assert.equal(pc.counts.Count(other), 1); assert.equal(phone.counts.Count(other), 1);
  // 続きの再生は、変わった行だけが送られる
  pc.play(song);
  const result = await pc.sync();
  assert.equal(result.pushed, 1);
  await phone.sync();
  assert.equal(phone.counts.Count(song), 6);
});

test('local songs are never uploaded', async t => {
  const server = FakeServer(), root = Temp(t), pc = Device(root, 'pc', server);
  pc.play(local); pc.play(song);
  await pc.sync();
  assert.deepEqual([...server.counts.values()].map(row => row.media_key), ['bili:BV1aaaaaaaaa:p1']);
  assert.equal(pc.counts.Count(local), 1, '端末の中の回数は、そのまま');
});

test('a reset on one device moves every device to the new epoch; plays after the reset count again; old rows stay as history', async t => {
  const server = FakeServer(), root = Temp(t), pc = Device(root, 'pc', server), phone = Device(root, 'phone', server);
  pc.play(song); phone.play(song);
  await pc.sync(); await phone.sync(); await pc.sync();
  assert.equal(pc.counts.Count(song), 2);
  pc.counts.Reset();
  await pc.sync(); await phone.sync();
  assert.equal(phone.counts.Count(song), 0, 'リセットが、iPhoneにも届く');
  assert.equal(server.prefs.epoch, 1);
  phone.play(song);
  await phone.sync(); await pc.sync();
  assert.equal(pc.counts.Count(song), 1); assert.equal(phone.counts.Count(song), 1);
  assert.ok([...server.counts.values()].some(row => row.epoch === 0), '古い世代の行は、履歴として残る');
});

test('the preference follows the newest change and an older change never overrides it', async t => {
  const server = FakeServer(), root = Temp(t), pc = Device(root, 'pc', server), phone = Device(root, 'phone', server);
  pc.setWeighted(false, 100);
  await pc.sync(); await phone.sync();
  assert.deepEqual(phone.prefs, { weighted: false, at: 100 });
  phone.setWeighted(true, 200);
  await phone.sync(); await pc.sync();
  assert.deepEqual(pc.prefs, { weighted: true, at: 200 });
  // 古い時刻の変更（オフライン中に行った変更が、あとで届く）は、新しい設定を上書きしない
  const late = Device(root, 'late', server); late.setWeighted(false, 150);
  await late.sync();
  assert.deepEqual(late.prefs, { weighted: true, at: 200 });
  assert.equal(server.prefs.weighted_shuffle, true);
});

test('the server keeps the larger count when an older, smaller row arrives later', async t => {
  const server = FakeServer(), root = Temp(t), pc = Device(root, 'pc', server);
  pc.play(song); pc.play(song); pc.play(song);
  await pc.sync();
  const repo = await Repo(server);
  const [row] = [...server.counts.values()];
  assert.equal(row.n, 3);
  await repo.PushCounts(pc.counts.ledger.deviceId, [{ epoch: row.epoch, month: row.month, key: row.media_key, n: 1 }]); // 古い・小さい値
  assert.equal([...server.counts.values()][0].n, 3, '減らない');
});

test('when the extra tables have not been created yet, syncing reports it and changes nothing', async t => {
  const server = FakeServer(), root = Temp(t), pc = Device(root, 'pc', server);
  server.countsTable = false; pc.play(song);
  const result = await pc.sync();
  assert.equal(result.ok, false); assert.equal(result.missing, true); assert.match(result.error, /schema\.sql/);
  assert.equal(pc.counts.Count(song), 1, '端末の回数は、そのまま');
  server.countsTable = true;
  assert.equal((await pc.sync()).ok, true, 'SQLを実行したあとは、そのまま使える');
  assert.equal(server.counts.size, 1);
});

// ---- v0.7.5：お気に入り・再生履歴・自動スケジュール・再同期ループ防止・ResetLink
function FullDevice(root, name, server) {
  let now = 10000;
  const counts = new PlayCounts(path.join(root, `${name}-counts.json`));
  const favs = new FavoriteStore(path.join(root, `${name}-favs.json`), { now: () => now });
  const hist = new HistoryStore(path.join(root, `${name}-hist.json`), { now: () => now });
  counts.now = () => now;
  counts.onCounted = (key, at) => hist.Add(key, at);
  const device = {
    counts, favs, hist,
    prefs: { weighted: true, at: 0 },
    get now() { return now; },
    set now(v) { now = v; },
    play: entry => { counts.Begin(entry); for (let i = 0; i < 6; i++) { now += 1000; counts.Observe({ position: i, duration: 200, paused: false }); } },
    adapter: () => ({
      Read: async () => counts.SyncRead({ ...device.prefs }),
      Apply: async ({ rows, epoch, cursor, prefs }) => { counts.SyncApply({ rows, epoch, cursor }); if (prefs) device.prefs = { ...prefs }; },
      Pushed: async () => counts.SyncPushed(),
      favorites: {
        Read: async () => favs.SyncRead(counts.ledger.deviceId),
        Apply: async ({ rows, cursor }) => favs.SyncApply({ rows, cursor }),
        Pushed: async () => favs.SyncPushed()
      },
      history: {
        Read: async () => hist.SyncRead(counts.ledger.deviceId),
        Apply: async ({ rows, clearedAt, cursor }) => hist.SyncApply({ rows, clearedAt, cursor }),
        Pushed: async () => hist.SyncPushed()
      }
    }),
    sync: async () => SyncExtras(device.adapter(), await Repo(server))
  };
  return device;
}

test('favorites sync LWW across devices, resolve ties to fav=true, migrate legacy keys at t=1, exclude local songs, and enforce limits separately', async t => {
  const server = FakeServer({ now: 100000 }), root = Temp(t);
  const kA = 'bili:BV1aaaaaaaaa:p1', kB = 'bili:BV1bbbbbbbbb:p1', kC = 'bili:BV1ccccccccc:p1', kLocal = 'local:song.mp3';
  // 旧形式（v0.7.4）ファイルからの移行テスト
  fs.writeFileSync(path.join(root, 'pc-favs.json'), JSON.stringify({ version: 1, keys: [kA, kLocal] }));
  const pc = FullDevice(root, 'pc', server), phone = FullDevice(root, 'phone', server);
  assert.equal(pc.favs.Has(kA), true); assert.equal(pc.favs.Has(kLocal), true);
  // phone 側で同時刻 t=1 は使わず、別曲 kB を遅い時刻でお気に入り・解除を競合させる
  phone.now = 5000; phone.favs.Set(kB, true);
  assert.equal((await pc.sync()).ok, true);
  assert.equal((await phone.sync()).ok, true);
  // kA は移行済み (t=1, fav=true) で phone へ届き、ローカル曲はサーバーに出ない
  assert.equal(phone.favs.Has(kA), true);
  assert.equal(phone.favs.Has(kB), true);
  assert.equal(phone.favs.Has(kLocal), false);
  assert.equal(pc.favs.Has(kLocal), true);
  assert.ok(!server.favorites.has(kLocal));
  assert.equal((await pc.sync()).ok, true);
  assert.equal(pc.favs.Has(kB), true);
  // 移行後は states 付きで保存され、再起動しても at: 1 扱いに戻らない
  const savedPc = JSON.parse(fs.readFileSync(path.join(root, 'pc-favs.json'), 'utf8'));
  assert.ok(savedPc.states && savedPc.states[kA].at === 1 && savedPc.syncCursor > 0);
  // pc で kB を新しい時刻で解除
  pc.now = 9000; pc.favs.Set(kB, false);
  assert.equal((await pc.sync()).ok, true);
  assert.equal((await phone.sync()).ok, true);
  assert.equal(phone.favs.Has(kB), false, '解除が別端末へ届く');
  // 自分の cursor=0 初期化後も device_id フィルタがないためサーバーから自己復旧できる
  const pcFresh = new FavoriteStore(path.join(root, 'pc-rebuilt.json'), { now: () => 20000 });
  const r = await SyncExtras({
    favorites: { Read: async () => pcFresh.SyncRead(pc.counts.ledger.deviceId), Apply: async v => pcFresh.SyncApply(v), Pushed: async () => pcFresh.SyncPushed() }
  }, await Repo(server));
  assert.equal(r.ok, true);
  assert.equal(pcFresh.Has(kA), true); assert.equal(pcFresh.Has(kB), false);
  // 同じキーで解除履歴と登録上限が分離されていることの確認（fav: false が MAX_TOMBSTONES に達しても fav: true は追加・保護される）
  const doc = FavCore.Clean(null).doc;
  FavCore.Set(doc, kC, true, 100);
  for (let i = 0; i < FavCore.MAX_TOMBSTONES + 5; i++) {
    const key = `bili:BV1${String(i).padStart(9, '0')}:p1`;
    doc.states[key] = { fav: false, at: 10 + i };
  }
  FavCore.PruneTombstones(doc, new Set([`bili:BV1${String(0).padStart(9, '0')}:p1`]));
  assert.equal(doc.states[kC].fav, true);
  assert.ok(doc.states[`bili:BV1${String(0).padStart(9, '0')}:p1`], '未送信保護キーは残る');
  assert.equal(Object.values(doc.states).filter(s => !s.fav).length, FavCore.MAX_TOMBSTONES);
});

test('history syncs plays, deduplicates batch keys, remote clear deletes only Bilibili tracks, and server clamps future time', async t => {
  const server = FakeServer({ now: 50000 }), root = Temp(t);
  const pc = FullDevice(root, 'pc', server), phone = FullDevice(root, 'phone', server);
  pc.now = 10000; pc.play(song);
  pc.now = 10000 + 120000; pc.play(song); // 1分以上離れて同一曲の2件を意図的に作る（送信時の一意化テスト）
  server.now = 200000;
  phone.now = 15000; phone.play({ type: 'local', fileName: 'phone-only.mp3' });
  phone.now = 20000; phone.play(other);
  assert.equal((await pc.sync()).ok, true, '重複キーがあっても PostgreSQL 21000 エラーにならない');
  assert.equal((await phone.sync()).ok, true);
  assert.equal((await pc.sync()).ok, true);
  assert.deepEqual(phone.hist.Keys(10), ['bili:BV1aaaaaaaaa:p1', 'bili:BV1bbbbbbbbb:p1', 'local:phone-only.mp3']);
  assert.deepEqual(pc.hist.Keys(10), ['bili:BV1aaaaaaaaa:p1', 'bili:BV1bbbbbbbbb:p1']);
  // pc で履歴クリア → リモートからは Bilibili のみ消え、phone のローカル曲履歴は残る
  pc.now = 250000; pc.hist.Clear();
  assert.equal((await pc.sync()).ok, true);
  assert.equal((await phone.sync()).ok, true);
  assert.deepEqual(phone.hist.Keys(10), ['local:phone-only.mp3']);
  // サーバーへ極端な未来時刻を送っても now + 600000 でクランプされる
  const repo = await Repo(server);
  server.now = 300000;
  await repo.PushHistory('dev-x', [{ key: 'bili:BV1aaaaaaaaa:p1', at: 999999999999 }]);
  assert.equal(server.history.get('bili:BV1aaaaaaaaa:p1').played_at, 300000 + 600000);
});

test('partial missing schema tables report error without blocking available sync blocks, and recover after SQL runs', async t => {
  const server = FakeServer({ now: 100000 }), root = Temp(t), pc = FullDevice(root, 'pc', server);
  server.favoritesTable = false; server.historyTable = false;
  pc.play(song); pc.favs.Set('bili:BV1aaaaaaaaa:p1', true);
  const partial = await pc.sync();
  assert.equal(partial.ok, false); assert.equal(partial.missing, true); assert.match(partial.error, /schema\.sql/);
  assert.equal(partial.pushed, 1, '再生回数の同期は止まらず完了する');
  assert.equal(server.counts.size, 1);
  server.favoritesTable = true; server.historyTable = true;
  const ok = await pc.sync();
  assert.equal(ok.ok, true);
  assert.equal(server.favorites.size, 1); assert.equal(server.history.size, 1);
});

test('SyncService suppresses resync loop when receiving remote prefs and resets extras sync cursors on ResetLink', async t => {
  const { Store, ValidateLibrary } = require('../src/core/store.cjs');
  const { SyncService, StoreAdapter } = require('../src/core/sync-service.cjs');
  const Storage = require('../src/core/sync-storage.cjs');
  const server = FakeServer({ now: Date.now() }), root = Temp(t);
  const makeSvc = name => {
    const dir = path.join(root, name), syncDir = path.join(dir, 'sync');
    fs.mkdirSync(dir, { recursive: true });
    const counts = new PlayCounts(path.join(dir, 'play-ledger.json'));
    const favs = new FavoriteStore(path.join(dir, 'favorites.json'));
    const hist = new HistoryStore(path.join(dir, 'play-history.json'));
    let scheduled = 0;
    const store = new Store(dir, { committed: () => { service.Changed(); } });
    const FakeSafe = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
    const service = new SyncService({
      directory: syncDir,
      adapter: StoreAdapter(store, { validateLibrary: input => ValidateLibrary(input) }),
      vault: new Storage.SessionVault(syncDir, FakeSafe),
      request: server.request,
      now: () => server.now,
      timers: { set: (_fn, ms) => { if (ms < 60000) scheduled++; return { unref() {} }; }, clear() {} },
      extras: () => ({
        Read: async () => counts.SyncRead({ weighted: store.data.settings.weightedShuffle !== false, at: store.data.settings.weightedShuffleAt || 0 }),
        Apply: async ({ rows, epoch, cursor, prefs }) => { counts.SyncApply({ rows, epoch, cursor }); if (prefs) store.Apply({ type: 'settings', settings: { weightedShuffle: prefs.weighted, weightedShuffleAt: prefs.at } }); },
        Pushed: async () => counts.SyncPushed(),
        favorites: { Read: async () => favs.SyncRead(counts.ledger.deviceId), Apply: async v => favs.SyncApply(v), Pushed: async () => favs.SyncPushed() },
        history: { Read: async () => hist.SyncRead(counts.ledger.deviceId), Apply: async v => hist.SyncApply(v), Pushed: async () => hist.SyncPushed() }
      }),
      onResetExtras: () => { counts.ResetSync(); favs.ResetSync(); hist.ResetSync(); }
    });
    favs.onChange = info => { if (info?.syncable) service.ScheduleExtras(); };
    counts.onChange = info => { if (info?.rows?.length || info?.epoch !== undefined) service.ScheduleExtras(); };
    return { dir, store, service, counts, favs, hist, resetScheduled: () => { scheduled = 0; }, getScheduled: () => scheduled };
  };
  const a = makeSvc('a'), b = makeSvc('b');
  for (const d of [a, b]) {
    d.service.Configure({ url: CONFIG.url, anonKey: CONFIG.anonKey });
    await d.service.SendCode('me@example.com'); await d.service.VerifyCode('me@example.com', '123456');
    d.service.Start();
  }
  a.store.Apply({ type: 'settings', settings: { weightedShuffle: false, weightedShuffleAt: 999 } });
  a.favs.Set('bili:BV1aaaaaaaaa:p1', true);
  assert.equal((await a.service.Enable()).ok, true);
  b.resetScheduled();
  assert.equal((await b.service.Enable()).ok, true);
  assert.equal(b.store.data.settings.weightedShuffle, false);
  assert.equal(b.favs.Has('bili:BV1aaaaaaaaa:p1'), true);
  assert.equal(b.getScheduled(), 0, 'リモートの設定受信で再同期が再スケジュールされない');
  // ローカル曲では ScheduleExtras は呼ばれない
  b.resetScheduled();
  b.favs.Set('local:only.mp3', true);
  b.counts.Begin(local); b.counts.now = () => 10000; b.counts.Observe({ position: 0, duration: 100, paused: false }); b.counts.now = () => 15000; b.counts.Observe({ position: 5, duration: 100, paused: false });
  assert.equal(b.getScheduled(), 0, 'ローカル曲では自動同期を予約しない');
  // ResetLink で syncCursor が 0 に戻る
  a.service.ResetLink();
  assert.equal(a.counts.ledger.syncCursor, 0);
  assert.equal(a.favs.doc.syncCursor, 0);
  assert.equal(a.hist.state.syncCursor, 0);
});
