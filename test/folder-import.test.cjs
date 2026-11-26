'use strict';
// フォルダから追加（v0.7.4。PC版）：フォルダの走査・埋め込みタグの読み取り・追加の確認・確定後のアーティスト保存。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { ScanFolder } = require('../src/core/folder-scan.cjs');
const { ParseFfmetadata, ReadTags, TitleFrom } = require('../src/core/media-tags.cjs');
const registerLibraryIpc = require('../src/main/ipc-library.cjs');
const { Needs } = require('./support-env.cjs');
const { readMain } = require('./support-source.cjs');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-folder-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const rel = (root, files) => files.map(f => path.relative(root, f).split(path.sep).join('/'));

test('ScanFolder finds media in natural order, enforces limit/depth, and refuses non-folders', async t => {
  const root = temp(t);
  for (const name of ['10.mp3', '2.mp3', 'note.txt', 'cover.jpg', 'a/x.flac', 'a/b/y.mp4', 'a/b/c/z.wav']) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), 'x'); }
  const found = await ScanFolder(root);
  assert.deepEqual(rel(root, found.files), ['2.mp3', '10.mp3', 'a/b/c/z.wav', 'a/b/y.mp4', 'a/x.flac']);
  assert.equal(found.truncated, false); assert.equal(found.skipped, 0);

  const root2 = temp(t);
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root2, `s${i}.mp3`), 'x');
  const limited = await ScanFolder(root2, { limit: 3 });
  assert.equal(limited.files.length, 3); assert.equal(limited.truncated, true);
  fs.mkdirSync(path.join(root2, 'd1', 'd2'), { recursive: true }); fs.writeFileSync(path.join(root2, 'd1', 'd2', 'deep.mp3'), 'x');
  const shallow = await ScanFolder(root2, { maxDepth: 1 });
  assert.ok(!rel(root2, shallow.files).includes('d1/d2/deep.mp3')); assert.equal(shallow.skipped, 1);
  await assert.rejects(ScanFolder(path.join(root2, 's0.mp3')), /フォルダ/);
  await assert.rejects(ScanFolder(path.join(root2, 'missing')), /フォルダ/);
});

test('symbolic links are skipped, never followed', { skip: Needs.symlink }, async t => {
  const root = temp(t), outside = temp(t);
  fs.writeFileSync(path.join(outside, 'secret.mp3'), 'x'); fs.symlinkSync(outside, path.join(root, 'link'), 'dir'); fs.writeFileSync(path.join(root, 'ok.mp3'), 'x');
  const found = await ScanFolder(root);
  assert.deepEqual(rel(root, found.files), ['ok.mp3']); assert.equal(found.skipped, 1);
});

test('ffmetadata parsing, TitleFrom, and ReadTags read tags safely and handle failures/timeouts', async () => {
  const text = [';FFMETADATA1', 'TITLE=夜に駆ける', 'artist=YOASOBI', 'album=THE BOOK', 'comment=a\\=b\\;c', '', '[CHAPTER]', 'TIMEBASE=1/1000', 'title=チャプターの題名'].join('\n');
  assert.deepEqual(ParseFfmetadata(text), { title: '夜に駆ける', artist: 'YOASOBI', album: 'THE BOOK' });
  assert.deepEqual(ParseFfmetadata('album_artist=Group\ntitle=  a   b  '), { artist: 'Group', title: 'a b' });
  assert.deepEqual(ParseFfmetadata(''), {}); assert.deepEqual(ParseFfmetadata(null), {});
  assert.equal(ParseFfmetadata('title=' + 'x'.repeat(1000)).title.length, 300);
  assert.equal(TitleFrom({ title: '曲名' }, '/a/b/file.mp3'), '曲名');
  assert.equal(TitleFrom({}, '/a/b/file.mp3'), 'file');
  assert.equal(TitleFrom(undefined, 'C:\\music\\x.flac'.replace(/\\/g, '/')), 'x');

  const fake = (out, code = 0, hang = false) => (...args) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {}; fake.args = args;
    if (!hang) setImmediate(() => { child.stdout.emit('data', out); child.emit('close', code); });
    return child;
  };
  assert.deepEqual(await ReadTags('ffmpeg', 'a.mp3', { spawnFn: fake('title=T\nartist=A') }), { title: 'T', artist: 'A' });
  assert.ok(fake.args[1].includes('-f') && fake.args[1].includes('ffmetadata') && !fake.args[1].includes('-y'), '読み取りだけ');
  assert.deepEqual(await ReadTags('ffmpeg', 'a.mp3', { spawnFn: fake('title=T', 1) }), {});
  assert.deepEqual(await ReadTags('ffmpeg', 'a.mp3', { spawnFn: () => { throw new Error('no ffmpeg'); } }), {});
  assert.deepEqual(await ReadTags('ffmpeg', 'a.mp3', { spawnFn: fake('', 0, true), timeoutMs: 20 }), {});
});

