'use strict';
const fs = require('node:fs');
const path = require('node:path');
const APP_ID = 'local.favecusplayer.desktop';

function RelaunchDetails(root, executable, appPath, icon) {
  const target = root ? path.win32.join(root, 'FavecusPlayer.exe') : executable;
  return { appId: APP_ID, appIconPath: root ? target : icon, appIconIndex: 0,
    relaunchCommand: root ? `"${target}"` : `"${target}" "${appPath}"`, relaunchDisplayName: 'Favecus Player' };
}

function PreviousInstallRoots(root) {
  for (const name of ['runtime/config/favecus-player-install.json', 'favecus-player-install.json']) {
    try { const m = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); if (m.product !== 'favecus-player') continue; return [...new Set([m.previousRoot, ...(Array.isArray(m.previousRoots) ? m.previousRoots : [])].filter(p => typeof p === 'string' && path.isAbsolute(p)))].slice(-32); } catch {}
  }
  return [];
}
function ConfigureTaskbar(win, app, shell, root) {
  if (process.platform !== 'win32') return;
  const icon = path.join(__dirname, '../../build/icon.ico');
  win.setAppDetails(RelaunchDetails(root, process.execPath, app.getAppPath(), icon));
  if (!root) return;
  const target = path.join(root, 'FavecusPlayer.exe');
  if (!fs.existsSync(target)) return;
  const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  fs.mkdirSync(programs, { recursive: true });
  const options = { target, cwd: root, args: '', description: 'Favecus Player', icon: target, iconIndex: 0, appUserModelId: APP_ID };
  const normalize = value => path.resolve(value).toLowerCase();
  const ownedTargets = new Set([root, ...PreviousInstallRoots(root)].filter(Boolean).flatMap(folder => ['FavecusPlayer.exe', 'FocusPlayer.exe'].map(name => normalize(path.join(folder, name)))));
  for (const directory of [programs, app.getPath('desktop')]) {
    const file = path.join(directory, 'Favecus Player.lnk'), legacy = path.join(directory, 'Focus Player.lnk');
    let oldOwned = false;
    try { oldOwned = ownedTargets.has(normalize(shell.readShortcutLink(legacy).target)); } catch {}
    if (fs.existsSync(file)) {
      let existing; try { existing = shell.readShortcutLink(file); } catch { continue; }
      if (!ownedTargets.has(normalize(existing.target))) continue;
      if (!shell.writeShortcutLink(file, 'update', options)) throw new Error('ショートカットを更新できませんでした。');
    } else if (directory === programs || oldOwned) {
      if (!shell.writeShortcutLink(file, 'create', options)) throw new Error('ショートカットを作成できませんでした。');
    }
    if (oldOwned && fs.existsSync(file) && normalize(shell.readShortcutLink(file).target) === normalize(target)) fs.unlinkSync(legacy);
  }

}
module.exports = { APP_ID, RelaunchDetails, ConfigureTaskbar, PreviousInstallRoots };
