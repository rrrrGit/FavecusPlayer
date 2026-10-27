'use strict';

class BackgroundMode {
  constructor(settings, canSwitch, enter, options = {}) {
    this.settings = settings; this.canSwitch = canSwitch; this.enter = enter;
    this.now = options.now || Date.now; this.schedule = options.schedule || setTimeout; this.cancel = options.cancel || clearTimeout;
    this.onError = options.onError || (() => {}); this.since = null; this.timer = null; this.serial = 0; this.disposed = false;
  }
  SetForeground(foreground) {
    if (foreground) this.since = null;
    else if (this.since === null) this.since = this.now();
    this.Refresh();
  }
  Refresh() {
    this.serial++; this.cancel(this.timer); this.timer = null;
    const settings = this.settings();
    if (this.disposed || this.since === null || !settings.autoThumbnailEnabled || !this.canSwitch()) return;
    const serial = this.serial, delay = Math.max(0, settings.autoThumbnailMinutes * 60000 - (this.now() - this.since));
    this.timer = this.schedule(() => {
      this.timer = null;
      if (this.disposed || serial !== this.serial || this.since === null || !this.settings().autoThumbnailEnabled || !this.canSwitch()) return;
      try { this.enter(); } catch (error) { this.onError(error); }
    }, delay);
    this.timer?.unref?.();
  }
  Dispose() { this.disposed = true; this.serial++; this.cancel(this.timer); this.timer = null; }
}
module.exports = { BackgroundMode };
