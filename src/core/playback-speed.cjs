'use strict';
// 再生速度（v0.7.4）。0.5〜2.0倍の7段階。この端末内だけに保存し、同期しない。iPhone版（PlaybackSpeed.swift）と同じ段階。
const fs = require('node:fs');
const path = require('node:path');

const OPTIONS = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);

// 選べる値のうち、いちばん近いもの（数でない・範囲外は 1）。
function Nearest(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return OPTIONS.reduce((best, option) => (Math.abs(option - number) < Math.abs(best - number) ? option : best), OPTIONS[0]);
}
// いまの速度の、次の段階（いちばん速いときは、いちばん遅い段階へ戻る。押すたびに切り替える操作用）。
function Next(value) {
  const at = OPTIONS.indexOf(Nearest(value));
  return OPTIONS[(at + 1) % OPTIONS.length];
}
function Label(value) { return `${Nearest(value)}x`; }

class SpeedStore {
  constructor(file) {
    this.file = file; this.value = 1;
    try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); if (data?.version === 1) this.value = Nearest(data.speed); } catch { /* 初めて・壊れている：1倍 */ }
  }
  Get() { return this.value; }
  Set(value) {
    this.value = Nearest(value);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`; fs.writeFileSync(temp, JSON.stringify({ version: 1, speed: this.value })); fs.renameSync(temp, this.file);
    } catch { /* 保存できなくても、この起動の間は使える */ }
    return this.value;
  }
}

module.exports = { OPTIONS, Nearest, Next, Label, SpeedStore };
