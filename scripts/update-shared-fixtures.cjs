'use strict';
// shared/fixtures/cases.json の expect / expectError を、NodeのWeb API（本物のURL等）で実行した結果から更新する。
// 期待値の正本はWindows版（Node）の挙動。生成後の差分は必ず目視で確認してからコミットする。
// 使い方: node scripts/update-shared-fixtures.cjs [--write]
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { Build } = require('./build-shared-bundle.cjs');
const file = path.resolve(__dirname, '../shared/fixtures/cases.json');
const cases = JSON.parse(fs.readFileSync(file, 'utf8'));
const context = vm.createContext({ URL, atob, structuredClone });
vm.runInContext(Build({ native: true }), context, { filename: 'favecus-core.native.js' });
context.cases = JSON.stringify(cases);
const observed = JSON.parse(vm.runInContext('FavecusCore.Observe(cases)', context));
let changed = 0;
const next = cases.map((testCase, i) => {
  const { name, call, args, divergence } = testCase, seen = observed[i], out = { name, call, args };
  if (divergence) out.divergence = divergence;
  if ('error' in seen) out.expectError = seen.error; else out.expect = seen.ok;
  if (JSON.stringify(out) !== JSON.stringify(testCase)) changed++;
  return out;
});
if (process.argv.includes('--write')) { fs.writeFileSync(file, JSON.stringify(next, null, 1) + '\n'); console.log(`updated ${changed} of ${cases.length} cases`); }
else console.log(`${changed} of ${cases.length} cases would change (use --write)`);
