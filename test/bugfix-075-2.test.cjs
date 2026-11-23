'use strict';
// v0.7.5 第2弾修正（15+5項目・3点リーダー・音量バー延長）の回帰テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { appScripts } = require('./support-source.cjs');
const { CanonicalMediaKey } = require('../src/core/library-identity.cjs');
const Ledger = require('../src/core/play-ledger.cjs');
const { PlayCounts } = require('../src/core/play-counts.cjs');
const { FavoriteStore } = require('../src/core/favorites.cjs');
const { HistoryStore } = require('../src/core/play-history-store.cjs');
const { SongNotesStore } = require('../src/core/song-notes-store.cjs');
const { AutoListSettingsStore } = require('../src/core/auto-list-settings-store.cjs');
const { ListViewStore } = require('../src/core/list-views.cjs');
const { OutputDeviceStore } = require('../src/core/output-device.cjs');
const { SpeedStore } = require('../src/core/playback-speed.cjs');
const { TrashStore } = require('../src/core/trash-store.cjs');
const { Store, ValidateLibrary } = require('../src/core/store.cjs');
const { LibraryMediaKey } = require('../src/core/library-identity.cjs');
const { SyncService, StoreAdapter } = require('../src/core/sync-service.cjs');
const Storage = require('../src/core/sync-storage.cjs');
const { SupabaseSyncRepository } = require('../src/core/sync-supabase.cjs');
const { KEY, FakeServer } = require('./fake-supabase.cjs');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const FakeSafe = () => ({
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(Buffer.from(text).toString('base64')),
  decryptString: buffer => Buffer.from(buffer.toString(), 'base64').toString()
});

