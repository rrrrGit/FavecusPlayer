'use strict';
// 自動リストの設定のファイル保存（PC版。規則は auto-list-settings.cjs＝共通JS）。この端末内だけ。原子的に書く。
const { ReadJson, WriteJsonAtomic } = require('./json-file.cjs');
const Settings = require('./auto-list-settings.cjs');

class AutoListSettingsStore {
  constructor(file) {
    this.file = file; this.value = Settings.Normalize({});
    const data = ReadJson(file);
    if (data?.version === 1) this.value = Settings.Normalize(data.settings);
  }
  Get() { return Settings.Normalize(this.value); }
  Set(settings) {
    this.value = Settings.Normalize(settings);
    WriteJsonAtomic(this.file, { version: 1, settings: this.value });
    return this.Get();
  }
}

module.exports = { AutoListSettingsStore };
