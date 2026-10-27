'use strict';
const path = require('node:path');
const { CollectionURL } = require('./bilibili.cjs');
const { ParseBilibili, IsAllowedRemote } = require('./urls.cjs');
const { MediaChannel } = require('./media-channel.cjs');
const HOME = 'https://www.bilibili.com/';
function AllowedBrowseURL(raw) {
  try {
    const url = new URL(raw);
    return IsAllowedRemote(raw, 'bilibili') || (url.protocol === 'https:' && url.hostname === 'search.bilibili.com' && !url.username && !url.password && !url.port);
  } catch { return false; }
}
function SearchURL(value) {
  const keyword = String(value || '').trim();
  if (!keyword || keyword.length > 200) throw new Error('検索する言葉を1〜200文字で入力してください。');
  const url = new URL('https://search.bilibili.com/all'); url.searchParams.set('keyword', keyword); return url.href;
}
class BilibiliBrowser {
  constructor(electron, options) {
    this.electron = electron; this.options = options; this.window = null; this.view = null; this.disposed = false;
    this.profile = { loggedIn: false }; this.loading = null; this.busy = false; this.navigation = 0; this.message = '';
    this.openEpoch = 0;
    this.Handle('browse:state', () => this.State());
    this.Handle('browse:command', (command, value) => this.Command(command, value));
    this.Handle('browse:add', () => this.AddCurrent());
  }
  Handle(channel, callback) {
    this.electron.ipcMain.handle(channel, async (event, ...args) => {
      const wc = this.window?.webContents;
      if (!wc || wc.isDestroyed() || event.sender !== wc || event.senderFrame !== wc.mainFrame || event.senderFrame.url !== 'favecus://app/browse.html') return { ok: false, error: '許可されていない操作です。' };
      try { return { ok: true, value: await callback(...args) }; } catch (error) { return { ok: false, error: error.message }; }
    });
  }
  async CheckLogin() {
    try { this.profile = await this.options.profile(); }
    catch (error) { this.profile = { loggedIn: false }; this.Update(); throw error; }
    this.Update();
    if (!this.profile.loggedIn) throw new Error('設定・連携からBilibiliにログインしてください。');
  }
  Video() {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed() || wc.isLoadingMainFrame?.()) return null;
    try { return ParseBilibili(wc.getURL()); } catch { return CollectionURL(wc.getURL()) ? { url: wc.getURL(), collection: true } : null; }
  }
  State() {
    const wc = this.view?.webContents, video = this.Video(), history = wc?.navigationHistory;
    return { url: wc?.getURL() || '', title: wc?.getTitle().slice(0, 180) || 'Bilibiliから検索して追加', video,
      canAdd: !!video && !!this.profile.loggedIn && !this.busy, busy: this.busy, loggedIn: !!this.profile.loggedIn,
      canBack: !!history?.canGoBack(), canForward: !!history?.canGoForward(), message: this.message,
      maximized: !!this.window?.isMaximized(), muted: this.muted !== false };
  }
  Update() { if (this.window && !this.window.isDestroyed()) this.window.webContents.send('browse:state', this.State()); }
  Bounds() {
    if (!this.window || !this.view) return;
    const [width, height] = this.window.getContentSize(); this.view.setBounds({ x: 0, y: 116, width, height: Math.max(0, height - 116) });
  }
  async Open() {
    if (this.disposed) return;
    const epoch = ++this.openEpoch;
    await this.CheckLogin(); if (this.disposed || epoch !== this.openEpoch) return;
    if (!this.window || this.window.isDestroyed()) {
      const { BrowserWindow, WebContentsView } = this.electron;
      const window = new BrowserWindow({ width: 1160, height: 820, minWidth: 820, minHeight: 480, show: false, frame: false,
        backgroundColor: '#11131b', title: 'Favecus Player · Bilibili検索', icon: path.join(__dirname, '../../build/icon.png'),
        webPreferences: { preload: path.join(__dirname, '../preloads/browse.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
      this.window = window; this.muted = true; this.message = '';
      const view = new WebContentsView({ webPreferences: { partition: 'persist:favecus-bilibili', preload: path.join(__dirname, '../preloads/media.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
      this.view = view; window.contentView.addChildView(view); this.Bounds(); view.webContents.setAudioMuted(true);
      window.webContents.on('will-navigate', event => event.preventDefault()); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const wc = view.webContents;
      const channel = new MediaChannel(wc, { suspended: () => { if (!wc.isDestroyed()) wc.setAudioMuted(true); } });
      this.mediaChannel = channel;
      const guard = (event, url) => { if (!AllowedBrowseURL(event.url || url)) { event.preventDefault(); this.message = 'この画面ではBilibili内のページを開けます。'; this.Update(); } };
      wc.on('will-navigate', guard); wc.on('will-redirect', guard);
      wc.setWindowOpenHandler(({ url }) => { if (AllowedBrowseURL(url)) void this.Navigate(url); else { this.message = 'Bilibili以外のページは開きませんでした。'; this.Update(); } return { action: 'deny' }; });
      wc.on('did-start-navigation', (event, _url, _same, main) => { if ((event.isMainFrame ?? main) !== false) { this.navigation++; this.message = ''; this.Update(); } });
      for (const event of ['did-navigate', 'did-stop-loading', 'page-title-updated']) wc.on(event, () => this.Update());
      wc.on('did-navigate-in-page', (event, _url, main) => { if ((event.isMainFrame ?? main) !== false) this.Update(); });
      wc.on('did-finish-load', () => { channel.Ready(); this.SetVolume(this.options.volume()); this.Update(); });
      wc.on('did-fail-load', (_event, code, _text, _url, main) => { if (main && code !== -3) { this.message = `ページを開けませんでした（${code}）。検索または再読み込みを試してください。`; this.Update(); } });
      wc.on('render-process-gone', () => { this.message = '検索画面が終了しました。再読み込みで開き直せます。'; this.Update(); });
      window.on('resize', () => this.Bounds());
      for (const event of ['maximize', 'unmaximize']) window.on(event, () => this.Update());
      window.on('hide', () => this.Silence()); window.on('minimize', () => this.Silence());
      window.on('closed', () => { if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }); if (this.window === window) { this.window = null; this.view = null; this.navigation++; } this.options.refresh?.(); });
      this.loading = window.loadURL('favecus://app/browse.html');
      void this.Navigate(HOME);
    }
    const window = this.window;
    try { await this.loading; } catch { if (this.window === window) this.Close(); throw new Error('検索ウィンドウを開けませんでした。'); }
    if (this.disposed || this.window !== window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore(); window.show(); window.focus(); this.Update();
  }
  async Navigate(url) {
    if (!AllowedBrowseURL(url)) throw new Error('Bilibiliのページを指定してください。');
    const wc = this.view?.webContents; if (!wc || wc.isDestroyed()) return;
    this.mediaChannel?.Suspend();
    this.message = ''; this.Update();
    try { await wc.loadURL(url); } catch (error) { if (!wc.isDestroyed() && this.view?.webContents === wc && error.code !== 'ERR_ABORTED') { this.message = 'ページを開けませんでした。インターネット接続を確認してください。'; this.Update(); } }
  }
  SetVolume(value) {
    const wc = this.view?.webContents; if (!wc || wc.isDestroyed()) return;
    this.mediaChannel?.Send('media:command', { type: 'volume', value }); wc.setAudioMuted(!this.mediaChannel?.ready || this.muted !== false || value === 0);
  }
  Silence() { this.muted = true; const wc = this.view?.webContents; if (wc && !wc.isDestroyed()) { this.mediaChannel?.Send('media:command', { type: 'pause' }); wc.setAudioMuted(true); } this.Update(); }
  Hide() { this.window?.hide(); }
  async AddCurrent() {
    if (this.busy) throw new Error('動画を確認しています。');
    const video = this.Video(); if (!video) throw new Error('追加する投稿動画のページを開いてください。');
    const wc = this.view.webContents, navigation = this.navigation; this.busy = true; this.Update();
    try {
      await this.CheckLogin();
      let title = '';
      try {
        const data = video.collection ? null : await this.options.details(video.videoId), part = data?.pages?.find(p => p.page === video.part) || data?.pages?.[video.part - 1];
        title = data?.pages?.length > 1 ? part?.part || '' : data?.title || '';
      } catch {}
      if (this.disposed || wc.isDestroyed() || this.view?.webContents !== wc || navigation !== this.navigation || this.Video()?.url !== video.url) throw new Error('表示中のページが変わりました。追加する動画をもう一度確認してください。');
      if (!title && video.part === 1) title = wc.getTitle().replace(/\s*[-_|]\s*(哔哩哔哩.*|bilibili.*)$/i, '');
      await this.options.add({ url: video.url, title: String(title).slice(0, 180), analyze: true }); return true;
    } finally { this.busy = false; this.Update(); }
  }
  async Command(command, value) {
    const window = this.window, wc = this.view?.webContents; if (!window || window.isDestroyed()) return;
    const history = wc?.navigationHistory;
    if (command === 'minimize') window.minimize();
    else if (command === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    else if (command === 'close') this.Close();
    else if (command === 'back' && history?.canGoBack()) history.goBack();
    else if (command === 'forward' && history?.canGoForward()) history.goForward();
    else if (command === 'search') await this.Navigate(SearchURL(value));
    else if (command === 'home') await this.Navigate(HOME);
    else if (command === 'reload') await this.Navigate(wc.getURL() || HOME);
    else if (command === 'sound') { this.muted = !this.muted; this.SetVolume(this.options.volume()); this.Update(); }
  }
  Close() { this.openEpoch++; this.window?.close(); }
  Destroy() { this.disposed = true; this.navigation++; this.Close(); }
}
module.exports = { BilibiliBrowser, AllowedBrowseURL, SearchURL };