test('CanonicalMediaKey and PlayLedger aggregate av/BV counts and SyncRows sends only own Bilibili rows', t => {
  const canonical = CanonicalMediaKey([{ aid: '123', bvid: 'BV1aaaaaaaaa' }]);
  assert.equal(canonical('bili-av:123:p1'), 'bili:BV1aaaaaaaaa:p1');
  assert.equal(canonical('bili-av:999:p2'), 'bili-av:999:p2');
  assert.equal(canonical('local:song.mp3'), 'local:song.mp3');

  const ledger = Ledger.NewLedger('dev-a');
  Ledger.Increment(ledger, 'bili-av:123:p1', Date.UTC(2026, 10, 20), '2026-11');
  Ledger.Increment(ledger, 'bili:BV1aaaaaaaaa:p1', Date.UTC(2026, 10, 20), '2026-11');
  Ledger.Increment(ledger, 'local:only.mp3', Date.UTC(2026, 10, 20), '2026-11');
  Ledger.MergeRows(ledger, [{ device: 'dev-b', epoch: 0, month: '2026-11', key: 'bili:BV1aaaaaaaaa:p1', n: 3 }]);

  assert.equal(Ledger.Count(ledger, 'bili:BV1aaaaaaaaa:p1', canonical), 5);
  assert.equal(Ledger.Count(ledger, 'bili-av:123:p1', canonical), 5);
  const stats = Ledger.Stats(ledger, { nowMs: Date.UTC(2026, 10, 20), canonical });
  assert.equal(stats.top[0].key, 'bili:BV1aaaaaaaaa:p1');
  assert.equal(stats.top[0].count, 5);

  const syncRows = Ledger.SyncRows(ledger);
  assert.equal(syncRows.every(row => row.device === 'dev-a' && Ledger.IsSyncKey(row.key)), true);
  assert.deepEqual(syncRows.map(row => row.key).sort(), ['bili-av:123:p1', 'bili:BV1aaaaaaaaa:p1']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-counts-alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let aliases = [];
  const counts = new PlayCounts(path.join(dir, 'play-ledger.json'), () => {}, { aliases: () => aliases });
  const avEntry = { type: 'bilibili', url: 'https://www.bilibili.com/video/av123/', aid: '123', part: 1 };
  const bvEntry = { type: 'bilibili', url: 'https://www.bilibili.com/video/BV1aaaaaaaaa/', videoId: 'BV1aaaaaaaaa', part: 1 };
  counts.MergeRemote({
    rows: [
      { device: 'dev-b', epoch: 0, month: '2026-11', key: 'bili-av:123:p1', n: 2 },
      { device: 'dev-b', epoch: 0, month: '2026-11', key: 'bili:BV1aaaaaaaaa:p1', n: 4 }
    ]
  });
  assert.equal(counts.Count(bvEntry), 4);
  aliases = [{ aid: '123', bvid: 'BV1aaaaaaaaa' }];
  counts.InvalidateCache();
  assert.equal(counts.Count(avEntry), 6);
  assert.equal(counts.Count(bvEntry), 6);
  assert.equal(counts.Stats({ nowMs: Date.UTC(2026, 10, 20) }).top[0].count, 6);
});

test('FavoriteStore, HistoryStore, and SongNotesStore migrate av aliases and roll back on save failure', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-alias-stores-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const aliases = [{ aid: '123', bvid: 'BV1aaaaaaaaa' }];

  const favFile = path.join(dir, 'favorites.json');
  const fav = new FavoriteStore(favFile, { now: () => 100 });
  fav.Set('bili-av:123:p1', true);
  assert.equal(fav.MigrateAliases(aliases), true);
  assert.equal(fav.Has('bili:BV1aaaaaaaaa:p1'), true);
  assert.equal(fav.Has('bili-av:123:p1'), false);

  const histFile = path.join(dir, 'history.json');
  const hist = new HistoryStore(histFile, { now: () => 500 });
  hist.Add('bili-av:123:p1', 300);
  hist.Add('bili:BV1aaaaaaaaa:p1', 450);
  assert.equal(hist.MigrateAliases(aliases), true);
  assert.deepEqual(hist.Keys(10), ['bili:BV1aaaaaaaaa:p1']);
  assert.equal(hist.items[0].at, 450);

  const notesFile = path.join(dir, 'notes.json');
  const notes = new SongNotesStore(notesFile);
  notes.Set('bili-av:123:p1', { artist: '歌手A', tags: ['タグ1'], memo: 'avメモ', chapters: [{ title: '前奏', at: 5 }] });
  notes.Set('bili:BV1aaaaaaaaa:p1', { tags: ['タグ2'], chapters: [{ title: 'サビ', at: 40 }] });
  assert.equal(notes.MigrateAliases(aliases), true);
  assert.equal(notes.Has('bili-av:123:p1'), false);
  const merged = notes.Get('bili:BV1aaaaaaaaa:p1');
  assert.equal(merged.artist, '歌手A');
  assert.equal(merged.memo, 'avメモ');
  assert.deepEqual(new Set(merged.tags), new Set(['タグ1', 'タグ2']));
  assert.equal(merged.chapters.length, 2);

  // WriteJsonAtomic 失敗時のロールバック（ファイルパスにディレクトリを作る）
  fs.rmSync(histFile, { force: true });
  fs.mkdirSync(histFile);
  assert.throws(() => hist.Add('bili:BV1bbbbbbbbb:p1', 600), /保存できませんでした/);
  assert.deepEqual(hist.Keys(10), ['bili:BV1aaaaaaaaa:p1']);
  assert.throws(() => hist.Clear(), /保存できませんでした/);
  assert.deepEqual(hist.Keys(10), ['bili:BV1aaaaaaaaa:p1']);
  fs.rmdirSync(histFile);

  fs.rmSync(notesFile, { force: true });
  fs.mkdirSync(notesFile);
  assert.throws(() => notes.Set('bili:BV1bbbbbbbbb:p1', { memo: 'fail' }), /保存できませんでした/);
  assert.equal(notes.Has('bili:BV1bbbbbbbbb:p1'), false);
  fs.rmdirSync(notesFile);
});

