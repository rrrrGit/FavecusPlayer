'use strict';
// 曲の情報（アーティスト・タグ・メモ・チャプター。共通の規則 core/song-notes.cjs）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Notes = require('../src/core/song-notes.cjs');
const { SongNotesStore } = require('../src/core/song-notes-store.cjs');
const App = require('../src/core/library-app.cjs');

test('normalize: trims, limits lengths/counts, deduplicates tags, orders chapters, and handles empty input', () => {
  const n = Notes.Normalize({
    artist: '  ' + 'あ'.repeat(150) + '  ',
    tags: ['#歌枠', '歌枠', ' 雑談 ', '', 'x'.repeat(50), ...Array.from({ length: 30 }, (_, i) => 't' + i)],
    memo: 'a\r\nb\u0001c',
    chapters: [{ at: 90, title: '後' }, { at: 10, title: 'a' }, { at: 90, title: '上書き' }, { at: -1, title: 'bad' }, { at: 5, title: '' }, { at: 'x', title: 'bad' }],
  });
  assert.equal(n.artist.length, 100);
  assert.equal(n.tags[0], '歌枠');
  assert.equal(n.tags.filter(t => t === '歌枠').length, 1);
  assert.equal(n.tags[1], '雑談');
  assert.equal(n.tags.length, Notes.MAX_TAGS);
  assert.ok(n.tags.every(t => t.length <= Notes.MAX_TAG));
  assert.equal(n.memo, 'a\nbc');
  assert.deepEqual(n.chapters, [{ at: 10, title: 'a' }, { at: 90, title: '上書き' }]);
  assert.deepEqual(Notes.Normalize(null), { artist: '', tags: [], memo: '', chapters: [] });
  assert.equal(Notes.IsEmpty({ tags: [' ', '#'] }), true);
  assert.equal(Notes.Normalize({ memo: 'x'.repeat(5000) }).memo.length, Notes.MAX_MEMO);
  assert.equal(Notes.Normalize({ chapters: Array.from({ length: 300 }, (_, i) => ({ at: i, title: 'c' })) }).chapters.length, Notes.MAX_CHAPTERS);
});

test('times and chapters parse, format, round-trip, and resolve ChapterAt cleanly', () => {
  assert.equal(Notes.ParseTime('1:23'), 83);
  assert.equal(Notes.ParseTime('01:02:03'), 3723);
  assert.equal(Notes.ParseTime('0:00'), 0);
  for (const bad of ['1:75', '1:99:00', 'abc', '12', '', '1:2']) assert.equal(Notes.ParseTime(bad), null, bad);
  assert.equal(Notes.FormatTime(83), '1:23');
  assert.equal(Notes.FormatTime(3723), '1:02:03');

  const pasted = ['0:00 オープニング', '03:15 - 一曲目', '[10:30] 雑談', '１:00:00 全角の数字は読めない', '1:05:20・エンディング', '二曲目 15:42', '見出しだけの行', '', '99:99 ありえない時刻'].join('\n');
  const chapters = Notes.ParseChapters(pasted);
  assert.deepEqual(chapters.map(c => `${c.at}:${c.title}`), ['0:オープニング', '195:一曲目', '630:雑談', '942:二曲目', '3920:エンディング']);
  const text = Notes.FormatChapters(chapters);
  assert.equal(text.split('\n')[0], '0:00 オープニング');
  assert.deepEqual(Notes.ParseChapters(text), chapters);

  const sample = [{ at: 0, title: 'A' }, { at: 60, title: 'B' }, { at: 200, title: 'C' }];
  assert.equal(Notes.ChapterAt(sample, 0).title, 'A');
  assert.equal(Notes.ChapterAt(sample, 59.9).title, 'A');
  assert.equal(Notes.ChapterAt(sample, 60).title, 'B');
  assert.equal(Notes.ChapterAt(sample, 9999).title, 'C');
  assert.equal(Notes.ChapterAt([{ at: 30, title: 'X' }], 5), null);
  assert.equal(Notes.ChapterAt([], 5), null);
});

