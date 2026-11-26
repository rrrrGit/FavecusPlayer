'use strict';
// v0.7.6 フルスキャン不具合修正（同期 Pull/Compact 競合・ResetLink 中断・QueueSync 重み・UI 遷移/ガード・CI/ビルド設定・ガイド更新）の回帰テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { appScripts } = require('./support-source.cjs');
const App = require('../src/core/library-app.cjs');
const S = require('../src/core/sync-state.cjs');
const E = require('../src/core/sync-engine.cjs');
const { Store, ValidateLibrary } = require('../src/core/store.cjs');
const { LibraryMediaKey } = require('../src/core/library-identity.cjs');
const { SyncService, StoreAdapter } = require('../src/core/sync-service.cjs');
const Storage = require('../src/core/sync-storage.cjs');
const { SupabaseSyncRepository, SendCode, VerifyCode } = require('../src/core/sync-supabase.cjs');
const { SyncSession } = require('../src/core/sync-session.cjs');
const { SyncExtras } = require('../src/core/sync-counts.cjs');
const { KEY, CONFIG, FakeServer } = require('./fake-supabase.cjs');

const DAY = 86400000, T0 = Date.UTC(2026, 10, 13);
const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pid = n => id(1, n), tid = n => id(2, n);
const track = (n, title = `曲${n}`) => ({ id: tid(n), title, addedAt: '2026-11-13T00:00:00.000Z', type: 'bilibili', url: `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'a')}/` });
const list = (n, name, entries = [], childIds = []) => ({ id: pid(n), name, icon: '', entries, childIds, createdAt: '2026-11-13T00:00:00.000Z', lastAddedAt: '', includeInAll: true });
const library = (playlists, rootPlaylistIds) => ({ version: 3, identityVersion: 2, videoAliases: [], rootPlaylistIds, playlists });

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const FakeSafe = () => ({
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(Buffer.from(text).toString('base64')),
  decryptString: buffer => Buffer.from(buffer.toString(), 'base64').toString()
});

test('SupabaseSyncRepository.Pull falls back to full resync when Compact advances watermark mid-pull', async () => {
  const server = FakeServer({ now: T0 });
  await SendCode(CONFIG, server.request, 'a@example.com');
  let session = await VerifyCode(CONFIG, server.request, 'a@example.com', '123456', () => server.now);
  const makeRepo = reqFn => new SupabaseSyncRepository({
    config: CONFIG,
    request: reqFn,
    now: () => server.now,
    session: { get: () => session, set: v => { session = v; } }
  });

  const repoA = makeRepo(server.request);
  const a = E.NewDevice('dev-a'), b = E.NewDevice('dev-b');
  E.Initialize(a, library([list(1, 'メイン', [track(1, '残る'), track(2, '消える')])], [pid(1)]), T0);
  assert.equal((await E.Sync(a, repoA, T0)).ok, true);
  assert.equal((await E.Sync(b, repoA, T0)).ok, true);
  const cursorBeforeDelete = b.cursor;

  // 端末Aが曲2を削除して同期し、90日以上経過させる
  const nextView = JSON.parse(JSON.stringify(a.view));
  nextView.playlists[0].entries = [track(1, '残る')];
  E.Edit(a, nextView, T0 + 1000);
  assert.equal((await E.Sync(a, repoA, T0 + 1000)).ok, true);
  server.now = T0 + 92 * DAY;

  // 端末Bが増分 Pull 中（初回 Meta() 後、sync_changes?seq=gt.<cursor> 取得前）に Compact が走る
  let compacted = false;
  const repoB = makeRepo(async (method, reqUrl, init) => {
    if (method === 'GET' && String(reqUrl).includes('sync_changes') && String(reqUrl).includes(`seq=gt.${cursorBeforeDelete}`) && !compacted) {
      compacted = true;
      await repoA.Compact(server.now);
    }
    return server.request(method, reqUrl, init);
  });

  const pulled = await repoB.Pull(cursorBeforeDelete);
  assert.equal(compacted, true);
  assert.equal(pulled.resync, true, 'Compact 割り込み時は全量再同期へフォールバックする');
  const ids = new Set(pulled.snapshot.map(r => r.id));
  assert.equal(ids.has(S.TrackId(tid(1))), true, '生存レコードは保持される');
  assert.equal(ids.has(S.TrackId(tid(2))), false, '90日超削除済みレコードは復活しない');
});