test('Local stores roll back in-memory state when WriteJsonAtomic fails', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-local-rollback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const failWrite = (file, run) => {
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
    try { run(); } finally { fs.rmdirSync(file); }
  };

  const autoFile = path.join(dir, 'auto-list.json');
  const auto = new AutoListSettingsStore(autoFile);
  const initialAuto = auto.Get();
  failWrite(autoFile, () => {
    assert.throws(() => auto.Set({ ...initialAuto, recentDays: 30 }), /保存できませんでした/);
  });
  assert.deepEqual(auto.Get(), initialAuto);

  const listFile = path.join(dir, 'list-views.json');
  const listViews = new ListViewStore(listFile);
  failWrite(listFile, () => {
    assert.throws(() => listViews.Set('pl1', { sort: 'count-desc', favorite: 'only' }), /保存できませんでした/);
  });
  assert.equal(listViews.Get('pl1'), null);

  const outputFile = path.join(dir, 'output-device.json');
  const output = new OutputDeviceStore(outputFile);
  failWrite(outputFile, () => {
    assert.throws(() => output.Set('Headphones'), /保存できませんでした/);
  });
  assert.equal(output.Get(), '');

  const speedFile = path.join(dir, 'speed.json');
  const speed = new SpeedStore(speedFile);
  failWrite(speedFile, () => {
    assert.throws(() => speed.Set(1.5), /保存できませんでした/);
  });
  assert.equal(speed.Get(), 1);

  const trashFile = path.join(dir, 'trash.json');
  const trash = new TrashStore(trashFile, () => '2026-11-23T00:00:00.000Z');
  const plId = '00000000-0000-4000-8000-000000000001';
  const entryId = '00000000-0000-4000-8000-000000000002';
  assert.equal(trash.Add({
    id: 'tr1', kind: 'entry', label: '曲1', deletedAt: '2026-11-23T00:00:00.000Z',
    playlistId: plId, index: 0,
    entry: { id: entryId, type: 'local', fileName: 'a.mp3', title: '曲1' }
  }), true);
  failWrite(trashFile, () => {
    assert.equal(trash.Remove('tr1'), false);
    assert.equal(trash.Clear(), false);
  });
  assert.equal(trash.List().length, 1);
});

test('FakeServer rejects duplicate sync_counts rows, clamps cleared_at to +599000, and PushCounts deduplicates', async () => {
  const server = FakeServer();
  const headers = { apikey: KEY };
  await server.request('POST', 'https://abcdefgh.supabase.co/auth/v1/otp', { headers, body: { email: 'a@example.com' } });
  const auth = await server.request('POST', 'https://abcdefgh.supabase.co/auth/v1/verify', { headers, body: { email: 'a@example.com', token: '123456' } });
  const authed = { ...headers, Authorization: `Bearer ${auth.json.access_token}` };

  const dup = await server.request('POST', 'https://abcdefgh.supabase.co/rest/v1/sync_counts', {
    headers: authed,
    body: [
      { device_id: 'd1', epoch: 0, month: '2026-11', media_key: 'bili:BV1aaaaaaaaa:p1', n: 2 },
      { device_id: 'd1', epoch: 0, month: '2026-11', media_key: 'bili:BV1aaaaaaaaa:p1', n: 5 }
    ]
  });
  assert.equal(dup.status, 400);
  assert.equal(dup.json.code, '21000');

  const repo = new SupabaseSyncRepository({
    config: { url: 'https://abcdefgh.supabase.co', anonKey: KEY },
    request: server.request,
    now: () => server.now,
    session: { get: () => ({ accessToken: auth.json.access_token, refreshToken: auth.json.refresh_token, userId: auth.json.user.id, expiresAt: server.now + 3600000 }), set() {} }
  });
  await repo.PushCounts('d1', [
    { epoch: 0, month: '2026-11', key: 'bili:BV1aaaaaaaaa:p1', n: 2 },
    { epoch: 0, month: '2026-11', key: 'bili:BV1aaaaaaaaa:p1', n: 5 }
  ]);
  const pulled = await repo.PullCounts(0, 'd2');
  assert.equal(pulled.rows.length, 1);
  assert.equal(pulled.rows[0].n, 5);

  await repo.PutHistoryState({ clearedAt: server.now + 10_000_000 });
  const hState = await repo.GetHistoryState();
  assert.equal(hState.clearedAt, server.now + 599000);
});

