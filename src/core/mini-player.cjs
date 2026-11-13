'use strict';
const { BrowserWindow, Tray, Menu, screen, ipcMain, app } = require('electron');
const path = require('node:path');
const { MiniBounds, ExpandBounds } = require('./window-placement.cjs');
const { TaskbarPlayer } = require('./taskbar-player.cjs');
class MiniPlayer {
  constructor(main, state, command, volume, notice, options = {}) {
    this.main = main; this.state = state; this.command = command; this.volume = volume; this.notice = notice;
    this.window = null; this.tray = null; this.expanded = false; this.ready = false; this.disposed = false;
    this.options = options; this.showEpoch = 0; this.settings = options.settings || (() => ({}));
    if ((options.platform || process.platform) === 'win32') {
      const Peer = options.TaskbarPlayer || TaskbarPlayer;
      this.taskbar = new Peer(path.join(__dirname, '../../build/FavecusPlayerTaskbar.exe'), state, this.settings,
        async (action, value) => {
          if (action === 'restore') this.Restore();
          else if (action === 'floating') await this.ShowFloating();
          else if (action === 'volume') await volume(value);
          else await command(action);
        }, (code, text) => this.Status(code, text), error => { this.Restore(); this.Status('error', error.message); notice(error.message); },
        { log: path.join(app.getPath('userData'), 'taskbar.log') });
    }
    const icon = path.join(__dirname, '../../build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
    try {
      this.tray = new Tray(icon); this.tray.setToolTip('Favecus Player');
      this.tray.on('click', () => { void this.Show().catch(error => notice(error.message)); });
      this.tray.on('double-click', () => this.Restore());
      this.tray.on('right-click', () => {
        const state = this.state();
        this.tray.popUpContextMenu(Menu.buildFromTemplate([
          { label: state.title, enabled: false }, { type: 'separator' },
          { label: 'プレイヤーを開く', click: () => this.Restore() },
          { label: 'ミニプレイヤー', click: () => { void this.Show().catch(error => notice(error.message)); } },
          { label: state.paused ? '再生' : '一時停止', enabled: state.canToggle, click: () => { void command('toggle').catch(error => notice(error.message)); } },
          { label: '前の曲', enabled: state.canStep, click: () => { void command('previous').catch(error => notice(error.message)); } },
          { label: '次の曲', enabled: state.canStep, click: () => { void command('next').catch(error => notice(error.message)); } },
          { label: '停止', enabled: state.canStop, click: () => { void command('stop').catch(error => notice(error.message)); } },
          { type: 'separator' }, { label: '終了', click: () => app.quit() }
        ]));
      });
    } catch { notice('通知領域のアイコンを作成できませんでした。小型画面の↗で元の画面へ戻れます。'); }
    this.Handle('mini:state', () => state());
    this.Handle('mini:command', value => {
      if (!['toggle', 'stop', 'previous', 'next'].includes(value)) throw new Error('許可されていない操作です。');
      return command(value);
    });
    this.Handle('mini:volume', value => volume(value));
    this.Handle('mini:restore', () => this.Restore());
    this.Handle('mini:expand', value => {
      if (typeof value !== 'boolean') return;
      this.expanded = value;
      const bounds = this.window.getBounds(), work = screen.getDisplayMatching(bounds).workArea;
      this.window.setBounds(ExpandBounds(bounds, work, value));
    });
    this.reposition = () => {
      if (this.window?.isVisible()) { this.window.setBounds(this.Placement()); this.window.webContents.send('mini:collapsed'); }
    };
    screen.on('display-removed', this.reposition); screen.on('display-metrics-changed', this.reposition);
  }
  // 通知領域にアイコンがあり、そこから再表示・終了できるときだけtrue（×ボタンでの格納の条件）。
  CanHideToTray() { return !this.disposed && !!this.tray && !this.tray.isDestroyed(); }
  Status(code, text) { this.options.status?.(code, text); }
  Handle(channel, callback) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!this.window || this.window.isDestroyed() || event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame || event.senderFrame.url !== 'favecus://app/mini.html') return { ok: false, error: '許可されていない操作です。' };
      try { return { ok: true, value: await callback(...args) }; } catch (error) { return { ok: false, error: error.message }; }
    });
  }
  Placement() {
    let anchor;
    try { anchor = this.tray?.getBounds(); } catch {}
    const display = anchor?.width > 0 ? screen.getDisplayMatching(anchor) : screen.getDisplayMatching(this.main.getBounds());
    this.expanded = false;
    return MiniBounds(display.workArea, anchor?.width > 0 ? anchor : null);
  }
  async Show() {
    if (this.disposed || this.main.isDestroyed()) return;
    const epoch = ++this.showEpoch;
    if (this.taskbar && this.settings().taskbarEmbed !== false) {
      try {
        await this.taskbar.Show();
        if (this.disposed || epoch !== this.showEpoch) return;
        this.window?.hide(); this.main.hide(); return;
      } catch (error) {
        if (this.disposed || epoch !== this.showEpoch) return;
        this.notice(`${error.message} 通常の小型画面を表示します。`);
      }
    }
    await this.ShowFloating(epoch);
  }
  async ShowFloating(epoch = ++this.showEpoch) {
    if (this.disposed || this.main.isDestroyed()) return;
    this.taskbar?.Stop();
    if (!this.window || this.window.isDestroyed()) {
      this.window = new BrowserWindow({ ...this.Placement(), show: false, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
        resizable: false, movable: false, maximizable: false, minimizable: false, title: 'Favecus Player · ミニプレイヤー',
        webPreferences: { preload: path.join(__dirname, '../preloads/mini.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
      this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.window.webContents.on('will-navigate', e => e.preventDefault());
      this.window.webContents.on('render-process-gone', () => { this.Restore(); this.window?.destroy(); this.window = null; this.ready = false; });
      this.window.on('close', e => { if (!this.disposed) { e.preventDefault(); this.Restore(); } });
      this.loading = this.window.loadURL('favecus://app/mini.html');
    }
    try { await this.loading; }
    catch { this.window?.destroy(); this.window = null; throw new Error('ミニプレイヤーを開けませんでした。'); }
    if (this.disposed || epoch !== this.showEpoch || !this.window || this.window.isDestroyed()) return;
    this.ready = true; this.window.setBounds(this.Placement()); this.window.webContents.send('mini:collapsed'); this.Update();
    this.window.show(); this.window.focus(); this.main.hide();
    this.Status('floating', '独立した小型画面で表示しています');
  }
  Restore() {
    ++this.showEpoch; this.taskbar?.Stop();
    if (this.disposed || this.main.isDestroyed()) return;
    this.window?.hide(); if (this.main.isMinimized()) this.main.restore(); this.main.show(); this.main.focus();
    this.Status('off', '通常画面で表示しています');
  }
  Update() {
    const value = this.state();
    this.taskbar?.Update();
    if (this.window && !this.window.isDestroyed() && this.ready) this.window.webContents.send('mini:state', value);
    if (this.tray && !this.tray.isDestroyed()) this.tray.setToolTip(`Favecus Player · ${value.title}`.slice(0, 127));
  }
  async Configure() {
    if (this.taskbar?.connection && this.settings().taskbarEmbed === false) await this.ShowFloating();
    else this.Update();
  }
  Destroy() {
    this.disposed = true; ++this.showEpoch; this.taskbar?.Stop();
    screen.removeListener('display-removed', this.reposition); screen.removeListener('display-metrics-changed', this.reposition);
    for (const name of ['state', 'command', 'volume', 'restore', 'expand']) ipcMain.removeHandler(`mini:${name}`);
    this.window?.destroy(); this.tray?.destroy(); this.window = null; this.tray = null;
  }
}
module.exports = { MiniPlayer };
