'use strict';
// v0.7.5 不具合修正（新機能追加を除く既存問題点の是正）の回帰テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { readMain, readApp, appScripts } = require('./support-source.cjs');
const { FavoriteStore } = require('../src/core/favorites.cjs');
const { PlayTimeStore } = require('../src/core/play-time-store.cjs');
const { Store } = require('../src/core/store.cjs');
const { FakeServer, jwt } = require('./fake-supabase.cjs');
const { QueueFollower } = require('../src/ui/queue-follow.js');
const { ListArtwork } = require('../src/ui/list-artwork.js');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('05-insights uses no inline style attribute and wires back = Settings on all 4 modals', () => {
  const insights = read('src/ui/app/05-insights.js');
  assert.doesNotMatch(insights, /\bstyle\s*=/i, 'CSP style-src self 準拠のため inline style 属性を使わない');
  assert.match(insights, /OpenModal\('自動リスト',[\s\S]*?,\s*'保存する',\s*Settings\)/);
  assert.match(insights, /OpenModal\('再生統計',[\s\S]*?,\s*null,\s*'保存',\s*Settings\)/);
  assert.match(insights, /OpenModal\('ライブラリの点検',\s*'',\s*null,\s*'保存',\s*Settings\)/);
  assert.match(insights, /OpenModal\('出力デバイス',[\s\S]*?,\s*'保存する',\s*Settings\)/);
});

test('FavoriteStore.SetMany validates all keys atomically, rolls back on error or save failure, and notifies once', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-favmany-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'favorites.json');
  const store = new FavoriteStore(file, { now: () => 1000 });
  const events = [];
  store.onChange = info => events.push(info);

  const ok = store.SetMany(['bili:BV1aaaaaaaaa:p1', 'bili:BV1bbbbbbbbb:p1', 'local:track.mp3'], true);
  assert.deepEqual(ok, { fav: true, changed: 3 });
  assert.equal(events.length, 1, '複数曲の一括更新でも通知は1回');
  assert.equal(events[0].syncable, true);
  assert.deepEqual(new FavoriteStore(file).List().sort(), ['bili:BV1aaaaaaaaa:p1', 'bili:BV1bbbbbbbbb:p1', 'local:track.mp3']);

  assert.throws(
    () => store.SetMany(['bili:BV1ccccccccc:p1', 'invalid key with spaces'], true),
    /お気に入りにできません/
  );
  assert.equal(store.Has('bili:BV1ccccccccc:p1'), false, '途中で不正キーがあれば手前の変更もロールバックする');
  assert.equal(new FavoriteStore(file).Has('bili:BV1ccccccccc:p1'), false);
  assert.equal(events.length, 1);

  store.Save = () => false;
  assert.throws(
    () => store.SetMany(['bili:BV1ddddddddd:p1'], true),
    /保存できませんでした/
  );
  assert.equal(store.Has('bili:BV1ddddddddd:p1'), false, '保存失敗時は状態もロールバックする');
  assert.equal(events.length, 1);
});

test('PlayTimeStore.Flush keeps dirty = true when atomic write fails and clears it after recovery', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-pt-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'play-time.json');
  let nowMs = Date.UTC(2026, 10, 22, 12, 0, 0);
  const store = new PlayTimeStore(target, () => nowMs);
  store.Begin();
  store.Observe({ position: 0, paused: false, playbackRate: 1 });
  nowMs += 1000;
  store.Observe({ position: 1, paused: false, playbackRate: 1 }); // 初回 flush 済みにし lastFlush を nowMs にする
  assert.equal(store.dirty, false);

  // FLUSH_INTERVAL_MS (10秒) 未満の加算なので自動 Flush されず dirty = true になる
  nowMs += 4000;
  store.Observe({ position: 5, paused: false, playbackRate: 1 });
  assert.equal(store.dirty, true);

  // 保存先パスにディレクトリを置いて WriteJsonAtomic の rename を失敗させる
  fs.rmSync(target, { force: true });
  fs.mkdirSync(target, { recursive: true });
  assert.equal(store.Flush(), false);
  assert.equal(store.dirty, true, '書き込み失敗時は dirty を残す');

  fs.rmdirSync(target);
  assert.equal(store.Flush(), true);
  assert.equal(store.dirty, false);
  assert.equal(new PlayTimeStore(target, () => nowMs).Stats({ months: 1 }).totalSeconds, 5);
});

