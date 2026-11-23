'use strict';
// 音声の出力デバイスの選択（v0.7.4。PC版。保存済み・ローカルの曲の再生だけ）。この端末内だけに保存し、同期しない。
// デバイスのIDは、ページごとに違う（画面とプレーヤーで一致しない）ため、デバイスの名前（label）で覚える。空は「既定のデバイス」。
const { ReadJson, WriteJsonAtomic } = require('./json-file.cjs');

const MAX_LABEL = 200;
const Clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_LABEL);

// 名前（label）に合うデバイスのID。名前が空・見つからないときは、'default'（既定）。devices：[{ deviceId, label }]
function Resolve(label, devices) {
  const wanted = Clean(label);
  if (!wanted || !Array.isArray(devices)) return 'default';
  return devices.find(device => device && device.label === wanted && typeof device.deviceId === 'string')?.deviceId || 'default';
}

class OutputDeviceStore {
  constructor(file) {
    this.file = file; this.label = '';
    const data = ReadJson(file);
    if (data?.version === 1) this.label = Clean(data.label);
  }
  Get() { return this.label; }
  Set(label) {
    const prev = this.label;
    this.label = Clean(label);
    if (!WriteJsonAtomic(this.file, { version: 1, label: this.label })) {
      this.label = prev;
      throw new Error('出力デバイスの設定を保存できませんでした。');
    }
    return this.label;
  }
}

module.exports = { MAX_LABEL, Clean, Resolve, OutputDeviceStore };
