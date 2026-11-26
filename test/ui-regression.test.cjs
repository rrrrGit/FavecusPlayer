'use strict';
// PC UI 回帰テスト（通知レイアウト・3点メニュー・複数選択・モーダルガード・CSP/CSS不変条件）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { readMain, readApp, appScripts } = require('./support-source.cjs');
const { Store } = require('../src/core/store.cjs');
const { QueueFollower } = require('../src/ui/queue-follow.js');
const { ListArtwork } = require('../src/ui/list-artwork.js');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function createUiHarness(t, apiOverrides = {}, stateOverrides = {}) {
  const html = read('src/ui/index.html');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-ui-reg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir), firstList = store.data.activePlaylistId;
  store.Apply({ type: 'add', playlistId: firstList, urls: 'av100\nav101' });
  store.Apply({ type: 'create', name: '移動先' });
  const secondList = store.data.activePlaylistId;
  store.Apply({ type: 'select', playlistId: firstList });

  const nodes = new Map(), docListeners = {}, winListeners = {}, errors = [];
  class Node {
    constructor(tag = 'div') {
      this.tagName = tag; this.children = []; this.events = {}; this.dataset = {}; this.style = { setProperty() {} };
      this.scrollTop = 0; this.checked = false; this.disabled = false; this.open = false; this.clientHeight = 300; this.classes = new Set();
      this.classList = {
        add: (...v) => v.forEach(x => this.classes.add(x)),
        remove: (...v) => v.forEach(x => this.classes.delete(x)),
        contains: x => this.classes.has(x),
        toggle: (x, f) => { if (f ?? !this.classes.has(x)) this.classes.add(x); else this.classes.delete(x); },
      };
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
    querySelectorAll(sel) {
      const all = this.children.flatMap(c => [c, ...c.querySelectorAll('*')]);
      return sel === '*' ? all : all.filter(n => sel.startsWith('.') ? n.classList.contains(sel.slice(1)) : n.tagName === sel);
    }
    querySelector(sel) { return sel === 'use' ? { setAttribute() {} } : this.querySelectorAll(sel)[0]; }
    set innerHTML(htmlStr) {
      this.children = [];
      for (const m of htmlStr.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)) {
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
  const origBefore = nodes.get('entries').before.bind(nodes.get('entries'));
  nodes.get('entries').before = n => { if (n.id) nodes.set(n.id, n); origBefore(n); };

  const documentObj = {
    body: new Node('body'),
    getElementById: id => nodes.get(id),
    createElement: tag => new Node(tag),
    createDocumentFragment: () => new Node('fragment'),
    querySelectorAll: () => [],
    addEventListener: (name, fn) => { (docListeners[name] ||= []).push(fn); },
  };
  const api = {
    state: async () => ({
      state: store.Snapshot(), current: null, playback: null, statuses: {}, foreground: true, accounts: {}, version: '0.7.5', platform: 'win32',
      ...stateOverrides,
    }),
    accounts: async () => ({}),
    onEvent() {},
    bounds() {},
    action: async a => store.Apply(a),
    listStats: async () => ({}),
    ...apiOverrides,
  };
  const ctx = {
    document: documentObj,
    window: {
      addEventListener: (name, fn) => { (winListeners[name] ||= []).push(fn); },
      favecusApp: api,
      FavecusQueueFollow: { QueueFollower },
      FavecusListArtwork: { ListArtwork },
      FavecusTransport: require('../src/ui/transport-model.js'),
      FavecusEntryView: require('../src/ui/entry-view.js'),
    },
    requestAnimationFrame() {},
    IntersectionObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} },
    setTimeout() { return 1; },
    clearTimeout() {},
    console: { error: e => errors.push(e) },
  };
  vm.createContext(ctx);
  for (const file of ['library-tree.js', 'home-view.js', 'library-search.js', 'tree-view.js', 'parent-picker.js', 'playlist-reader.js', 'keybindings.js', 'queue-drag.js']) {
    vm.runInContext(read(`src/ui/${file}`).replace('})(globalThis)', '})(window)'), ctx);
  }
  for (const script of appScripts()) vm.runInContext(script, ctx);
  return { store, firstList, secondList, nodes, docListeners, documentObj, ctx, errors };
}

