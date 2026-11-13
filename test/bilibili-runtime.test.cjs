'use strict';
// v0.7.0 Step12：iPhone版（JavaScriptCore）のBilibili情報取得の入口を、偽のhostで確認する。応答はすべて合成データ（実在の動画・アカウントではない）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Bili = require('../src/core/bilibili-runtime.cjs');

const audio = { id: 30280, bandwidth: 192000, codecs: 'mp4a.40.2', baseUrl: 'https://upos.bilivideo.com/a/30280.m4s', size: 1000 };
const view = { code: 0, data: { bvid: 'BV1aaaaaaaaa', aid: 1, duration: 100, pic: 'https://i0.hdslb.com/pic.jpg', pages: [{ page: 1, cid: 7, duration: 100 }] } };
function Host(handler) {
  const calls = [];
  globalThis.__favecusHost = { request: async (method, url, init) => { const { headers, body } = JSON.parse(init); calls.push({ method, url, headers, body }); return JSON.stringify(await handler(new URL(url), calls.length)); } };
  return calls;
}

test('resolve asks only api.bilibili.com with a Referer, sends no cookies from JS, and returns the chosen audio stream', async () => {
  const calls = Host(url => ({ status: 200, json: url.pathname === '/x/web-interface/view' ? view : { code: 0, data: { dash: { audio: [audio], video: [] }, timelength: 100000 } } }));
  const result = await Bili.Resolve({ url: 'https://www.bilibili.com/video/BV1aaaaaaaaa/', kind: 'audio', height: 720 });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.resolved.streams[0].urls[0], audio.baseUrl); assert.equal(result.resolved.duration, 100);
  assert.deepEqual(calls.map(c => new URL(c.url).origin), ['https://api.bilibili.com', 'https://api.bilibili.com']);
  assert.ok(calls.every(c => c.headers.Referer === 'https://www.bilibili.com/' && !('Cookie' in c.headers)));
});

test('HTTP 412, 429 and 401 stop immediately without retrying in another way', async () => {
  for (const status of [412, 429, 401]) {
    const calls = Host(() => ({ status, json: null }));
    const result = await Bili.Resolve({ url: 'https://www.bilibili.com/video/BV1aaaaaaaaa/', kind: 'audio' });
    assert.equal(result.stopBatch, true, String(status)); assert.equal(result.httpStatus, status); assert.equal(calls.length, 1);
  }
});

test('login-required and risk-control codes stop with a message; a protected stream is refused', async () => {
  Host(() => ({ status: 200, json: { code: -101 } }));
  let result = await Bili.Resolve({ url: 'https://www.bilibili.com/video/BV1aaaaaaaaa/', kind: 'audio' });
  assert.match(result.error, /ログインが必要/); assert.equal(result.stopBatch, true);
  Host(url => ({ status: 200, json: url.pathname === '/x/web-interface/view' ? view : { code: -352 } }));
  result = await Bili.Resolve({ url: 'https://www.bilibili.com/video/BV1aaaaaaaaa/', kind: 'audio' });
  assert.equal(result.stopBatch, true);
  Host(url => ({ status: 200, json: url.pathname === '/x/web-interface/view' ? view : { code: 0, data: { dash: { audio: [audio], video: [] }, is_drm: 1 } } }));
  result = await Bili.Resolve({ url: 'https://www.bilibili.com/video/BV1aaaaaaaaa/', kind: 'audio' });
  assert.match(result.error, /保護された動画/);
});

test('an invalid video URL is refused before any request', async () => {
  const calls = Host(() => ({ status: 200, json: view }));
  const result = await Bili.Resolve({ url: 'https://evil.example.com/video/BV1aaaaaaaaa/', kind: 'audio' });
  assert.ok(result.error); assert.equal(calls.length, 0);
});

test('profile reports the login state without exposing anything else', async () => {
  Host(() => ({ status: 200, json: { code: 0, data: { isLogin: true, mid: 4242, uname: 'テスト', secret: 'x' } } }));
  assert.deepEqual(await Bili.Profile(), { loggedIn: true, uid: '4242', name: 'テスト' });
  Host(() => ({ status: 200, json: { code: -101 } }));
  assert.deepEqual(await Bili.Profile(), { loggedIn: false });
  // リスク制御・混雑では、ログアウト扱いにしない（Swift側は error のときログイン情報を消さない）
  for (const code of [-352, -412, -509]) {
    Host(() => ({ status: 200, json: { code } }));
    const result = await Bili.Profile();
    assert.equal(result.loggedIn, undefined); assert.ok(result.error); assert.equal(result.stopBatch, true);
  }
});

test('info returns the title and length from the view API only (part title for later parts)', async () => {
  const calls = Host(() => ({ status: 200, json: { code: 0, data: { bvid: 'BV1aaaaaaaaa', aid: 1, title: ' 曲名 ', duration: 300, pages: [{ page: 1, cid: 7, duration: 300, part: 'p1' }, { page: 2, cid: 8, duration: 120, part: '後編' }] } } }));
  assert.deepEqual(await Bili.Info({ url: 'https://www.bilibili.com/video/BV1aaaaaaaaa/' }), { title: '曲名', duration: 300, thumbnailURL: null });
  assert.deepEqual(await Bili.Info({ url: 'https://www.bilibili.com/video/BV1aaaaaaaaa/?p=2' }), { title: '曲名 P2 後編', duration: 120, thumbnailURL: null });
  assert.ok(calls.every(call => call.url.includes('/x/web-interface/view')), 'view以外は呼ばない');
  Host(() => ({ status: 412, json: {} }));
  const refused = await Bili.Info({ url: 'BV1aaaaaaaaa' });
  assert.ok(refused.error); assert.equal(refused.stopBatch, true);
  assert.ok((await Bili.Info({ url: 'https://example.com/x' })).error);
});