test('SyncService SuppressChanged resets cleanly and ResetLink defers during active Cycle', async t => {
  const server = FakeServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-sync-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data'), syncDir = path.join(data, 'sync');
  fs.mkdirSync(data, { recursive: true });
  let service;
  const store = new Store(data, { committed: () => service?.Changed() });
  const adapter = StoreAdapter(store, { validateLibrary: input => ValidateLibrary(input), mediaKey: LibraryMediaKey });
  let resetExtrasCount = 0;
  const statuses = [];
  service = new SyncService({
    directory: syncDir, adapter, vault: new Storage.SessionVault(syncDir, FakeSafe()),
    request: server.request, now: () => server.now, timers: { set: () => ({ unref() {} }), clear() {} },
    onStatus: s => statuses.push(s.state)
  });
  service.onResetExtras = () => { resetExtrasCount++; };

  assert.throws(() => service.SuppressChanged(() => { throw new Error('boom'); }), /boom/);
  assert.equal(service.suppressChanged, false, '例外発生時も suppressChanged が戻る');

  service.Configure({ url: 'https://abcdefgh.supabase.co', anonKey: KEY });
  await service.SendCode('me@example.com');
  await service.VerifyCode('me@example.com', '123456');
  service.Start();
  assert.equal((await service.Enable()).ok, true);

  let releasePull;
  const pullStarted = new Promise(resolve => {
    const orig = server.request;
    server.request = async (...args) => {
      if (String(args[1]).includes('/rest/v1/sync_changes') && args[0] === 'GET') {
        resolve();
        await new Promise(done => { releasePull = done; });
      }
      return orig(...args);
    };
    service.request = server.request;
  });

  const cyclePromise = service.SyncNow();
  await pullStarted;
  service.ResetLink();
  assert.equal(resetExtrasCount, 0, 'Cycle 実行中は ResetLink を完了させず pendingReset に留める');
  assert.equal(service.pendingReset, true);
  releasePull();

  const cycleResult = await cyclePromise;
  assert.equal(cycleResult.ok, false);
  assert.match(cycleResult.error, /中断/);
  assert.equal(resetExtrasCount, 1, 'Cycle 終了後に _FinishReset と onResetExtras が走る');
  assert.equal(service.pendingReset, false);
  assert.equal(service.device, null);
  assert.equal(statuses.at(-1), 'off');
});

