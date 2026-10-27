'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const fsp = fs.promises;
const EXECUTABLE = 'FavecusPlayer.exe';
async function Hash(file) { const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function NoLinks(file) {
  for (let parent = path.resolve(file); ; parent = path.dirname(parent)) {
    const stat = await fsp.lstat(parent).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
    if (stat?.isSymbolicLink()) throw new Error('実行ファイルの表示情報をリンク先へ書き込むことはできません。');
    if (parent === path.dirname(parent)) break;
  }
}
const PSQuote = text => `'${String(text).replaceAll("'", "''")}'`;
async function UpdateResources(target, donor) {
  const script = await fsp.readFile(path.join(__dirname, 'brand-runtime.ps1'), 'utf8');
  const program = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // 検証済み同梱スクリプトを実行する。実行ポリシーの変更・無効化は行わない。
  const command = `& {\n${script}\n} -Target ${PSQuote(target)} -Donor ${PSQuote(donor)}`;
  await new Promise((resolve, reject) => {
    const child = spawn(program, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Windowsのアプリ名・アイコンを設定できませんでした（${code}）。`)));
  });
}
async function Brand({ directory, stage, donor, update = UpdateResources }) {
  const source = path.join(directory, 'electron.exe'), destination = path.join(directory, EXECUTABLE), marker = path.join(directory, '.favecus-branding.json');
  for (const file of [source, destination, marker, donor, stage]) await NoLinks(file);
  const sourceHash = await Hash(source), donorHash = await Hash(donor);
  const previous = await fsp.readFile(marker, 'utf8').then(JSON.parse).catch(() => null);
  if (previous?.version === 1 && previous.sourceHash === sourceHash && previous.donorHash === donorHash && await Hash(destination).catch(() => null) === previous.outputHash) return { executable: destination, reused: true };
  const temporary = path.join(stage, `FavecusPlayer-branded-${randomUUID()}.exe`), markerTemporary = `${marker}.${randomUUID()}.tmp`;
  try {
    await fsp.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    await update(temporary, donor);
    const outputHash = await Hash(temporary);
    if (outputHash === sourceHash) throw new Error('実行ファイルの表示情報が更新されていません。');
    await fsp.rename(temporary, destination);
    await fsp.writeFile(markerTemporary, JSON.stringify({ version: 1, sourceHash, donorHash, outputHash }), { flag: 'wx' });
    await fsp.rename(markerTemporary, marker);
    return { executable: destination, reused: false };
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {}); await fsp.rm(markerTemporary, { force: true }).catch(() => {});
  }
}
module.exports = { Brand, EXECUTABLE };