test('fake-supabase skips no-op sync_counts updates without incrementing countsSeq', async () => {
  const server = FakeServer();
  const headers = { apikey: 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url') + '.signature-signature' };
  await server.request('POST', 'https://abcdefgh.supabase.co/auth/v1/otp', { headers, body: { email: 'a@example.com' } });
  const auth = await server.request('POST', 'https://abcdefgh.supabase.co/auth/v1/verify', { headers, body: { email: 'a@example.com', token: '123456' } });
  const authedHeaders = { ...headers, Authorization: `Bearer ${auth.json.access_token}` };

  const row = { device_id: 'dev1', epoch: 0, month: '2026-11', media_key: 'bili:BV1aaaaaaaaa:p1', n: 3 };
  await server.request('POST', 'https://abcdefgh.supabase.co/rest/v1/sync_counts', { headers: authedHeaders, body: [row] });
  assert.equal(server.countsSeq, 1);

  // 同じ n=3 または小さい n=2 の再送では countsSeq が増えない
  await server.request('POST', 'https://abcdefgh.supabase.co/rest/v1/sync_counts', { headers: authedHeaders, body: [row, { ...row, n: 2 }] });
  assert.equal(server.countsSeq, 1);

  // n=4 に増えた場合だけ countsSeq が進む
  await server.request('POST', 'https://abcdefgh.supabase.co/rest/v1/sync_counts', { headers: authedHeaders, body: [{ ...row, n: 4 }] });
  assert.equal(server.countsSeq, 2);
});

test('docs/DEVELOPMENT-STATUS.md contains no NUL bytes', () => {
  const buf = fs.readFileSync(path.join(root, 'docs/DEVELOPMENT-STATUS.md'));
  assert.equal(buf.includes(0), false);
});

test('PC main/UI wiring covers filtered resume/toggle guards, queue/favorites emit, and bulk selection reset', async t => {
  const main = readMain();
  assert.match(main, /function ResumeOffer\(\)[\s\S]*?ArrangedEntries\(saved\.scope\)/);
  assert.match(main, /function MiniState\(\)[\s\S]*?ArrangedEntries\(list\.id\)\.length/);
  assert.match(main, /if \(command === 'toggle' && !current\)[\s\S]*?ArrangedEntries\(list\.id\)\.length/);
  assert.match(main, /function SyncPlayingQueue\(\)[\s\S]*?Emit\('queue', QueueState\(\)\)/);
  assert.match(main, /onApplied:[\s\S]*?Emit\('favorites', FavoriteIds\(\)\)/);
  assert.match(main, /function RememberVideo[\s\S]*?Emit\('favorites', FavoriteIds\(\)\)/);
  assert.match(main, /Handle\('library:favorite-many',[\s\S]*?S\.favorites\.SetMany\(/);
  assert.match(main, /Handle\('trash:restore',[\s\S]*?Emit\('favorites', FavoriteIds\(\)\)/);

  // 複数選択モードが別プレイリスト移動やホーム表示で自動解除されることを UI 実スクリプトで確認する
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-ui-bulk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir), firstList = store.data.activePlaylistId;
  store.Apply({ type: 'add', playlistId: firstList, urls: 'av100\nav101' });
  store.Apply({ type: 'create', name: '移動先' });
  const secondList = store.data.activePlaylistId;
  store.Apply({ type: 'select', playlistId: firstList });

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
    addEventListener(name, fn) { this.events[name] = fn; }
    querySelectorAll(sel) { const all = this.children.flatMap(c => [c, ...c.querySelectorAll('*')]); return sel === '*' ? all : all.filter(n => sel.startsWith('.') ? n.classList.contains(sel.slice(1)) : n.tagName === sel); }
    querySelector(sel) { return sel === 'use' ? { setAttribute() {} } : this.querySelectorAll(sel)[0]; }
    set innerHTML(html) {
      this.children = [];
      for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)) {
        const id = m[2].match(/\bid="([^"]+)"/)?.[1];
        const pct = m[2].match(/\bdata-pct="([^"]+)"/)?.[1];
        if (!id && pct === undefined) continue;
        const n = new Node(m[1]);
        if (id) n.id = id;
        if (pct !== undefined) n.dataset.pct = pct;
        this.append(n);
      }
    }
    get offsetHeight() { return 60; }
    getBoundingClientRect() { return { top: 0, y: 0, x: 0, left: 0, right: 500, bottom: 300, width: 500, height: 300 }; }
    scrollTo() {}
    contains(n) { return n === this || this.children.some(c => c.contains(n)); }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const html = read('src/ui/index.html');
  for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const n = new Node(m[1]); n.id = m[2]; nodes.set(n.id, n);
  }
  const mainNode = new Node('main');
  mainNode.append(nodes.get('entries'));
  const document = { body: new Node('body'), getElementById: id => nodes.get(id), createElement: tag => new Node(tag), querySelectorAll: () => [], addEventListener() {} };
  const api = {
    state: async () => ({ state: store.Snapshot(), current: null, playback: null, statuses: {}, foreground: true, accounts: {}, version: '0.7.4', platform: 'win32' }),
    accounts: async () => ({}), onEvent() {}, bounds() {}, action: async a => store.Apply(a),
    stats: async () => ({ total: 3, totalSeconds: 90, months: [{ month: '2026-10', plays: 1, seconds: 30 }, { month: '2026-11', plays: 2, seconds: 60 }], thisMonthTop: [], top: [] })
  };
  const ctx = {
    document,
    window: { addEventListener() {}, favecusApp: api, FavecusQueueFollow: { QueueFollower }, FavecusListArtwork: { ListArtwork }, FavecusTransport: require('../src/ui/transport-model.js') },
    requestAnimationFrame() {}, IntersectionObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} },
    setTimeout() { return 1; }, clearTimeout() {}, console: { error() {} }
  };
  const origBefore = nodes.get('entries').before.bind(nodes.get('entries'));
  nodes.get('entries').before = n => { if (n.id) nodes.set(n.id, n); origBefore(n); };

  vm.createContext(ctx);
  for (const file of ['library-tree.js', 'home-view.js', 'library-search.js', 'tree-view.js', 'parent-picker.js', 'playlist-reader.js', 'keybindings.js', 'queue-drag.js']) {
    vm.runInContext(read(`src/ui/${file}`).replace('})(globalThis)', '})(window)'), ctx);
  }
  for (const script of appScripts()) vm.runInContext(script, ctx);
  await new Promise(setImmediate);

  vm.runInContext('SetSelectionMode(true); BulkSelectAll();', ctx);
  assert.equal(vm.runInContext('selectionMode', ctx), true);
  assert.equal(vm.runInContext('selectedEntries.size', ctx), 2);

  await vm.runInContext(`Action({ type: 'select', playlistId: '${secondList}' })`, ctx);
  assert.equal(vm.runInContext('selectionMode', ctx), false, '別プレイリストへ切り替えると複数選択モードが解除される');
  assert.equal(vm.runInContext('selectedEntries.size', ctx), 0);
  assert.equal(nodes.get('bulk-bar').classList.contains('hidden'), true);

  vm.runInContext('SetSelectionMode(true); BulkSelectAll(); allListsView = true; Render();', ctx);
  assert.equal(vm.runInContext('selectionMode', ctx), false, 'ホームへ移動すると複数選択モードが解除される');
  assert.equal(vm.runInContext('selectedEntries.size', ctx), 0);

  vm.runInContext('StatsSettings()', ctx);
  await new Promise(setImmediate);
  const widths = nodes.get('modal-body').querySelectorAll('i').map(n => n.style.width);
  assert.deepEqual(widths, ['50%', '100%', '50%', '100%'], '再生統計バーの幅が DOM style.width 経由で設定される');
  assert.equal(nodes.get('modal-back').classList.contains('hidden'), false, '再生統計モーダルに戻るボタンが表示される');
});
