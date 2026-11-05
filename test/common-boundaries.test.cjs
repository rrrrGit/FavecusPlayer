'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function CommonRuntime() {
  const cache = new Map(), root = path.resolve(__dirname, '../src');
  function load(file) {
    file = path.resolve(root, file); assert.ok(file.startsWith(root + path.sep));
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const requireLocal = name => { assert.ok(name.startsWith('.'), `端末APIへの依存: ${name}`); return load(path.resolve(path.dirname(file), name)); };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, require: requireLocal, URL, structuredClone, atob }, { filename: file });
    return module.exports;
  }
  return { load, files: () => [...cache.keys()].map(file => path.relative(root, file)) };
}
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('common validation, sharing, identity and search run without Node APIs or DOM', () => {
  const runtime = CommonRuntime(), format = runtime.load('core/library-data.cjs'), share = runtime.load('core/library-share.cjs');
  const search = runtime.load('ui/library-search.js'), identity = runtime.load('core/import-identity.cjs');
  const data = { version: 3, identityVersion: 2, videoAliases: [], rootPlaylistIds: [id(1)], playlists: [
    { id: id(1), name: '親', childIds: [id(2)], entries: [] },
    { id: id(2), name: '子', childIds: [], includeInAll: false, entries: [{ id: id(3), mediaId: id(4), type: 'bilibili', title: '曲', url: 'https://www.bilibili.com/video/av123/?p=2' }] }
  ] };
  const before = JSON.stringify(data), output = share.ShareData(data, 'information');
  assert.equal(output.playlists[1].entries[0].mediaId, id(4)); assert.equal(share.ReadShare(output).mode, 'information');
  assert.equal(search.Page(search.Index(output), '曲 親').items[0].pathText, 'ホーム ＞ 親 ＞ 子');
  const plan = identity.PlanImportIdentity([], output.playlists, output.rootPlaylistIds, { keyOf: entry => entry.url, createId: () => id(9) });
  assert.ok(plan); assert.equal(JSON.stringify(data), before); assert.equal(format.ValidateLibrary(output)[1].id, id(2));
  assert.ok(!runtime.files().some(file => /store\.cjs|playlist-icon\.cjs$/.test(file)));
  assert.throws(() => format.ValidateLibrary(data, true, () => 'invalid'), /識別番号/);
});
test('portable queue retains an injected integer generator through cloning', () => {
  const { Queue } = CommonRuntime().load('core/queue.cjs'), calls = [], queue = new Queue(null, null, max => { calls.push(max); return max - 1; });
  const entries = [1, 2, 3].map(n => ({ id: id(n), playlistId: id(10), url: `av${n}` }));
  const first = queue.ShuffleStart(id(10), entries); assert.ok(entries.some(entry => entry.id === first)); assert.ok(calls.length > 0);
  assert.equal(queue.Clone().Index(7), 6); assert.equal(calls.at(-1), 7);
});
test('playlist PNG validation uses standard web APIs without Buffer or file access', () => {
  const { ValidateIcon } = CommonRuntime().load('core/playlist-icon-data.cjs');
  const icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYl8AAAAASUVORK5CYII=';
  assert.equal(ValidateIcon(icon), icon); assert.equal(ValidateIcon(''), '');
  assert.throws(() => ValidateIcon('data:image/png;base64,AAAA'), /画像/); assert.throws(() => ValidateIcon('data:image/png;base64,AAA=='), /画像/);
});
