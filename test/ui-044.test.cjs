'use strict';
const { test } = require('node:test');
const { readApp } = require('./support-source.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Store } = require('../src/core/store.cjs');
const { AdditionReview } = require('../src/core/addition-review.cjs');
// DOMイベントと保存を接続するテスト。レイアウトやWindowsの実描画は検証しない。
function Harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-ui-044-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root), source = store.data.activePlaylistId;
  store.Apply({ type: 'add', playlistId: source, urls: 'av123\nav456' });
  store.Apply({ type: 'title', playlistId: source, entryId: store.Playlist(source).entries[0].id, title: 'TEST 曲A' });
  store.Apply({ type: 'title', playlistId: source, entryId: store.Playlist(source).entries[1].id, title: '曲B' });
  store.Apply({ type: 'create', name: 'A' }); const a = store.data.activePlaylistId;
  store.Apply({ type: 'add', playlistId: a, urls: 'av789', title: '曲C' });
  store.Apply({ type: 'create', name: '新しいリスト' }); const target = store.data.activePlaylistId;
  const nodes = new Map(), calls = [], errors = [];
  class Node {
    constructor(tag = 'div') { this.tagName = tag; this.style = { setProperty() {} }; this.dataset = {}; this.children = []; this.events = {}; this.checked = false; this.disabled = false; const classes = new Set(); this.classList = { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle: (x, force) => { if (force ?? !classes.has(x)) classes.add(x); else classes.delete(x); } }; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...children) { this.children = children; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return (this.text || '') + this.children.map(x => x.textContent || '').join(''); }
    set value(value) { this.val = String(value); }
    get value() { return this.val ?? (this.tagName === 'select' ? this.children[0]?.value : '') ?? ''; }
    setAttribute(key, value) { this[key] = value; }
    getBoundingClientRect() { return { top: 0, height: 40 }; }
    focus() {}
    addEventListener(key, fn) { this.events[key] = fn; }
    click() { if (!this.disabled) return this.onclick?.() ?? this.events.click?.(); }
    querySelectorAll(selector) { const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]); return selector === '*' ? all : all.filter(node => selector === 'input:checked' ? node.tagName === 'input' && node.checked : node.tagName === selector); }
    querySelector(selector) { if (selector === 'use') return { setAttribute() {} }; return this.querySelectorAll(selector)[0]; }
    set innerHTML(html) {
      for (const id of this.htmlIds || []) nodes.delete(id); this.htmlIds = []; this.children = [];
      for (const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const node = new Node(match[1]); node.id = match[2]; nodes.set(node.id, node); this.children.push(node); this.htmlIds.push(node.id);
        for (const attr of match[0].matchAll(/\b(type|value|class)="([^"]*)"/g)) node[attr[1] === 'class' ? 'className' : attr[1]] = attr[2];
      }
    }
    showModal() { assert.equal(this.open, false); this.open = true; }
    close() { this.open = false; }
    reportValidity() { return true; }
  }
  for (const id of ['modal', 'modal-body', 'modal-title', 'modal-submit', 'modal-back', 'modal-form', 'modal-close', 'modal-cancel', 'modal-notice', 'modal-actions', 'toast', 'mute', 'transport-volume', 'transport-volume-value', 'downloads-status', 'download-mini', 'download-mini-cancel', 'download-mini-gauge', 'download-mini-label', 'download-mini-detail']) nodes.set(id, new Node()); nodes.get('modal').open = false;
  const review = new AdditionReview(store);
  const api = { resolveURL: async value => { const video = require('../src/core/urls.cjs').ParseBilibili(value); return { kind: 'video', video: { ...video, title: '' }, sources: [] }; }, action: async action => { calls.push(structuredClone(action)); return store.Apply(action); }, accounts: async () => ({}), prepareFiles: async () => null,
    preferSaved: async value => ({ preferSaved: value }), prepareAdd: async action => { calls.push(structuredClone(action)); return review.Prepare(action); }, commitAdd: (id, allowed) => review.Commit(id, allowed), cancelAdd: async id => review.Cancel(id) };
  const document = { getElementById: id => nodes.get(id), createElement: tag => new Node(tag), createDocumentFragment: () => new Node() };
  const context = { document, window: { favecusApp: api, FavecusTransport: {} }, initialState: store.Snapshot(), BackgroundInteractive() {}, Render() {}, SendBounds() {}, UpdateStatus() {}, setTimeout: () => 1, clearTimeout() {}, console: { error: e => errors.push(e) } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/library-tree.js'), 'utf8').replace('})(globalThis)', '})(window)'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/tree-view.js'), 'utf8').replace('})(globalThis)', '})(window)'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/parent-picker.js'), 'utf8').replace('})(globalThis)', '})(window)'), context);
  const sourceCode = readApp();
  vm.runInContext(sourceCode.slice(0, sourceCode.indexOf('function ClearDropMarks()')) + '\nstate = initialState;', context);
  return { store, nodes, calls, api, review, source, a, target, run: code => vm.runInContext(code, context), node: id => nodes.get(id), submit: () => vm.runInContext('PerformModal(submitModal, true)', context) };
}
test('existing-list picker preserves multi-song selection across lists and defaults only the current destination', async t => {
  const h = Harness(t); h.run('ExistingTracks()');
  const destinations = h.node('modal-body').children.at(-1).querySelectorAll('input').filter(n => n.type === 'checkbox');
  assert.deepEqual(destinations.filter(x => x.checked).map(x => x.value), [h.target]);
  let songs = h.node('existing-tracks').querySelectorAll('input'); assert.equal(songs.length, 2);
  songs[0].checked = true; songs[0].onchange();
  const chooseSource = id => h.node('existing-source').querySelectorAll('div').find(n => n.dataset.playlistId === id).children.find(n => n.className === 'parent-name').click();
  chooseSource(h.a); songs = h.node('existing-tracks').querySelectorAll('input');
  songs[0].checked = true; songs[0].onchange(); assert.match(h.node('existing-count').textContent, /2曲/);
  chooseSource(h.source); assert.equal(h.node('existing-tracks').querySelectorAll('input')[0].checked, true);
  const remaining = h.node('modal-body').children.at(-1).querySelectorAll('input').filter(n => n.type === 'checkbox');
  assert.deepEqual(remaining.filter(x => !x.disabled).map(x => x.value), [h.target]);
  assert.ok(remaining.filter(x => [h.source, h.a].includes(x.value)).every(x => x.disabled));
  await h.submit();
  assert.equal(h.calls.at(-1).type, 'add-existing'); assert.deepEqual(h.calls.at(-1).destinationIds, [h.target]);
  assert.deepEqual(h.store.Playlist(h.target).entries.map(e => e.title), ['TEST 曲A', '曲C']); assert.equal(h.store.Playlist(h.a).entries.length, 1); assert.equal(h.node('modal').open, false);
});
test('URL additions use checkboxes and keep the modal open if no destination is selected', async t => {
  const h = Harness(t); h.run('AddURL()'); h.node('url-input').value = 'av999'; h.node('url-title').value = '[ニコカラ] 新曲';
  const destinations = h.node('modal-body').children.at(-1).querySelectorAll('input').filter(n => n.type === 'checkbox'); for (const x of destinations) x.checked = false;
  if (h.node('url-load')) await h.node('url-load').onclick(); await h.submit(); assert.equal(h.node('modal').open, true); assert.equal(h.calls.length, 0); assert.match(h.node('modal-notice').textContent, /追加先/);
  destinations.find(x => x.value === h.a).checked = true; destinations.find(x => x.value === h.target).checked = true; if (h.node('url-load')) await h.node('url-load').onclick(); await h.submit();
  assert.equal(h.store.Playlist(h.a).entries.at(-1).title, '新曲'); assert.equal(h.store.Playlist(h.target).entries[0].title, '新曲');
});
test('settings shows ordered category buttons and back persists only the edited section', async t => {
  const h = Harness(t); h.run('Settings()');
  const buttons = h.node('settings-sections').children;
  assert.deepEqual(buttons.map(x => x.textContent), ['プレイリストの出力›', '使い方›', '自動消去単語設定›', 'Discordアクティビティ›', 'ミニプレイヤー、タスクバー›', '再生・表示›', 'キーコンフィグ›', 'シャッフルの再生回数›', 'バージョン更新›', 'プレイリストの同期›', '自動リスト›', 'ライブラリの点検›', '出力デバイス›', '再生統計›', '最近削除›']);
  assert.equal(h.node('discord-id'), undefined); assert.equal(h.node('taskbar-width'), undefined); assert.ok(h.node('master-volume')); assert.ok(h.node('bili-account-state'));
  await buttons[3].click(); assert.equal(h.node('modal-title').textContent, 'Discordアクティビティ'); assert.equal(h.node('modal-back').classList.contains('hidden'), false);
  h.node('discord-id').value = '123456789012345678'; h.node('discord-enabled').checked = true;
  await h.node('modal-back').click(); assert.equal(h.node('modal-title').textContent, '設定・連携'); assert.equal(h.node('modal').open, true);
  assert.equal(h.store.data.settings.discordEnabled, true); assert.equal(h.store.data.settings.taskbarWidth, 500);
  assert.deepEqual(h.calls.at(-1).settings, { discordEnabled: true, discordClientId: '123456789012345678', discordImageKey: 'favecus_player_music', hideWhenPaused: true, discordThumbnail: true, discordVideoLink: true, discordThumbnailSize: 'small' });
  await h.node('settings-sections').children[4].click(); h.node('taskbar-width').value = '460'; if (h.node('url-load')) await h.node('url-load').onclick(); await h.submit();
  assert.equal(h.store.data.settings.taskbarWidth, 460); assert.equal(h.store.data.settings.discordEnabled, true); assert.equal(h.node('modal-title').textContent, '設定・連携');
});
test('invalid details stay editable, closing discards details, and adding a phrase applies immediately', async t => {
  const h = Harness(t); h.run('DiscordSettings()'); h.node('discord-enabled').checked = true; h.node('discord-id').value = 'invalid';
  await h.node('modal-back').click(); assert.equal(h.node('modal-title').textContent, 'Discordアクティビティ'); assert.equal(h.store.data.settings.discordEnabled, false);
  assert.match(h.node('modal-notice').textContent, /Application ID/); h.run('CloseModal()'); assert.equal(h.node('modal').open, false);
  h.run('TitleWordsSettings()'); h.node('title-word-input').value = 'TEST'; await h.node('title-word-add').click();
  assert.equal(h.store.Playlist(h.source).entries[0].title, '曲A'); assert.ok(h.store.data.settings.titleCleanupWords.includes('TEST'));
  assert.equal(h.node('modal-title').textContent, '自動消去単語設定'); assert.match(h.node('modal-notice').textContent, /1件/);
  await h.node('modal-back').click(); assert.equal(h.node('modal-title').textContent, '設定・連携');
});
test('closing while a settings save is pending does not reopen it on completion; cancelled file selection can retry', async t => {
  const h = Harness(t); let finish;
  h.api.action = action => new Promise(resolve => { finish = () => resolve(h.store.Apply(action)); });
  h.run('TaskbarSettings()'); h.node('taskbar-width').value = '470'; const pending = h.node('modal-back').click();
  h.run('CloseModal()'); finish(); await pending; assert.equal(h.node('modal').open, false); assert.equal(h.store.data.settings.taskbarWidth, 470);
  h.run('AddLocalFiles()'); if (h.node('url-load')) await h.node('url-load').onclick(); await h.submit(); assert.equal(h.node('modal').open, true); assert.equal(h.node('modal-submit').disabled, false);
});
test('duplicate checkboxes start unchecked, selected duplicates can be added, and cancel abandons normal rows too', async t => {
  const h = Harness(t); h.run('ExistingTracks()');
  await h.run(`AddSelected({ type: 'add', urls: 'av123\\nav456\\nav999' }, ['${h.source}'])`);
  assert.equal(h.node('modal-title').textContent, '重複の可能性がある曲');
  let checks = h.node('duplicate-list').querySelectorAll('input'); assert.equal(checks.length, 2); assert.ok(checks.every(c => !c.checked));
  assert.equal(h.store.Playlist(h.source).entries.length, 2); h.run('CloseModal()'); assert.equal(h.review.plans.size, 0);
  h.run('ExistingTracks()'); await h.run(`AddSelected({ type: 'add', urls: 'av123\\nav456' }, ['${h.source}'])`);
  await h.node('duplicate-all').click(); assert.ok(h.node('duplicate-list').querySelectorAll('input').every(c => c.checked));
  await h.node('duplicate-none').click(); checks = h.node('duplicate-list').querySelectorAll('input'); checks[1].checked = true;
  await h.submit(); assert.equal(h.node('modal').open, false); assert.equal(h.store.Playlist(h.source).entries.length, 3);
  assert.equal(h.store.Playlist(h.source).entries.at(-1).videoId, 'av456'); assert.equal(h.review.plans.size, 0);
});
test('a late duplicate check after closing never adds rows or reopens the dialog', async t => {
  const h = Harness(t); let finish;
  h.api.prepareAdd = action => new Promise(resolve => { finish = async () => resolve(await h.review.Prepare(action)); });
  h.run('AddURL()'); h.node('url-input').value = 'av999'; await h.node('url-load').onclick(); const pending = h.submit();
  h.run('CloseModal()'); await finish(); await pending;
  assert.equal(h.node('modal').open, false); assert.equal(h.store.Playlist(h.target).entries.length, 0); assert.equal(h.review.plans.size, 0);
});
test('playback settings append after existing categories and save only the background display preferences', async t => {
  const h = Harness(t); h.run('Settings()'); await h.node('settings-sections').children[5].click();
  assert.equal(h.node('modal-title').textContent, '再生・表示'); assert.equal(h.node('auto-thumbnail').checked, true); assert.equal(h.node('auto-thumbnail-minutes').value, '5');
  h.node('auto-thumbnail-minutes').value = '12'; h.node('auto-thumbnail').checked = false;
  await h.node('modal-back').click(); assert.equal(h.node('modal-title').textContent, '設定・連携');
  assert.deepEqual(h.calls.at(-1).settings, { volumeLeveling: true, autoThumbnailEnabled: false, autoThumbnailMinutes: 12 }); // 音量の自動調整（v0.7.3）：既定はオン
});

test('URL classification is explicit and a stale network response cannot reopen a closed dialog', async t => {
  const h = Harness(t); let finish;
  h.api.resolveURL = value => new Promise(resolve => { finish = () => resolve({ kind: 'video', video: { ...require('../src/core/urls.cjs').ParseBilibili(value), title: '取得名', duration: 233 }, sources: [] }); });
  h.run('AddURL()'); h.node('url-input').value = 'av999'; assert.equal(h.node('modal-submit').disabled, true);
  const pending = h.node('url-load').onclick(); h.run('CloseModal()'); finish(); await pending;
  assert.equal(h.node('modal').open, false); assert.equal(h.store.Playlist(h.target).entries.length, 0);
});