test('SyncSession.Cycle and SyncExtras abort before applying remote changes when ResetLink interrupts', async t => {
  const server = FakeServer({ now: T0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-sync-abort-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data'), syncDir = path.join(data, 'sync');
  fs.mkdirSync(data, { recursive: true });

  await SendCode(CONFIG, server.request, 'me@example.com');
  let session = await VerifyCode(CONFIG, server.request, 'me@example.com', '123456', () => server.now);
  const peerRepo = new SupabaseSyncRepository({
    config: CONFIG,
    request: server.request,
    now: () => server.now,
    session: { get: () => session, set: v => { session = v; } }
  });

  // まず端末側の同期を有効化（まだサーバーに別端末リストは存在しない状態）
  let service;
  const store = new Store(data, { committed: () => service?.Changed() });
  const adapter = StoreAdapter(store, { validateLibrary: input => ValidateLibrary(input), mediaKey: LibraryMediaKey });
  service = new SyncService({
    directory: syncDir, adapter, vault: new Storage.SessionVault(syncDir, FakeSafe()),
    request: server.request, now: () => server.now, timers: { set: () => ({ unref() {} }), clear() {} }
  });
  service.Configure({ url: 'https://abcdefgh.supabase.co', anonKey: KEY });
  await service.SendCode('me@example.com');
  await service.VerifyCode('me@example.com', '123456');
  service.Start();
  assert.equal((await service.Enable()).ok, true);

  // Enable 完了後に別端末が新しいリスト・お気に入りを登録する
  const peer = E.NewDevice('peer-dev');
  E.Initialize(peer, library([list(9, '旧アカウントのリスト', [track(9)])], [pid(9)]), T0);
  assert.equal((await E.Sync(peer, peerRepo, T0)).ok, true);
  await peerRepo.PushFavorites('peer-dev', [{ key: 'bili:BV1oldaccount:p1', fav: true, at: T0 + 100 }]);

  let appliedFavorites = 0;
  let aborted = false;
  const favAdapter = {
    Read: async () => ({ deviceId: 'dev-local', cursor: 0, rows: [] }),
    Apply: async () => { appliedFavorites++; },
    Pushed: async () => {}
  };
  const extraAborted = await SyncExtras(
    { favorites: favAdapter },
    {
      ...peerRepo,
      PullFavorites: async cursor => {
        aborted = true;
        return peerRepo.PullFavorites(cursor);
      }
    },
    { isAborted: () => aborted }
  );
  assert.equal(extraAborted.aborted, true);
  assert.equal(appliedFavorites, 0, 'Reset 割り込み後の SyncExtras は Apply しない');

  let holdPull;
  let held = false;
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
  holdPull();
  const res = await cyclePromise;
  assert.equal(res.ok, false);
  assert.match(res.error, /中断/);
  assert.equal(store.data.playlists.some(p => p.name === '旧アカウントのリスト'), false, '中断時に旧アカウントのプレイリストがローカルへ反映されない');

  // SyncSession.Cycle 直接呼び出しでも isAborted が Apply を抑止する
  let sessionApplied = false;
  const syncSession = new SyncSession({
    adapter: {
      Library: async () => ({ version: 3, identityVersion: 2, videoAliases: [], rootPlaylistIds: [], playlists: [] }),
      Context: async () => ({ aliases: [] }),
      Apply: async () => { sessionApplied = true; return true; }
    },
    repository: () => ({
      Pull: async () => ({ changes: [{ id: S.PlaylistId(pid(8)), f: { name: ['X', 100, 'p', 0] } }], cursor: 1 }),
      Push: async () => {},
      Compact: async () => {}
    }),
    persist: async () => {},
    deviceId: () => 'dev-1',
    now: () => 200
  });
  await syncSession.Enable({ url: 'u', userId: 'me' });
  sessionApplied = false;
  let stopNow = false;
  const baseRepo = syncSession.makeRepository;
  syncSession.makeRepository = () => ({
    Pull: async c => { stopNow = true; sessionApplied = false; return baseRepo().Pull(c); },
    Push: async () => {},
    Compact: async () => {}
  });
  const sRes = await syncSession.Cycle({ isAborted: () => stopNow });
  assert.equal(sRes.aborted, true);
  assert.equal(sessionApplied, false);
});

test('library-app QueueSync updates weights when provided and clears on null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-qsync-w-'));
  try {
    const store = new Store(dir);
    const pid = store.data.activePlaylistId;
    store.Apply({ type: 'add', playlistId: pid, urls: 'av1\nav2\nav3\nav4' });
    const entries = store.data.playlists[0].entries;
    const text = JSON.stringify(store.Snapshot());
    const playable = entries.map(e => e.id);

    // 最初はシャッフルオフ（重みなし）で開始
    const start = App.QueueStart({ text, scope: pid, entryId: entries[0].id, shuffle: false, playable, seed: 42 });
    assert.equal(start.id, entries[0].id);

    // 途中でシャッフルオン + weights ありへ切り替え：重い曲（重み1000）と軽い曲（重み0.001）が抽選に影響する
    const favTarget = entries[3].id;
    const weights = { [entries[1].id]: 0.001, [entries[2].id]: 0.001, [favTarget]: 10000 };
    const synced = App.QueueSync({ text, scope: pid, entryId: entries[0].id, ownScope: pid, shuffle: true, playable, weights });
    assert.equal(synced.stopped, false);
    const list = App.QueueList();
    assert.equal(list.upcoming[0], favTarget, 'QueueSync に weights を渡すと重みが有効になる');

    // weights: null でシャッフル重みを解除でき、以降の shuffle: true で極端な重み固定が消える
    const cleared = App.QueueSync({ text, scope: pid, entryId: entries[0].id, ownScope: pid, shuffle: false, playable, weights: null });
    assert.equal(cleared.stopped, false);
    assert.deepEqual(App.QueueList().upcoming, [entries[1].id, entries[2].id, entries[3].id]);

    // 再び shuffle: true（weights なし）に切り替えても、以前の重み（entries[3] 固定）が残らない
    let sawNonFavFirst = false;
    for (let i = 0; i < 20; i++) {
      App.QueueSync({ text, scope: pid, entryId: entries[0].id, ownScope: pid, shuffle: false, playable });
      App.QueueSync({ text, scope: pid, entryId: entries[0].id, ownScope: pid, shuffle: true, playable });
      if (App.QueueList().upcoming[0] !== favTarget) { sawNonFavFirst = true; break; }
    }
    assert.equal(sawNonFavFirst, true, 'weights: null で重みが解除され均等シャッフルに戻る');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PC UI SyncSettings guards modal navigation and AddURL opens PlaylistURL with no destinations checked', async t => {
  const html = read('src/ui/index.html');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-ui-076-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir), firstList = store.data.activePlaylistId;
  store.Apply({ type: 'add', playlistId: firstList, urls: 'av100' });

  const nodes = new Map();
  class Node {
    constructor(tag = 'div') {
      this.tagName = tag; this.children = []; this.events = {}; this.dataset = {}; this.style = { setProperty() {} };
      this.scrollTop = 0; this.checked = false; this.disabled = false; this.open = false; this.clientHeight = 300; this.classes = new Set();
      this.classList = { add: (...v) => v.forEach(x => this.classes.add(x)), remove: (...v) => v.forEach(x => this.classes.delete(x)), contains: x => this.classes.has(x), toggle: (x, f) => { if (f ?? !this.classes.has(x)) this.classes.add(x); else this.classes.delete(x); } };
    }
    set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classes].join(' '); }
    append(...children) { for (const n of children) { if (n.id) nodes.set(n.id, n); if (n.parentElement) n.parentElement.children = n.parentElement.children.filter(c => c !== n); n.parentElement = this; this.children.push(n); } }
    prepend(...children) { for (const n of [...children].reverse()) { if (n.id) nodes.set(n.id, n); if (n.parentElement) n.parentElement.children = n.parentElement.children.filter(c => c !== n); n.parentElement = this; this.children.unshift(n); } }
    replaceChildren(...children) { this.children = []; this.text = ''; this.append(...children); }
    set textContent(v) { this.text = String(v); this.children = []; }
    get textContent() { return (this.text || '') + this.children.map(c => c.textContent).join(''); }
    set value(v) { this.val = String(v); }
    get value() { return this.val ?? ''; }
    setAttribute(k, v) { this[k] = v; }
    getAttribute(k) { return this[k] ?? null; }
    removeAttribute(k) { delete this[k]; }
    focus() {}
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
    querySelectorAll(sel) { const all = this.children.flatMap(c => [c, ...c.querySelectorAll('*')]); return sel === '*' ? all : all.filter(n => sel.startsWith('.') ? n.classList.contains(sel.slice(1)) : n.tagName === sel); }
    querySelector(sel) { return sel === 'use' ? { setAttribute() {} } : this.querySelectorAll(sel)[0]; }
    set innerHTML(htmlStr) {
      this.children = [];
      for (const m of htmlStr.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)) {
        const id = m[2].match(/\bid="([^"]+)"/)?.[1];
        if (!id) continue;
        const n = new Node(m[1]); n.id = id; this.append(n);
      }
    }
    get offsetHeight() { return 60; }
    getBoundingClientRect() { return { top: 0, y: 0, x: 0, left: 0, right: 500, bottom: 300, width: 500, height: 300 }; }
    scrollTo() {}
    contains(n) { return n === this || this.children.some(c => c.contains(n)); }
    showModal() { this.open = true; }
    close() { this.open = false; for (const fn of this.events.close || []) fn(); }
  }
  for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)) {
    const id = m[2].match(/\bid="([^"]+)"/)?.[1];
    if (!id) continue;
    const n = new Node(m[1]); n.id = id;
    const cls = m[2].match(/\bclass="([^"]+)"/)?.[1];
    if (cls) n.className = cls;
    nodes.set(n.id, n);
  }
  const wrap = new Node('div'); wrap.className = 'transport-more-wrap';
  wrap.append(nodes.get('transport-more'), nodes.get('transport-menu'));
  nodes.get('transport-menu').append(nodes.get('sleep'), nodes.get('speed'), nodes.get('stop'));
  new Node('main').append(nodes.get('entries'));

  let resolveSyncStatus;
  const syncStatusPromise = new Promise(r => { resolveSyncStatus = r; });
  const documentObj = {
    body: new Node('body'),
    getElementById: id => nodes.get(id),
    createElement: tag => new Node(tag),
    createDocumentFragment: () => new Node('fragment'),
    querySelectorAll: () => [],
    addEventListener() {}
  };
  const api = {
    state: async () => ({ state: store.Snapshot(), current: null, playback: null, statuses: {}, foreground: true, accounts: {}, version: '0.7.5', platform: 'win32' }),
    accounts: async () => ({}),
    onEvent() {},
    bounds() {},
    sync: async cmd => cmd.action === 'status' ? syncStatusPromise : {},
    resolveURL: async () => ({ kind: 'playlist', sources: [{ kind: 'parts', url: 'https://www.bilibili.com/video/BV1x/', title: 'テスト' }] }),
    listStats: async () => ({})
  };
  const errors = [];
  const ctx = {
    document: documentObj,
    window: {
      addEventListener() {},
      favecusApp: api,
      FavecusTransport: require('../src/ui/transport-model.js'),
      FavecusEntryView: require('../src/ui/entry-view.js')
    },
    requestAnimationFrame() {}, IntersectionObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} },
    setTimeout() { return 1; }, clearTimeout() {}, console: { error: e => errors.push(e) }
  };
  vm.createContext(ctx);
  for (const file of ['library-tree.js', 'home-view.js', 'library-search.js', 'tree-view.js', 'parent-picker.js', 'playlist-reader.js', 'keybindings.js', 'queue-drag.js']) {
    vm.runInContext(read(`src/ui/${file}`).replace('})(globalThis)', '})(window)'), ctx);
  }
  for (const script of appScripts()) vm.runInContext(script, ctx);
  await new Promise(setImmediate);

  // 1) SyncSettings: ステータス解決前に別モーダルを開いても TypeError が出ない
  vm.runInContext('SyncSettings()', ctx);
  vm.runInContext("OpenModal('別の設定', '<p>other</p>')", ctx);
  resolveSyncStatus({ enabled: false, configured: false, signedIn: false, email: 'a@b.c', url: 'https://x.supabase.co' });
  await new Promise(setImmediate);
  assert.equal(nodes.get('toast').classList.contains('hidden'), true, 'モーダル遷移後にエラートーストが出ない');
  assert.equal(errors.length, 0);

  // 2) AddURL: 追加先のチェックがすべて外れていても、再生リストURLの読み込みで PlaylistURL モーダルへ進める
  vm.runInContext('AddURL()', ctx);
  const check = nodes.get('modal-body').querySelectorAll('input').find(i => i.type === 'checkbox');
  assert.ok(check);
  check.checked = false;
  check.onchange?.();
  nodes.get('url-input').value = 'https://www.bilibili.com/video/BV1x/?p=1';
  await nodes.get('url-load').onclick();
  assert.equal(nodes.get('modal-title').textContent, '再生リストURLから追加', '追加先が空でも PlaylistURL モーダルを開ける');
});

