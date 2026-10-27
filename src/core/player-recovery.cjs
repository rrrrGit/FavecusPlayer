'use strict';
class PlayerRecovery {
  constructor(recover, options = {}) {
    this.recover = recover; this.schedule = options.schedule || setTimeout; this.cancel = options.cancel || clearTimeout;
    this.onError = options.onError || (() => {}); this.delay = options.delay || 20000; this.stallDelay = options.stallDelay || 15000; this.token = null; this.timer = null; this.ready = false; this.fired = false;
  }
  Begin(token, embedded) {
    this.Cancel(); this.token = token; this.ready = false; this.fired = false; this.embedded = embedded; this.position = null; this.paused = false;
    if (embedded) this.Arm(token, 'timeout', this.delay);
  }
  Arm(token, reason, delay) { this.cancel(this.timer); this.timer = this.schedule(() => this.Trigger(token, reason), delay); this.timer?.unref?.(); }
  Observe(token, health) {
    if (token !== this.token || !this.embedded || this.fired || !health || typeof health.ready !== 'boolean') return;
    if (Number.isInteger(health.errorCode) && health.errorCode >= 2 && health.errorCode <= 4) { this.Trigger(token, 'media-error'); return; }
    if (health.ready) this.ready = true;
    if (health.ready && health.paused !== false || health.ended) { this.paused = true; this.cancel(this.timer); this.timer = null; return; }
    if (Number.isFinite(health.position) && !health.paused && !health.ended) {
      const advanced = this.position === null || Math.abs(health.position - this.position) > .05;
      if (advanced || this.paused) this.Arm(token, 'stalled', this.stallDelay);
      this.position = health.position; this.paused = false;
    }
  }
  Trigger(token, reason) {
    if (token !== this.token || !this.embedded || this.fired) return;
    this.fired = true; this.cancel(this.timer); this.timer = null;
    Promise.resolve().then(() => { if (this.token === token) return this.recover(token, reason); }).catch(this.onError);
  }
  Cancel() { this.cancel(this.timer); this.timer = null; this.token = null; }
}
module.exports = { PlayerRecovery };
