'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function ConvertWma(executable, source, destination) {
  if (!fs.existsSync(executable)) throw new Error('WMA変換用のFFmpegが見つかりません。Favecus Playerのセットアップを再実行してください。');
  const temp = `${destination}.partial`;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', path.resolve(source), '-map', '0:a:0', '-vn', '-c:a', 'flac', '-f', 'flac', '-n', temp], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let error = ''; child.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-2000); });
      const timer = setTimeout(() => { child.kill(); reject(new Error('WMAの変換が時間内に終わりませんでした。')); }, 30 * 60 * 1000);
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`WMAを変換できませんでした。保護されていない音声ファイルか確認してください。\n${error.slice(-300)}`)); });
    });
    await fs.promises.rename(temp, destination);
  } finally { await fs.promises.rm(temp, { force: true }).catch(() => {}); }
}
module.exports = { ConvertWma };
