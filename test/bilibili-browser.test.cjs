'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BilibiliBrowser, AllowedBrowseURL, SearchURL } = require('../src/core/bilibili-browser.cjs');
function Harness(t) {
  const windows = [], views = [], handlers = new Map(), additions = [];
  let loggedIn = true, detail = async () => ({ title: '全体', pages: [{ page: 1, part: '曲A' }, { page: 2, part: '曲B' }] });
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = { url: '' }; this.sent = []; this.title = '曲B - bilibili'; this.navigationHistory = { canGoBack: () => false, canGoForward: () => false }; }
    isDestroyed() { return !!this.closed; } close() { this.closed = true; } getURL() { return this.mainFrame.url; } getTitle() { return this.title; } isLoadingMainFrame() { return !!this.loading; }
    setAudioMuted(value) { this.muted = value; } setWindowOpenHandler(fn) { this.openHandler = fn; } send(type, value) { this.sent.push({ type, value }); }
    async loadURL(url) { this.loading = true; this.emit('did-start-navigation', { url, isMainFrame: true }); this.mainFrame.url = url; this.loading = false; this.emit('did-navigate'); this.emit('did-finish-load'); }
  }
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new Contents(); this.contentView = { addChildView() {} }; windows.push(this); }
    isDestroyed() { return !!this.closed; } getContentSize() { return [900, 600]; } isMaximized() { return !!this.maximized; } isMinimized() { return !!this.minimized; }
    maximize() { this.maximized = true; } unmaximize() { this.maximized = false; } minimize() { this.minimized = true; this.emit('minimize'); } restore() { this.minimized = false; }
    show() { this.visible = true; } hide() { this.visible = false; this.emit('hide'); } focus() { this.focused = true; }
    close() { if (!this.closed) { this.closed = true; this.emit('closed'); } } loadURL(url) { return this.webContents.loadURL(url); }
  }
  class View { constructor(options) { this.options = options; this.webContents = new Contents(); views.push(this); } setBounds(value) { this.bounds = value; } }
  const browser = new BilibiliBrowser({ BrowserWindow: Window, WebContentsView: View, ipcMain: { handle: (key, fn) => handlers.set(key, fn) } }, { profile: async () => ({ loggedIn }), details: id => detail(id), volume: () => .5, add: value => additions.push(value) });
  t.after(() => browser.Destroy());
  const invoke = async (channel, ...args) => { const wc = browser.window.webContents, result = await handlers.get(channel)({ sender: wc, senderFrame: wc.mainFrame }, ...args); if (!result.ok) throw new Error(result.error); return result.value; };
  return { browser, windows, views, handlers, additions, invoke, login: value => loggedIn = value, details: fn => detail = fn };
}
test('search uses the app-owned window, shared session and a separate trusted toolbar', async t => {
  const h = Harness(t); await h.browser.Open(); const view = h.views[0], window = h.windows[0];
  assert.equal(window.options.frame, false); assert.equal(window.webContents.getURL(), 'favecus://app/browse.html'); assert.equal(window.visible, true);
  assert.equal(view.options.webPreferences.partition, 'persist:favecus-bilibili'); assert.equal(view.options.webPreferences.nodeIntegration, false); assert.equal(view.options.webPreferences.sandbox, true);
  assert.deepEqual(view.bounds, { x: 0, y: 116, width: 900, height: 484 }); assert.equal(view.webContents.muted, true);
  await h.invoke('browse:command', 'search', 'ナツノヒ + 曲'); const url = new URL(view.webContents.getURL()); assert.equal(url.hostname, 'search.bilibili.com'); assert.equal(url.searchParams.get('keyword'), 'ナツノヒ + 曲');
  assert.equal((await h.invoke('browse:state')).canAdd, false);
  await h.browser.Open(); assert.equal(h.windows.length, 1);
  await h.invoke('browse:command', 'sound'); assert.equal(view.webContents.muted, false);
  await h.invoke('browse:command', 'minimize'); assert.equal(view.webContents.muted, true); assert.equal(window.minimized, true);
});
test('opening and adding require login, and the selected part is copied into the normal add draft', async t => {
  const h = Harness(t); h.login(false); await assert.rejects(h.browser.Open(), /ログイン/); assert.equal(h.windows.length, 0);
  h.login(true); await h.browser.Open(); await h.browser.Navigate('https://www.bilibili.com/video/av123/?p=2&share_source=x');
  assert.equal((await h.invoke('browse:state')).canAdd, true); await h.invoke('browse:add');
  assert.deepEqual(h.additions, [{ url: 'https://www.bilibili.com/video/av123/?p=2', title: '曲B', analyze: true }]);
  h.login(false); await assert.rejects(h.invoke('browse:add'), /ログイン/); assert.equal(h.additions.length, 1); assert.equal((await h.invoke('browse:state')).canAdd, false);
});
test('external popups, unsafe schemes and remote-frame IPC cannot access the add or window controls', async t => {
  const h = Harness(t); await h.browser.Open(); const wc = h.views[0].webContents, original = wc.getURL();
  for (const url of ['https://evil.test/', 'https://search.bilibili.com.evil.test/', 'file:///secret', 'https://user@www.bilibili.com/', 'https://search.bilibili.com:8443/']) {
    assert.equal(AllowedBrowseURL(url), false); assert.equal(wc.openHandler({ url }).action, 'deny'); assert.equal(wc.getURL(), original);
  }
  assert.equal(AllowedBrowseURL(SearchURL('日本語')), true); assert.throws(() => SearchURL(' '));
  const result = await h.handlers.get('browse:add')({ sender: wc, senderFrame: wc.mainFrame }); assert.equal(result.ok, false); assert.equal(h.additions.length, 0);
  let blocked = false; wc.emit('will-redirect', { url: 'https://evil.test/', preventDefault: () => blocked = true }); assert.equal(blocked, true);
  wc.openHandler({ url: 'https://www.bilibili.com/video/av123' }); await Promise.resolve(); assert.match(wc.getURL(), /av123/);
});
test('navigation or closing during metadata lookup cannot add a stale page, and closing releases the remote player', async t => {
  const h = Harness(t); await h.browser.Open(); await h.browser.Navigate('https://www.bilibili.com/video/av123/?p=2');
  let finish; h.details(() => new Promise(resolve => finish = resolve)); const pending = h.invoke('browse:add');
  await Promise.resolve(); await Promise.resolve(); await h.browser.Navigate('https://www.bilibili.com/video/av456/');
  finish({ title: '古い曲', pages: [] }); await assert.rejects(pending, /ページが変わりました/); assert.equal(h.additions.length, 0);
  const view = h.views[0]; h.browser.Close(); assert.equal(view.webContents.isDestroyed(), true); assert.equal(h.browser.window, null);
});

test('the existing browser add button accepts collection pages and passes them into the common resolver', async t => {
  const h = Harness(t); await h.browser.Open(); await h.views[0].webContents.loadURL('https://space.bilibili.com/23/favlist?fid=321');
  assert.equal(h.browser.State().canAdd, true); await h.invoke('browse:add');
  assert.equal(h.additions[0].url, 'https://space.bilibili.com/23/favlist?fid=321'); assert.equal(h.additions[0].analyze, true);
});

test('navigation blocks volume and pause IPC in the search player and restores the latest volume after loading', async t => {
  const h = Harness(t); await h.browser.Open(); const wc = h.views[0].webContents;
  const count = wc.sent.length;
  wc.loading = true; wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  h.browser.options.volume = () => .37;
  h.browser.SetVolume(.37); h.browser.Silence();
  assert.equal(wc.sent.length, count); assert.equal(wc.muted, true);
  wc.loading = false; wc.emit('did-finish-load');
  assert.equal(wc.sent.at(-1).value.value, .37); assert.equal(wc.muted, true);
  await h.invoke('browse:command', 'sound'); assert.equal(wc.muted, false);
});
