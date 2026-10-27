'use strict';
class ListArtwork {
  constructor({ root, load, observe }) {
    this.load = load; this.records = new Map(); this.queue = new Set(); this.active = 0; this.enabled = false;
    this.observer = observe(changes => {
      for (const { target, isIntersecting } of changes) {
        const record = this.records.get(target); if (!record) continue;
        record.visible = isIntersecting;
        if (isIntersecting) { if (!record.loaded && !record.pending) this.queue.add(record); }
        else { this.queue.delete(record); record.loaded = false; target.src = 'music.png'; }
      }
      this.Pump();
    }, { root, rootMargin: '80px 0px', threshold: 0 });
  }
  Reset() { this.observer.disconnect(); this.records.clear(); this.queue.clear(); }
  Add(image, playlistId, entryId) {
    image.src = 'music.png';
    image.onerror = () => { image.onerror = null; image.src = 'music.png'; };
    this.records.set(image, { image, playlistId, entryId, visible: false, loaded: false, pending: false });
    this.observer.observe(image);
  }
  SetEnabled(value) {
    this.enabled = value;
    if (value) for (const record of this.records.values()) if (record.visible && !record.loaded && !record.pending) this.queue.add(record);
    this.Pump();
  }
  Current(record) { return this.enabled && record.visible && this.records.get(record.image) === record; }
  Pump() {
    while (this.enabled && this.active < 2 && this.queue.size) {
      const record = this.queue.values().next().value; this.queue.delete(record);
      if (!this.Current(record) || record.pending || record.loaded) continue;
      this.active++; record.pending = true;
      Promise.resolve().then(() => this.Current(record) ? this.load(record.playlistId, record.entryId) : null).then(value => {
        if (!this.Current(record)) return;
        const safe = typeof value === 'string' && value.length <= 131072 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value);
        record.image.src = safe ? value : 'music.png'; record.loaded = true;
      }).catch(() => { if (this.Current(record)) { record.image.src = 'music.png'; record.loaded = true; } }).finally(() => {
        record.pending = false; this.active--;
        if (this.Current(record) && !record.loaded) this.queue.add(record);
        this.Pump();
      });
    }
  }
}
if (typeof module !== 'undefined' && module.exports) module.exports = { ListArtwork };
else window.FavecusListArtwork = { ListArtwork };
