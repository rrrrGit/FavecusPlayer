'use strict';
(function (root) {
  class QueueDrag {
    constructor(options) { this.options = options; this.gesture = null; this.serial = 0; }
    Bind(handle, row, item, enabled = true) {
      handle.draggable = false;
      handle.addEventListener('pointerdown', e => { if (!enabled || e.button !== 0 || e.isPrimary === false) return; this.Cancel(); this.gesture = { handle, row, item, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, active: false }; handle.setPointerCapture?.(e.pointerId); });
      handle.addEventListener('pointermove', e => this.Move(e)); handle.addEventListener('pointerup', e => this.End(e)); handle.addEventListener('pointercancel', () => this.Cancel()); handle.addEventListener('lostpointercapture', () => this.Cancel());
    }
    Move(e) { const g = this.gesture; if (!g || g.pointerId !== e.pointerId) return; g.x = e.clientX; g.y = e.clientY; if (!g.active && Math.hypot(g.x - g.startX, g.y - g.startY) < 5) return; e.preventDefault(); if (!g.active) { g.active = true; g.row.classList.add('dragging'); this.options.start(g.item); this.ScrollFrame(++this.serial); } this.Target(); }
    Target() {
      const g = this.gesture; this.options.clear(); if (!g?.active) return null; const bounds = this.options.list().getBoundingClientRect();
      if (g.x < bounds.left || g.x > bounds.right || g.y < bounds.top || g.y > bounds.bottom) return null;
      const row = this.options.hit(g.x, g.y);
      if (row?.dataset.playlistId && row.dataset.playlistId !== g.item.playlistId) { row.classList.add('drop-child'); return { playlistId: row.dataset.playlistId }; }
      if (!row || !row.dataset.ownerId || !row.dataset.entryId || row.dataset.entryId === g.item.entryId) return null;
      const rect = row.getBoundingClientRect(), after = g.y > rect.top + rect.height / 2; row.classList.add(after ? 'drop-after' : 'drop-before'); return row.dataset.ownerId !== g.item.playlistId ? { playlistId: row.dataset.ownerId, targetId: row.dataset.entryId, after } : { targetId: row.dataset.entryId, after };
    }
    ScrollFrame(serial) { this.options.schedule(() => { const g = this.gesture; if (!g?.active || serial !== this.serial) return; const list = this.options.list(), b = list.getBoundingClientRect(); if (g.x >= b.left && g.x <= b.right && g.y >= b.top && g.y <= b.bottom) { if (g.y < b.top + 35) list.scrollTop -= 8; else if (g.y > b.bottom - 35) list.scrollTop += 8; this.Target(); } this.ScrollFrame(serial); }); }
    Wheel(e) { if (!this.gesture?.active) return false; const list = this.options.list(), scale = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? list.clientHeight : 1; e.preventDefault(); list.scrollTop += e.deltaY * scale; this.options.interact(); this.Target(); return true; }
    End(e) { const g = this.gesture; if (!g || g.pointerId !== e.pointerId) return; g.x = e.clientX; g.y = e.clientY; const target = this.Target(), active = g.active; this.Cancel(); if (active && target) this.options.drop(g.item, target); }
    Cancel() { const g = this.gesture; this.gesture = null; this.serial++; if (!g) return; g.row.classList.remove('dragging'); this.options.clear(); try { if (g.handle.hasPointerCapture?.(g.pointerId)) g.handle.releasePointerCapture(g.pointerId); } catch {} if (g.active) this.options.end(); }
  }
  root.FavecusQueueDrag = QueueDrag;
  if (typeof module !== 'undefined' && module.exports) module.exports = { QueueDrag };
})(globalThis);
