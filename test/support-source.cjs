'use strict';
// ソースの文字列を見るテスト用：main.cjs は、src/main/*.cjs（IPCの登録を分けたもの）と合わせて読む。
const fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
function readAll(entry, folder, extension) {
  const parts = [fs.readFileSync(path.join(root, entry), 'utf8')];
  const dir = path.join(root, folder);
  if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir).sort()) if (name.endsWith(extension)) parts.push(fs.readFileSync(path.join(dir, name), 'utf8'));
  return parts.join('\n');
}
module.exports = {
  readMain: () => readAll('src/main.cjs', 'src/main', '.cjs'),
  readApp: () => readAll('src/ui/app.js', 'src/ui/app', '.js')
};