test('the addition review reads tags (four at a time), uses title, keeps artist beside entry, and survives failures', async t => {
  const { AdditionReview } = require('../src/core/addition-review.cjs');
  const { Store } = require('../src/core/store.cjs');
  const dir = temp(t), root = temp(t), store = new Store(dir), review = new AdditionReview(store, {});
  const files = ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3', 'f.mp3'].map(name => { const file = path.join(root, name); fs.writeFileSync(file, 'x'); return file; });
  let active = 0, peak = 0;
  const describe = async file => {
    active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 15)); active--;
    if (file.endsWith('c.mp3')) throw new Error('reader failed');
    return file.endsWith('a.mp3') ? { title: 'タグの曲名', artist: '歌い手' } : {};
  };
  const plan = await review.PrepareFiles([store.data.playlists[0].id], files, { describe });
  assert.equal(plan.totalCount, 6);
  const items = review.plans.get(plan.id).items;
  assert.equal(items[0].entry.title, 'タグの曲名');
  assert.equal(items[0].artist, '歌い手');
  assert.equal(items[1].entry.title, 'b');
  assert.equal(items[2].entry.title, 'c');
  assert.equal(Object.hasOwn(items[0].entry, 'artist'), false);
  assert.ok(peak <= 4 && peak >= 2, `並行は4まで（実際 ${peak}）`);
});

test('IPC commit saves tag artists only for added songs once, and cancel forgets pending artists', async t => {
  const makeHarness = () => {
    const media = temp(t), source = temp(t);
    fs.writeFileSync(path.join(source, 'a.mp3'), 'x'); fs.writeFileSync(path.join(source, 'b.mp3'), 'x');
    const handlers = new Map(), saved = [], plans = new Map();
    const overrides = {
      Handle: (name, fn) => handlers.set(name, fn), fs, path, Emit: () => {}, SyncPlayingQueue: () => {},
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [source] }) },
      ScanFolder, ReadTags: async (_executable, file) => (file.endsWith('a.mp3') ? { title: 'タグの曲名', artist: '歌い手' } : {}),
      ffmpeg: 'ffmpeg', store: { media, Targets: () => [{ id: 'p' }] },
      notesStore: { Set: (key, record) => { saved.push([key, record]); } }, win: {},
      additionReview: {
        plans,
        PrepareFiles: async (_ids, files, options) => {
          const items = [];
          for (const file of files) { const info = await options.describe(file); items.push({ sourceFile: file, ...(info.artist ? { artist: info.artist } : {}), entry: { type: 'local', fileName: `${path.basename(file, '.mp3')}-id.mp3`, title: info.title || path.basename(file) } }); }
          plans.set('plan1', { items });
          return { id: 'plan1', totalCount: items.length, warnings: [] };
        },
        Commit: async () => { fs.writeFileSync(path.join(media, 'a-id.mp3'), 'x'); return { state: {} }; },
        Cancel: () => {}
      }
    };
    registerLibraryIpc(new Proxy({}, { get: (_target, key) => (key in overrides ? overrides[key] : () => {}) }));
    return { handlers, saved };
  };
  const h1 = makeHarness();
  const plan = await h1.handlers.get('library:prepare-folder')(['p']);
  await h1.handlers.get('library:commit-add')(plan.id, []);
  assert.deepEqual(h1.saved, [['local:a-id.mp3', { artist: '歌い手' }]]);

  const h2 = makeHarness();
  const cancelled = await h2.handlers.get('library:prepare-folder')(['p']);
  h2.handlers.get('library:cancel-add')(cancelled.id);
  await h2.handlers.get('library:commit-add')(cancelled.id, []);
  assert.deepEqual(h2.saved, []);
  const again = await h2.handlers.get('library:prepare-folder')(['p']);
  await h2.handlers.get('library:commit-add')(again.id, []);
  await h2.handlers.get('library:commit-add')(again.id, []);
  assert.equal(h2.saved.length, 1);
});

test('PC wiring: the folder dialog, the scan, the artist hand-off after commit, and the button', () => {
  const main = readMain();
  assert.match(main, /Handle\('library:prepare-folder'/);
  assert.match(main, /properties: \['openDirectory'\]/);
  assert.match(main, /ScanFolder\(selected\.filePaths\[0\]\)/);
  assert.match(main, /notesStore\?\.Set\('local:' \+ item\.fileName/);
  assert.match(main, /pendingArtists\.delete\(id\)/);
  assert.match(read('src/preloads/ui.cjs'), /prepareFolder: invoke\('library:prepare-folder'\)/);
  assert.doesNotMatch(read('src/ui/index.html'), /id="add-folder"/);
  assert.match(read('src/ui/app/02-add.js'), /CloseModal\(\); AddLocalFolder\(\)/);
});
