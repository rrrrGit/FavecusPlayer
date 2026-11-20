'use strict';
// v0.7.4 G：お気に入り（シャッフルの重み・保存・つなぎ）。
const { test } = require('node:test');
const { readMain, readApp } = require('./support-source.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Ledger = require('../src/core/play-ledger.cjs');
const App = require('../src/core/library-app.cjs');
const { FavoriteStore, ValidKey } = require('../src/core/favorites.cjs');

test('a favorite is a little more likely, and a heavily played favorite is still behind a fresh song', () => {
  assert.equal(Ledger.WeightOf(0, false), 1);
  assert.equal(Ledger.WeightOf(0, true), Ledger.FAVORITE_BOOST);
  assert.equal(Ledger.WeightOf(3, true), Ledger.Weight(3) * Ledger.FAVORITE_BOOST);
  assert.ok(Ledger.WeightOf(3, true) > Ledger.WeightOf(3, false), 'お気に入りの方が、少し選ばれやすい');
  assert.ok(Ledger.WeightOf(10, true) < Ledger.WeightOf(0, false), '再生回数が多いお気に入りは、まだ聴いていない曲より、後回し（少しだけ、早めになるだけ）');
  assert.ok(Ledger.FAVORITE_BOOST > 1 && Ledger.FAVORITE_BOOST <= 2, '倍率は、少しだけ');
});

test('the shared ledger call applies the favorite boost only to the listed keys (and is unchanged without favorites)', () => {
  const text = JSON.stringify(Ledger.NewLedger('devA'));
  const plain = App.LedgerCounts({ text, keys: ['bili:BV1aaaaaaaaa:p1', 'local:a.mp3'] });
  assert.deepEqual(plain.weights, { 'bili:BV1aaaaaaaaa:p1': 1, 'local:a.mp3': 1 });
  const boosted = App.LedgerCounts({ text, keys: ['bili:BV1aaaaaaaaa:p1', 'local:a.mp3'], favorites: ['local:a.mp3', 'not-in-keys'] });
  assert.equal(boosted.weights['local:a.mp3'], Ledger.FAVORITE_BOOST);
  assert.equal(boosted.weights['bili:BV1aaaaaaaaa:p1'], 1);
  assert.deepEqual(boosted.counts, plain.counts, '再生回数は、変わらない');
});

test('over many shuffles a favorite comes first a little more often than an ordinary song (and never always)', () => {
  const { Queue } = require('../src/core/queue.cjs');
  let seed = 12345; const rng = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const entries = ['a', 'b', 'c', 'd'].map((id, n) => ({ id, playlistId: 'p', url: `u${n}` }));
  const weight = entry => Ledger.WeightOf(0, entry.id === 'a');
  let firsts = 0; const rounds = 4000;
  for (let i = 0; i < rounds; i++) { const queue = new Queue(rng, weight, max => Math.floor(rng() * max)); if (queue.ShuffleStart('p', entries) === 'a') firsts++; }
  const share = firsts / rounds; // 期待値：1.5 / (1.5 + 3) ≒ 0.33（お気に入りがなければ 0.25）
  assert.ok(share > 0.28 && share < 0.40, `お気に入りが最初に選ばれた割合 ${share}`);
});

test('the favorite store keeps keys across a restart, rejects bad keys, and ignores a damaged file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-fav-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'favorites.json');
  const store = new FavoriteStore(file);
  assert.equal(store.Set('bili:BV1aaaaaaaaa:p1', true), true);
  assert.equal(store.Set('local:song.mp3', true), true);
  assert.deepEqual(new FavoriteStore(file).List().sort(), ['bili:BV1aaaaaaaaa:p1', 'local:song.mp3']);
  assert.equal(store.Set('local:song.mp3', false), false);
  assert.equal(new FavoriteStore(file).Has('local:song.mp3'), false);
  for (const bad of ['', null, 'a b', 'x'.repeat(201), '../etc']) assert.throws(() => store.Set(bad, true), /お気に入りにできません/);
  assert.equal(ValidKey('bili:BV1aaaaaaaaa:p1'), true);
  fs.writeFileSync(file, '{ not json'); assert.deepEqual(new FavoriteStore(file).List(), []);
  fs.writeFileSync(file, JSON.stringify({ version: 1, keys: ['ok:1', 'bad key', 5, null] })); assert.deepEqual(new FavoriteStore(file).List(), ['ok:1']);
});

test('PC: the shuffle weight uses the favorite rule, the toggle is on the current song and the song menu', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const main = readMain();
  assert.match(main, /PlayLedger\.WeightOf\(playCounts\?\.Count\(entry\) \|\| 0, IsFavorite\(entry\)\)/);
  assert.match(main, /Handle\('library:favorite'/);
  assert.match(main, /favorites\.Set\(key, value === true\)/);
  assert.match(read('src/preloads/ui.cjs'), /favorite: invoke\('library:favorite'\)/);
  assert.match(read('src/ui/index.html'), /id="favorite"/);
  assert.match(readApp(), /お気に入りにする/);
});
