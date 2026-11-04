'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Store } = require('../src/core/store.cjs');
const { AdditionReview } = require('../src/core/addition-review.cjs');
const { ListArtwork } = require('../src/ui/list-artwork.js');
const { QueueFollower } = require('../src/ui/queue-follow.js');
// 実rendererをDOMモデルへ接続する。寸法は固定値で、Windowsの描画確認ではない。
async function Harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-ui-046-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root), id = store.data.activePlaylistId;
  store.Apply({ type: 'add', playlistId: id, urls: Array.from({ length: 12 }, (_, n) => `av${100 + n}`).join('\n') });
  store.Playlist(id).entries.forEach((entry, index) => entry.title = `曲${index + 1}`); store.Save();
  const review = new AdditionReview(store), nodes = new Map(), frames = [], errors = [], scrolls = [], bounds = [], calls = [], windowEvents = {};
  let now = 0, emit, artworkObserver, timerId = 0; const timers = new Map();
  class Node {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = {}; this.dataset = {}; this.style = { setProperty() {} }; this.scrollTop = 0; this.checked = false; this.disabled = false; this.open = false; this.clientHeight = 300; this.classes = new Set();
      this.classList = { add: (...values) => values.forEach(v => this.classes.add(v)), remove: (...values) => values.forEach(v => this.classes.delete(v)), contains: v => this.classes.has(v), toggle: (v, force) => { if (force ?? !this.classes.has(v)) this.classes.add(v); else this.classes.delete(v); } };
    }
    set className(value) { this.classes = new Set(value.split(/\s+/)); } get className() { return [...this.classes].join(' '); }
    append(...children) { for (const node of children) { node.parentElement = this; this.children.push(node); } }
    replaceChildren(...children) { this.children = []; this.text = ''; this.append(...children); }
    set textContent(value) { this.text = String(value); this.children = []; } get textContent() { return (this.text || '') + this.children.map(c => c.textContent).join(''); }
    set value(value) { this.val = String(value); } get value() { return this.val ?? this.children[0]?.value ?? ''; }
    setAttribute(k, v) { this[k] = v; } getAttribute(k) { return this[k] ?? null; } removeAttribute(k) { delete this[k]; }
    focus() { document.activeElement = this; }
    addEventListener(name, callback) { this.events[name] = callback; }
    querySelectorAll(selector) { const all = this.children.flatMap(c => [c, ...c.querySelectorAll('*')]); if (selector === '*') return all;
      return all.filter(n => selector === 'input:checked' ? n.tagName === 'input' && n.checked : selector.startsWith('.') ? n.classList.contains(selector.slice(1)) : n.tagName === selector); }
    closest(selector) { return selector.startsWith('.') && this.classList.contains(selector.slice(1)) ? this : this.parentElement?.closest(selector); }
    querySelector(selector) { return selector === 'use' ? { setAttribute() {} } : this.querySelectorAll(selector)[0]; }
    set innerHTML(html) { for (const id of this.htmlIds || []) nodes.delete(id); this.htmlIds = []; this.children = [];
      for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) { const n = new Node(match[1]); n.id = match[2]; nodes.set(n.id, n); this.append(n); this.htmlIds.push(n.id);
        for (const attr of match[0].matchAll(/\b(type|value|class)="([^"]*)"/g)) n[attr[1] === 'class' ? 'className' : attr[1]] = attr[2]; }
    }
    get offsetHeight() { return this.classList.contains('entry') || this.classList.contains('playlist-entry') ? 60 : 0; }
    getBoundingClientRect() { const parentRow = this.classList.contains('parent-row'), height = parentRow ? 38 : 300; const top = parentRow || this.classList.contains('entry') || this.classList.contains('playlist-entry') ? 100 + this.parentElement.children.indexOf(this) * (parentRow ? 38 : 60) - this.parentElement.scrollTop : 100; return { top, y: top, x: 100, left: 100, right: 600, bottom: top + height, width: 500, height }; }
    scrollTo({ top }) { this.scrollTop = top; scrolls.push(top); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); }
    showModal() { this.open = true; } close() { this.open = false; } reportValidity() { return true; }
  }
  const html = fs.readFileSync(path.join(__dirname, '../src/ui/index.html'), 'utf8');
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) { const n = new Node(match[1]); n.id = match[2]; nodes.set(n.id, n); }
  const surfaces = ['sidebar', 'main', 'transport', 'titlebar'].map(name => new Node(name));
  const document = { body: new Node('body'), events: {}, getElementById: id => nodes.get(id), createElement: tag => new Node(tag), createDocumentFragment: () => new Node(), querySelectorAll: selector => {
    if (selector === '.sidebar, main, .transport, .titlebar') return surfaces;
    const all = [...nodes.values()].flatMap(n => [n, ...n.querySelectorAll('*')]);
    if (selector === '[data-saved-title]') return all.filter(n => Object.hasOwn(n.dataset, 'savedTitle'));
    if (selector === '.sidebar [title], main [title], .transport [title]') return all.filter(n => n.title);
    return [];
  }, addEventListener(name, fn) { this.events[name] = fn; } };
  const api = { resolveURL: async value => { const video = require('../src/core/urls.cjs').ParseBilibili(value); return { kind: 'video', video: { ...video, title: '' }, sources: [] }; }, state: async () => ({ state: store.Snapshot(), current: null, playback: null, statuses: {}, foreground: true, accounts: { bilibili: { loggedIn: true } }, version: '0.4.6', platform: 'win32' }),
    entryThumbnail: async () => null, preferSaved: async value => ({ preferSaved: value }), accounts: async () => ({ bilibili: { loggedIn: true } }), onEvent: cb => emit = cb, bounds: value => bounds.push(value), action: async value => store.Apply(value),
    prepareAdd: value => { calls.push(value); return review.Prepare(value); }, commitAdd: (id, selected) => review.Commit(id, selected), cancelAdd: async id => review.Cancel(id) };
  const context = { document, window: { addEventListener: (name, fn) => windowEvents[name] = fn, favecusApp: api, FavecusQueueFollow: { QueueFollower }, FavecusListArtwork: { ListArtwork }, FavecusTransport: require('../src/ui/transport-model.js') },
    Date: class extends Date { static now() { return now; } }, requestAnimationFrame: fn => frames.push(fn), IntersectionObserver: class { constructor(callback, options) { this.callback = callback; this.options = options; this.items = new Set(); if (options.threshold === 0) artworkObserver = this; } observe(item) { this.items.add(item); } disconnect() { this.items.clear(); } }, ResizeObserver: class { constructor() {} observe() {} }, setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout: id => timers.delete(id), console: { error: e => errors.push(e) } };
  vm.createContext(context);
  for (const file of ['library-tree.js', 'tree-view.js', 'parent-picker.js', 'playlist-reader.js', 'keybindings.js', 'queue-drag.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui', file), 'utf8').replace('})(globalThis)', '})(window)'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/app.js'), 'utf8'), context); await new Promise(setImmediate);
  const flush = () => { while (frames.length) frames.shift()(); };
  flush(); assert.equal(errors.length, 0);
  return { store, id, api, artworkObserver, nodes, scrolls, bounds, calls, html, document, surfaces, windowEvent: name => windowEvents[name]?.(), flush, run: code => vm.runInContext(code, context), emit: (type, value) => emit({ type, value }), advance: ms => now += ms,
    play(index) { const entry = store.Playlist(id).entries[index]; emit({ type: 'current', value: { source: entry.type, playlistId: id, entryId: entry.id, entry } }); }, node: id => nodes.get(id), submit: () => vm.runInContext('PerformModal(submitModal, true)', context), tick(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } } };
}
function SingleDownloadAPI(h) {
  const started = [], estimates = [], value = { id: 'single-estimate', total: 1, skipped: 0, unknown: 0, fileBytes: 1048576, requiredBytes: 2097152, secondsMin: 1, secondsMax: 10 };
  h.api.downloads = async () => ({}); h.api.cancelDownloadEstimate = async () => {};
  h.api.estimateDownload = async input => { estimates.push({ ...input }); return value; };
  h.api.downloadPlaylist = async input => { started.push({ ...input }); return { job: { ...input, playlistName: '曲の保存先', status: 'running', total: 1, finished: 0, completed: 0, skipped: 0, failed: 0 } }; };
  return { started, estimates, value };
}
function EditEntry(h, playlistId = h.id, index = 0) { h.run(`EntryMenu(${JSON.stringify({ ...h.store.Playlist(playlistId).entries[index], playlistId })})`); }
test('067 single download targets the edited child and part, preserves drafts on back and start, and saves a title only on submit', async t => {
  const h = await Harness(t), s = h.store, api = SingleDownloadAPI(h);
  s.Apply({ type: 'create', name: '子', parentId: h.id }); const child = s.data.activePlaylistId;
  s.Apply({ type: 'add', playlistId: child, urls: 'av999\nhttps://www.bilibili.com/video/av999/?p=2' });
  s.Apply({ type: 'select', playlistId: h.id }); h.emit('state', s.Snapshot());
  const entry = s.Playlist(child).entries[1], before = s.Snapshot(); EditEntry(h, child, 1);
  h.node('entry-title-input').value = '編集中の名前'; h.node('entry-download-button').onclick(); await new Promise(setImmediate);
  assert.equal(h.node('modal-title').textContent, 'この動画のみをダウンロード'); assert.match(h.node('download-entry-meta').textContent, /av999 \/ パート 2/);
  assert.equal(h.node('download-list-picker'), undefined); assert.equal(h.node('download-children'), undefined);
  assert.equal(api.estimates[0].playlistId, child); assert.equal(api.estimates[0].entryId, entry.id); assert.equal(api.estimates[0].entryURL, entry.url); assert.equal(api.estimates[0].includeChildren, false);
  await h.node('modal-back').onclick(); assert.equal(h.node('entry-title-input').value, '編集中の名前'); assert.deepEqual(s.Snapshot(), before);
  h.node('entry-download-button').onclick(); await new Promise(setImmediate);
  h.node('download-kind').value = 'audio'; h.node('download-kind').onchange(); await new Promise(setImmediate); assert.equal(h.node('download-height').disabled, true);
  await h.node('download-start').onclick(); assert.equal(api.started.length, 1); assert.equal(api.started[0].entryId, entry.id); assert.equal(api.started[0].kind, 'audio');
  assert.equal(h.node('modal-title').textContent, '動画の編集'); assert.equal(h.node('entry-title-input').value, '編集中の名前'); assert.deepEqual(s.Snapshot(), before);
  assert.equal(h.node('download-mini').classList.contains('hidden'), false); await h.submit(); assert.equal(s.Entry(child, entry.id).title, '編集中の名前'); assert.equal(s.Playlist(child).entries[0].title, before.playlists.find(p => p.id === child).entries[0].title);
});
test('067 local editing has no download action and saved badges follow the exact part', async t => {
  const h = await Harness(t); SingleDownloadAPI(h); const entry = h.store.Playlist(h.id).entries[0];
  h.emit('downloads', { available: [{ url: entry.url + '?p=2', kind: 'video' }] }); EditEntry(h); assert.equal(h.node('entry-download-state').textContent, 'オンライン');
  h.emit('downloads', { available: [{ url: entry.url, kind: 'audio' }] }); assert.equal(h.node('entry-download-state').textContent, '音声保存済み');
  h.node('entry-download-button').onclick(); await new Promise(setImmediate); assert.equal(h.node('download-entry-saved').textContent, '音声保存済み');
  h.emit('downloads', { available: [{ url: entry.url, kind: 'video' }] }); assert.equal(h.node('download-entry-saved').textContent, '動画保存済み');
  const local = { ...entry, type: 'local', fileName: 'music.mp3' }; h.store.Playlist(h.id).entries[0] = local; h.emit('state', h.store.Snapshot()); EditEntry(h);
  assert.equal(h.node('entry-download-button'), undefined); assert.equal(h.node('entry-download-state'), undefined);
});
test('067 stale single targets disable start and late estimates cannot reach another editor', async t => {
  const h = await Harness(t), api = SingleDownloadAPI(h), pending = []; let cancelled = 0;
  h.api.cancelDownloadEstimate = async () => cancelled++; h.api.estimateDownload = () => new Promise(resolve => pending.push(resolve));
  EditEntry(h); h.node('entry-download-button').onclick(); await new Promise(setImmediate); assert.equal(h.node('download-start').disabled, false);
  const entry = h.store.Playlist(h.id).entries[0]; h.store.Apply({ type: 'remove', playlistId: h.id, entryId: entry.id }); h.emit('state', h.store.Snapshot());
  assert.equal(h.node('download-start').disabled, true); assert.match(h.node('download-count').textContent, /移動・削除/);
  pending[0]({ ...api.value, id: 'removed' }); await new Promise(setImmediate); assert.equal(h.run('downloadEstimate'), null);
  await h.node('download-start').onclick(); assert.equal(api.started.length, 0); await h.node('modal-back').onclick(); assert.equal(h.node('modal').open, false);
  EditEntry(h); h.node('entry-download-button').onclick(); await new Promise(setImmediate); h.run('CloseModal()'); EditEntry(h);
  pending[1]({ ...api.value, id: 'closed' }); await new Promise(setImmediate); assert.equal(h.run('downloadEstimate'), null); assert.equal(h.node('modal-title').textContent, '動画の編集'); assert.equal(cancelled, 2);
});
test('067 a single start resists double clicks, reports rejection, and can retry without committing the draft', async t => {
  const h = await Harness(t); SingleDownloadAPI(h); let reject, starts = 0;
  h.api.downloadPlaylist = () => { starts++; return new Promise((_resolve, fail) => reject = fail); };
  EditEntry(h); h.node('entry-title-input').value = '未確定'; h.node('entry-download-button').onclick(); await new Promise(setImmediate);
  const start = h.node('download-start').onclick(); await h.node('download-start').onclick(); assert.equal(starts, 1); assert.equal(h.node('download-start').disabled, true);
  reject(new Error('保存先に書き込めません。')); await start; assert.equal(h.node('download-start').disabled, false); assert.match(h.node('toast').textContent, /保存先に書き込めません/);
  assert.notEqual(h.store.Playlist(h.id).entries[0].title, '未確定');
  h.api.downloadPlaylist = async input => { starts++; return { job: { ...input, playlistName: '再試行', status: 'running', total: 1, finished: 0 } }; };
  await h.node('download-start').onclick(); assert.equal(starts, 2); assert.equal(h.node('modal-title').textContent, '動画の編集'); assert.equal(h.node('entry-title-input').value, '未確定'); assert.notEqual(h.store.Playlist(h.id).entries[0].title, '未確定');
});
test('067 another running single job blocks start and does not supply an estimate for this part', async t => {
  const h = await Harness(t), api = SingleDownloadAPI(h), entry = h.store.Playlist(h.id).entries[1];
  h.emit('downloads', { job: { playlistId: h.id, entryId: entry.id, kind: 'video', height: 720, playlistName: '別の曲', status: 'running', total: 1, finished: 0, estimate: { ...api.value, fileBytes: 999999999 } } });
  EditEntry(h); h.node('entry-download-button').onclick(); await new Promise(setImmediate);
  assert.equal(h.node('download-start').disabled, true); assert.match(h.node('download-estimate').textContent, /別の保存処理/); assert.equal(api.estimates.length, 0);
  h.emit('downloads', { job: { status: 'completed', total: 1, finished: 1 } }); await new Promise(setImmediate); assert.equal(h.node('download-start').disabled, false); assert.equal(api.estimates.length, 1);
});
test('normal playback follows each new row to the top without reordering and does not follow in the background', async t => {
  const h = await Harness(t), order = h.store.Playlist(h.id).entries.map(e => e.id); h.play(1); h.flush(); assert.equal(h.node('entries').scrollTop, 60);
  h.play(11); h.flush(); assert.equal(h.node('entries').scrollTop, 660); assert.equal(h.node('entries').querySelector('.queue-tail').style.height, '240px');
  h.emit('foreground', false); h.play(3); h.flush(); assert.equal(h.node('entries').scrollTop, 660);
  h.emit('foreground', true); h.flush(); assert.equal(h.node('entries').scrollTop, 180); assert.deepEqual(h.store.Playlist(h.id).entries.map(e => e.id), order);
});
test('manual scrolling, dragging, modals and a late input cancel automatic movement without resetting the existing offset', async t => {
  const h = await Harness(t), list = h.node('entries'); h.play(2); h.flush(); list.scrollTop = 123;
  list.events.wheel(); h.play(5); h.flush(); assert.equal(list.scrollTop, 123);
  h.advance(1600); h.play(6); list.events.wheel(); h.flush(); assert.equal(list.scrollTop, 123);
  h.advance(1600); list.events.pointerdown({ clientX: 596, pointerType: 'mouse' }); h.advance(3000); h.play(7); h.flush(); assert.equal(list.scrollTop, 123);
  h.document.events.pointerup(); h.advance(1600); h.run('dragged = { playlistId: state.activePlaylistId };'); h.play(8); h.flush(); assert.equal(list.scrollTop, 123);
  h.run('dragged = null; AddURL();'); h.play(9); h.flush(); assert.equal(list.scrollTop, 123); h.run('CloseModal()');
  h.play(4); h.flush(); assert.equal(list.scrollTop, 240);
  list.scrollTop = 97; h.emit('state', h.store.Snapshot()); h.flush(); assert.equal(list.scrollTop, 97);
});
test('filtering retains the query, and the next-track overlay reflects the queue supplied by the main process', async t => {
  const h = await Harness(t); h.node('filter').value = '曲1'; h.node('filter').events.input(); h.advance(1600); h.play(4); h.flush(); assert.equal(h.scrolls.length, 0); assert.equal(h.node('filter').value, '曲1');
  h.emit('queue', { playlistId: h.id, name: 'お気に入り', shuffle: true, repeat: 'all', next: { id: 'x', index: 9, title: '次の曲名' } });
  assert.equal(h.node('up-next').classList.contains('hidden'), false); assert.equal(h.node('up-next-title').textContent, '09　次の曲名');
  h.emit('queue', { shuffle: true, repeat: 'off', next: null }); assert.match(h.node('up-next-title').textContent, /終了/);
  h.emit('queue', { shuffle: false }); assert.equal(h.node('up-next').classList.contains('hidden'), false);
});
test('browser additions prefill the existing URL dialog and preserve destination and duplicate review behavior', async t => {
  const h = await Harness(t); const draft = { url: 'https://www.bilibili.com/video/av100/?p=2', title: '<b>別パート</b>' };
  h.emit('add-url', draft); assert.equal(h.node('url-input').value, draft.url); assert.equal(h.node('url-title').value, draft.title);
  const selected = h.node('modal-body').children.at(-1).querySelectorAll('input:checked'); assert.equal(selected.length, 1); assert.equal(selected[0].value, h.id);
  await h.node('url-load').onclick(); await h.submit(); assert.equal(h.store.Playlist(h.id).entries.at(-1).part, 2); assert.equal(h.node('modal').open, false);
  h.emit('add-url', draft); await h.node('url-load').onclick(); await h.submit(); assert.equal(h.node('modal-title').textContent, '重複の可能性がある曲');
  assert.equal(h.node('duplicate-list').querySelectorAll('input:checked').length, 0); h.run('CloseModal()'); assert.equal(h.store.Playlist(h.id).entries.length, 13);
});
test('search requires login and the four integrated add buttons keep the requested left-to-right order', async t => {
  const h = await Harness(t); const actionRow = h.html.match(/<div class="heading-actions">(.*?)<\/div>/s)[1];
  assert.deepEqual([...actionRow.matchAll(/id="([^"]+)"/g)].map(x => x[1]), ['browse-bilibili', 'add-files', 'add-existing', 'add-url']);
  assert.equal(h.node('browse-bilibili').disabled, false); h.emit('accounts', { bilibili: { loggedIn: false } }); assert.equal(h.node('browse-bilibili').disabled, true);
  h.run('Settings()'); assert.ok(h.node('bili-favorites')); assert.equal(h.node('modal-title').textContent, '設定・連携');
});

test('visible row artwork appears after the number without a source badge and does not trigger playback', async t => {
  const h = await Harness(t), list = h.node('entries'); let requests = 0, plays = 0;
  h.api.entryThumbnail = async (playlistId, entryId) => { requests++; assert.equal(playlistId, h.id); assert.equal(entryId, h.store.Playlist(h.id).entries[0].id); return 'data:image/png;base64,aWNvbg=='; };
  h.api.play = async () => plays++;
  const row = list.children[0], cover = row.children[1];
  assert.equal(row.querySelector('.entry-thumb'), undefined); assert.equal(cover.tagName, 'img'); assert.equal(cover.className, 'entry-cover'); assert.equal(row.children[2].className, 'icon-button');
  assert.equal(requests, 0); assert.equal(cover.src, 'music.png'); assert.equal(h.artworkObserver.options.root, list);
  h.artworkObserver.callback([{ target: cover, isIntersecting: true }]); await new Promise(setImmediate);
  assert.equal(requests, 1); assert.equal(cover.src, 'data:image/png;base64,aWNvbg=='); assert.equal(plays, 0);
  await row.children[2].events.click(); assert.equal(plays, 1); assert.equal(list.children[0], row);
  h.artworkObserver.callback([{ target: cover, isIntersecting: false }]); assert.equal(cover.src, 'music.png');
});
test('track changes follow the next frame without rebuilding rows or awaiting a blocked thumbnail request', async t => {
  const h = await Harness(t), list = h.node('entries'), rows = [...list.children], cover = rows[0].children[1];
  h.api.entryThumbnail = () => new Promise(() => {});
  h.artworkObserver.callback([{ target: cover, isIntersecting: true }]); await new Promise(setImmediate);
  h.play(10); assert.equal(list.scrollTop, 0); h.flush(); assert.equal(list.scrollTop, 600);
  assert.deepEqual(list.children, rows); assert.ok(rows[10].classList.contains('current'));
  h.play(1); h.flush(); assert.equal(list.scrollTop, 60); assert.equal(rows[10].classList.contains('current'), false); assert.ok(rows[1].classList.contains('current'));
});
test('focus moving to the video keeps the list interactive and follows the next track without another click', async t => {
  const h = await Harness(t); h.play(1); h.flush();
  h.windowEvent('blur');
  assert.ok(h.surfaces.every(node => !node.inert));
  h.play(8); h.flush(); assert.equal(h.node('entries').scrollTop, 480);
  h.windowEvent('focus'); h.run('AddURL()');
  assert.ok(h.surfaces.every(node => node.inert));
  h.windowEvent('focus'); assert.ok(h.surfaces.every(node => node.inert));
  h.run('CloseModal()'); assert.ok(h.surfaces.every(node => !node.inert));
});
test('an explicit play click follows immediately after manual scrolling while automatic changes still respect manual input', async t => {
  const h = await Harness(t), list = h.node('entries');
  list.scrollTop = 123; list.events.wheel();
  h.play(4); h.flush(); assert.equal(list.scrollTop, 123);
  h.api.play = async (_scope, id) => h.play(h.store.Playlist(h.id).entries.findIndex(e => e.id === id));
  await list.children[7].children[2].events.click(); h.flush();
  assert.equal(list.scrollTop, 420);
  list.events.wheel(); h.play(9); h.flush(); assert.equal(list.scrollTop, 420);
});
test('child playlist arrows expand and collapse in place without playback, selection or queue changes', async t => {
  const h = await Harness(t), s = h.store;
  s.Apply({ type: 'create', name: '子リスト', parentId: h.id }); const child = s.data.activePlaylistId;
  s.Apply({ type: 'add', playlistId: child, urls: 'av501' });
  s.Apply({ type: 'create', name: '孫リスト', parentId: child }); const grandchild = s.data.activePlaylistId;
  s.Apply({ type: 'add', playlistId: grandchild, urls: 'av601' }); s.Apply({ type: 'select', playlistId: h.id });
  h.emit('state', s.Snapshot()); const list = h.node('entries'), card = list.children[0];
  assert.ok(card.classList.contains('playlist-entry')); assert.equal(card.dataset.playlistId, child); assert.equal(list.querySelectorAll('.entry').length, 12);
  assert.deepEqual(s.Entries(h.id).slice(-2).map(e => e.videoId), ['av501', 'av601']);
  const queue = s.Entries(h.id).map(e => e.id); let played = 0; h.api.play = async () => played++;
  assert.equal(card.children[1].getAttribute('aria-expanded'), 'false');
  await card.children[1].events.click();
  assert.equal(list.children[0].children[1].getAttribute('aria-expanded'), 'true'); assert.equal(h.document.activeElement, list.children[0].children[1]);
  assert.equal(list.children[1].dataset.playlistId, grandchild); assert.equal(list.querySelectorAll('.entry').length, 13);
  await list.children[1].children[1].events.click(); assert.equal(list.querySelectorAll('.entry').length, 14);
  const entry = s.Playlist(grandchild).entries[0]; h.advance(1600); h.emit('current', { source: entry.type, playlistId: grandchild, entryId: entry.id, entry }); h.flush();
  assert.equal(list.children[2].dataset.entryId, entry.id); assert.ok(list.children[2].classList.contains('current')); assert.equal(list.scrollTop, 120);
  await list.children[0].children[1].events.click(); assert.equal(list.querySelectorAll('.entry').length, 12); assert.ok(list.children[0].classList.contains('current'));
  assert.equal(played, 0); assert.equal(s.data.activePlaylistId, h.id); assert.equal(h.run('current.entryId'), entry.id); assert.deepEqual(s.Entries(h.id).map(e => e.id), queue);
  await list.children[0].children[0].events.click(); assert.equal(s.data.activePlaylistId, child); assert.equal(h.node('entries').children[0].dataset.playlistId, grandchild);
  assert.equal(h.node('entries').querySelectorAll('.entry').length, 1);
});
test('a lost pointer release during focus transfer does not permanently block automatic scrolling', async t => {
  const h = await Harness(t), list = h.node('entries');
  list.events.pointerdown({ clientX: 596, pointerType: 'mouse' }); h.windowEvent('blur'); h.advance(1600);
  h.play(7); h.flush(); assert.equal(list.scrollTop, 420);
  h.emit('foreground', false); h.play(4); h.flush(); assert.equal(list.scrollTop, 420);
  h.emit('foreground', true); h.flush(); assert.equal(list.scrollTop, 240);
});
test('expanded songs keep their real owner for edits, ordering and parent playback', async t => {
  const h = await Harness(t), s = h.store;
  s.Apply({ type: 'create', name: '子リスト', parentId: h.id }); const child = s.data.activePlaylistId;
  s.Apply({ type: 'add', playlistId: child, urls: 'av501\nav502' }); s.Apply({ type: 'select', playlistId: h.id }); h.emit('state', s.Snapshot());
  const ownOrder = s.Playlist(h.id).entries.map(e => e.id), entry = s.Playlist(child).entries[0];
  const list = h.node('entries'); await list.children[0].children[1].events.click();
  let selected; h.api.play = async (...args) => selected = args;
  await list.children[1].children[2].events.click(); assert.deepEqual(selected, [h.id, entry.id]);
  await list.children[1].children.at(-1).events.click(); h.node('entry-title-input').value = '展開中に編集'; await h.submit();
  assert.equal(s.Entry(child, entry.id).title, '展開中に編集'); assert.deepEqual(s.Playlist(h.id).entries.map(e => e.id), ownOrder);
  list.children[1].children[0].events.keydown({ altKey: true, key: 'ArrowDown', preventDefault() {} }); await new Promise(setImmediate);
  assert.equal(s.Playlist(child).entries[1].id, entry.id); assert.deepEqual(s.Playlist(h.id).entries.map(e => e.id), ownOrder);
  h.node('filter').value = '展開中に編集'; h.node('filter').events.input();
  assert.equal(list.children[0].dataset.playlistId, child); assert.equal(list.querySelectorAll('.entry').length, 1);
});
test('expanded all-playlist duplicates resolve to the existing deduplicated playback queue', async t => {
  const h = await Harness(t), s = h.store, original = s.Playlist(h.id).entries[0];
  s.Apply({ type: 'create', name: '同じ曲を持つリスト' }); const other = s.data.activePlaylistId;
  s.Apply({ type: 'add', playlistId: other, urls: original.url }); h.emit('state', s.Snapshot()); h.run('allListsView = true; Render();');
  const list = h.node('entries'); await list.children[1].children[1].events.click();
  let selected; h.api.play = async (...args) => selected = args;
  await list.children[2].children[2].events.click(); assert.deepEqual(selected, ['*', original.id]);
});
test('transfer hides the source playlist while leaving its children selectable, and ZIP actions pass no password', async t => {
  const h = await Harness(t), s = h.store;
  s.Apply({ type: 'create', name: '移動先', parentId: h.id }); const child = s.data.activePlaylistId; s.Apply({ type: 'select', playlistId: h.id }); h.emit('state', s.Snapshot());
  h.run('TransferEntry(List().id, List().entries[0])');
  const inputs = h.node('modal-body').children.at(-1).querySelectorAll('input').filter(n => n.type === 'checkbox'); assert.deepEqual(inputs.map(n => n.value), [child]);
  h.run('Transfer()'); assert.equal(h.node('archive-password'), undefined);
  let exportArgs, importArgs; h.api.exportLibrary = async (...args) => { exportArgs = args; return {}; }; h.api.importLibrary = async (...args) => { importArgs = args; return null; };
  await h.node('export-button').onclick(); await h.node('import-button').onclick(); assert.deepEqual(exportArgs, []); assert.deepEqual(importArgs, []);
});

function ParentTree(h) {
  const s = h.store; s.Apply({ type: 'rename', playlistId: h.id, name: 'EroGameSongs' });
  const create = (name, parentId = null) => { s.Apply({ type: 'create', name, parentId }); return s.data.activePlaylistId; };
  const parent = create('ケロQ・枕', h.id), a = create('サクラノ詩', parent), b = create('サクラノ刻', parent), other = create('toneworks');
  s.Apply({ type: 'select', playlistId: h.id }); h.emit('state', s.Snapshot());
  return { parent, a, b, other };
}
test('parent search opens ancestors, highlights matches in the full tree and scrolls only the picker without selecting a parent', async t => {
  const h = await Harness(t), ids = ParentTree(h); h.node('entries').scrollTop = 123; h.node('new-list').onclick({ type: 'click' });
  const picker = h.node('new-parent'), choices = picker.querySelector('.parent-choices'), search = picker.querySelector('.parent-search'); choices.clientHeight = 80;
  assert.deepEqual(choices.children.map(r => r.dataset.playlistId), [h.id, ids.other]);
  assert.equal(picker.querySelector('.parent-root').getAttribute('aria-pressed'), 'true');
  search.focus(); search.value = 'サクラノ刻'; search.oninput();
  assert.deepEqual(choices.children.map(r => r.dataset.playlistId), [h.id, ids.parent, ids.a, ids.b, ids.other]);
  assert.deepEqual(choices.querySelectorAll('.search-match').map(r => r.dataset.playlistId), [ids.b]);
  assert.equal(choices.scrollTop, 93); assert.equal(h.node('entries').scrollTop, 123); assert.equal(h.document.activeElement, search);
  assert.equal(picker.querySelector('.parent-root').getAttribute('aria-pressed'), 'true');
  choices.children[3].querySelector('.parent-name').onclick();
  assert.equal(picker.querySelector('.parent-selection').textContent, '選択中：EroGameSongs/ケロQ・枕/サクラノ刻');
  h.node('name-input').value = '子として新規作成'; await h.submit();
  const created = h.store.data.activePlaylistId;
  assert.ok(h.store.Playlist(ids.b).childIds.includes(created)); assert.equal(h.node('modal').open, false);
});
test('parent search cycles multiple results, handles Japanese composition, and restores collapsed branches when cleared', async t => {
  const h = await Harness(t), ids = ParentTree(h); h.run('NewList()');
  const picker = h.node('new-parent'), choices = picker.querySelector('.parent-choices'), search = picker.querySelector('.parent-search');
  search.focus(); search.value = 'サクラ'; search.oninput();
  assert.deepEqual(choices.querySelectorAll('.search-match').map(r => r.dataset.playlistId), [ids.a, ids.b]);
  assert.match(picker.querySelector('.parent-search-status').textContent, /1 \/ 2件/);
  let prevented = false; search.onkeydown({ key: 'Enter', isComposing: true, preventDefault() { prevented = true; } }); assert.equal(prevented, false);
  search.onkeydown({ key: 'Enter', preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  assert.deepEqual(choices.querySelectorAll('.search-current').map(r => r.dataset.playlistId), [ids.b]);
  assert.equal(h.document.activeElement, search); assert.equal(h.node('modal').open, true);
  picker.querySelector('.parent-search-tools').children[2].onclick();
  assert.deepEqual(choices.querySelectorAll('.search-current').map(r => r.dataset.playlistId), [ids.a]);
  search.value = '見つからない'; search.oninput(); assert.match(picker.querySelector('.parent-search-status').textContent, /ありません/);
  assert.deepEqual(choices.children.map(r => r.dataset.playlistId), [h.id, ids.other]);
  search.value = ''; search.oninput(); assert.deepEqual(choices.children.map(r => r.dataset.playlistId), [h.id, ids.other]);
  assert.equal(choices.querySelectorAll('.search-match').length, 0);
  choices.children[0].querySelector('.tree-expand').onclick();
  const focused = choices.children[0].querySelector('.tree-expand'); assert.equal(h.document.activeElement, focused); assert.equal(focused.getAttribute('aria-expanded'), 'true');
  search.value = 'ｅｒｏｇａｍｅｓｏｎｇｓ'; search.oninput(); assert.equal(choices.children[0].classList.contains('search-match'), true);
  search.value = ''; search.oninput(); assert.deepEqual(choices.children.map(r => r.dataset.playlistId), [h.id, ids.parent, ids.other]);
});
test('the header plus creates under the current nested playlist and the sidebar plus resets to no parent', async t => {
  const h = await Harness(t), ids = ParentTree(h); await h.run(`Action({ type: 'select', playlistId: '${ids.b}' })`);
  h.node('new-child-list').onclick();
  const picker = h.node('new-parent'); assert.equal(picker.querySelector('.parent-selection').textContent, '選択中：EroGameSongs/ケロQ・枕/サクラノ刻');
  assert.equal(picker.querySelector('.parent-choices').querySelector('.selected').dataset.playlistId, ids.b);
  h.node('name-input').value = '追加した子'; await h.submit(); assert.ok(h.store.Playlist(ids.b).childIds.includes(h.store.data.activePlaylistId));
  h.node('new-list').onclick({ type: 'click' }); assert.equal(h.node('new-parent').querySelector('.parent-root').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(h.node('new-parent').querySelector('.parent-choices').children.map(r => r.dataset.playlistId), [h.id, ids.other]);
  h.run('CloseModal(); allListsView = true; Render()'); assert.equal(h.node('new-child-list').classList.contains('hidden'), true);
});
test('move and nested-create parent pickers exclude the moved playlist and descendants while preserving the original dialog', async t => {
  const h = await Harness(t), ids = ParentTree(h); h.run(`MovePlaylist('${ids.parent}')`);
  const picker = h.node('move-parent'), search = picker.querySelector('.parent-search'); search.value = 'サクラ'; search.oninput();
  assert.match(picker.querySelector('.parent-search-status').textContent, /ありません/);
  picker.querySelector('.parent-choices').children[0].querySelector('.tree-expand').onclick();
  assert.deepEqual(picker.querySelector('.parent-choices').children.map(r => r.dataset.playlistId), [h.id, ids.other]);
  h.node('move-new-parent').onclick(); const dialog = h.document.body.children.at(-1), form = dialog.children[0];
  const nestedSearch = form.querySelector('.parent-search'); nestedSearch.value = 'tone'; nestedSearch.oninput();
  form.querySelector('.parent-choices').children.find(r => r.dataset.playlistId === ids.other).querySelector('.parent-name').onclick();
  form.querySelector('input').value = '新しい親'; await form.onsubmit({ preventDefault() {} });
  const created = h.store.data.playlists.find(p => p.name === '新しい親');
  assert.ok(h.store.Playlist(ids.other).childIds.includes(created.id)); assert.ok(created.childIds.includes(ids.parent));
  assert.equal(h.store.Playlist(h.id).childIds.includes(ids.parent), false); assert.equal(h.node('modal').open, false); assert.equal(dialog.open, false);
});
test('next-track hierarchy uses the track owner and playback scope while keeping the existing number and title', async t => {
  const h = await Harness(t), ids = ParentTree(h); h.play(0);
  const queue = { playlistId: h.id, name: 'EroGameSongs', shuffle: true, repeat: 'all', next: { id: 'next', playlistId: ids.b, index: 39, title: '次の曲' } };
  h.emit('queue', queue); assert.equal(h.node('up-next-path').textContent, 'EroGameSongs/ケロQ・枕/サクラノ刻'); assert.equal(h.node('up-next-title').textContent, '39　次の曲');
  h.store.Apply({ type: 'playlist-attach', playlistId: ids.other, ids: [ids.parent], removeOriginal: false });
  h.store.Apply({ type: 'select', playlistId: ids.other }); h.emit('state', h.store.Snapshot());
  assert.equal(h.node('up-next-path').textContent, 'EroGameSongs/ケロQ・枕/サクラノ刻');
  h.emit('queue', { ...queue, playlistId: ids.other }); assert.equal(h.node('up-next-path').textContent, 'toneworks/ケロQ・枕/サクラノ刻');
  h.store.Apply({ type: 'rename', playlistId: ids.b, name: '変更後' }); h.emit('state', h.store.Snapshot()); assert.equal(h.node('up-next-path').textContent, 'toneworks/ケロQ・枕/変更後');
  h.emit('queue', { ...queue, next: null }); assert.equal(h.node('up-next-path').textContent, ''); assert.match(h.node('up-next-title').textContent, /終了/);
  h.emit('queue', { ...queue, shuffle: false }); assert.equal(h.node('up-next').classList.contains('hidden'), false);
});

test('060 collapsed descendants remain searchable and clearing a query restores their collapsed state', async t=>{
 const h=await Harness(t),s=h.store;s.Apply({type:'create',name:'子',parentId:h.id});const child=s.data.activePlaylistId;s.Apply({type:'create',name:'孫',parentId:child});const grand=s.data.activePlaylistId;s.Apply({type:'add',playlistId:grand,urls:'av555',title:'探している歌'});s.Apply({type:'select',playlistId:h.id});h.emit('state',s.Snapshot());
 assert.equal(h.node('entries').querySelectorAll('.entry').length,12);h.node('filter').value='探して';h.node('filter').events.input();assert.equal(h.node('entries').querySelectorAll('.entry').length,1);assert.equal(h.node('entries').querySelectorAll('.playlist-entry').length,2);
 h.node('filter').value='';h.node('filter').events.input();assert.equal(h.node('entries').querySelectorAll('.entry').length,12);
});
test('065 all-list display starts with roots, expands children without playback and counts all registered entries',async t=>{
 const h=await Harness(t),s=h.store;s.Apply({type:'create',name:'子',parentId:h.id});const child=s.data.activePlaylistId;s.Apply({type:'add',playlistId:child,urls:'av777'});s.Apply({type:'playlist-properties',playlistId:child,includeInAll:false});h.emit('state',s.Snapshot());let plays=0;h.api.play=()=>plays++;h.node('all-lists').onclick();
 assert.equal(h.node('entries').querySelectorAll('.playlist-entry').length,1);await h.node('entries').children[0].children[1].events.click();assert.equal(h.node('entries').querySelectorAll('.playlist-entry').length,2);assert.equal(plays,0);assert.equal(h.node('all-count').textContent,'13曲');assert.equal(s.Entries('*').length,12);
 h.run('SortLists()');h.node('playlist-sort').value='name';await h.submit();assert.equal(s.data.settings.playlistSort,'name');
});
test('060 destination-name search preserves hidden checked lists and lets users inspect descendant songs',async t=>{
 const h=await Harness(t),s=h.store;s.Apply({type:'create',name:'親A'});const parent=s.data.activePlaylistId;s.Apply({type:'create',name:'目標リスト',parentId:parent});const child=s.data.activePlaylistId;s.Apply({type:'add',playlistId:child,urls:'av567',title:'目標の曲'});s.Apply({type:'select',playlistId:h.id});h.emit('state',s.Snapshot());h.run('AddURL()');
 const body=h.node('modal-body'),search=body.querySelector('.destination-search');search.value='目標リスト';search.oninput();
 const checks=body.querySelectorAll('input').filter(n=>n.type==='checkbox');assert.equal(checks.length,2);const chosen=checks.find(c=>c.value===child);chosen.checked=true;chosen.onchange();
 const trackSearch=body.querySelector('.destination-track-search');trackSearch.value='目標';trackSearch.oninput();assert.match(body.querySelector('.destination-results').textContent,/目標の曲/);
 search.value='お気に入り';search.oninput();const ids=h.run('document.getElementById("modal-body").querySelector(".destination-choices")');assert.ok(ids);h.node('url-input').value='av876';await h.node('url-load').onclick();await h.submit();assert.equal(s.Playlist(child).entries.at(-1).videoId,'av876');assert.equal(s.Playlist(h.id).entries.at(-1).videoId,'av876');
});
test('060 source-list name edits and filtering preserve checked hidden songs during import',async t=>{
 const h=await Harness(t);const videos=[{...require('../src/core/urls.cjs').ParseBilibili('av501'),title:'on vocal'},{...require('../src/core/urls.cjs').ParseBilibili('av502'),title:'off vocal'}];
 h.api.playlistSources=async()=>[{kind:'parts',id:'av501',title:'曲一覧'}];h.api.playlistVideos=async()=>({videos,hasMore:false});h.run('PlaylistURL()');h.node('playlist-source-url').value='av501';await h.node('playlist-fetch').onclick();
 let inputs=h.node('playlist-videos').querySelectorAll('input'),check=inputs.find(n=>n.type==='checkbox'),name=inputs.find(n=>n.type==='text');check.checked=true;check.onchange();name.value='指定した曲名';name.oninput();
 h.node('playlist-video-filter').value='off vocal';h.node('playlist-video-filter').oninput();h.node('playlist-select-all').onclick();await h.submit();const last=h.store.Playlist(h.id).entries.slice(-2);assert.deepEqual(last.map(e=>e.title),['指定した曲名','off vocal']);
});
test('060 timeline expands future and played names as read-only rows and manual scrolling prevents refocus',async t=>{
 const h=await Harness(t);let plays=0;h.api.play=()=>plays++;h.play(0);const timeline={history:[{title:'前に再生した曲'}],current:{title:'現在の曲'},upcoming:[{title:'次の1曲'},{title:'次の2曲'},{title:'次の3曲'},{title:'次の4曲'}]};h.emit('queue',{playlistId:h.id,next:{index:2,title:'次の1曲'},timeline});h.node('up-next-toggle').onclick();const box=h.node('queue-timeline');
 assert.equal(h.node('up-next-toggle').getAttribute('aria-expanded'),'true');assert.equal(box.querySelectorAll('.timeline-future').length,4);assert.equal(box.querySelectorAll('button').length,0);assert.match(box.textContent,/前に再生した曲/);assert.equal(plays,0);assert.match(fs.readFileSync(path.join(__dirname,'../src/ui/style.css'),'utf8'),/queue-timeline\{height:156px/);
 box.scrollTop=52;box.events.wheel();h.emit('queue',{playlistId:h.id,timeline});assert.equal(box.scrollTop,52);h.node('up-next-toggle').onclick();assert.equal(box.classList.contains('hidden'),true);
});
test('060 dropping a song onto a playlist waits for copy or move confirmation and cancellation changes nothing',async t=>{
 const h=await Harness(t),s=h.store;s.Apply({type:'create',name:'移動先',parentId:h.id});const dest=s.data.activePlaylistId;s.Apply({type:'select',playlistId:h.id});h.emit('state',s.Snapshot());const entry=s.Playlist(h.id).entries[0];h.api.transferEntry=async args=>s.Transfer(args);
 h.run(`DropTrackIntoPlaylist({playlistId:${JSON.stringify(h.id)},entryId:${JSON.stringify(entry.id)}},${JSON.stringify(dest)})`);assert.equal(s.Playlist(dest).entries.length,0);assert.equal(h.node('modal-cancel').textContent,'キャンセル');h.run('CloseModal()');assert.equal(s.Playlist(h.id).entries.length,12);
 h.run(`DropTrackIntoPlaylist({playlistId:${JSON.stringify(h.id)},entryId:${JSON.stringify(entry.id)}},${JSON.stringify(dest)})`);await h.node('drop-track-actions').children[0].events.click();assert.equal(s.Playlist(dest).entries.length,1);assert.equal(s.Playlist(h.id).entries.length,12);
 const second=s.Playlist(h.id).entries[1];h.run(`DropTrackIntoPlaylist({playlistId:${JSON.stringify(h.id)},entryId:${JSON.stringify(second.id)}},${JSON.stringify(dest)})`);await h.node('drop-track-actions').children[1].events.click();assert.equal(s.Playlist(dest).entries.length,2);assert.equal(s.Playlist(h.id).entries.length,11);
});
test('060 key configuration saves changed keys and shortcut capture ignores modal, background, composition and held play toggles',async t=>{
 const h=await Harness(t);h.run('KeySettings()');const inputs=h.node('keybinding-fields').querySelectorAll('input');inputs[0].onkeydown({code:'KeyD',preventDefault(){},stopPropagation(){}});await h.submit();assert.equal(h.store.data.settings.keybindings.forward,'KeyD');h.run('CloseModal()');let calls=[];h.api.shortcut=async value=>calls.push(value);
 const press=extra=>{const e={code:'Space',isTrusted:true,preventDefault(){this.prevented=true},stopPropagation(){},...extra};h.document.events.keydown(e);return e;};
 press();await new Promise(setImmediate);assert.equal(calls.length,1);assert.equal(press({repeat:true}).prevented,true);assert.equal(calls.length,1);press({isComposing:true});assert.equal(calls.length,1);
 h.emit('foreground',false);press();assert.equal(calls.length,1);h.emit('foreground',true);h.run('Settings()');press();assert.equal(calls.length,1);
});

test('061 all-list UI follows parent order, shows empty excluded lists and finds ancestors of matching descendants', async t => {
  const h = await Harness(t), s = h.store;
  s.Apply({ type: 'create', name: '子' }); const child = s.data.activePlaylistId;
  s.Apply({ type: 'create', name: '親' }); const parent = s.data.activePlaylistId;
  s.Playlist(parent).childIds = [child]; s.data.rootPlaylistIds = [h.id, parent]; s.Playlist(child).includeInAll = false;
  s.Apply({ type: 'add', playlistId: child, urls: 'av888', title: '目標曲' });
  h.emit('state', s.Snapshot()); h.node('all-lists').onclick();
  assert.deepEqual(h.node('entries').querySelectorAll('.playlist-entry').map(row => row.dataset.playlistId), [h.id, parent]);
  await h.node('entries').querySelectorAll('.playlist-entry')[1].children[1].events.click();
  assert.deepEqual(h.node('entries').querySelectorAll('.playlist-entry').map(row => row.dataset.playlistId), [h.id, parent, child]);
  assert.match(h.node('entry-count').textContent, /3 リスト/); assert.match(h.node('entry-count').textContent, /13 曲/);
  assert.equal(h.node('entries').querySelectorAll('.playlist-entry')[2].style.marginLeft, '18px');
  h.node('filter').value = '目標曲'; h.node('filter').events.input();
  assert.deepEqual(h.node('entries').querySelectorAll('.playlist-entry').map(row => row.dataset.playlistId), [parent, child]);
  assert.equal(h.node('entries').querySelectorAll('.entry').length, 1);
});

test('062 download target search, estimates and child options drive the actual saved selection', async t => {
  const h = await Harness(t), initial = h.store.data.activePlaylistId; h.store.Apply({ type: 'create', name: '保存先の親' }); const parent = h.store.data.activePlaylistId; h.store.Apply({ type: 'add', playlistId: parent, urls: 'av998' }); h.store.Apply({ type: 'create', name: '保存対象の子', parentId: parent }); const child = h.store.data.activePlaylistId; h.store.Apply({ type: 'add', playlistId: child, urls: 'av999' });
  h.emit('state', h.store.Snapshot()); const estimates = [], started = [];
  h.api.downloads = async () => ({ directory: 'D:/FavecusPlayer/downloads', preferSaved: true }); h.api.cancelDownloadEstimate = async () => {};
  h.api.estimateDownload = async options => { estimates.push({ ...options }); return { id: `estimate-${estimates.length}`, total: 1, skipped: 0, unknown: 0, fileBytes: 10485760, requiredBytes: 31457280, freeBytes: 1073741824, downloadBytes: 10000000, secondsMin: 5, secondsMax: 60 }; };
  h.api.downloadPlaylist = async options => { started.push({ ...options }); return { job: { playlistId: options.playlistId, playlistName: '選択リスト', status: 'running', finished: 0, total: 1, completed: 0, skipped: 0, failed: 0 } }; };
  h.run('DownloadsDialog()'); await new Promise(setImmediate); assert.equal(h.node('download-start').disabled, false); assert.match(h.node('download-estimate').textContent, /10.0 MB/); assert.match(h.node('download-estimate').textContent, /30.0 MB/); assert.match(h.node('download-estimate').textContent, /10〜100 Mbps/);
  const search = h.node('download-list-picker').querySelector('.parent-search'); search.value = '保存対象の子'; search.oninput(); assert.equal(estimates.at(-1).playlistId, child);
  const name = h.node('download-list-picker').querySelectorAll('.parent-name').find(n => n.textContent === '保存先の親'); name.onclick(); await new Promise(setImmediate); assert.equal(estimates.at(-1).playlistId, parent);
  h.node('download-children').checked = false; h.node('download-children').onchange(); await new Promise(setImmediate); assert.equal(estimates.at(-1).includeChildren, false);
  await h.node('download-start').onclick(); assert.equal(started[0].playlistId, parent); assert.ok(started[0].estimateId); assert.equal(h.node('modal').open, false); assert.equal(h.node('download-mini').classList.contains('hidden'), false); assert.notEqual(started[0].playlistId, initial);
});
test('062 slow estimate responses and closed dialogs cannot enable saving a stale selection', async t => {
  const h = await Harness(t), pending = []; let cancelled = 0;
  h.api.downloads = async () => ({}); h.api.cancelDownloadEstimate = async () => { cancelled++; }; h.api.estimateDownload = options => new Promise(resolve => pending.push({ options, resolve }));
  h.run('DownloadsDialog()'); await new Promise(setImmediate); assert.equal(h.node('download-start').disabled, false);
  h.node('download-kind').value = 'audio'; h.node('download-kind').onchange(); await new Promise(setImmediate); assert.equal(pending.length, 2);
  const value = { total: 1, skipped: 0, unknown: 0, fileBytes: 1048576, requiredBytes: 2097152, freeBytes: 10000000, secondsMin: 1, secondsMax: 10 };
  pending[1].resolve({ ...value, id: 'new' }); await new Promise(setImmediate); pending[0].resolve({ ...value, id: 'old' }); await new Promise(setImmediate); assert.equal(h.run('downloadEstimate.id'), 'new');
  h.node('download-recalculate').onclick(); h.run('CloseModal()'); pending[2].resolve({ ...value, id: 'closed' }); await new Promise(setImmediate); assert.equal(h.run('downloadEstimate'), null); assert.equal(cancelled, 1);
});
test('065 parent navigation returns one level, clears filtering and preserves the currently playing track', async t => {
  const h = await Harness(t), s = h.store; h.play(3); const playing = h.run('current.entryId');
  s.Apply({ type: 'create', name: '子', parentId: h.id }); const child = s.data.activePlaylistId; s.Apply({ type: 'create', name: '孫', parentId: child }); h.emit('state', s.Snapshot());
  h.api.play = () => assert.fail('navigation must not start playback'); h.node('filter').value = 'search'; await h.node('playlist-up').onclick();
  assert.equal(s.data.activePlaylistId, child); assert.equal(h.node('filter').value, ''); assert.equal(h.run('current.entryId'), playing); assert.equal(h.node('playlist-up').classList.contains('hidden'), false);
  await h.node('playlist-up').onclick(); assert.equal(s.data.activePlaylistId, h.id); assert.equal(h.node('playlist-up').classList.contains('hidden'), true);
});
test('065 compact download progress remains after closing a dialog, supports cancel, and hides five seconds after completion', async t => {
  const h = await Harness(t); let cancelled = 0; const job = { id: 'job', status: 'running', total: 4, finished: 1, completed: 1, skipped: 0, failed: 0, active: [{ title: '曲', phase: 'ダウンロード中', bytes: 50, totalBytes: 100 }] };
  h.api.cancelDownload = async () => { cancelled++; return { job: { ...job, status: 'cancelling' } }; };
  h.run('OpenModal("test", "", null)'); h.emit('downloads', { job }); h.run('CloseModal()');
  assert.equal(h.node('download-mini').classList.contains('hidden'), false); assert.equal(Number(h.node('download-mini-gauge').value), 37.5); assert.equal(h.node('modal').open, false); assert.equal(cancelled, 0);
  await h.node('download-mini-cancel').onclick(); assert.equal(cancelled, 1); assert.equal(h.node('download-mini-cancel').disabled, true);
  h.tick(200); h.emit('downloads', { job: { ...job, status: 'completed', finished: 4, completed: 4, active: [], endedAt: 200 } });
  assert.equal(h.node('download-mini-label').textContent, '保存が終了しました。'); assert.equal(Number(h.node('download-mini-gauge').value), 100); assert.equal(h.node('download-mini-cancel').classList.contains('hidden'), true);
  h.tick(4999); assert.equal(h.node('download-mini').classList.contains('hidden'), false); h.tick(1); assert.equal(h.node('download-mini').classList.contains('hidden'), true);
});
test('065 saved-versus-online preference is changed in playback settings and not offered in the download dialog', async t => {
  const h = await Harness(t); let chosen; h.api.preferSaved = async value => { chosen = value; return { preferSaved: value }; };
  h.emit('downloads', { preferSaved: false }); h.run('PlaybackSettings()'); assert.equal(h.node('playback-source').value, 'online'); h.node('playback-source').value = 'saved'; await h.submit(); assert.equal(chosen, true); assert.equal(h.node('modal-title').textContent, '設定・連携');
  h.api.downloads = async () => ({}); h.api.cancelDownloadEstimate = async () => {}; h.api.estimateDownload = async () => ({ id: 'estimate', total: 1, skipped: 0, fileBytes: 1, requiredBytes: 2, secondsMin: 1, secondsMax: 2 }); h.run('DownloadsDialog()'); await new Promise(setImmediate); assert.equal(h.node('download-prefer'), undefined);
});
test('062 Discord settings save supported image size and image-only link toggle', async t => {
  const h = await Harness(t); h.run('DiscordSettings()'); h.node('discord-size').value = 'large'; h.node('discord-video-link').checked = false; await h.run('submitModal()'); assert.equal(h.store.data.settings.discordThumbnailSize, 'large'); assert.equal(h.store.data.settings.discordVideoLink, false);
  h.run('DiscordSettings()'); assert.equal(h.node('discord-size').value, 'large'); h.node('discord-thumbnail').checked = false; h.node('discord-thumbnail').onchange(); assert.equal(h.node('discord-size').disabled, true);
});

test('066 Drive settings save the URL before opening and reject another host', async t => {
  const h = await Harness(t), seen = []; h.api.openRelease = async () => seen.push(h.store.data.settings.releaseDriveURL);
  h.run('ReleaseSettings()'); h.node('release-drive-url').value = 'https://drive.google.com/drive/folders/test'; await h.node('release-open').onclick(); assert.deepEqual(seen, ['https://drive.google.com/drive/folders/test']);
  h.node('release-drive-url').value = 'https://github.com/owner/player'; await h.node('release-open').onclick(); assert.equal(seen.length, 1);
});

test('066 saving begins during pending estimation and ignores late responses after the dialog closes', async t => {
  const h = await Harness(t); let resolve, options, cancelled = 0;
  h.api.downloads = async () => ({}); h.api.cancelDownloadEstimate = async () => cancelled++; h.api.estimateDownload = () => new Promise(r => resolve = r);
  h.api.downloadPlaylist = async input => { options = input; return { job: { playlistId: h.id, status: 'running', total: 12, finished: 0, completed: 0, skipped: 0, failed: 0, active: [], estimate: { checked: 1, total: 12, projected: true, fileBytes: 12000000, downloadBytes: 12000000, requiredBytes: 30000000, skipped: 0, unknown: 11, secondsMin: 4, secondsMax: 30 } } }; };
  h.run('DownloadsDialog()'); await new Promise(setImmediate); assert.equal(h.node('download-start').disabled, false); await h.node('download-start').onclick(); assert.equal(options.estimateId, undefined); assert.equal(h.node('modal').open, false); assert.equal(cancelled, 1); assert.match(h.node('download-mini-detail').textContent, /全体の推計/);
  resolve({ id: 'late', total: 12, fileBytes: 1, requiredBytes: 1 }); await new Promise(setImmediate); assert.equal(h.run('downloadEstimate'), null); assert.equal(h.node('modal').open, false);
});
test('066 import all keeps the selected parent and includes branches hidden by search', async t => {
  const h = await Harness(t); h.store.Apply({ type: 'create', name: '取り込み先D' }); const destination = h.store.data.activePlaylistId; h.emit('state', h.store.Snapshot()); let received;
  const plan = { id: 'plan', rootPlaylistIds: ['a'], playlists: [{ id: 'a', name: 'A', count: 1, childIds: ['b','s'] }, { id: 'b', name: 'B', count: 1, childIds: [] }, { id: 's', name: 'S', count: 1, childIds: [] }] };
  h.api.commitImport = async (id, ids, options) => { received = { id, ids: Array.from(ids), parentId: options.parentId }; return { state: h.store.Snapshot(), imported: 3, ancestors: 0 }; }; h.api.cancelImport = async () => {};
  h.run(`ImportSelection(${JSON.stringify(plan)})`); h.node('archive-parent').querySelectorAll('.parent-name').find(n => n.textContent === '取り込み先D').onclick(); h.node('archive-search').value = 'B'; h.node('archive-search').oninput();
  await h.node('archive-import-all').onclick(); assert.deepEqual(received, { id: 'plan', ids: ['a','b','s'], parentId: destination }); assert.equal(h.node('modal').open, false);
});
test('066 unchecking a child cancels parent-wide import while retaining the sibling and empty ancestor summary', async t => {
  const h = await Harness(t); let ids;
  const plan = { id: 'plan', rootPlaylistIds: ['a'], playlists: [{ id: 'a', name: 'A', count: 1, childIds: ['b','s'] }, { id: 'b', name: 'B', count: 1, childIds: [] }, { id: 's', name: 'S', count: 1, childIds: [] }] };
  h.api.commitImport = async (_id, selected) => { ids = Array.from(selected); return { state: h.store.Snapshot(), imported: 2, ancestors: 1 }; }; h.api.cancelImport = async () => {};
  h.run(`ImportSelection(${JSON.stringify(plan)})`); const input = h.node('archive-lists').querySelector('input'); input.checked = true; input.onchange(); h.node('archive-search').value = 'B'; h.node('archive-search').oninput();
  const child = h.node('archive-lists').querySelectorAll('input').find(n => n.value === 'b'); child.checked = false; child.onchange(); assert.match(h.node('archive-selection-summary').textContent, /構造のみ 1/); await h.submit(); assert.deepEqual(ids, ['s']);
});
test('066 positional drop confirms before changing data, supports cancellation, and inserts at the chosen child position', async t => {
  const h = await Harness(t), s = h.store; s.Apply({ type: 'create', name: '子リスト', parentId: h.id }); const child = s.data.activePlaylistId; s.Apply({ type: 'add', playlistId: child, urls: 'av999' }); h.emit('state', s.Snapshot());
  const anchor = s.Playlist(child).entries[0], item = { playlistId: h.id, entryId: s.Playlist(h.id).entries[0].id }, before = s.Snapshot(); h.api.transferEntry = async args => s.Transfer(args);
  const drop = `DropTrackIntoPlaylist(${JSON.stringify(item)},${JSON.stringify(child)},${JSON.stringify({targetId:anchor.id,after:false})})`;
  h.run(drop); assert.match(h.node('drop-track-note').textContent, /前/); assert.deepEqual(s.Snapshot(), before); h.run('CloseModal()'); assert.deepEqual(s.Snapshot(), before);
  h.run(drop); await h.node('drop-track-actions').children[0].events.click(); assert.equal(s.Playlist(child).entries.length, 2); assert.equal(s.Playlist(child).entries[1].id, anchor.id); assert.equal(s.Playlist(h.id).entries.length, 12); assert.equal(h.node('modal').open, false);
});
