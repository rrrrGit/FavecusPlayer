'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, ValidateSettings } = require('../src/core/store.cjs');
const { TitleCleaner, ValidateTitleWords, DEFAULT_TITLE_WORDS } = require('../src/core/title-cleanup.cjs');
function Lists(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-044-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'data')), source = store.data.activePlaylistId;
  store.Apply({ type: 'create', name: 'A' }); const a = store.data.activePlaylistId;
  store.Apply({ type: 'create', name: 'B' }); const b = store.data.activePlaylistId;
  return { root, store, source, a, b };
}
test('title cleanup removes literal phrases, not their individual characters, and keeps bracket contents', () => {
  const clean = TitleCleaner(DEFAULT_TITLE_WORDS);
  assert.equal(clean('【純K投屏】 [ニコカラ] 「刻ト詩」'), '刻ト詩');
  assert.equal(clean('ニコとカラフル / 樱之刻 🎵 𠮷'), 'ニコとカラフル / 樱之刻 🎵 𠮷');
  assert.equal(TitleCleaner(['.*', 'a+b', '$1', '(注)', '\\'])('曲.* a+b $1 (注)\\'), '曲');
  assert.equal(TitleCleaner(['nico', 'nicokara'])('NICOKARA 曲 Nico'), '曲');
  assert.deepEqual(ValidateTitleWords([' ニコカラ ', '純K投屏', '純k投屏']), ['ニコカラ', '純K投屏']);
  const cascade = TitleCleaner(['ab', 'xx']); assert.equal(cascade(cascade('曲 axxb')), cascade('曲 axxb'));
  assert.equal(clean('ニコカラ'), ''); assert.equal(TitleCleaner([])('[曲名]'), '[曲名]');
});
test('one URL batch targets multiple checked playlists with independent deduplication and IDs', t => {
  const { store, source, a, b } = Lists(t);
  store.Apply({ type: 'add', playlistId: a, urls: 'https://www.bilibili.com/video/av123/?p=2', title: '既存の曲名' });
  const existing = store.Playlist(a).entries[0];
  store.Apply({ type: 'add-videos', destinationIds: [source, a, b, b], videos: [{ url: 'https://www.bilibili.com/video/av123/?p=2&share_source=x', title: '[ニコカラ] 新しい曲名' }, { url: 'av123', title: '「先頭」' }, { url: 'av123', title: '重複' }] });
  assert.deepEqual(store.data.playlists.map(p => p.entries.length), [2, 2, 2]);
  assert.equal(store.Playlist(a).entries[0].id, existing.id); assert.equal(existing.title, '既存の曲名');
  assert.deepEqual(store.Playlist(b).entries.map(e => e.title), ['新しい曲名', '先頭']);
  assert.deepEqual(store.Playlist(b).entries.map(e => e.part), [2, 1]);
  assert.equal(new Set(store.data.playlists.flatMap(p => p.entries.map(e => e.id))).size, 6);
  assert.equal(store.data.activePlaylistId, b);
});
test('multiple existing songs from different playlists copy together, retaining one shared local file', async t => {
  const { root, store, source, a, b } = Lists(t), file = path.join(root, '[ニコカラ] 樱之刻.mp3'); fs.writeFileSync(file, 'media');
  await store.AddFiles(source, [file]); store.Apply({ type: 'add', playlistId: a, urls: 'av456', title: '「刻ト詩」' });
  const local = store.Playlist(source).entries[0], online = store.Playlist(a).entries[0];
  store.Apply({ type: 'add-existing', entries: [{ playlistId: source, entryId: local.id }, { playlistId: a, entryId: online.id }, { playlistId: a, entryId: online.id }], destinationIds: [source, b] });
  assert.equal(store.Playlist(a).entries.length, 1); assert.equal(store.Playlist(source).entries.length, 2); assert.equal(store.Playlist(b).entries.length, 2);
  assert.equal(store.Playlist(b).entries[0].fileName, local.fileName); assert.equal(fs.readdirSync(store.media).length, 1);
  const loaded = new Store(store.directory); assert.equal(loaded.Playlist(b).entries[0].title, '樱之刻');
  assert.equal(fs.readFileSync(path.join(loaded.media, local.fileName), 'utf8'), 'media');
  const { folder } = await loaded.Export(root); const next = new Store(path.join(root, 'imported')); await next.Import(path.join(folder, 'favecus-player-library.json'));
  assert.equal(fs.readdirSync(next.media).length, 1); assert.equal(next.data.playlists.flatMap(p => p.entries).filter(e => e.type === 'local').length, 2);
});
test('every destination, source reference, URL and global capacity validates before batch changes', t => {
  const { store, source, a, b } = Lists(t);
  store.Apply({ type: 'add', playlistId: source, urls: 'av123' });
  const ref = { playlistId: source, entryId: store.Playlist(source).entries[0].id }, before = store.Snapshot(), disk = fs.readFileSync(store.file);
  for (const destinationIds of [[], [a, 'missing'], [a, null]]) assert.throws(() => store.Apply({ type: 'add', destinationIds, urls: 'av456' }));
  assert.throws(() => store.Apply({ type: 'add-existing', destinationIds: [a, b], entries: [ref, { ...ref, entryId: 'missing' }] }));
  assert.throws(() => store.Apply({ type: 'add-videos', destinationIds: [a, b], videos: [{ url: 'av456' }, { url: 'https://evil.example/video' }] }));
  assert.deepEqual(store.Snapshot(), before); assert.deepEqual(fs.readFileSync(store.file), disk);
  const save = store.Save; store.Save = () => { throw new Error('disk full'); };
  assert.throws(() => store.Apply({ type: 'add-existing', destinationIds: [a, b], entries: [ref] }), /disk full/); store.Save = save;
  assert.deepEqual(store.Snapshot(), before); assert.deepEqual(fs.readFileSync(store.file), disk);
  store.Playlist(source).entries = Array.from({ length: 9999 }, (_, i) => ({ ...before.playlists[0].entries[0], id: `id-${i}` }));
  assert.throws(() => store.Apply({ type: 'add-existing', destinationIds: [a, b], entries: [{ playlistId: source, entryId: 'id-0' }] }), /10000/);
  assert.equal(store.Playlist(a).entries.length, 0); assert.equal(store.Playlist(b).entries.length, 0);
});
test('adding a phrase renames all existing titles without changing references, settings or playback order', async t => {
  const { root, store, source, a, b } = Lists(t), file = path.join(root, 'TEST 曲.mp3'); fs.writeFileSync(file, 'bytes');
  await store.AddFiles(source, [file]);
  store.Apply({ type: 'add-videos', destinationIds: [a, b], videos: [{ url: 'https://www.bilibili.com/video/av123/?p=3', title: 'TEST 樱之刻 🎵' }, { url: 'av456', title: 'TEST 刻ト詩' }] });
  store.Apply({ type: 'settings', settings: { volume: .43, taskbarWidth: 480, discordClientId: '123456789012345678' } });
  const before = store.Snapshot();
  store.Apply({ type: 'settings', settings: { titleCleanupWords: [...store.data.settings.titleCleanupWords, 'TEST'] } });
  for (const list of before.playlists) for (const entry of list.entries) {
    const { missing, ...original } = entry;
    assert.deepEqual(store.Entry(list.id, entry.id), { ...original, title: entry.title.replace('TEST ', '') });
  }
  assert.equal(store.data.settings.volume, .43); assert.equal(store.data.settings.taskbarWidth, 480);
  const loaded = new Store(store.directory); assert.deepEqual(loaded.Snapshot(), store.Snapshot());
  loaded.Apply({ type: 'settings', settings: { titleCleanupWords: [] } });
  loaded.Apply({ type: 'add', playlistId: a, urls: 'av777', title: '[ニコカラ] TEST 新曲' });
  const reloaded = new Store(loaded.directory); assert.equal(reloaded.Playlist(a).entries.at(-1).title, '[ニコカラ] TEST 新曲');
  assert.equal(reloaded.Playlist(a).entries[0].title, '樱之刻 🎵'); assert.deepEqual(reloaded.data.settings.titleCleanupWords, []);
});
test('invalid phrases and failed settings saves leave both titles and persisted settings intact', t => {
  const { store, a } = Lists(t); store.Apply({ type: 'add', playlistId: a, urls: 'av123', title: 'TEST 曲' });
  const before = store.Snapshot(), disk = fs.readFileSync(store.file);
  for (const words of [null, 'TEST', [''], [' '.repeat(3)], ['x'.repeat(81)], [false], Array(201).fill('x')]) assert.throws(() => store.Apply({ type: 'settings', settings: { titleCleanupWords: words } }));
  assert.deepEqual(store.Snapshot(), before);
  const save = store.Save; store.Save = () => { throw new Error('disk full'); };
  assert.throws(() => store.Apply({ type: 'settings', settings: { titleCleanupWords: ['TEST'] } }), /disk full/); store.Save = save;
  assert.deepEqual(store.Snapshot(), before); assert.deepEqual(fs.readFileSync(store.file), disk);
  assert.deepEqual(ValidateSettings({ titleCleanupWords: [] }).titleCleanupWords, []);
});
test('older libraries acquire the default phrases once while preserving original backup and schema', t => {
  const { store, a } = Lists(t); store.Apply({ type: 'add', playlistId: a, urls: 'av123' });
  const old = store.Snapshot(); delete old.settings.titleCleanupWords; old.playlists[1].entries[0].title = '【純K投屏】「刻ト詩」';
  const bytes = JSON.stringify(old); fs.writeFileSync(store.file, bytes);
  const next = new Store(store.directory); assert.equal(next.Playlist(a).entries[0].title, '刻ト詩'); assert.equal(next.data.version, 3);
  assert.deepEqual(next.data.settings.titleCleanupWords, [...DEFAULT_TITLE_WORDS]); assert.equal(fs.readFileSync(`${store.file}.bak`, 'utf8'), bytes);
});
test('local multi-list import copies media once and removes incomplete batch files on failure', async t => {
  const { root, store, a, b } = Lists(t), file = path.join(root, '「新曲」.mp3'); fs.writeFileSync(file, 'original');
  await assert.rejects(() => store.AddFiles([a, b], [file, path.join(root, 'missing.mp3')]));
  assert.equal(fs.readdirSync(store.media).length, 0); assert.equal(store.Playlist(a).entries.length, 0);
  await store.AddFiles([a, b], [file]);
  assert.equal(fs.readdirSync(store.media).length, 1); assert.equal(store.Playlist(a).entries[0].fileName, store.Playlist(b).entries[0].fileName); assert.equal(store.Playlist(a).entries[0].title, '新曲');
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  const before = store.Snapshot(), save = store.Save; store.Save = () => { throw new Error('disk full'); };
  await assert.rejects(() => store.AddFiles([a, b], [file]), /disk full/); store.Save = save;
  assert.deepEqual(store.Snapshot(), before); assert.equal(fs.readdirSync(store.media).length, 1);
});