test('SongNotesStore persists per media key, migrates aliases, rolls back on save failure, and survives broken files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-notes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'n', 'song-notes.json'), store = new SongNotesStore(file);
  assert.equal(store.Get('local:a.mp3'), null);
  assert.equal(store.Set('local:a.mp3', { artist: '歌い手', tags: ['歌枠'], chapters: [{ at: 5, title: 'x' }] }).artist, '歌い手');
  assert.deepEqual(new SongNotesStore(file).Get('local:a.mp3').tags, ['歌枠']);
  assert.throws(() => store.Set('bad key', { artist: 'x' }), /識別できない/);
  assert.throws(() => store.Set('', { artist: 'x' }), /識別できない/);
  assert.equal(store.Set('local:a.mp3', { artist: ' ' }), null);
  assert.equal(new SongNotesStore(file).Has('local:a.mp3'), false);
  assert.equal(fs.existsSync(file + '.tmp'), false);

  store.Set('bili-av:123:p1', { artist: '歌手A', tags: ['タグ1'], memo: 'avメモ', chapters: [{ title: '前奏', at: 5 }] });
  store.Set('bili:BV1aaaaaaaaa:p1', { tags: ['タグ2'], chapters: [{ title: 'サビ', at: 40 }] });
  assert.equal(store.MigrateAliases([{ aid: '123', bvid: 'BV1aaaaaaaaa' }]), true);
  assert.equal(store.Has('bili-av:123:p1'), false);
  const merged = store.Get('bili:BV1aaaaaaaaa:p1');
  assert.equal(merged.artist, '歌手A');
  assert.equal(merged.memo, 'avメモ');
  assert.deepEqual(new Set(merged.tags), new Set(['タグ1', 'タグ2']));
  assert.equal(merged.chapters.length, 2);

  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);
  try {
    assert.throws(() => store.Set('bili:BV1bbbbbbbbb:p1', { memo: 'fail' }), /保存できませんでした/);
    assert.equal(store.Has('bili:BV1bbbbbbbbb:p1'), false);
  } finally {
    fs.rmdirSync(file);
  }

  fs.writeFileSync(file, '{ broken');
  assert.equal(new SongNotesStore(file).Has('local:a.mp3'), false);
});

test('shared entry points and PC/iPhone wiring are connected for song notes and chapters', () => {
  const normalized = App.NotesNormalize({ record: { artist: ' A ', tags: ['#x', 'x'] } });
  assert.deepEqual(normalized.record, { artist: 'A', tags: ['x'], memo: '', chapters: [] });
  assert.deepEqual(App.NotesChapters({ text: '1:00 a\n2:00 b' }).chapters, [{ at: 60, title: 'a' }, { at: 120, title: 'b' }]);
  assert.equal(App.NotesChapters({ chapters: [{ at: 60, title: 'a' }] }).text, '1:00 a');

  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const { readMain } = require('./support-source.cjs');
  const main = readMain();
  assert.match(main, /notesStore = new SongNotesStore\(path\.join\(app\.getPath\('userData'\), 'song-notes\.json'\)\)/);
  assert.match(main, /Handle\('notes:get'/);
  assert.match(main, /Handle\('notes:set'/);
  assert.match(main, /notesStore\.Set\(key, record\)/);
  assert.match(read('src/preloads/ui.cjs'), /notesGet: invoke\('notes:get'\)/);
  assert.match(read('src/ui/app/03-downloads.js'), /SongInfoDialog\(p\.id, entry\)/);
  assert.match(read('src/ui/index.html'), /id="chapters"/);
  assert.match(read('src/ui/app/05-notes.js'), /api\.command\('seek', chapter\.at\)/);

  const swift = read('ios/FavecusPlayer/Library/SongNotes.swift');
  assert.match(swift, /callAsync\("NotesChapters"/);
  assert.match(swift, /callAsync\("NotesNormalize"/);
  assert.match(swift, /song-notes\.json/);
  assert.match(swift, /struct SongInfoSheet/);
  assert.match(swift, /struct ChapterMenu/);
  assert.match(read('ios/FavecusPlayer/Playback/FullPlayerView.swift'), /ChapterMenu\(player: player\)/);
  assert.match(read('ios/FavecusPlayer/Library/PlaylistDetailView.swift'), /SongInfoSheet\(player: player, entry: entry\)/);
  assert.match(read('ios/FavecusPlayer/Playback/PlaybackEngine.swift'), /let notes = SongNotesStore\(\)/);
});
