'use strict';
// 基盤（json-file・crash-diagnostics・共通モジュール境界・main/UI分割契約）の統合テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { ReadJson, WriteJsonAtomic, RemoveFile } = require('../src/core/json-file.cjs');
const { StartCrashDiagnostics } = require('../src/core/crash-diagnostics.cjs');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('json-file ReadJson, WriteJsonAtomic, and RemoveFile handle missing, broken, nested, and blocked paths', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sample.json');
  assert.equal(ReadJson(file), null);
  fs.writeFileSync(file, '{broken json');
  assert.equal(ReadJson(file), null);
  fs.writeFileSync(file, JSON.stringify({ version: 1, items: ['a', 2] }));
  assert.deepEqual(ReadJson(file), { version: 1, items: ['a', 2] });

  const nested = path.join(dir, 'sub', 'data.json');
  assert.equal(WriteJsonAtomic(nested, { version: 1, count: 42 }), true);
  assert.deepEqual(ReadJson(nested), { version: 1, count: 42 });
  assert.deepEqual(fs.readdirSync(path.dirname(nested)), ['data.json']);

  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const blockedTarget = path.join(blocker, 'child.json');
  assert.equal(WriteJsonAtomic(blockedTarget, { version: 1 }), false);
  assert.equal(ReadJson(blockedTarget), null);

  const dirTarget = path.join(dir, 'existing-dir');
  fs.mkdirSync(dirTarget);
  assert.equal(WriteJsonAtomic(dirTarget, { version: 1 }), false);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);

  const rmFile = path.join(dir, 'remove.json');
  WriteJsonAtomic(rmFile, { ok: true });
  assert.equal(fs.existsSync(rmFile), true);
  RemoveFile(rmFile);
  assert.equal(fs.existsSync(rmFile), false);
  RemoveFile(rmFile);
});

test('crash diagnostics rotate logs without upload, annotate safely, and tolerate handler startup failure', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-crash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const directory = path.join(dir, 'runtime/logs');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'electron.log'), Buffer.alloc(4 * 1024 * 1024 + 1, 'x'));
  fs.writeFileSync(path.join(directory, 'electron.log.old'), 'old');
  const order = [], annotations = new Map();
  let options;
  const app = { getVersion: () => '0.6.3', getPath: () => assert.fail('Install root must be used'), commandLine: { appendSwitch: (name, value) => order.push([name, value]) }, setPath: (name, value) => order.push([name, value]) };
  const crashReporter = { start(value) { options = value; order.push(['start']); }, addExtraParameter: (key, value) => annotations.set(key, value) };
  const result = StartCrashDiagnostics({ app, crashReporter, installRoot: dir, runId: '27780-48437828' });
  assert.equal(result.started, true);
  assert.equal(options.uploadToServer, false);
  assert.equal(options.submitURL, undefined);
  assert.equal(options.globalExtra.favecus_run, '27780-48437828');
  assert.equal(options.globalExtra.favecus_version, '0.6.3');
  assert.deepEqual(order.at(-2), ['crashDumps', path.join(directory, 'crashes')]);
  assert.deepEqual(order.at(-1), ['start']);
  assert.equal(fs.statSync(path.join(directory, 'electron.log.old')).size, 4 * 1024 * 1024 + 1);
  assert.deepEqual(fs.readdirSync(dir), ['runtime']);
  result.Annotate({ event: 'track-change', video: 'a'.repeat(300), part: null });
  assert.equal(annotations.get('favecus_event'), 'track-change');
  assert.equal(annotations.get('favecus_video').length, 127);
  assert.equal(annotations.get('favecus_part'), '');

  const failRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-crash-failure-'));
  t.after(() => fs.rmSync(failRoot, { recursive: true, force: true }));
  const app2 = { getVersion: () => '0.6.3', getPath: () => failRoot, commandLine: { appendSwitch() {} }, setPath() {} };
  const failed = StartCrashDiagnostics({ app: app2, crashReporter: { start() { throw new Error('handler unavailable'); }, addExtraParameter() { assert.fail('Handler did not start'); } } });
  assert.equal(failed.started, false);
  assert.equal(failed.error, 'handler unavailable');
  assert.doesNotThrow(() => failed.Annotate({ event: 'play' }));
});