test('PC 3-dot transport menu, longer volume bar, modal epoch, bulk copy cancel, and CSS/source invariants', async t => {
  const html = read('src/ui/index.html');
  assert.match(html, /class="transport-more-wrap"[\s\S]*id="transport-more"[\s\S]*id="transport-menu"[\s\S]*id="sleep"[\s\S]*id="speed"[\s\S]*id="stop"[\s\S]*icons\.svg#stop/);

  const css = read('src/ui/style.css');
  assert.match(css, /grid-template-columns:[\s\S]*?236px;/);
  assert.match(css, /\.transport-volume input\s*\{\s*width:\s*150px;/);
  assert.match(css, /\.transport-menu\s*\{/);
  for (const cssFile of ['src/ui/style.css', 'src/ui/browse.css', 'src/ui/mini.css']) {
    assert.doesNotMatch(read(cssFile), /:favecus-visible/, `${cssFile} に typo がない`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-ui-more-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir), firstList = store.data.activePlaylistId;
  store.Apply({ type: 'add', playlistId: firstList, urls: 'av100\nav101' });
  store.Apply({ type: 'create', name: 'コピー先' });
  store.Apply({ type: 'select', playlistId: firstList });

  const nodes = new Map();
  const docListeners = {};
  const winListeners = {};
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
    before(node) { if (node.id) nodes.set(node.id, node); if (this.parentElement) { const i = this.parentElement.children.indexOf(this); node.parentElement = this.parentElement; this.parentElement.children.splice(Math.max(0, i), 0, node); } }
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

  const boundsLog = [];
  const commands = [];
  const documentObj = {
    body: new Node('body'),
    getElementById: id => nodes.get(id),
    createElement: tag => new Node(tag),
    querySelectorAll: () => [],
    addEventListener: (name, fn) => { (docListeners[name] ||= []).push(fn); }
  };
  const api = {
    state: async () => ({
      state: store.Snapshot(),
      current: { entryId: store.data.playlists[0].entries[0].id, playlistId: firstList, entry: store.data.playlists[0].entries[0] },
      playback: { title: 'テスト曲', duration: 120, position: 10, paused: false },
      statuses: {}, foreground: true, accounts: {}, version: '0.7.5', platform: 'win32',
      speed: 1.5, sleep: { mode: 'song' }, listViews: { [firstList]: { sort: 'count-desc', favorite: 'any', played: 'any' } }
    }),
    accounts: async () => ({}),
    onEvent() {},
    bounds: b => boundsLog.push(b),
    action: async a => store.Apply(a),
    command: async cmd => commands.push(cmd),
    listStats: async () => ({}),
    speed: async v => v,
    sleepTimer: async cmd => cmd.song ? { mode: 'song' } : { mode: 'off' }
  };
  const ctx = {
    document: documentObj,
    window: {
      addEventListener: (name, fn) => { (winListeners[name] ||= []).push(fn); },
      favecusApp: api,
      FavecusTransport: require('../src/ui/transport-model.js'),
      FavecusEntryView: require('../src/ui/entry-view.js')
    },
    requestAnimationFrame() {}, IntersectionObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} },
    setTimeout() { return 1; }, clearTimeout() {}, console: { error() {} }
  };
  vm.createContext(ctx);
  for (const file of ['library-tree.js', 'home-view.js', 'library-search.js', 'tree-view.js', 'parent-picker.js', 'playlist-reader.js', 'keybindings.js', 'queue-drag.js']) {
    vm.runInContext(read(`src/ui/${file}`).replace('})(globalThis)', '})(window)'), ctx);
  }
  for (const script of appScripts()) vm.runInContext(script, ctx);
  await new Promise(setImmediate);

  assert.equal(nodes.get('speed').textContent, '再生速度：1.5x');
  assert.equal(nodes.get('sleep').textContent, '☾ おやすみ：この曲の終わりまで');
  assert.equal(nodes.get('transport-more').classList.contains('enabled'), true);
  assert.equal(nodes.get('transport-menu').classList.contains('hidden'), true);

  nodes.get('transport-more').onclick();
  assert.equal(vm.runInContext('transportMenuOpen', ctx), true);
  assert.equal(nodes.get('transport-menu').classList.contains('hidden'), false);
  assert.equal(nodes.get('transport-more').getAttribute('aria-expanded'), 'true');
  assert.equal(boundsLog.at(-1).visible, false, 'メニュー展開中は BrowserView を非表示にする');

  // メニュー内の別領域クリックは閉じない、外側クリックで閉じる
  for (const fn of docListeners.pointerdown || []) fn({ target: nodes.get('transport-menu') });
  assert.equal(vm.runInContext('transportMenuOpen', ctx), true);
  for (const fn of docListeners.pointerdown || []) fn({ target: documentObj.body });
  assert.equal(vm.runInContext('transportMenuOpen', ctx), false);
  assert.equal(nodes.get('transport-menu').classList.contains('hidden'), true);

  // Stop 押下でメニューが閉じて stop コマンドが呼ばれる
  nodes.get('transport-more').onclick();
  await nodes.get('stop').onclick();
  assert.equal(vm.runInContext('transportMenuOpen', ctx), false);
  assert.deepEqual(commands, ['stop']);

  // CloseModal で modal.close() と close イベントが連鎖しても modalEpoch が1回だけ増える
  vm.runInContext("OpenModal('テスト', '<p>hi</p>')", ctx);
  const beforeCloseEpoch = vm.runInContext('modalEpoch', ctx);
  vm.runInContext('CloseModal()', ctx);
  assert.equal(vm.runInContext('modalEpoch', ctx), beforeCloseEpoch + 1);

  // ListView が有効なリストでは手動並べ替えハンドル (.entry-number) が無効になる
  const handles = nodes.get('entries').querySelectorAll('.entry-number');
  assert.ok(handles.length > 0);
  assert.equal(handles.every(h => h.disabled === true), true);

  // BulkTransfer('copy') で重複確認がキャンセル (result === false) されたときは選択を保持する
  const entryId = store.data.playlists[0].entries[0].id;
  vm.runInContext(`SetSelectionMode(true); selectedEntries.set('${entryId}', { playlistId: '${firstList}', entryId: '${entryId}' }); AddSelected = async () => false; BulkTransfer('copy');`, ctx);
  const destCheckbox = nodes.get('modal-body').querySelectorAll('input').find(i => i.type === 'checkbox' && !i.disabled);
  assert.ok(destCheckbox);
  destCheckbox.checked = true;
  await vm.runInContext('submitModal()', ctx);
  assert.equal(vm.runInContext('selectedEntries.size', ctx), 1, '追加キャンセル時は選択を残す');
});
