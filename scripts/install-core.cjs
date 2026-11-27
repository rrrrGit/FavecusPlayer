'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createGunzip } = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const downloads = require('./runtime-downloads.json');
const { Brand } = require('./brand-runtime.cjs');
const fsp = fs.promises;
const IsProduct = value => ['favecus-player', 'focus-player'].includes(value);
const MAX_DOWNLOAD = 350 * 1024 * 1024;
const CONFIG = 'runtime/config';

async function Hash(file) { const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function NoLink(file) { const stat = await fsp.lstat(file).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e)); if (stat?.isSymbolicLink()) throw new Error(`リンク先のフォルダーは更新できません: ${file}`); return stat; }
function SafeRelative(value) { return typeof value === 'string' && value.length < 220 && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every(x => x && x !== '.' && x !== '..' && /^[\w. -]+$/.test(x)); }
function PSQuote(text) { return `'${String(text).replaceAll("'", "''")}'`; }
async function Run(program, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); let error = '';
    child.stderr.on('data', data => { error = (error + data).slice(-3000); });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`ファイルの展開に失敗しました（${code}）。${error}`)));
  });
}
async function ExtractZip(archive, destination) {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await Run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${PSQuote(archive)},${PSQuote(destination)})`]);
}
async function Download(asset, destination, progress = () => {}, fetcher = fetch) {
  if (!/^https:\/\//.test(asset.url) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size > MAX_DOWNLOAD) throw new Error('ダウンロードの設定が正しくありません。');
  const response = await fetcher(asset.url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!response.ok || !response.body || (response.url && !response.url.startsWith('https:'))) throw new Error(`${asset.name}を取得できません（HTTP ${response.status}）。`);
  const file = await fsp.open(destination, 'wx'); let bytes = 0, reported = -1; const hash = createHash('sha256');
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > asset.size || bytes > MAX_DOWNLOAD) throw new Error('ダウンロードサイズが一致しません。');
      hash.update(chunk); await file.writeFile(chunk);
      const percentage = Math.floor(bytes / asset.size * 10) * 10;
      if (percentage !== reported) { reported = percentage; progress(`${asset.name} ${percentage}%`); }
    }
    if (bytes !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error(`${asset.name}の確認に失敗しました。再実行してください。`);
  } finally { await file.close(); }
}
async function ValidatePayload(payload) {
  const manifest = JSON.parse(await fsp.readFile(path.join(payload, 'manifest.json'), 'utf8'));
  if (manifest.product !== 'favecus-player' || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !Array.isArray(manifest.files) || manifest.files.length > 2000) throw new Error('Favecus Playerの更新ファイルではありません。');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!SafeRelative(entry.path) || seen.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('更新ファイルの一覧が正しくありません。');
    seen.add(entry.path);
    const file = path.join(payload, entry.path);
    for (let parent = file; parent !== payload; parent = path.dirname(parent)) await NoLink(parent);
    if (await Hash(file) !== entry.sha256) throw new Error(`更新ファイルが壊れています: ${entry.path}`);
  }
  for (const required of ['app/package.json', 'app/src/main.cjs', 'FavecusPlayer.exe', 'bootstrap/node.exe', 'bootstrap/NODE-LICENSE.txt']) if (!seen.has(required)) throw new Error(`必要なファイルがありません: ${required}`);
  const pkg = JSON.parse(await fsp.readFile(path.join(payload, 'app/package.json'), 'utf8'));
  if (pkg.name !== 'favecus-player' || pkg.version !== manifest.version) throw new Error('バージョンが一致しません。');
  return manifest;
}
const InstallName = /^(?:FavecusPlayer|Favecus Player|FocusPlayer|Focus Player)$/i;
async function KnownInstallation(root) {
  let known = false;
  if (!(await NoLink(root))?.isDirectory()) return false;
  for (const name of ['runtime', CONFIG]) await NoLink(path.join(root, name));
  for (const name of [`${CONFIG}/favecus-player-install.json`, 'favecus-player-install.json', 'focus-player-install.json']) {
    const marker = path.join(root, name); await NoLink(marker);
    if (fs.existsSync(marker)) { const data = JSON.parse(await fsp.readFile(marker, 'utf8')); known ||= IsProduct(data.product); }
  }
  const legacy = path.join(root, 'package.json'); await NoLink(legacy);
  if (!known && fs.existsSync(legacy)) { const data = JSON.parse(await fsp.readFile(legacy, 'utf8')); known = IsProduct(data.name) && fs.existsSync(path.join(root, 'src/main.cjs')); }
  return known;
}
async function ResolveInstallRoot(selected, mode) {
  if (!['setup', 'patch'].includes(mode) || typeof selected !== 'string' || !selected.trim()) throw new Error('保存先を選択してください。');
  let root = path.resolve(selected);
  if (mode === 'setup' && !InstallName.test(path.basename(root)) && !await KnownInstallation(root)) root = path.join(root, 'FavecusPlayer');
  while (InstallName.test(path.basename(root)) && await KnownInstallation(root) && await KnownInstallation(path.dirname(root))) root = path.dirname(root);
  return root;
}
async function NestedInstallation(root, notes) {
  const nested = path.join(root, 'FavecusPlayer');
  if (!await KnownInstallation(nested) || !await OwnedApp(path.join(nested, 'app'))) return null;
  await Preflight(nested, 'patch');
  const allowed = new Set(['app', 'runtime', 'FavecusPlayer.exe', 'Maintenance.exe', 'active.txt', 'favecus-player-install.json', 'Start.cmd']);
  for (const name of await fsp.readdir(nested)) {
    const file = path.join(nested, name), stat = await NoLink(file);
    if (name === 'downloads' && stat.isDirectory() && !(await fsp.readdir(file)).length) continue;
    if (!allowed.has(name)) { notes.push('内側のFavecusPlayerには保存データまたは個人ファイルがあるため、そのまま残しました。'); return null; }
  }
  return nested;
}
async function Preflight(root, mode) {
  if (!['setup', 'patch'].includes(mode) || path.parse(root).root === root) throw new Error('Favecus Playerのフォルダーを選択してください。');
  for (let p = root; p !== path.dirname(p); p = path.dirname(p)) await NoLink(p);
  const stat = await NoLink(root); if (stat && !stat.isDirectory()) throw new Error('保存先がフォルダーではありません。');
  const known = await KnownInstallation(root);
  if (mode === 'patch' && !known) throw new Error('選択した場所はFavecus Playerのフォルダーではありません。0.1.0ではStart.cmdとpackage.jsonがある場所を選択してください。');
  if (!known && stat && (await fsp.readdir(root)).length) throw new Error('保存先に別のファイルがあります。空の保存先を選択してください。');
  for (const name of ['app', 'runtime', 'runtime/previous-installations', 'downloads', CONFIG, `${CONFIG}/active.txt`, `${CONFIG}/Maintenance.exe`, `${CONFIG}/Start.cmd`, 'active.txt', 'Start.cmd', 'FavecusPlayer.exe', 'FocusPlayer.exe', 'Maintenance.exe', '.backups']) await NoLink(path.join(root, name));
  if (fs.existsSync(path.join(root, 'app')) && !await OwnedApp(path.join(root, 'app'))) throw new Error('保存先のappフォルダーはFavecus Playerのものと確認できません。更新を中断しました。');
}
async function EnsureElectron(root, stage, progress, deps) {
  const target = path.join(root, 'runtime', `electron-${downloads.electron.version}`);
  await NoLink(target);
  const marker = path.join(target, '.favecus-download.json'), oldMarker = path.join(target, '.focus-download.json'); await NoLink(marker); await NoLink(oldMarker);
  const previous = await fsp.readFile(fs.existsSync(marker) ? marker : oldMarker, 'utf8').then(JSON.parse).catch(() => null);
  if (previous?.sha256 === downloads.electron.sha256 && ['electron.exe', 'icudtl.dat', 'resources.pak', 'ffmpeg.dll'].every(x => fs.existsSync(path.join(target, x)))) {
    await AtomicWrite(marker, JSON.stringify(previous)); await fsp.rm(oldMarker, { force: true }); return;
  }
  progress('Electron本体を取得しています…');
  const archive = path.join(stage, 'electron.zip'), directory = path.join(stage, 'electron');
  await deps.download(downloads.electron, archive, progress); await deps.extract(archive, directory);
  if (!fs.existsSync(path.join(directory, 'electron.exe'))) throw new Error('Electronの展開結果が正しくありません。');
  await fsp.writeFile(path.join(directory, '.favecus-download.json'), JSON.stringify({ sha256: downloads.electron.sha256 }));
  await ReplaceDirectory(directory, target, stage);
}
async function ReplaceDirectory(from, to, stage) {
  await NoLink(to);
  const backup = path.join(stage, `old-${randomUUID()}`), existed = fs.existsSync(to);
  if (existed) await fsp.rename(to, backup);
  try { await fsp.rename(from, to); }
  catch (error) {
    if (existed) {
      try { await fsp.rename(backup, to); }
      catch (rollbackError) { error.keepStage = true; error.message = `${error.message}（退避先 ${backup} の復元にも失敗しました: ${rollbackError.message}）`; }
    }
    throw error;
  }
}
async function EnsureFFmpeg(root, stage, progress, deps) {
  const target = path.join(root, 'runtime', 'ffmpeg'); await NoLink(target);
  const binary = path.join(target, 'ffmpeg.exe'); await NoLink(binary);
  if (fs.existsSync(binary) && await Hash(binary) === downloads.ffmpeg.binary.sha256 && fs.existsSync(path.join(target, 'LICENSE.txt'))) return;
  progress('WMAの取り込みに必要なFFmpegを取得しています…');
  const archive = path.join(stage, 'ffmpeg.gz'), directory = path.join(stage, 'ffmpeg');
  await fsp.mkdir(directory); await deps.download(downloads.ffmpeg.archive, archive, progress);
  const output = path.join(directory, 'ffmpeg.exe');
  await pipeline(fs.createReadStream(archive), createGunzip(), fs.createWriteStream(output, { flags: 'wx' }));
  if (await Hash(output) !== downloads.ffmpeg.binary.sha256) throw new Error('FFmpegの展開結果が一致しません。');
  await deps.download(downloads.ffmpeg.license, path.join(directory, 'LICENSE.txt'), progress);
  await deps.download(downloads.ffmpeg.readme, path.join(directory, 'README.txt'), progress);
  await ReplaceDirectory(directory, target, stage);
}
async function AtomicWrite(file, content) { const temp = `${file}.${randomUUID()}.tmp`; await fsp.writeFile(temp, content); try { await fsp.rename(temp, file); } finally { await fsp.rm(temp, { force: true }); } }
async function OwnedApp(directory, version) {
  try {
    if (!(await NoLink(directory))?.isDirectory()) return false;
    for (const name of ['package.json', 'src', 'src/main.cjs']) await NoLink(path.join(directory, name));
    const pkg = JSON.parse(await fsp.readFile(path.join(directory, 'package.json'), 'utf8'));
    return IsProduct(pkg.name) && /^\d+\.\d+\.\d+$/.test(pkg.version) && (!version || pkg.version === version) && (await fsp.stat(path.join(directory, 'src/main.cjs'))).isFile();
  } catch { return false; }
}
async function CleanOldVersions(root, progress) {
  let pending = false;
  for (const name of await fsp.readdir(root)) {
    const version = name.match(/^app-(\d+\.\d+\.\d+)-\d{10,16}$/)?.[1];
    if (!version || !await OwnedApp(path.join(root, name), version)) continue;
    try { await fsp.rm(path.join(root, name), { recursive: true, force: true }); } catch { pending = true; }
  }
  const backups = path.join(root, '.backups');
  if ((await NoLink(backups))?.isDirectory()) {
    for (const name of await fsp.readdir(backups)) {
      if (!/^\d{10,16}-[0-9a-f-]{36}$/.test(name)) continue;
      const folder = path.join(backups, name);
      try {
        if (!(await NoLink(folder))?.isDirectory()) continue;
        const names = await fsp.readdir(folder);
        if (names.some(x => !['FavecusPlayer.exe', 'FocusPlayer.exe', 'active.txt', 'favecus-player-install.json', 'focus-player-install.json', 'Start.cmd'].includes(x))) continue;
        for (const file of names) if (!(await NoLink(path.join(folder, file)))?.isFile()) throw new Error('Unknown backup');
        const marker = JSON.parse(await fsp.readFile(path.join(folder, fs.existsSync(path.join(folder, 'favecus-player-install.json')) ? 'favecus-player-install.json' : 'focus-player-install.json'), 'utf8'));
        if (IsProduct(marker.product)) await fsp.rm(folder, { recursive: true, force: true });
      } catch { pending = true; }
    }
    if (!(await fsp.readdir(backups)).length) await fsp.rmdir(backups);
  }
  if (pending) progress('使用中などで整理できなかった旧版があります。次の更新時にもう一度整理します。');
}
async function Commit(root, payload, manifest, stage, progress, hooks = {}) {
  const appName = 'app', appPath = path.join(root, appName);
  const backup = path.join(stage, 'rollback'); await fsp.mkdir(backup);
  await fsp.mkdir(path.join(root, CONFIG), { recursive: true });
  const affected = ['FavecusPlayer.exe', 'FocusPlayer.exe', 'active.txt', 'favecus-player-install.json', 'focus-player-install.json', 'Start.cmd', `${CONFIG}/active.txt`, `${CONFIG}/favecus-player-install.json`, `${CONFIG}/Start.cmd`];
  const old = new Map();
  for (const name of affected) {
    const target = path.join(root, name); await NoLink(target);
    const contents = await fsp.readFile(target).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
    old.set(name, contents); if (contents) { await fsp.mkdir(path.dirname(path.join(backup, name)), { recursive: true }); await fsp.writeFile(path.join(backup, name), contents); }
  }
  const stagedApp = path.join(stage, 'app'); await fsp.mkdir(stagedApp);
  for (const entry of manifest.files.filter(x => x.path.startsWith('app/'))) {
    const target = path.join(stagedApp, entry.path.slice(4)); await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.copyFile(path.join(payload, entry.path), target);
  }
  const notes = [], nested = await NestedInstallation(root, notes);
  let archived = null, movedOld = false, placedNew = false;
  try {
    if (await NoLink(appPath)) {
      if (!await OwnedApp(appPath)) throw new Error('既存のappフォルダーを確認できません。');
      await fsp.rename(appPath, path.join(backup, 'app')); movedOld = true;
    }
    await fsp.rename(stagedApp, appPath); placedNew = true;
    progress('新しいバージョンに切り替えています…');
    await AtomicWrite(path.join(root, 'FavecusPlayer.exe'), await fsp.readFile(path.join(payload, 'FavecusPlayer.exe')));
    await fsp.rm(path.join(root, 'FocusPlayer.exe'), { force: true });
    await fsp.rm(path.join(root, 'focus-player-install.json'), { force: true });
    await hooks.beforeSwitch?.();
    if (nested) {
      const folder = path.join(root, 'runtime/previous-installations'); await fsp.mkdir(folder, { recursive: true });
      const candidate = path.join(folder, `nested-${Date.now()}-${randomUUID()}`);
      await fsp.rename(nested, candidate); archived = candidate; await hooks.afterArchive?.();
      notes.push(`重複したプログラムを保管しました: ${archived}`);
    }
    const previous = JSON.parse(old.get(`${CONFIG}/favecus-player-install.json`)?.toString() || old.get('favecus-player-install.json')?.toString() || '{}');
    const previousRoots = [...new Set([...(previous.previousRoots || []), previous.previousRoot, hooks.previousRoot, nested].filter(p => typeof p === 'string' && path.isAbsolute(p)))].slice(-32);
    const archivedInstallations = [...(previous.archivedInstallations || []), ...(archived ? [{ from: nested, to: path.relative(root, archived) }] : [])].slice(-32);
    const previousRoot = hooks.previousRoot || JSON.parse(old.get(`${CONFIG}/favecus-player-install.json`)?.toString() || '{}').previousRoot || JSON.parse(old.get('favecus-player-install.json')?.toString() || '{}').previousRoot || null;
    await AtomicWrite(path.join(root, CONFIG, 'favecus-player-install.json'), JSON.stringify({ product: 'favecus-player', version: manifest.version, app: appName, previousRoot, previousRoots, archivedInstallations, installedAt: new Date().toISOString() }, null, 2));
    await AtomicWrite(path.join(root, CONFIG, 'Start.cmd'), `@echo off\r\nstart "" "%~dp0..\\..\\FavecusPlayer.exe"\r\nexit /b\r\n`);
    await AtomicWrite(path.join(root, CONFIG, 'active.txt'), `${appName}\r\n`);
    for (const name of ['active.txt', 'favecus-player-install.json', 'Start.cmd']) await fsp.rm(path.join(root, name), { force: true });
    await hooks.afterSwitch?.();
  } catch (error) {
    const failures = [];
    if (archived) { try { await fsp.rename(archived, nested); } catch (e) { failures.push(e); } }
    try {
      if (placedNew) await fsp.rm(appPath, { recursive: true, force: true });
      if (movedOld) await fsp.rename(path.join(backup, 'app'), appPath);
    } catch (e) { failures.push(e); }
    for (const [name, content] of old) {
      try { if (content !== null) await AtomicWrite(path.join(root, name), content); else await fsp.rm(path.join(root, name), { force: true }); }
      catch (e) { failures.push(e); }
    }
    if (failures.length) { error.keepStage = true; error.message += ` 復旧用ファイルを保管しました: ${backup}`; }
    throw error;
  }
  await CleanOldVersions(root, progress).catch(() => progress('旧版の整理が完了していません。新しいアプリへの更新は完了しています。'));
  return { version: manifest.version, app: appName, notes };
}
async function InstallCurrent({ root, payload, mode, progress = () => {}, dependencies = {} }) {
  root = path.resolve(root); payload = path.resolve(payload);
  await Preflight(root, mode); progress('更新ファイルを確認しています…');
  const manifest = await ValidatePayload(payload);
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(path.join(root, CONFIG), { recursive: true });
  const marker = path.join(root, CONFIG, 'favecus-player-install.json');
  if (![marker, path.join(root, 'favecus-player-install.json'), path.join(root, 'focus-player-install.json')].some(file => fs.existsSync(file))) await AtomicWrite(marker, JSON.stringify({ product: 'favecus-player', status: 'preparing' }));
  await fsp.mkdir(path.join(root, 'downloads'), { recursive: true });
  const lock = path.join(root, CONFIG, 'setup.lock');
  // Windows版の多重起動防止に加え、直接スクリプトを実行した場合も同時更新を防ぐ。
  let handle, stage, keepStage = false;
  for (const candidate of [path.join(root, '.setup-lock'), lock]) {
  await NoLink(candidate);
  if (fs.existsSync(candidate)) {
    const old = await fsp.readFile(candidate, 'utf8').then(JSON.parse).catch(() => null);
    let running = true;
    if (Number.isInteger(old?.pid) && old.pid > 0) { try { process.kill(old.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; } }
    else running = Date.now() - (await fsp.stat(candidate)).mtimeMs < 60000;
    if (running) throw new Error('別のセットアップが実行中です。終了後に再実行してください。');
    await fsp.rm(candidate); progress('中断されたセットアップから再開します。');
  }
  }
  try { handle = await fsp.open(lock, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('別のセットアップが実行中です。'); throw error; }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await handle.close(); handle = null;
    const deps = { download: Download, extract: ExtractZip, ...dependencies };
    const runtime = path.join(root, 'runtime'); await fsp.mkdir(runtime, { recursive: true });
    stage = await fsp.mkdtemp(path.join(runtime, '.setup-stage-'));
    const nodeDirectory = path.join(runtime, 'node'); await NoLink(nodeDirectory); await fsp.mkdir(nodeDirectory, { recursive: true });
    for (const name of ['node.exe', 'NODE-LICENSE.txt']) { await NoLink(path.join(nodeDirectory, name)); await AtomicWrite(path.join(nodeDirectory, name), await fsp.readFile(path.join(payload, 'bootstrap', name))); }
    if (deps.runtimes) await deps.runtimes(root, stage, progress);
    else {
      await EnsureElectron(root, stage, progress, deps); progress('Windowsのアプリ名・アイコンを設定しています…');
      await (deps.brand || Brand)({ directory: path.join(root, 'runtime', `electron-${downloads.electron.version}`), stage, donor: path.join(payload, 'FavecusPlayer.exe') });
      await EnsureFFmpeg(root, stage, progress, deps);
    }
    const result = await Commit(root, payload, manifest, stage, progress, deps);
    progress(`Favecus Player ${result.version} の準備が完了しました。`); return result;
  } catch (error) { keepStage = !!error.keepStage; throw error; }
  finally {
    try { await handle?.close(); } finally {
      try {
        if (stage && !keepStage) await fsp.rm(stage, { recursive: true, force: true }).catch(() => progress('更新用一時ファイルの一部を整理できませんでした。'));
      } finally { await fsp.rm(lock, { force: true }); }
    }
  }
}
async function Install(options) {
  const previousRoot = options.selection ? await ResolveInstallRoot(options.root, options.mode) : path.resolve(options.root);
  await Preflight(previousRoot, options.mode);
  await ValidatePayload(path.resolve(options.payload));
  const root = /^(?:FocusPlayer|Focus Player)$/i.test(path.basename(previousRoot)) ? path.join(path.dirname(previousRoot), 'FavecusPlayer') : previousRoot;
  const renamed = root !== previousRoot && fs.existsSync(previousRoot);
  if (renamed) {
    if (await NoLink(root)) throw new Error('同じ場所にFavecusPlayerフォルダーがあります。既存データを上書きせず更新を中断しました。');
    try { await fsp.rename(previousRoot, root); }
    catch { throw new Error('旧名フォルダーを変更できません。アプリを終了し（×ボタンでは通知領域に残ります。通知領域のアイコンを右クリックして「終了」を選びます）、Patch.exeを更新先フォルダーの外に置いて再実行してください。'); }
  }
  try {
    const result = await InstallCurrent({ ...options, root, dependencies: { ...options.dependencies, previousRoot: renamed ? previousRoot : null } });
    return { ...result, root };
  } catch (error) {
    if (renamed) {
      try { await fsp.rename(root, previousRoot); }
      catch { error.message += ` 保存データと復旧用ファイルは${root}に残っています。`; }
    }
    throw error;
  }
}
module.exports = { ResolveInstallRoot, Install, ValidatePayload, Preflight, Commit, Download, Hash, SafeRelative, PSQuote };