function commonRuntime() {
  const cache = new Map(), srcRoot = path.resolve(__dirname, '../src');
  function load(file) {
    file = path.resolve(srcRoot, file);
    assert.ok(file.startsWith(srcRoot + path.sep));
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} };
    cache.set(file, mod);
    const requireLocal = name => { assert.ok(name.startsWith('.'), `端末APIへの依存: ${name}`); return load(path.resolve(path.dirname(file), name)); };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module: mod, exports: mod.exports, require: requireLocal, URL, structuredClone, atob }, { filename: file });
    return mod.exports;
  }
  return { load, files: () => [...cache.keys()].map(file => path.relative(srcRoot, file)) };
}

test('common modules (validation, share, identity, search, queue, icon) run without Node APIs or DOM', () => {
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const runtime = commonRuntime();
  const format = runtime.load('core/library-data.cjs'), share = runtime.load('core/library-share.cjs');
  const search = runtime.load('ui/library-search.js'), identity = runtime.load('core/import-identity.cjs');
  const data = {
    version: 3, identityVersion: 2, videoAliases: [], rootPlaylistIds: [id(1)],
    playlists: [
      { id: id(1), name: '親', childIds: [id(2)], entries: [] },
      { id: id(2), name: '子', childIds: [], includeInAll: false, entries: [{ id: id(3), mediaId: id(4), type: 'bilibili', title: '曲', url: 'https://www.bilibili.com/video/av123/?p=2' }] },
    ],
  };
  const before = JSON.stringify(data), output = share.ShareData(data, 'information');
  assert.equal(output.playlists[1].entries[0].mediaId, id(4));
  assert.equal(share.ReadShare(output).mode, 'information');
  assert.equal(search.Page(search.Index(output), '曲 親').items[0].pathText, 'ホーム ＞ 親 ＞ 子');
  const plan = identity.PlanImportIdentity([], output.playlists, output.rootPlaylistIds, { keyOf: entry => entry.url, createId: () => id(9) });
  assert.ok(plan);
  assert.equal(JSON.stringify(data), before);
  assert.equal(format.ValidateLibrary(output)[1].id, id(2));
  assert.ok(!runtime.files().some(file => /store\.cjs|playlist-icon\.cjs$/.test(file)));
  assert.throws(() => format.ValidateLibrary(data, true, () => 'invalid'), /識別番号/);

  const { Queue } = commonRuntime().load('core/queue.cjs'), calls = [];
  const queue = new Queue(null, null, max => { calls.push(max); return max - 1; });
  const entries = [1, 2, 3].map(n => ({ id: id(n), playlistId: id(10), url: `av${n}` }));
  const first = queue.ShuffleStart(id(10), entries);
  assert.ok(entries.some(entry => entry.id === first));
  assert.ok(calls.length > 0);
  assert.equal(queue.Clone().Index(7), 6);
  assert.equal(calls.at(-1), 7);

  const { ValidateIcon } = commonRuntime().load('core/playlist-icon-data.cjs');
  const icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYl8AAAAASUVORK5CYII=';
  assert.equal(ValidateIcon(icon), icon);
  assert.equal(ValidateIcon(''), '');
  assert.throws(() => ValidateIcon('data:image/png;base64,AAAA'), /画像/);
  assert.throws(() => ValidateIcon('data:image/png;base64,AAA=='), /画像/);
});

