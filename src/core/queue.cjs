'use strict';

const { randomInt } = require('node:crypto');
class Queue {
  constructor(random = null, weight = null) { this.random = random; this.weight = weight; this.Clear(); }
  get ids() { return this.cycles[this.cycleIndex]?.ids || []; }
  Clone() {
    const copy = new Queue(this.random);
    Object.assign(copy, this, { available: [...this.available], history: [...this.history], catalog: new Map(this.catalog), cycles: this.cycles.map(c => ({ ...c, ids: [...c.ids], seen: new Set(c.seen) })) });
    return copy;
  }
  Index(max) { return this.random ? Math.floor(this.random() * max) : randomInt(max); }
  Shuffled(ids) {
    if (this.weight) return ids.map(id => ({ id, rank: -Math.log((this.Index(2147483646) + 1) / 2147483647) / Math.max(1e-12, Number(this.weight(this.catalog.get(id))) || 1) })).sort((a, b) => a.rank - b.rank).map(x => x.id);
    const result = [...ids];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.Index(i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  Start(playlistId, entries, id, shuffle) {
    this.Clear(); this.playlistId = playlistId; this.shuffle = !!shuffle;
    this.catalog = new Map(entries.map(e => [e.id, { ...e }]));
    this.available = [...new Set(entries.map(e => e.id))];
    if (!this.available.includes(id)) return null;
    const ids = shuffle ? [id, ...this.Shuffled(this.available.filter(x => x !== id))] : [...this.available];
    this.cycles = [{ ids, seen: new Set([id]) }]; this.cycleIndex = 0; this.index = ids.indexOf(id);
    return id;
  }
  ShuffleStart(playlistId, entries) {
    this.Clear(); this.playlistId = playlistId; this.shuffle = true;
    this.catalog = new Map(entries.map(e => [e.id, { ...e }]));
    this.available = [...new Set(entries.map(e => e.id))];
    if (!this.available.length) return null;
    const ids = this.Shuffled(this.available);
    this.cycles = [{ ids, seen: new Set([ids[0]]) }]; this.index = 0;
    return ids[0];
  }
  Sync(playlistId, entries, id, shuffle) {
    if (playlistId !== this.playlistId || !this.ids.includes(id)) return this.Start(playlistId, entries, id, shuffle);
    for (const e of entries) this.catalog.set(e.id, { ...e });
    const available = [...new Set(entries.map(e => e.id))], valid = new Set(available), cycle = this.cycles[this.cycleIndex];
    if (!valid.has(id)) { this.Clear(); return null; }
    if (!!shuffle !== this.shuffle) {
      const seen = new Set([...cycle.seen].filter(x => valid.has(x))); seen.add(id);
      const prefix = cycle.ids.filter(x => seen.has(x) && x !== id);
      const ids = shuffle ? [...prefix, id, ...this.Shuffled(available.filter(x => !seen.has(x)))] : [...available];
      this.cycles = [{ ids, seen }]; this.cycleIndex = 0;
    } else if (!shuffle) {
      cycle.ids = [...available];
      this.cycles = [cycle]; this.cycleIndex = 0;
    } else {
      for (const [i, c] of this.cycles.entries()) {
        c.ids = c.ids.filter(x => valid.has(x));
        if (i < this.cycleIndex) continue;
        const known = new Set(c.ids), added = this.Shuffled(available.filter(x => !known.has(x) && !c.seen.has(x)));
        // 再生済みの区間を動かさず、新曲だけを未再生区間へ混ぜる。
        const boundary = c.ids.reduce((last, x, at) => c.seen.has(x) ? at + 1 : last, 0);
        for (const next of added) c.ids.splice(boundary + this.Index(c.ids.length - boundary + 1), 0, next);
      }
      this.cycles = this.cycles.filter(c => c === cycle || c.ids.length);
      this.cycleIndex = this.cycles.indexOf(cycle);
    }
    this.available = available; this.shuffle = !!shuffle; this.index = this.ids.indexOf(id);
    const future = this.cycles[this.cycleIndex + 1];
    if (future && future.seen.size <= 1 && future.anchor !== this.ids.at(-1)) this.cycles.splice(this.cycleIndex + 1);
    return id;
  }
  PrepareNextCycle(at = this.cycleIndex) {
    if (at < this.cycles.length - 1) return;
    const last = this.cycles[at].ids.at(-1);
    const ids = this.Shuffled(this.available.length > 1 ? this.available.filter(id => id !== last) : this.available);
    this.cycles.push({ ids, seen: new Set([last]), anchor: last });
  }
  Peek(repeat, automatic = true) {
    if (this.index < 0 || !this.ids.length) return null;
    if (automatic && repeat === 'one') return this.ids[this.index];
    if (this.index + 1 < this.ids.length) return this.ids[this.index + 1];
    if (repeat !== 'all') return null;
    if (!this.shuffle) return this.ids[0];
    // 次の周をここで確定し、表示と実際の曲送りで同じ抽選結果を使う。
    this.PrepareNextCycle();
    return this.cycles[this.cycleIndex + 1].ids[0];
  }
  Move(direction, repeat, automatic = false) {
    if (this.index < 0 || !this.ids.length) return null;
    const previous = this.ids[this.index];
    if (automatic && repeat === 'one') { this.Remember(previous); return previous; }
    let next = this.index + direction;
    if (next < 0 || next >= this.ids.length) {
      if (repeat !== 'all') return null;
      if (this.shuffle && next >= this.ids.length) {
        this.PrepareNextCycle();
        this.cycleIndex++; next = 0;
        if (this.cycleIndex > 2) { this.cycles.shift(); this.cycleIndex--; }
      } else if (this.shuffle && next < 0 && this.cycleIndex > 0) {
        this.cycleIndex--; next = this.ids.length - 1;
      } else next = (next + this.ids.length) % this.ids.length;
    }
    this.index = next; this.cycles[this.cycleIndex].seen.add(this.ids[next]);
    this.Remember(previous);
    return this.ids[next];
  }
  Remember(id) { this.history.push(id); if (this.history.length > 1000) this.history.shift(); }
  Timeline(repeat) {
    if (this.index < 0) return { history: [], current: null, upcoming: [] };
    const current = this.ids[this.index], upcoming = repeat === 'one' ? [current, current, current] : this.ids.slice(this.index + 1);
    if (repeat === 'all') {
      let cycle = this.cycleIndex;
      while (upcoming.length < 3 && this.available.length) {
        if (this.shuffle) { this.PrepareNextCycle(cycle); upcoming.push(...this.cycles[++cycle].ids); }
        else upcoming.push(...this.available);
      }
    }
    return { history: [...this.history], current, upcoming };
  }
  Clear() { this.cycles = []; this.cycleIndex = 0; this.index = -1; this.playlistId = null; this.available = []; this.shuffle = false; this.history = []; this.catalog = new Map(); }
}

module.exports = { Queue };
