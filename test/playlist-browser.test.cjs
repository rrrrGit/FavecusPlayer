'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PlaylistBrowser } = require('../src/ui/playlist-reader.js');
const { BilibiliAccount } = require('../src/core/bilibili.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');
const video = (id, part = 1) => ({ ...ParseBilibili(`https://www.bilibili.com/video/av${id}/?p=${part}`), title: `曲 ${id}-${part}` });
const parent = { kind: 'season', mid: '10', id: '20', title: '親の合集' };
const parts = id => ({ kind: 'parts', id: `av${id}`, title: `作品 ${id}`, total: 2 });
function Harness() {
  const a = video(123), b = video(456), calls = [];
  const api = {
    playlistSources: async () => [parts(123), parent],
    playlistParts: async url => { calls.push(url); return parts(ParseBilibili(url).videoId.slice(2)); },
    playlistVideos: async source => ({ videos: source.kind === 'season' ? [a, b] : [video(source.id.slice(2), 1), video(source.id.slice(2), 2)], hasMore: false, skipped: 0 })
  };
  return { browser: new PlaylistBrowser(api), api, a, b, calls };
}
test('collection siblings open their own parts; returning preserves selections from different children', async () => {
  const h = Harness(), b = h.browser;
  await b.Search('URL'); assert.equal(b.current.source.kind, 'parts');
  await b.Select(1); assert.equal(b.current.source, parent);
  await b.Enter(h.a); assert.equal(b.current.source.id, 'av123');
  const selected = b.current.videos[1]; b.selected.set(selected.url, selected.title);
  b.Back(); assert.equal(b.current.source, parent); assert.equal(b.current.videos[1].url, h.b.url);
  await b.Enter(h.b); assert.equal(b.current.source.id, 'av456');
  const second = b.current.videos[0]; b.selected.set(second.url, second.title);
  b.Back(); await b.Enter(h.a);
  assert.equal(b.selected.get(selected.url), selected.title); assert.equal(b.selected.get(second.url), second.title);
  const before = h.calls.length; await b.Enter(b.current.videos[0]); assert.equal(h.calls.length, before);
});
test('missing parts and failed child retrieval leave the loaded parent and selections available', async () => {
  const h = Harness(), b = h.browser; await b.Search('URL'); await b.Select(1);
  b.selected.set(h.b.url, h.b.title); h.api.playlistParts = async () => null;
  await b.Enter(h.a); assert.equal(b.current.source, parent); assert.equal(b.parents.length, 0); assert.match(b.message, /複数のパートがありません/);
  h.api.playlistParts = async () => { throw new Error('HTTP 403'); };
  await b.Enter(h.a); assert.equal(b.current.source, parent); assert.equal(b.selected.size, 1); assert.equal(b.ready, true); assert.match(b.message, /HTTP 403/);
});
test('cancelled or closed requests cannot replace the current list, while a new URL clears old choices', async () => {
  const h = Harness(), b = h.browser; await b.Search('URL'); await b.Select(1);
  let resolve; h.api.playlistParts = () => new Promise(r => resolve = r);
  const pending = b.Enter(h.a); assert.equal(b.ready, false); b.Cancel(); resolve(parts(123)); await pending;
  assert.equal(b.current.source, parent); assert.equal(b.parents.length, 0);
  const closed = b.Enter(h.b); b.Close(); resolve(parts(456)); await closed; assert.equal(b.current.source, parent);
  const other = Harness().browser; await other.Search('one'); other.selected.set('old', 'old'); await other.Search('two'); assert.equal(other.selected.size, 0);
});
test('Bilibili child source uses the chosen sibling and treats single-part videos as leaves', async () => {
  const ids = [];
  const account = new BilibiliAccount(async url => {
    const id = new URL(url).searchParams.get('aid'); ids.push(id);
    return { ok: true, json: async () => ({ code: 0, data: { title: '日本語 中文', pages: id === '456' ? [{ page: 1 }, { page: 2 }] : [{ page: 1 }] } }) };
  });
  assert.equal(await account.Parts(video(123).url), null);
  const source = await account.Parts(video(456).url); assert.equal(source.kind, 'parts'); assert.equal(source.id, 'av456'); assert.equal(source.total, 2);
  const page = await account.ListVideos(source); assert.equal(page.videos[1].url, video(456, 2).url); assert.deepEqual(ids, ['123', '456']);
});
