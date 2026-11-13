'use strict';
// 端末共通のJSを、requireのないJavaScriptCore（iOS）でも読める単一ファイルへまとめる。
// 許可リスト外・非相対のrequireは失敗させ、端末APIへの依存が混ざらないようにする。
// URL・atob・structuredCloneはshared/runtime/prelude.jsの実装を、各モジュールの引数として渡す。
const fs = require('node:fs'), path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
// バンドル内の仮想パス → 実ファイル。ランナーが ../core/... で参照できるよう、srcと同じ階層に揃える。
const MODULES = {
  'core/library-data.cjs': 'src/core/library-data.cjs',
  'core/library-identity.cjs': 'src/core/library-identity.cjs',
  'core/device-media.cjs': 'src/core/device-media.cjs',
  'core/sync-clock.cjs': 'src/core/sync-clock.cjs',
  'core/sync-order.cjs': 'src/core/sync-order.cjs',
  'core/sync-state.cjs': 'src/core/sync-state.cjs',
  'core/sync-library.cjs': 'src/core/sync-library.cjs',
  'core/sync-engine.cjs': 'src/core/sync-engine.cjs',
  'core/sync-supabase.cjs': 'src/core/sync-supabase.cjs',
  'core/media-identity.cjs': 'src/core/media-identity.cjs',
  'core/urls.cjs': 'src/core/urls.cjs',
  'core/library-share.cjs': 'src/core/library-share.cjs',
  'core/import-identity.cjs': 'src/core/import-identity.cjs',
  'core/playlist-icon-data.cjs': 'src/core/playlist-icon-data.cjs',
  'core/queue.cjs': 'src/core/queue.cjs',
  'ui/library-tree.js': 'src/ui/library-tree.js',
  'ui/library-search.js': 'src/ui/library-search.js',
  'runtime/prelude.js': 'shared/runtime/prelude.js',
  'runtime/fixture-runner.js': 'shared/runtime/fixture-runner.js'
};
function Resolve(from, name) {
  if (!name.startsWith('.')) throw new Error(`端末APIへの依存（非相対のrequire）: ${name} in ${from}`);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), name));
  if (!Object.prototype.hasOwnProperty.call(MODULES, resolved)) throw new Error(`許可リスト外のモジュール: ${resolved} (from ${from})`);
  return resolved;
}
function Build(options = {}) {
  const parts = [];
  for (const [virtual, file] of Object.entries(MODULES)) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^﻿/, '');
    for (const match of source.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)) Resolve(virtual, match[2]);
    // 期待値生成用（native）：Node本来のWeb APIを使い、polyfillの代わりにする。
    const body = options.native && virtual === 'runtime/prelude.js'
      ? 'module.exports = { URL: globalThis.URL, atob: globalThis.atob, structuredClone: globalThis.structuredClone };'
      : source;
    parts.push(`${JSON.stringify(virtual)}: function (module, exports, require, URL, atob, structuredClone) {\n${body}\n}`);
  }
  return `'use strict';
// 生成物：scripts/build-shared-bundle.cjs。直接編集しない。
(function (global) {
  var defs = {
${parts.join(',\n')}
  };
  var cache = {};
  function normalize(from, name) {
    var out = from.split('/').slice(0, -1);
    name.split('/').forEach(function (part) { if (part === '..') out.pop(); else if (part !== '.' && part !== '') out.push(part); });
    return out.join('/');
  }
  function load(name) {
    if (cache[name]) return cache[name].exports;
    if (!Object.prototype.hasOwnProperty.call(defs, name)) throw new Error('unknown module: ' + name);
    var module = { exports: {} }; cache[name] = module;
    var prelude = name === 'runtime/prelude.js' ? null : load('runtime/prelude.js');
    var req = function (request) { return load(normalize(name, request)); };
    var args = prelude ? [prelude.URL, prelude.atob, prelude.structuredClone] : [undefined, undefined, undefined];
    defs[name].apply(module.exports, [module, module.exports, req].concat(args));
    return module.exports;
  }
  function runner() { return load('runtime/fixture-runner.js'); }
  global.FavecusCore = {
    load: load,
    RunCases: function (json) { return runner().RunCases(json); },
    Observe: function (json) { return runner().Observe(json); },
    Bench: function (json) { return runner().Bench(json); }
  };
})(globalThis);
`;
}
if (require.main === module) {
  const out = path.join(ROOT, 'shared', 'dist', 'favecus-core.js');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Build());
  console.log(`wrote ${path.relative(ROOT, out)}`);
}
module.exports = { Build, MODULES };
