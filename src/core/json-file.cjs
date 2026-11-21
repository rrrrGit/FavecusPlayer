'use strict';
// 端末固有の小さな設定・記録を JSON ファイルへ原子的に読み書きする共通ヘルパー（Node 専用）。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function ReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function WriteJsonAtomic(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(value));
    fs.renameSync(temp, file);
    return true;
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch {}
    return false;
  }
}

function RemoveFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}

module.exports = { ReadJson, WriteJsonAtomic, RemoveFile };
