'use strict';
// ソースの文字列を見るテスト用：main.cjs は、src/main/*.cjs（IPCの登録を分けたもの）と合わせて読む。
const fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
function readAll(entry, folder, extension) {
  const parts = [], last = fs.readFileSync(path.join(root, entry), 'utf8');
  const dir = path.join(root, folder);
  if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir).sort()) if (name.endsWith(extension)) parts.push(fs.readFileSync(path.join(dir, name), 'utf8'));
  // main.cjs は先頭、app.js は最後（読み込み順）
  return (folder === 'src/main' ? [last, ...parts] : [...parts, last]).join('\n');
}
// 画面のスクリプトを、index.html と同じ順に、1つずつ（ブラウザと同じ読み込み方を、テストでも再現する）
function appScripts() {
  const dir = path.join(root, 'src/ui/app');
  return [...fs.readdirSync(dir).sort().map(n => fs.readFileSync(path.join(dir, n), 'utf8')), fs.readFileSync(path.join(root, 'src/ui/app.js'), 'utf8')];
}
module.exports = {
  appScripts,
  readMain: () => readAll('src/main.cjs', 'src/main', '.cjs'),
  readApp: () => readAll('src/ui/app.js', 'src/ui/app', '.js')
};
