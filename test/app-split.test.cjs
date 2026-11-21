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
        return {
          mappings: [{ playlistId: 'p1', entryId: 'e1', destinations: [{ playlistId: 'p2', entryId: 'e2' }] }],
          state: { playlists }
        };
      }
    }
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
