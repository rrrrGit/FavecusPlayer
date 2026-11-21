'use strict';
// 画面（app.js）と main の分割：読み込み・許可リスト・分けたファイルの取りこぼしがないこと。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('every src/ui/app/*.js file is loaded by index.html in order, before app.js, and served by the app protocol', () => {
  const files = fs.readdirSync(path.join(root, 'src/ui/app')).filter(n => n.endsWith('.js')).sort();
  const html = read('src/ui/index.html'), main = read('src/main.cjs');
  const tags = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map(m => m[1]);
  const at = tags.indexOf('app/' + files[0]);
  assert.ok(at >= 0);
  assert.deepEqual(tags.slice(at, at + files.length + 1), [...files.map(n => 'app/' + n), 'app.js'], '読み込み順：分けたファイル → app.js');
  for (const name of [...files.map(n => 'app/' + n), 'app.js']) assert.ok(main.includes(`'${name}'`), `${name} が、許可リストにない`);
  for (const name of files) assert.match(read('src/ui/app/' + name), /^'use strict';/, `${name} の先頭に 'use strict'`);
});

test('every src/main/*.cjs module is required by main.cjs with the shared context and only reads state through it', () => {
  const dir = path.join(root, 'src/main'), main = read('src/main.cjs');
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.cjs'))) {
    assert.ok(main.includes(`require('./main/${name}')(ctx)`), `${name} が、main.cjs から呼ばれていない`);
    const code = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.doesNotMatch(code, /require\(['"]electron['"]\)/, `${name} は electron を直接読まない（ctx から受け取る）`);
    assert.doesNotMatch(code, /require\(['"]\.\.?\/core\//, `${name} は core を直接読まない（main.cjs 経由。テストの差し替えを保つ）`);
  }
});

test('every name an ipc module takes from ctx (destructured or S.name) is provided by MakeContext or assigned to ctx in main.cjs', () => {
  const main = read('src/main.cjs');
  const body = main.slice(main.indexOf('function MakeContext()'), main.indexOf('async function Start()')).split('\r\n').join('\n');
  const provided = new Set([...body.matchAll(/get ([A-Za-z0-9_]+)\(\)/g)].map(m => m[1]));
  const list = /\n    ([A-Za-z0-9_, ]+)\n  \};/.exec(body);
  assert.ok(list, 'MakeContext の名前の一覧');
  for (const name of list[1].split(',')) provided.add(name.trim());
  for (const m of main.matchAll(/\bctx\.([A-Za-z0-9_]+) = /g)) provided.add(m[1]);
  const dir = path.join(root, 'src/main');
  for (const file of fs.readdirSync(dir).filter(n => n.endsWith('.cjs'))) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8');
    const taken = new Set([...code.matchAll(/\bS\.([A-Za-z0-9_]+)/g)].map(m => m[1]));
    const destructured = /const \{([^}]*)\} = ctx;/.exec(code);
    if (destructured) for (const name of destructured[1].split(',')) if (name.trim()) taken.add(name.trim());
    for (const name of taken) assert.ok(provided.has(name), `${file}: ctx に ${name} がない`);
  }
});