test('CI workflows include release/v* (covering release/v0.7.6), build-windows.py avoids modifying native/config.h, and GUIDE/README reflect v0.7.5', () => {
  const iosYml = read('.github/workflows/ios.yml');
  const winYml = read('.github/workflows/windows-build.yml');
  assert.match(iosYml, /release\/v(?:\*|0\.7\.6)/);
  assert.match(iosYml, /permissions:\s*\r?\n\s*contents:\s*read/);
  assert.match(iosYml, /node-version:\s*"24\.20\.0"/);
  assert.match(winYml, /release\/v(?:\*|0\.7\.6)/);

  const configH = read('native/config.h');
  assert.match(configH, /#ifndef ELECTRON_FOLDER[\s\S]*#define ELECTRON_FOLDER[\s\S]*#endif/);
  const buildWin = read('scripts/build-windows.py');
  assert.doesNotMatch(buildWin, /config\.h['"]\)\.write_text/);
  assert.match(buildWin, /-DELECTRON_FOLDER=L"/);

  assert.match(read('docs/GUIDE.md'), /^# Favecus Player v0\.7\.5 の使い方/);
  assert.match(read('docs/GUIDE.html'), /<h1>Favecus Player v0\.7\.5 の使い方<\/h1>/);
  assert.match(read('README.md'), /^# Favecus Player 0\.7\.5/);
  assert.match(read('README.md'), /Favecus-Player-0\.7\.5-Patch\.exe/);
  assert.doesNotMatch(read('docs/BUILD.md'), /今回のリリースは0\.6\.6/);
});

test('SyncService SignOut prevents in-flight Repository session.set from restoring cleared session', () => {
  const fs = require('node:fs'), os = require('node:os');
  const { SyncService } = require('../src/core/sync-service.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-signout-'));
  try {
    let saved = { accessToken: 'old', refreshToken: 'r', expiresAt: 0, userId: 'u1' };
    const vault = { Available: () => true, Get: () => saved, Set: v => { saved = v; }, Clear: () => { saved = null; } };
    const svc = new SyncService({ directory: dir, adapter: { Library: () => ({}), Context: () => ({}), Apply: () => false }, vault, request: async () => ({ status: 200, json: {} }) });
    svc.Configure({ url: 'https://demo.supabase.co', anonKey: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig' });
    const repo = svc.Repository();
    svc.SignOut();
    assert.equal(saved, null);
    repo.session.set({ accessToken: 'resurrected', refreshToken: 'r2', expiresAt: 9999999999, userId: 'u1' });
    assert.equal(saved, null, 'SignOut 後に旧 Repository 経由でセッションが復活しない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('AdditionReview.Commit updates playlist lastAddedAt and LoudnessStore rejects corrupted entries', async () => {
  const fs = require('node:fs'), os = require('node:os');
  const { Store } = require('../src/core/store.cjs');
  const { AdditionReview } = require('../src/core/addition-review.cjs');
  const { LoudnessStore } = require('../src/core/loudness.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-rev-'));
  try {
    const store = new Store(dir);
    const listId = store.data.playlists[0].id;
    assert.equal(store.Playlist(listId).lastAddedAt, '');
    const review = new AdditionReview(store);
    const plan = await review.Prepare({ type: 'add', destinationIds: [listId], urls: 'https://www.bilibili.com/video/BV1xx411c7mD/' });
    await review.Commit(plan.id, []);
    assert.ok(store.Playlist(listId).lastAddedAt.length > 0, 'AdditionReview.Commit で lastAddedAt が更新される');

    const loudFile = path.join(dir, 'loudness.json');
    fs.writeFileSync(loudFile, JSON.stringify({ version: 1, records: { bad: null, good: { meanDb: -12, at: 100 } } }));
    const loud = new LoudnessStore(loudFile, null);
    assert.deepEqual(Object.keys(loud.records), ['good']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SyncRuntime propagates host.isAborted to SyncExtras and stops local apply', async () => {
  const SyncRuntime = require('../src/core/sync-runtime.cjs');
  let favApplied = false;
  let aborted = true;
  const prevHost = globalThis.__favecusHost;
  try {
    globalThis.__favecusHost = {
      isAborted: () => aborted,
      countsRead: async () => null,
      favoritesRead: async () => JSON.stringify({ deviceId: 'ios-1', cursor: 0, rows: [] }),
      favoritesApply: async () => { favApplied = true; },
      favoritesPushed: async () => {}
    };
    const { SyncExtras } = require('../src/core/sync-counts.cjs');
    const res = await SyncExtras({ favorites: { Read: async () => ({ deviceId: 'ios-1', cursor: 0, rows: [] }), Apply: async () => { favApplied = true; }, Pushed: async () => {} } }, { PullFavorites: async () => ({ rows: [], cursor: 1 }) }, { isAborted: () => aborted });
    assert.equal(res.aborted, true);
    assert.equal(favApplied, false);
    assert.equal(typeof SyncRuntime.Cycle, 'function');
  } finally { globalThis.__favecusHost = prevHost; }
});
