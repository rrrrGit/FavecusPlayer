'use strict';
// ライブラリの点検（core/library-audit.cjs）：重複とリンク切れの検出・非破壊性・配線テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Audit } = require('../src/core/library-audit.cjs');
const App = require('../src/core/library-app.cjs');
const { readMain } = require('./support-source.cjs');

const video = (id, bv, title, part = 1) => ({ id, type: 'bilibili', videoId: bv, url: `https://www.bilibili.com/video/${bv}/${part > 1 ? `?p=${part}` : ''}`, part, title });
const local = (id, fileName, title) => ({ id, type: 'local', fileName, title });
const library = () => ({
  version: 3, activePlaylistId: 'p1', rootPlaylistIds: ['p1', 'p2'], settings: {},
  playlists: [
    { id: 'p1', name: 'A', childIds: [], entries: [video('1', 'BV1aaaaaaaaa', '曲A'), video('2', 'BV1aaaaaaaaa', '曲A（重複）'), video('3', 'BV1aaaaaaaaa', '曲A 別パート', 2), local('4', 'song.mp3', 'ローカル'), local('5', 'gone.mp3', '消えた曲')] },
    { id: 'p2', name: 'B', childIds: [], entries: [video('6', 'BV1aaaaaaaaa', '別のリストの同じ曲'), local('7', 'song.mp3', 'ローカル（別リスト）')] },
  ],
});

test('Audit detects per-playlist Bilibili/local duplicates and missing local files without cross-list false positives', () => {
  const report = Audit(library(), ['song.mp3']);
  assert.equal(report.duplicates.length, 1);
  assert.equal(report.duplicates[0].playlistId, 'p1');
  assert.deepEqual(report.duplicates[0].entries.map(e => e.id), ['1', '2']);
  assert.equal(report.checked, 7);
  assert.deepEqual(report.missing.map(m => m.entryId), ['5']);
  assert.equal(report.missing[0].fileName, 'gone.mp3');
  assert.equal(Audit(library(), []).missing.length, 3);

  const dupLocal = library();
  dupLocal.playlists[1].entries.push(local('8', 'song.mp3', 'もう1つ'));
  assert.ok(Audit(dupLocal, ['song.mp3']).duplicates.some(d => d.playlistId === 'p2' && d.entries.length === 2));
});

test('Audit never mutates the library, handles malformed input, and wires to PC/iPhone', () => {
  const data = library(), snapshot = JSON.stringify(data);
  Audit(data, []);
  assert.equal(JSON.stringify(data), snapshot);
  assert.deepEqual(Audit(null, []), { duplicates: [], missing: [], checked: 0 });
  assert.deepEqual(Audit({ playlists: [{ id: 'x', name: 'x', entries: [null, {}, { id: 'ok', type: 'local', fileName: 'a.mp3' }] }] }, ['a.mp3']), { duplicates: [], missing: [], checked: 1 });
  assert.ok(App.Audit({ text: '{' }).error);
  assert.equal(App.Audit({ text: JSON.stringify(library()), existingFiles: ['song.mp3'] }).missing.length, 1);

  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(readMain(), /Handle\('library:audit'/);
  assert.match(read('src/preloads/ui.cjs'), /audit: invoke\('library:audit'\)/);
  assert.match(read('src/ui/app/04-settings.js'), /\['ライブラリの点検', AuditSettings\]/);
  assert.match(read('ios/FavecusPlayer/Library/AuditViews.swift'), /callAsync\("Audit"/);
  assert.match(read('ios/FavecusPlayer/Library/OtherTabs.swift'), /AuditView\(store: store/);
});
