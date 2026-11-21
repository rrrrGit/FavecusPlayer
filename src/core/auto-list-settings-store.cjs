'use strict';
// 自動リストの設定のファイル保存（PC版。規則は auto-list-settings.cjs＝共通JS）。この端末内だけ。原子的に書く。
const fs = require('node:fs');
const path = require('node:path');
const Settings = require('./auto-list-settings.cjs');

class AutoListSettingsStore {
  constructor(file) {
    this.file = file; this.value = Settings.Normalize({});
    try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); if (data?.version === 1) this.value = Settings.Normalize(data.settings); } catch { /* 初めて・壊れている：既定 */ }
  }
  Get() { return Settings.Normalize(this.value); }
  Set(settings) {
    this.value = Settings.Normalize(settings);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`; fs.writeFileSync(temp, JSON.stringify({ version: 1, settings: this.value })); fs.renameSync(temp, this.file);
    } catch { /* 保存できなくても、この起動の間は使える */ }
    return this.Get();
  }
}

module.exports = { AutoListSettingsStore };
