'use strict';
class QueueFollower {
  constructor(options) { this.options = options; this.lastInput = -Infinity; this.held = false; this.serial = 0; }
  Interact() { this.lastInput = this.options.now(); this.serial++; }
  Resume() { this.lastInput = -Infinity; this.held = false; this.serial++; }
  Release() { if (this.held) this.Hold(false); }
  Hold(value) { this.held = value; this.Interact(); }
  Allowed() { return !this.held && this.options.now() - this.lastInput >= 1500 && this.options.foreground() && this.options.allowed(); }
  Request() {
    if (!this.Allowed()) return false;
    const serial = ++this.serial;
    this.options.schedule(() => { if (serial === this.serial && this.Allowed()) this.options.align(); });
    return true;
  }
}
if (typeof module !== 'undefined' && module.exports) module.exports = { QueueFollower };
else window.FavecusQueueFollow = { QueueFollower };
