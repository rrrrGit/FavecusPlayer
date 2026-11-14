'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ListArtwork } = require('../src/ui/list-artwork.js');
const { Thumbnails, SmallImage, CoverImage, FlatScore, IsFlatScore } = require('../src/core/thumbnail.cjs');
const flush = () => new Promise(setImmediate);
const png = fs.readFileSync(path.join(__dirname, '../build/music.png'));
const art = 'data:image/png;base64,aWNvbg==';
function ArtworkHarness() {
  let callback; const pending = [], requested = [];
  const list = new ListArtwork({ root: {}, load: (_playlist, id) => { requested.push(id); return new Promise(resolve => pending.push(resolve)); }, observe: fn => { callback = fn; return { observe() {}, disconnect() {} }; } });
  const images = Array.from({ length: 8 }, (_, id) => { const image = {}; list.Add(image, 'p', String(id)); return image; });
  return { list, images, requested, pending, visible: (indexes, value = true) => callback(indexes.map(index => ({ target: images[index], isIntersecting: value }))) };
}
test('list artwork loads at most two visible rows and releases offscreen image data', async () => {
  const h = ArtworkHarness(); h.visible([0, 1, 2, 3]); await flush(); assert.equal(h.requested.length, 0);
  h.list.SetEnabled(true); await flush(); assert.deepEqual(h.requested, ['0', '1']);
  h.visible([2], false); h.pending.shift()(art); await flush(); assert.deepEqual(h.requested, ['0', '1', '3']); assert.equal(h.images[0].src, art);
  h.visible([0], false); assert.equal(h.images[0].src, 'music.png');
  while (h.pending.length) h.pending.shift()(null); await flush(); assert.equal(h.images[1].src, 'music.png'); assert.equal(h.requested.includes('2'), false);
});
test('reset and background changes discard stale artwork and resume only current visible rows', async () => {
  const h = ArtworkHarness(); h.list.SetEnabled(true); h.visible([0]); await flush(); h.list.Reset();
  const image = {}; h.list.Add(image, 'p2', 'new'); h.pending.shift()(art); await flush(); assert.equal(image.src, 'music.png'); assert.equal(h.images[0].src, 'music.png');
  h.list.Reset(); h.list.Add(h.images[0], 'p2', 'new'); h.visible([0]); h.list.SetEnabled(false); await flush(); assert.equal(h.requested.length, 1);
  h.list.SetEnabled(true); await flush(); assert.equal(h.requested.at(-1), 'new');
  h.pending.shift()('https://untrusted.test/image.png'); await flush(); assert.equal(h.images[0].src, 'music.png');
});
test('small artwork keeps image proportions within 128 by 72 and handles an undecodable image', () => {
  let resized;
  const native = { createFromDataURL: () => ({ isEmpty: () => false, getSize: () => ({ width: 1600, height: 900 }), resize: options => { resized = options; return { toPNG: () => png }; } }) };
  assert.ok(SmallImage(art, native).startsWith('data:image/png;base64,')); assert.equal(resized.width, 128); assert.equal(resized.height, 72);
  assert.equal(SmallImage(art, { createFromDataURL: () => ({ isEmpty: () => true }) }), null);
});
test('home cover art is a centered square JPEG of at most 300 pixels, cached separately from the small preview', async () => {
  const calls = [], jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const native = { createFromDataURL: () => ({ isEmpty: () => false, getSize: () => ({ width: 1920, height: 1080 }),
    crop: rect => { calls.push(['crop', rect]); return { resize: options => { calls.push(['resize', options]); return { toJPEG: quality => { calls.push(['jpeg', quality]); return jpeg; } }; } }; } }) };
  assert.ok(CoverImage(art, native).startsWith('data:image/jpeg;base64,'));
  assert.deepEqual(calls[0], ['crop', { x: 420, y: 0, width: 1080, height: 1080 }]); assert.equal(calls[1][1].width, 300); assert.equal(calls[1][1].height, 300);
  assert.equal(CoverImage(art, { createFromDataURL: () => ({ isEmpty: () => true }) }), null);
  assert.equal(CoverImage(art, { createFromDataURL: () => ({ isEmpty: () => false, getSize: () => ({ width: 0, height: 0 }) }) }), null);
  const small = { createFromDataURL: () => ({ isEmpty: () => false, getSize: () => ({ width: 100, height: 100 }), crop: () => ({ resize: o => { calls.push(['small', o]); return { toJPEG: () => jpeg }; } }) }) };
  CoverImage(art, small); assert.equal(calls.at(-1)[1].width, 100, '元より大きくしない');
  let resizedSmall = 0, resizedCover = 0;
  const thumbs = new Thumbnails({ Details: async () => ({ pic: 'https://i0.hdslb.com/a.png' }) }, async () => new Response(png), '', '', { resize: () => { resizedSmall++; return 'small'; }, resizeCover: () => { resizedCover++; return 'cover'; } });
  const entry = { type: 'bilibili', videoId: 'BV1xx411c7mD' };
  assert.equal(await thumbs.GetPreview(entry), 'small'); assert.equal(await thumbs.GetPreview(entry, () => true, 'cover'), 'cover');
  assert.equal(await thumbs.GetPreview(entry), 'small'); assert.equal(await thumbs.GetPreview(entry, () => true, 'cover'), 'cover'); assert.deepEqual([resizedSmall, resizedCover], [1, 1], '種類ごとにキャッシュする');
  assert.equal(await new Thumbnails({}, async () => new Response(png), '', '', {}).GetPreview(entry, () => true, 'cover'), null, '変換が無ければ取得しない');
});
function Bitmap(pixel) { const b = Buffer.alloc(32 * 18 * 4); for (let i = 0; i < 32 * 18; i++) { const [blue, green, red] = pixel(i); b[i * 4] = blue; b[i * 4 + 1] = green; b[i * 4 + 2] = red; b[i * 4 + 3] = 255; } return b; }
test('flat (single-colour) images are detected, but real pictures and pictures with a small logo are not', () => {
  const flat = value => IsFlatScore(FlatScore(Bitmap(value)));
  assert.equal(flat(() => [255, 255, 255]), true, '真っ白'); assert.equal(flat(() => [0, 0, 0]), true, '真っ黒'); assert.equal(flat(() => [180, 120, 40]), true, '単色');
  assert.equal(flat(i => [250 + i % 5, 250 + i % 5, 250 + i % 5]), true, 'ほぼ白（わずかな階調）');
  assert.equal(flat(i => i % 10 === 0 ? [0, 0, 0] : [255, 255, 255]), false, '白地に黒い部分が1割ある画像は一色ではない');
  assert.equal(flat(i => [i * 7 % 256, i * 13 % 256, i * 29 % 256]), false, '絵柄のある画像');
  assert.equal(flat(i => i < 32 * 18 / 2 ? [200, 200, 200] : [40, 40, 40]), false, '明暗が2分された画像');
  assert.equal(IsFlatScore(FlatScore(Buffer.alloc(0))), false, '空の入力は一色とみなさない');
});
test('a flat thumbnail is replaced by the official preview frame near 60 seconds without changing normal thumbnails or breaking on failures', async () => {
  const crops = [], requests = [], shot = { index: Array.from({ length: 100 }, (_, i) => i * 5), image: ['//i0.hdslb.com/bfs/videoshot/a.jpg'], img_x_len: 10, img_y_len: 10, img_x_size: 160, img_y_size: 90 };
  const account = { Details: async () => ({ bvid: 'BV1xx411c7mD', pic: 'https://i0.hdslb.com/pic.png', pages: [{ cid: 7, duration: 200 }, { cid: 8, duration: 30 }] }), Request: async (endpoint, query) => { requests.push([endpoint, query]); return shot; } };
  const make = (flatSet, extra = {}) => new Thumbnails(account, async () => new Response(png), '', '', { flat: data => flatSet.has(data), crop: (data, rect) => { crops.push(rect); return 'frame'; }, ...extra });
  const entry = { type: 'bilibili', videoId: 'BV1xx411c7mD', part: 1 };
  assert.equal(await make(new Set(['flat'])).Improve(entry, 'flat'), 'frame'); assert.deepEqual(requests[0], ['/x/player/videoshot', { bvid: 'BV1xx411c7mD', cid: 7, index: 1 }]);
  assert.deepEqual(crops[0], { x: 320, y: 90, width: 160, height: 90 }, '60秒＝13番目の場面（右へ2列・下へ1行）を切り出す');
  assert.equal(await make(new Set(['flat'])).Improve(entry, 'real'), 'real', '一色でなければ何もしない'); assert.equal(requests.length, 1);
  assert.equal(await make(new Set(['flat', 'frame'])).Improve(entry, 'flat'), 'flat', '置き換え後も一色なら元のまま');
  assert.equal(await new Thumbnails({ ...account, Request: async () => { throw new Error('offline'); } }, async () => new Response(png), '', '', { flat: () => true, crop: () => 'frame' }).Improve(entry, 'flat'), 'flat', '失敗しても元の画像を返す');
  assert.equal(await new Thumbnails(account, async () => new Response(png), '', '').Improve(entry, 'flat'), 'flat', '判定が無ければ何もしない');
  crops.length = 0; await make(new Set(['flat'])).Improve({ ...entry, part: 2 }, 'flat'); assert.deepEqual(requests.at(-1)[1].cid, 8, 'パートごとのcidを使う'); assert.equal(crops[0].y, 0, '短い動画（30秒）は半分の15秒付近＝4番目（x=480）'); assert.equal(crops[0].x, 480);
  assert.equal(await make(new Set(['flat'])).Improve({ type: 'bilibili', videoId: 'BV1xx411c7mD', part: 1 }, 'flat', ''), 'frame');
  const invalid = { ...account, Request: async () => ({ ...shot, img_x_len: 0 }) }; assert.equal(await new Thumbnails(invalid, async () => new Response(png), '', '', { flat: () => true, crop: () => 'frame' }).Improve(entry, 'flat'), 'flat', '不正な応答は使わない');
});
test('the replacement result is remembered per video so repeated displays do not repeat the preview request, and failures retry after a minute', async () => {
  let requests = 0, now = 0, fail = false;
  const account = { Details: async () => ({ bvid: 'BV1xx411c7mD', pages: [{ cid: 7, duration: 200 }] }), Request: async () => { requests++; if (fail) throw new Error('offline'); return { index: [0, 60], image: ['//i0.hdslb.com/a.jpg'], img_x_len: 10, img_y_len: 10, img_x_size: 160, img_y_size: 90 }; } };
  const thumbs = new Thumbnails(account, async () => new Response(png), '', '', { flat: data => data === 'flat', crop: () => 'frame', now: () => now }), entry = { type: 'bilibili', videoId: 'BV1xx411c7mD', part: 1 };
  assert.equal(await thumbs.Improve(entry, 'flat'), 'frame'); assert.equal(await thumbs.Improve(entry, 'flat'), 'frame'); assert.equal(requests, 1, '同じ動画・同じ画像では再取得しない');
  assert.equal(await thumbs.Improve(entry, 'flat2'), 'flat2', '元の画像が変わった（一色でない）場合は覚えを使わない');
  const other = { ...entry, videoId: 'BV1GJ411x7h7' }; fail = true; thumbs.flat = data => data === 'flat';
  assert.equal(await thumbs.Improve(other, 'flat'), 'flat'); assert.equal(await thumbs.Improve(other, 'flat'), 'flat'); const failed = requests; assert.equal(failed, 2, '失敗は覚え、すぐには再試行しない');
  now = 61000; fail = false; assert.equal(await thumbs.Improve(other, 'flat'), 'frame', '60秒後に再試行する');
});
test('shared thumbnail jobs keep the two-request cap and recheck duplicates after a slot opens', async () => {
  const releases = new Map(), calls = []; let active = 0, maximum = 0, cancelled = false;
  const thumbs = new Thumbnails({ Details: id => { calls.push(id); active++; maximum = Math.max(maximum, active); return new Promise(resolve => releases.set(id, () => { active--; resolve({ pic: 'https://i0.hdslb.com/a.png' }); })); } }, async () => new Response(png), '', '');
  const entry = id => ({ type: 'bilibili', videoId: id });
  const requests = [thumbs.Get(entry('a')), thumbs.Get(entry('b')), thumbs.Get(entry('c')), thumbs.Get(entry('c')), thumbs.Get(entry('d'), () => !cancelled)];
  await flush(); assert.deepEqual(calls, ['a', 'b']); cancelled = true; releases.get('a')(); await flush(); assert.deepEqual(calls, ['a', 'b', 'c']);
  releases.get('b')(); releases.get('c')(); const results = await Promise.all(requests);
  assert.equal(maximum, 2); assert.equal(results[2], results[3]); assert.equal(results[4], null); assert.equal(thumbs.pending.size, 0);
});
test('small previews cache successful images and briefly cache failures without creating files', async () => {
  let requests = 0, now = 0, fail = true;
  const thumbs = new Thumbnails({ Details: async () => { requests++; if (fail) throw new Error('offline'); return { pic: 'https://i0.hdslb.com/a.png' }; } }, async () => new Response(png), '', '', { resize: () => art, now: () => now });
  const entry = { type: 'bilibili', videoId: 'av123' };
  assert.equal(await thumbs.GetPreview(entry), null); assert.equal(await thumbs.GetPreview(entry), null); assert.equal(requests, 1);
  now = 60001; fail = false; assert.equal(await thumbs.GetPreview(entry), art); assert.equal(await thumbs.GetPreview(entry), art); assert.equal(requests, 2);
  for (let n = 0; n < 100; n++) await thumbs.GetPreview({ ...entry, videoId: `av${n}` });
  assert.equal(thumbs.previews.size, 96); assert.ok(thumbs.cache.size <= 8);
});
