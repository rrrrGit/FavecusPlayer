'use strict';
// フォルダから追加（v0.7.4。PC版）：フォルダの走査・埋め込みタグの読み取り・追加の確認への組み込み。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { ScanFolder } = require('../src/core/folder-scan.cjs');
const { ParseFfmetadata, ReadTags, TitleFrom } = require('../src/core/media-tags.cjs');
const { Needs } = require('./support-env.cjs');
const { readMain } = require('./support-source.cjs');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-folder-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const rel = (root, files) => files.map(f => path.relative(root, f).split(path.sep).join('/'));

test('the scan finds media files in subfolders in natural order and ignores other files', async t => {
  const root = temp(t);
  for (const name of ['10.mp3', '2.mp3', 'note.txt', 'cover.jpg', 'a/x.flac', 'a/b/y.mp4', 'a/b/c/z.wav']) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), 'x'); }
  const found = await ScanFolder(root);
  assert.deepEqual(rel(root, found.files), ['2.mp3', '10.mp3', 'a/b/c/z.wav', 'a/b/y.mp4', 'a/x.flac']);
  assert.equal(found.truncated, false);
  assert.equal(found.skipped, 0);
});

test('the scan stops at the limit and says so, respects the depth limit, and refuses a non-folder', async t => {
  const root = temp(t);
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `s${i}.mp3`), 'x');
  const limited = await ScanFolder(root, { limit: 3 });
  assert.equal(limited.files.length, 3); assert.equal(limited.truncated, true);
  fs.mkdirSync(path.join(root, 'd1', 'd2'), { recursive: true }); fs.writeFileSync(path.join(root, 'd1', 'd2', 'deep.mp3'), 'x');
  const shallow = await ScanFolder(root, { maxDepth: 1 });
  assert.ok(!rel(root, shallow.files).includes('d1/d2/deep.mp3')); assert.equal(shallow.skipped, 1);
  await assert.rejects(ScanFolder(path.join(root, 's0.mp3')), /フォルダ/);
  await assert.rejects(ScanFolder(path.join(root, 'missing')), /フォルダ/);
});

test('symbolic links are skipped, never followed', { skip: Needs.symlink }, async t => {
  const root = temp(t), outside = temp(t);
  fs.writeFileSync(path.join(outside, 'secret.mp3'), 'x'); fs.symlinkSync(outside, path.join(root, 'link'), 'dir'); fs.writeFileSync(path.join(root, 'ok.mp3'), 'x');
  const found = await ScanFolder(root);
  assert.deepEqual(rel(root, found.files), ['ok.mp3']); assert.equal(found.skipped, 1);
});

test('ffmetadata output gives title, artist and album; escapes are undone; only file-level tags count', () => {
  const text = [';FFMETADATA1', 'TITLE=夜に駆ける', 'artist=YOASOBI', 'album=THE BOOK', 'comment=a\\=b\\;c', '', '[CHAPTER]', 'TIMEBASE=1/1000', 'title=チャプターの題名'].join('\n');
  assert.deepEqual(ParseFfmetadata(text), { title: '夜に駆ける', artist: 'YOASOBI', album: 'THE BOOK' });
  assert.deepEqual(ParseFfmetadata('album_artist=Group\ntitle=  a   b  '), { artist: 'Group', title: 'a b' });
  assert.deepEqual(ParseFfmetadata(''), {});
  assert.deepEqual(ParseFfmetadata(null), {});
  assert.equal(ParseFfmetadata('title=' + 'x'.repeat(1000)).title.length, 300);
  assert.equal(TitleFrom({ title: '曲名' }, '/a/b/file.mp3'), '曲名');
  assert.equal(TitleFrom({}, '/a/b/file.mp3'), 'file');
  assert.equal(TitleFrom(undefined, 'C:\\music\\x.flac'.replace(/\\/g, '/')), 'x');
});

test('ReadTags runs ffmpeg read-only, returns the tags, and returns empty on failure, a missing program or a timeout', async () => {
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

test('the addition review reads tags for each file (four at a time), uses the title, keeps the artist beside the entry and survives a failing reader', async t => {
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
  assert.equal(items[1].entry.title, 'b', 'タグがなければ、ファイル名');
  assert.equal(items[2].entry.title, 'c', '読み取りに失敗しても、ファイル名で続ける');
  assert.equal(Object.hasOwn(items[0].entry, 'artist'), false, 'アーティストは、曲のデータには入れない');
  assert.ok(peak <= 4 && peak >= 2, `並行は4まで（実際 ${peak}）`);
});

test('PC wiring: the folder dialog, the scan, the artist hand-off after commit, and the button', () => {
  const main = readMain();
  assert.match(main, /Handle\('library:prepare-folder'/);
  assert.match(main, /properties: \['openDirectory'\]/);
  assert.match(main, /ScanFolder\(selected\.filePaths\[0\]\)/);
  assert.match(main, /notesStore\?\.Set\('local:' \+ item\.fileName/);
  assert.match(main, /pendingArtists\.delete\(id\)/);
  assert.match(read('src/preloads/ui.cjs'), /prepareFolder: invoke\('library:prepare-folder'\)/);
  assert.doesNotMatch(read('src/ui/index.html'), /id="add-folder"/, '追加のボタンの並び（指定）は変えない');
  assert.match(read('src/ui/app/02-add.js'), /CloseModal\(\); AddLocalFolder\(\)/, '「ファイル追加」の画面の中から開く');
});
