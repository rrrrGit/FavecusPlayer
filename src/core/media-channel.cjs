'use strict';

// webContents.send() reads mainFrame internally. During a frame swap that can
// trigger Electron's native WebFrameMain duplicate-registration CHECK; a JS
// try/catch cannot recover from it. Keep all media IPC behind document readiness.
class MediaChannel {
  constructor(contents, { suspended = () => {}, failed = () => {}, sending = () => {} } = {}) {
    this.contents = contents; this.ready = false;
    this.suspended = suspended; this.failed = failed; this.sending = sending;
    contents.on('did-start-navigation', (event, _url, inPlace, mainFrame) => {
      if ((event.isMainFrame ?? mainFrame) !== false && !(event.isSameDocument ?? inPlace)) this.Suspend();
    });
    contents.on('render-process-gone', () => this.Suspend());
    contents.once('destroyed', () => { this.Suspend(); this.contents = null; });
  }
  Suspend() { this.ready = false; this.suspended(); }
  Ready() { this.ready = !!this.contents && !this.contents.isDestroyed(); return this.ready; }
  Send(channel, value) {
    if (!this.ready || !this.contents || this.contents.isDestroyed()) return false;
    try { this.sending(channel, value); this.contents.send(channel, value); return true; }
    catch (error) { this.failed(error); return false; }
  }
}
module.exports = { MediaChannel };