test('PC UI/main static invariants: CSP no inline style, Settings back wiring, CSS layout, and filtered resume/favorites emits', () => {
  const insights = read('src/ui/app/05-insights.js');
  assert.doesNotMatch(insights, /\bstyle\s*=/i);
  assert.match(insights, /OpenModal\('自動リスト',[\s\S]*?,\s*'保存する',\s*Settings\)/);
  assert.match(insights, /OpenModal\('再生統計',[\s\S]*?,\s*null,\s*'保存',\s*Settings\)/);
  assert.match(insights, /OpenModal\('ライブラリの点検',\s*'',\s*null,\s*'保存',\s*Settings\)/);
  assert.match(insights, /OpenModal\('出力デバイス',[\s\S]*?,\s*'保存する',\s*Settings\)/);

  const css = read('src/ui/style.css');
  assert.match(css, /grid-template-columns:[\s\S]*?236px;/);
  assert.match(css, /\.transport-volume input\s*\{\s*width:\s*150px;/);
  assert.match(css, /\.transport-menu\s*\{/);
  for (const cssFile of ['src/ui/style.css', 'src/ui/browse.css', 'src/ui/mini.css']) {
    assert.doesNotMatch(read(cssFile), /:favecus-visible/);
  }

  const main = readMain();
  assert.match(main, /function ResumeOffer\(\)[\s\S]*?ArrangedEntries\(saved\.scope\)/);
  assert.match(main, /function MiniState\(\)[\s\S]*?ArrangedEntries\(list\.id\)\.length/);
  assert.match(main, /if \(command === 'toggle' && !current\)[\s\S]*?ArrangedEntries\(list\.id\)\.length/);
  assert.match(main, /function SyncPlayingQueue\(notify = true\)[\s\S]*?Emit\('queue', QueueState\(\)\)/);
  assert.match(main, /onApplied:[\s\S]*?Emit\('favorites', FavoriteIds\(\)\)/);
  assert.match(main, /function RememberVideo[\s\S]*?Emit\('favorites', FavoriteIds\(\)\)/);
  assert.match(main, /Handle\('library:favorite-many',[\s\S]*?S\.favorites\.SetMany\(/);
  assert.match(main, /Handle\('trash:restore',[\s\S]*?Emit\('favorites', FavoriteIds\(\)\)/);
});

test('PC UI bulk selection resets on navigation, StatsSettings renders bars via style.width, and modal guards prevent stale renders', async t => {
  let resolveSyncStatus;
  const syncStatusPromise = new Promise(r => { resolveSyncStatus = r; });
  const h = createUiHarness(t, {
    stats: async () => ({ total: 3, totalSeconds: 90, months: [{ month: '2026-10', plays: 1, seconds: 30 }, { month: '2026-11', plays: 2, seconds: 60 }], thisMonthTop: [], top: [] }),
    sync: async cmd => cmd.action === 'status' ? syncStatusPromise : {},
    resolveURL: async () => ({ kind: 'playlist', sources: [{ kind: 'parts', url: 'https://www.bilibili.com/video/BV1x/', title: 'テスト' }] }),
  });
  await new Promise(setImmediate);

  vm.runInContext('SetSelectionMode(true); BulkSelectAll();', h.ctx);
  assert.equal(vm.runInContext('selectionMode', h.ctx), true);
  assert.equal(vm.runInContext('selectedEntries.size', h.ctx), 2);
  await vm.runInContext(`Action({ type: 'select', playlistId: '${h.secondList}' })`, h.ctx);
  assert.equal(vm.runInContext('selectionMode', h.ctx), false);
  assert.equal(vm.runInContext('selectedEntries.size', h.ctx), 0);
  assert.equal(h.nodes.get('bulk-bar').classList.contains('hidden'), true);

  vm.runInContext('SetSelectionMode(true); BulkSelectAll(); allListsView = true; Render();', h.ctx);
  assert.equal(vm.runInContext('selectionMode', h.ctx), false);
  assert.equal(vm.runInContext('selectedEntries.size', h.ctx), 0);

  vm.runInContext('StatsSettings()', h.ctx);
  await new Promise(setImmediate);
  assert.deepEqual(h.nodes.get('modal-body').querySelectorAll('i').map(n => n.style.width), ['50%', '100%', '50%', '100%']);
  assert.equal(h.nodes.get('modal-back').classList.contains('hidden'), false);

  vm.runInContext('SyncSettings()', h.ctx);
  vm.runInContext("OpenModal('別の設定', '<p>other</p>')", h.ctx);
  resolveSyncStatus({ enabled: false, configured: false, signedIn: false, email: 'a@b.c', url: 'https://x.supabase.co' });
  await new Promise(setImmediate);
  assert.equal(h.nodes.get('toast').classList.contains('hidden'), true);
  assert.equal(h.errors.length, 0);

  vm.runInContext('AddURL()', h.ctx);
  const check = h.nodes.get('modal-body').querySelectorAll('input').find(i => i.type === 'checkbox');
  assert.ok(check);
  check.checked = false;
  check.onchange?.();
  h.nodes.get('url-input').value = 'https://www.bilibili.com/video/BV1x/?p=1';
  await h.nodes.get('url-load').onclick();
  assert.equal(h.nodes.get('modal-title').textContent, '再生リストURLから追加');
});

test('PC UI 3-dot transport menu, modalEpoch, ListView handle disable, and BulkTransfer copy cancel', async t => {
  const boundsLog = [], commands = [];
  const h = createUiHarness(t, {
    bounds: b => boundsLog.push(b),
    command: async cmd => commands.push(cmd),
    speed: async v => v,
    sleepTimer: async cmd => cmd.song ? { mode: 'song' } : { mode: 'off' },
  }, {
    speed: 1.5,
    sleep: { mode: 'song' },
  });
  // Configure state override with firstList view and current entry
  const origState = h.ctx.window.favecusApp.state;
  const firstEntry = h.store.data.playlists[0].entries[0];
  h.ctx.window.favecusApp.state = async () => ({
    ...(await origState()),
    current: { entryId: firstEntry.id, playlistId: h.firstList, entry: firstEntry },
    playback: { title: 'テスト曲', duration: 120, position: 10, paused: false },
    listViews: { [h.firstList]: { sort: 'count-desc', favorite: 'any', played: 'any' } },
  });
  // Re-run Init so state override applies cleanly
  const h2 = createUiHarness(t, {
    bounds: b => boundsLog.push(b),
    command: async cmd => commands.push(cmd),
    speed: async v => v,
    sleepTimer: async cmd => cmd.song ? { mode: 'song' } : { mode: 'off' },
    state: async () => ({
      state: h.store.Snapshot(),
      current: { entryId: firstEntry.id, playlistId: h.firstList, entry: firstEntry },
      playback: { title: 'テスト曲', duration: 120, position: 10, paused: false },
      statuses: {}, foreground: true, accounts: {}, version: '0.7.5', platform: 'win32',
      speed: 1.5, sleep: { mode: 'song' }, listViews: { [h.firstList]: { sort: 'count-desc', favorite: 'any', played: 'any' } },
    }),
  });
  await new Promise(setImmediate);

  assert.equal(h2.nodes.get('speed').textContent, '再生速度：1.5x');
  assert.equal(h2.nodes.get('sleep').textContent, '☾ おやすみ：この曲の終わりまで');
  assert.equal(h2.nodes.get('transport-more').classList.contains('enabled'), true);
  assert.equal(h2.nodes.get('transport-menu').classList.contains('hidden'), true);

  h2.nodes.get('transport-more').onclick();
  assert.equal(vm.runInContext('transportMenuOpen', h2.ctx), true);
  assert.equal(h2.nodes.get('transport-menu').classList.contains('hidden'), false);
  assert.equal(h2.nodes.get('transport-more').getAttribute('aria-expanded'), 'true');
  assert.equal(boundsLog.at(-1).visible, false);

  for (const fn of h2.docListeners.pointerdown || []) fn({ target: h2.nodes.get('transport-menu') });
  assert.equal(vm.runInContext('transportMenuOpen', h2.ctx), true);
  for (const fn of h2.docListeners.pointerdown || []) fn({ target: h2.documentObj.body });
  assert.equal(vm.runInContext('transportMenuOpen', h2.ctx), false);
  assert.equal(h2.nodes.get('transport-menu').classList.contains('hidden'), true);

  h2.nodes.get('transport-more').onclick();
  await h2.nodes.get('stop').onclick();
  assert.equal(vm.runInContext('transportMenuOpen', h2.ctx), false);
  assert.deepEqual(commands, ['stop']);

  vm.runInContext("OpenModal('テスト', '<p>hi</p>')", h2.ctx);
  const beforeCloseEpoch = vm.runInContext('modalEpoch', h2.ctx);
  vm.runInContext('CloseModal()', h2.ctx);
  assert.equal(vm.runInContext('modalEpoch', h2.ctx), beforeCloseEpoch + 1);

  const handles = h2.nodes.get('entries').querySelectorAll('.entry-number');
  assert.ok(handles.length > 0);
  assert.equal(handles.every(node => node.disabled === true), true);

  vm.runInContext(`SetSelectionMode(true); selectedEntries.set('${firstEntry.id}', { playlistId: '${h.firstList}', entryId: '${firstEntry.id}' }); AddSelected = async () => false; BulkTransfer('copy');`, h2.ctx);
  const destCheckbox = h2.nodes.get('modal-body').querySelectorAll('input').find(i => i.type === 'checkbox' && !i.disabled);
  assert.ok(destCheckbox);
  destCheckbox.checked = true;
  await vm.runInContext('submitModal()', h2.ctx);
  assert.equal(vm.runInContext('selectedEntries.size', h2.ctx), 1);
});

test('notice appearance and dismissal update video bounds, stack up to 3 lines, and replace the timeout', () => {
  const renderer = readApp();
  const fnSource = name => {
    const start = renderer.indexOf(`function ${name}(`);
    assert.ok(start >= 0);
    return renderer.slice(start, renderer.indexOf('\n}', start) + 2);
  };
  const hidden = new Set(['hidden']), sent = [], timers = new Map();
  let nextTimer = 0;
  const elements = {
    modal: { open: false },
    toast: { textContent: '', classList: { add: x => hidden.add(x), remove: x => hidden.delete(x) } },
    'player-slot': { getBoundingClientRect: () => ({ x: 100, y: 120, width: 500, height: hidden.has('hidden') ? 400 : 320 }) },
  };
  const context = {
    Date, $: id => elements[id], api: { bounds: b => sent.push(b) },
    HasView: () => true, allListsView: false, transportMenuOpen: false, state: { settings: { thumbnailMode: false } },
    clearTimeout: id => timers.delete(id),
    setTimeout: (callback, delay) => { assert.equal(delay, 7000); const id = ++nextTimer; timers.set(id, callback); return id; },
  };
  vm.createContext(context);
  vm.runInContext(`let toastTimer; const toastLog = []; ${fnSource('SendBounds')} ${fnSource('Toast')}`, context);
  vm.runInContext('SendBounds()', context);
  assert.equal(sent.at(-1).height, 400);
  context.message = '外部ページは上部の「ブラウザーで開く」から開けます。';
  vm.runInContext('Toast(message)', context);
  assert.equal(sent.at(-1).height, 320);
  assert.equal(sent.at(-1).visible, true);
  assert.equal(elements.toast.textContent, context.message);
  const first = context.message;
  context.message = '新しい案内 中文 <img src=x>';
  vm.runInContext('Toast(message)', context);
  assert.equal(timers.size, 1);
  assert.equal(elements.toast.textContent, `${first}\n${context.message}`);
  vm.runInContext('Toast(message)', context);
  assert.equal(elements.toast.textContent, `${first}\n${context.message}`);
  for (const extra of ['3件目', '4件目']) { context.message = extra; vm.runInContext('Toast(message)', context); }
  assert.equal(elements.toast.textContent.split('\n').length, 3);
  assert.ok(elements.toast.textContent.endsWith('4件目'));
  [...timers.values()][0]();
  assert.equal(sent.at(-1).height, 400);
  assert.ok(hidden.has('hidden'));
  context.state.settings.thumbnailMode = true; vm.runInContext('Toast(message)', context); assert.equal(sent.at(-1).visible, false);
  context.state.settings.thumbnailMode = false; context.allListsView = true; vm.runInContext('Toast(message)', context); assert.equal(sent.at(-1).visible, false);
  context.allListsView = false; context.transportMenuOpen = true; vm.runInContext('Toast(message)', context); assert.equal(sent.at(-1).visible, false);
  context.transportMenuOpen = false; context.api = undefined; vm.runInContext('Toast(message)', context);
});