test('UI app scripts and main IPC modules follow loading order, protocol allowlist, and ctx contracts', () => {
  const files = fs.readdirSync(path.join(root, 'src/ui/app')).filter(n => n.endsWith('.js')).sort();
  const html = read('src/ui/index.html'), main = read('src/main.cjs');
  const tags = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map(m => m[1]);
  const at = tags.indexOf('app/' + files[0]);
  assert.ok(at >= 0);
  assert.deepEqual(tags.slice(at, at + files.length + 1), [...files.map(n => 'app/' + n), 'app.js']);
  for (const name of [...files.map(n => 'app/' + n), 'app.js']) assert.ok(main.includes(`'${name}'`), `${name} が許可リストにない`);
  for (const name of files) assert.match(read('src/ui/app/' + name), /^'use strict';/);

  const mainDir = path.join(root, 'src/main');
  const body = main.slice(main.indexOf('function MakeContext()'), main.indexOf('async function Start()')).split('\r\n').join('\n');
  const provided = new Set([...body.matchAll(/get ([A-Za-z0-9_]+)\(\)/g)].map(m => m[1]));
  const list = /\n    ([A-Za-z0-9_, ]+)\n  \};/.exec(body);
  assert.ok(list);
  for (const name of list[1].split(',')) provided.add(name.trim());
  for (const m of main.matchAll(/\bctx\.([A-Za-z0-9_]+) = /g)) provided.add(m[1]);

  for (const file of fs.readdirSync(mainDir).filter(n => n.endsWith('.cjs'))) {
    assert.ok(main.includes(`require('./main/${file}')(ctx)`), `${file} が main.cjs から呼ばれていない`);
    const code = fs.readFileSync(path.join(mainDir, file), 'utf8');
    assert.doesNotMatch(code, /require\(['"]electron['"]\)/);
    assert.doesNotMatch(code, /require\(['"]\.\.?\/core\//);
    const taken = new Set([...code.matchAll(/\bS\.([A-Za-z0-9_]+)/g)].map(m => m[1]));
    const destructured = /const \{([^}]*)\} = ctx;/.exec(code);
    if (destructured) for (const name of destructured[1].split(',')) if (name.trim()) taken.add(name.trim());
    for (const name of taken) assert.ok(provided.has(name), `${file}: ctx に ${name} がない`);
  }
});

test('library:duration passes ctx.ffmpeg to LocalDuration and library:move-tracks updates playback title', async () => {
  const register = require('../src/main/ipc-library.cjs');
  const handlers = new Map(), emitted = [], accepted = [];
  let savedCount = 0, syncCount = 0, gotFfmpeg = null, gotFile = null;
  const entry = { id: 'e1', type: 'local', fileName: 'song.mp3', title: '移動前の曲' };
  const movedEntry = { id: 'e2', type: 'local', fileName: 'song.mp3', title: '移動後の曲' };
  const playlists = [{ id: 'p1', entries: [entry] }, { id: 'p2', entries: [] }];
  const ctx = {
    path, fs, MEDIA_EXTENSIONS: new Set(['.mp3']), ffmpeg: '/custom/ffmpeg',
    Handle: (ch, fn) => handlers.set(ch, fn),
    Emit: (name, value) => emitted.push({ name, value }),
    AcceptPlayback: value => accepted.push({ ...value }),
    SyncPlayingQueue: () => { syncCount++; },
    LocalDuration: async (ff, file) => { gotFfmpeg = ff; gotFile = file; return 185; },
    offline: { Find: () => null },
    current: { playlistId: 'p1', entryId: 'e1', entry: { ...entry } },
    playback: { title: '元の表示' },
    thumbnail: { entryId: 'e1' },
    store: {
      media: path.join(root, 'media'),
      data: { playlists },
      Entry: (pid, eid) => playlists.find(p => p.id === pid).entries.find(e => e.id === eid),
      Save: () => { savedCount++; },
      TransferMany: () => {
        playlists[1].entries.push(movedEntry);
        return { mappings: [{ playlistId: 'p1', entryId: 'e1', destinations: [{ playlistId: 'p2', entryId: 'e2' }] }], state: { playlists } };
      },
    },
  };
  register(ctx);

  const duration = await handlers.get('library:duration')('p1', 'e1');
  assert.equal(duration, 185);
  assert.equal(gotFfmpeg, '/custom/ffmpeg');
  assert.equal(gotFile, path.join(ctx.store.media, 'song.mp3'));
  assert.equal(entry.duration, 185);
  assert.equal(savedCount, 1);

  await handlers.get('library:move-tracks')({ entries: [{ playlistId: 'p1', entryId: 'e1' }], destinationIds: ['p2'] });
  assert.equal(ctx.current.playlistId, 'p2');
  assert.equal(ctx.current.entryId, 'e2');
  assert.equal(ctx.thumbnail.entryId, 'e2');
  assert.equal(ctx.playback.title, '移動後の曲');
  assert.equal(accepted.at(-1)?.title, '移動後の曲');
  assert.equal(syncCount, 1);
  assert.ok(emitted.some(e => e.name === 'current-update'));
});

test('local stores roll back in-memory state when WriteJsonAtomic fails', t => {
  const { AutoListSettingsStore } = require('../src/core/auto-list-settings-store.cjs');
  const { ListViewStore } = require('../src/core/list-views.cjs');
  const { OutputDeviceStore } = require('../src/core/output-device.cjs');
  const { SpeedStore } = require('../src/core/playback-speed.cjs');
  const { TrashStore } = require('../src/core/trash-store.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-local-rollback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const failWrite = (file, run) => {
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
    try { run(); } finally { fs.rmdirSync(file); }
  };

  const autoFile = path.join(dir, 'auto-list.json');
  const auto = new AutoListSettingsStore(autoFile);
  const initialAuto = auto.Get();
  failWrite(autoFile, () => assert.throws(() => auto.Set({ ...initialAuto, recentDays: 30 }), /保存できませんでした/));
  assert.deepEqual(auto.Get(), initialAuto);

  const listFile = path.join(dir, 'list-views.json');
  const listViews = new ListViewStore(listFile);
  failWrite(listFile, () => assert.throws(() => listViews.Set('pl1', { sort: 'count-desc', favorite: 'only' }), /保存できませんでした/));
  assert.equal(listViews.Get('pl1'), null);

  const outputFile = path.join(dir, 'output-device.json');
  const output = new OutputDeviceStore(outputFile);
  failWrite(outputFile, () => assert.throws(() => output.Set('Headphones'), /保存できませんでした/));
  assert.equal(output.Get(), '');

  const speedFile = path.join(dir, 'speed.json');
  const speed = new SpeedStore(speedFile);
  failWrite(speedFile, () => assert.throws(() => speed.Set(1.5), /保存できませんでした/));
  assert.equal(speed.Get(), 1);

  const trashFile = path.join(dir, 'trash.json');
  const trash = new TrashStore(trashFile, () => '2026-11-23T00:00:00.000Z');
  assert.equal(trash.Add({
    id: 'tr1', kind: 'entry', label: '曲1', deletedAt: '2026-11-23T00:00:00.000Z',
    playlistId: '00000000-0000-4000-8000-000000000001', index: 0,
    entry: { id: '00000000-0000-4000-8000-000000000002', type: 'local', fileName: 'a.mp3', title: '曲1' },
  }), true);
  failWrite(trashFile, () => {
    assert.equal(trash.Remove('tr1'), false);
    assert.equal(trash.Clear(), false);
  });
  assert.equal(trash.List().length, 1);
});

test('CI workflows, build script, and documentation invariants stay consistent', () => {
  const iosYml = read('.github/workflows/ios.yml');
  const winYml = read('.github/workflows/windows-build.yml');
  assert.match(iosYml, /release\/v(?:\*|0\.7\.6)/);
  assert.match(iosYml, /permissions:\s*\r?\n\s*contents:\s*read/);
  assert.match(iosYml, /node-version:\s*"24\.20\.0"/);
  assert.match(winYml, /release\/v(?:\*|0\.7\.6)/);

  assert.match(read('native/config.h'), /#ifndef ELECTRON_FOLDER[\s\S]*#define ELECTRON_FOLDER[\s\S]*#endif/);
  const buildWin = read('scripts/build-windows.py');
  assert.doesNotMatch(buildWin, /config\.h['"]\)\.write_text/);
  assert.match(buildWin, /-DELECTRON_FOLDER=L"/);

  assert.match(read('docs/GUIDE.md'), /^# Favecus Player v0\.7\.5 の使い方/);
  assert.match(read('docs/GUIDE.html'), /<h1>Favecus Player v0\.7\.5 の使い方<\/h1>/);
  assert.match(read('README.md'), /^# Favecus Player 0\.7\.5/);
  assert.match(read('README.md'), /Favecus-Player-0\.7\.5-Patch\.exe/);
  assert.doesNotMatch(read('docs/BUILD.md'), /今回のリリースは0\.6\.6/);
  assert.equal(fs.readFileSync(path.join(root, 'docs/DEVELOPMENT-STATUS.md')).includes(0), false);
});
