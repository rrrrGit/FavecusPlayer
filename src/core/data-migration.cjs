'use strict';
const fs = require('node:fs'), path = require('node:path');
function RenameOwnedFolder(from, to) {
  if (!fs.existsSync(from)) return;
  if (!fs.lstatSync(from).isDirectory() || fs.lstatSync(from).isSymbolicLink()) throw new Error('保存フォルダーを確認できません。');
  if (fs.existsSync(to)) {
    if (fs.lstatSync(to).isSymbolicLink() || !fs.lstatSync(to).isDirectory() || fs.readdirSync(to).length) throw new Error('旧名と新名の保存フォルダーが両方あります。上書きを避けるため移行を中断しました。');
    fs.rmdirSync(to);
  }
  fs.renameSync(from, to);
}
function PrepareDataDirectory(appData) {
  const directory = path.join(appData, 'Favecus Player');
  RenameOwnedFolder(path.join(appData, 'Focus Player'), directory);
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('リンク先の保存フォルダーは使用できません。');
  fs.mkdirSync(directory, { recursive: true });
  for (const service of ['bilibili', 'youtube']) RenameOwnedFolder(path.join(directory, 'Partitions', `focus-${service}`), path.join(directory, 'Partitions', `favecus-${service}`));
  return directory;
}
module.exports = { PrepareDataDirectory };
