'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { fileURLToPath } = require('node:url');

test('067 application protocol serves every local HTML dependency including home and search', async t => {
  const h = await MainHarness(t, { netFetch: async url => new Response(fs.readFileSync(fileURLToPath(url))) });
  const handler = h.protocols.get('favecus');
  for (const page of ['index.html', 'mini.html', 'local.html', 'browse.html']) {
    const html = fs.readFileSync(path.join(__dirname, '../src/ui', page), 'utf8');
    const names = new Set([page, ...[...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(match => match[1].split('#')[0])]);
    for (const name of names) {
      const response = await handler(new Request(`favecus://app/${name}`));
      assert.equal(response.status, 200, `${page} requires ${name}`);
      const expected = path.join(__dirname, ['icon.png', 'music.png'].includes(name) ? '../build' : '../src/ui', name);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(expected));
    }
  }
});

test('067 application protocol rejects private source files and unknown hosts', async t => {
  const h = await MainHarness(t, { netFetch: async () => assert.fail('Rejected paths must not reach net.fetch') });
  for (const url of ['favecus://app/main.cjs', 'favecus://app/../core/store.cjs', 'favecus://other/home-view.js', 'favecus://app/missing.js']) {
    assert.equal((await h.protocols.get('favecus')(new Request(url))).status, 404, url);
  }
});
async function FlushPlayer() { await new Promise(setImmediate); await new Promise(setImmediate); }
function SavedTrack(h, entry, content = 'media', height = 720) {
  const file = `media/${entry.videoId}-p${entry.part}/video-${require('node:crypto').randomUUID()}.mp4`, token = require('../src/core/offline-library.cjs').Key(entry.url, 'video') + '.mp4';
  fs.mkdirSync(path.dirname(h.offline.ResolvePath(file)), { recursive: true }); fs.writeFileSync(h.offline.ResolvePath(file), content);
  const record = { token, kind: 'video', url: entry.url, aliases: [entry.url], file, bytes: Buffer.byteLength(content), height, layout: 4 }; h.offline.CommitRecord(record); return record;
}
function SavedURL(view) {
  // local.js は画面の操作部品も扱うため、最小限のDOM代用品を渡す（ここで確認するのは動画の読み込み元だけ）。
  const video = { addEventListener() {}, querySelectorAll: () => [], classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, contains: () => false, blur() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ui/local.js'), 'utf8'), { URL, location: { href: view.webContents.getURL() }, window: {}, setTimeout, clearTimeout, document: { getElementById: () => video, body: video, addEventListener() {} } });
  return video.src;
}
for (const [mode, extension] of [['information', 'json'], ['information', 'zip'], ['media', 'zip']]) test(`067 main exports ${mode} as ${extension} and imports a selected child under its destination`, async t => {
  const h = await MainHarness(t), root = h.store.data.activePlaylistId;
  await h.invoke('library:action', { type: 'create', name: '共有する子', parentId: root }); const child = h.store.data.activePlaylistId;
  await h.invoke('library:action', { type: 'add', playlistId: child, urls: 'https://www.bilibili.com/video/av123/?p=2' });
  const local = path.join(h.root, 'music.mp3'); fs.writeFileSync(local, 'local audio'); await h.store.AddFiles([child], [local]);
  const entry = h.store.Playlist(child).entries[0], saved = SavedTrack(h, entry), before = h.store.Snapshot(), file = path.join(h.root, `shared.${extension}`); h.chooseSave(file);
  const exported = await h.invoke('library:export', { mode }); assert.equal(exported.mode, mode); assert.equal(exported.downloaded, mode === 'media' ? 1 : 0); assert.ok(fs.existsSync(file)); assert.deepEqual(h.store.Snapshot(), before);
  const settings = JSON.parse(JSON.stringify(h.saveDialogs[0])); assert.match(settings.defaultPath, mode === 'information' ? /information.*\.json$/ : /media.*\.zip$/); assert.deepEqual(settings.filters.flatMap(f => f.extensions), mode === 'information' ? ['json', 'zip'] : ['zip']);
  if (extension === 'json') { const json = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(json.exportMode, 'information'); assert.equal(json.playlists.find(p => p.id === child).entries[1].mediaIncluded, false); assert.equal(json.settings, undefined); }
  else { const { ZipReader } = require('../src/core/zip.cjs'), zip = await new ZipReader().Open(file); try {
    assert.ok(zip.entries.has('playlists.fvpa'));
    assert.equal([...zip.entries.keys()].some(name => name.startsWith('media/')), mode === 'media'); assert.equal([...zip.entries.keys()].some(name => name.startsWith('downloads/')), mode === 'media');
  } finally { await zip.Close(); } }
  h.chooseFiles([file]); const plan = await h.invoke('library:import'); assert.equal(plan.mode, mode);
  const result = await h.invoke('library:import-commit', plan.id, [child], { parentId: root }); assert.equal(result.imported, 2); assert.equal(result.ancestors, 1);
  const added = result.state.playlists.filter(p => !before.playlists.some(old => old.id === p.id)), addedParent = added.find(p => p.childIds.length), addedChild = added.find(p => !p.childIds.length);
  assert.ok(result.state.playlists.find(p => p.id === root).childIds.includes(addedParent.id)); assert.ok(addedParent.childIds.includes(addedChild.id)); assert.equal(addedParent.entries.length, 0); assert.equal(addedChild.entries[0].part, 2); assert.equal(addedChild.entries[1].missing, mode === 'information');
  assert.ok(h.offline.Find(addedChild.entries[0])); assert.ok(fs.existsSync(h.offline.ResolvePath(saved.file))); assert.equal(h.offline.records.size, 1);
  if (mode === 'information') assert.equal(result.omitted, 1); else assert.equal(fs.readFileSync(path.join(h.store.media, addedChild.entries[1].fileName), 'utf8'), 'local audio');
});
test('067 main validates export modes before opening a chooser and releases its guard after cancellation or a failed export', async t => {
  const h = await MainHarness(t); for (const input of [null, 'media', [], { mode: 'unknown' }, { mode: 'information', password: 'no' }]) await assert.rejects(h.invoke('library:export', input)); assert.equal(h.saveDialogs.length, 0);
  assert.equal(await h.invoke('library:export', { mode: 'information' }), null); assert.equal(h.saveDialogs.length, 1);
  const file = path.join(h.root, 'preserved.json'); fs.writeFileSync(file, 'original'); h.chooseSave(file); await assert.rejects(h.invoke('library:export', { mode: 'media' }), /JSON/); assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  h.chooseSave(path.join(h.root, 'retry.zip')); const result = await h.invoke('library:export'); assert.equal(result.mode, 'media'); assert.ok(fs.existsSync(result.file));
});
test('067 main prevents a second export while a save chooser is pending and permits a retry after it closes', async t => {
  let finish; const h = await MainHarness(t, { saveDialog: () => new Promise(resolve => finish = resolve) });
  const pending = h.invoke('library:export', { mode: 'information' }); await FlushPlayer(); await assert.rejects(h.invoke('library:export', { mode: 'media' }), /別の出力/); assert.equal(h.saveDialogs.length, 1);
  finish({ canceled: true }); assert.equal(await pending, null); const retry = h.invoke('library:export', { mode: 'media' }); await FlushPlayer(); assert.equal(h.saveDialogs.length, 2); finish({ canceled: true }); assert.equal(await retry, null);
});
test('067 single downloads save exactly the requested part, reuse saved formats, and leave titles unchanged', async t => {
  const resolved = [], transfers = [];
  const h = await MainHarness(t, { downloadOptions: { ffmpeg: process.execPath, cover: async () => null,
    resolve: async (entry, kind) => { resolved.push({ url: entry.url, kind }); return { kind, height: 720, url: entry.url, duration: 1, layout: 'dash', streams: [{ urls: [] }] }; },
    transfer: async (_fetch, _stream, file) => { transfers.push(file); fs.writeFileSync(file, 'raw'); return 3; },
    assemble: async (_exe, _plan, _files, dest) => { fs.writeFileSync(dest, 'saved media'); return 1; }
  } }), id = h.store.data.activePlaylistId;
  await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123\nhttps://www.bilibili.com/video/av123/?p=2' });
  await h.invoke('library:action', { type: 'create', name: '子', parentId: id }); const child = h.store.data.activePlaylistId;
  await h.invoke('library:action', { type: 'add', playlistId: child, urls: 'av456' });
  const [first, entry] = h.store.Playlist(id).entries, before = h.store.Snapshot(), options = { playlistId: id, entryId: entry.id, entryURL: entry.url, includeChildren: false, kind: 'video', height: 720 };
  const start = await h.invoke('downloads:start', options); assert.equal(start.job.total, 1); assert.equal(start.job.entryId, entry.id); assert.equal(start.job.entryURL, entry.url);
  await h.offline.done; assert.equal(h.offline.job.completed, 1); assert.deepEqual(resolved, [{ url: entry.url, kind: 'video' }]); assert.equal(transfers.length, 1);
  assert.equal(h.offline.Find(first), null); assert.equal(h.offline.Find(h.store.Playlist(child).entries[0]), null); assert.ok(fs.existsSync(h.offline.Find(entry).path));
  const estimate = await h.invoke('downloads:estimate', options); assert.equal(estimate.total, 1); assert.equal(estimate.skipped, 1);
  await h.invoke('downloads:start', { ...options, estimateId: estimate.id }); await h.offline.done; assert.equal(h.offline.job.skipped, 1); assert.equal(transfers.length, 1);
  await h.invoke('downloads:start', { ...options, kind: 'audio' }); await h.offline.done; assert.equal(h.offline.job.completed, 1); assert.equal(transfers.length, 2);
  await h.invoke('downloads:start', { ...options, kind: 'audio' }); await h.offline.done; assert.equal(h.offline.job.skipped, 1); assert.equal(transfers.length, 2);
  assert.ok(h.offline.Find(entry, 'audio')); assert.ok(h.offline.Find(entry, 'video')); assert.deepEqual(h.store.Snapshot(), before);
});
test('067 main rejects incomplete, forged, local and stale single targets before any transfer', async t => {
  let resolves = 0; const h = await MainHarness(t, { downloadOptions: { ffmpeg: process.execPath, resolve: async () => { resolves++; throw new Error('must not resolve'); } } }), id = h.store.data.activePlaylistId;
  await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123\nav456' }); const entry = h.store.Playlist(id).entries[0], other = h.store.Playlist(id).entries[1];
  const input = { playlistId: id, entryId: entry.id, entryURL: entry.url, includeChildren: false, kind: 'video', height: 720 };
  for (const change of [{ entryId: undefined }, { entryURL: undefined }, { entryId: 'missing' }, { entryURL: other.url }, { includeChildren: true }, { kind: 'invalid' }, { height: 4 }]) {
    for (const channel of ['downloads:estimate', 'downloads:start']) await assert.rejects(h.invoke(channel, { ...input, ...change }));
  }
  h.store.Playlist(id).entries[0] = { ...entry, type: 'local', path: path.join(h.root, 'music.mp3') }; h.store.Save();
  await assert.rejects(h.invoke('downloads:start', input)); h.store.Playlist(id).entries[0] = entry; h.store.Save();
  await h.invoke('library:action', { type: 'remove', playlistId: id, entryId: entry.id });
  await assert.rejects(h.invoke('downloads:estimate', input)); await assert.rejects(h.invoke('downloads:start', { ...input, estimateId: 'stale' }));
  assert.equal(resolves, 0); assert.equal(h.offline.controller, null); assert.equal(h.offline.records.size, 0);
});
test('067 deleting the last playing reference waits for native destruction and publishes the cleanup result', async t => {
  const h = await MainHarness(t, { delayPlayerClose: true }), id = h.store.data.activePlaylistId;
  const state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123' }), entry = state.playlists[0].entries[0], record = SavedTrack(h, entry);
  await h.invoke('player:play', id, entry.id); const view = h.views.at(-1), url = SavedURL(view);
  await h.invoke('library:action', { type: 'remove', playlistId: id, entryId: entry.id }); await h.invoke('trash:clear'); /* 最近削除に保管中は、保存済みメディアを残す（v0.7.3）。完全に削除したあとに整理される */ await FlushPlayer();
  assert.equal((await h.invoke('app:state')).current, null); assert.ok(fs.existsSync(h.offline.ResolvePath(record.file))); assert.ok(h.offline.cleanup.leases.size);
  view.webContents.finishClose(); await FlushPlayer(); assert.equal(fs.existsSync(h.offline.ResolvePath(record.file)), false); assert.equal(h.offline.records.size, 0);
  assert.equal((await h.protocols.get('favecus')(new Request(url))).status, 403);
  assert.equal(h.messages.filter(m => m.value?.type === 'downloads').at(-1).value.value.available.length, 0);
});
test('067 single and batch moves retain a playing saved file until the final playlist is deleted', async t => {
  const h = await MainHarness(t, { delayPlayerClose: true }), first = h.store.data.activePlaylistId;
  let state = await h.invoke('library:action', { type: 'add', playlistId: first, urls: 'av123' }); const entry = state.playlists[0].entries[0], record = SavedTrack(h, entry);
  state = await h.invoke('library:action', { type: 'create', name: '移動先' }); const second = state.activePlaylistId;
  await h.invoke('player:play', first, entry.id); const view = h.views.at(-1);
  const one = await h.invoke('library:transfer', { playlistId: first, entryId: entry.id, destinationIds: [second], mode: 'move' }); await FlushPlayer();
  assert.equal(h.offline.File(record.token).file, record.file); assert.equal((await h.invoke('app:state')).current.playlistId, second);
  await h.invoke('library:move-tracks', { entries: [{ playlistId: second, entryId: one.destinations[0].entryId }], destinationIds: [first] }); await FlushPlayer();
  assert.equal((await h.invoke('app:state')).current.playlistId, first); assert.equal(h.views.at(-1), view);
  await h.invoke('library:action', { type: 'delete', playlistId: first }); await h.invoke('trash:clear'); /* 最近削除に保管中は、保存済みメディアを残す（v0.7.3）。完全に削除したあとに整理される */ await FlushPlayer(); assert.ok(fs.existsSync(h.offline.ResolvePath(record.file)));
  view.webContents.finishClose(); await FlushPlayer(); assert.equal(h.offline.File(record.token), null);
});
test('067 quality refresh and a second playback keep independent source paths and reject an expired playback route', async t => {
  const h = await MainHarness(t, { delayPlayerClose: true }), id = h.store.data.activePlaylistId;
  const state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123' }), entry = state.playlists[0].entries[0], old = SavedTrack(h, entry, 'old media');
  await h.invoke('player:play', id, entry.id); const first = h.views.at(-1), originalURL = SavedURL(first), current = SavedTrack(h, entry, 'new quality', 1080);
  await h.offline.CleanupRecord(old, current); h.offline.FlushCleanup(); assert.equal(await (await h.protocols.get('favecus')(new Request(originalURL))).text(), 'old media');
  await h.invoke('player:play', id, entry.id); const second = h.views.at(-1); assert.notEqual(first, second);
  assert.equal(await (await h.protocols.get('favecus')(new Request(SavedURL(second)))).text(), 'new quality');
  assert.equal(await (await h.protocols.get('favecus')(new Request(originalURL))).text(), 'old media');
  first.webContents.finishClose(); await FlushPlayer(); assert.equal(fs.existsSync(h.offline.ResolvePath(old.file)), false); assert.ok(h.offline.File(current.token));
  assert.equal((await h.protocols.get('favecus')(new Request(originalURL))).status, 403);
  assert.equal((await h.protocols.get('favecus')(new Request(`favecus://offline/${current.token}`))).status, 403);
  await h.invoke('player:command', 'stop'); second.webContents.finishClose(); await FlushPlayer();
});
test('067 an in-flight protocol stream keeps its source after the native player has closed', async t => {
  const h = await MainHarness(t, { delayPlayerClose: true }), id = h.store.data.activePlaylistId;
  const state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123' }), entry = state.playlists[0].entries[0], record = SavedTrack(h, entry);
  await h.invoke('player:play', id, entry.id); const view = h.views.at(-1), stream = new (require('node:stream').PassThrough)();
  const mock = t.mock.method(fs, 'createReadStream', () => stream); let response;
  try { response = await h.protocols.get('favecus')(new Request(SavedURL(view))); } finally { mock.mock.restore(); }
  await h.invoke('library:action', { type: 'remove', playlistId: id, entryId: entry.id }); await h.invoke('trash:clear'); /* 最近削除に保管中は、保存済みメディアを残す（v0.7.3）。完全に削除したあとに整理される */ await FlushPlayer(); view.webContents.finishClose(); await FlushPlayer();
  assert.ok(fs.existsSync(h.offline.ResolvePath(record.file))); assert.ok(h.offline.cleanup.leases.size);
  stream.end('media'); assert.equal(await response.text(), 'media'); await FlushPlayer(); assert.equal(fs.existsSync(h.offline.ResolvePath(record.file)), false);
});
test('067 a failed native close holds the file until actual destruction is observed', async t => {
  let fail = true; const h = await MainHarness(t, { onNative: type => { if (type === 'close' && fail) { fail = false; throw new Error('native busy'); } } }), id = h.store.data.activePlaylistId;
  const state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123' }), entry = state.playlists[0].entries[0], record = SavedTrack(h, entry);
  await h.invoke('player:play', id, entry.id); const view = h.views.at(-1);
  await h.invoke('library:action', { type: 'remove', playlistId: id, entryId: entry.id }); await h.invoke('trash:clear'); /* 最近削除に保管中は、保存済みメディアを残す（v0.7.3）。完全に削除したあとに整理される */ await FlushPlayer(); assert.ok(fs.existsSync(h.offline.ResolvePath(record.file)));
  view.webContents.finishClose(); await FlushPlayer(); assert.equal(fs.existsSync(h.offline.ResolvePath(record.file)), false);
});
test('067 startup removes known orphan downloads while retaining referenced and unmanaged files', async t => {
  let kept, orphan;
  const h = await MainHarness(t, { setupStore: store => store.Apply({ type: 'add', playlistId: store.data.activePlaylistId, urls: 'av123' }), setupDownloads: ({ directory, store }) => {
    const key = require('../src/core/offline-library.cjs').Key;
    fs.mkdirSync(directory); const records = ['av123', 'av999'].map((id, i) => {
      const url = require('../src/core/urls.cjs').ParseBilibili(id).url, file = `media/${id}-p1/video.mp4`; fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); fs.writeFileSync(path.join(directory, file), 'media');
      const record = { token: key(url, 'video') + '.mp4', url, file, kind: 'video', layout: 4, bytes: 5 }; if (i) orphan = record; else kept = record; return record;
    });
    fs.writeFileSync(path.join(directory, 'unmanaged.bin'), 'keep'); fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify({ version: 1, files: records }));
  } });
  assert.ok(h.offline.File(kept.token)); assert.equal(h.offline.File(orphan.token), null); assert.equal(fs.existsSync(h.offline.ResolvePath(orphan.file)), false); assert.equal(fs.readFileSync(path.join(h.offline.directory, 'unmanaged.bin'), 'utf8'), 'keep');
});
const improveCalls = [];
async function MainHarness(t, options = {}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'favecus-main-040-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const protocols=new Map(), handlers=new Map(), views=[], windows=[], messages=[], activities=[], previewCalls=[], connections=[], crashStarts=[], switches=new Map(), paths=new Map();const saveDialogs = []; let savePath = null; let ready, thumbnailDone, filePaths = [], loggedIn = false, activeOffline, activeStore;
  let now = 0, timerId = 0; const timers = new Map();
  const { BackgroundMode: ActualBackgroundMode } = require('../src/core/background-mode.cjs');
  class BackgroundMode extends ActualBackgroundMode {
    constructor(settings, canSwitch, enter, options) { super(settings, canSwitch, enter, { ...options, now: () => now, schedule: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; }, cancel: id => timers.delete(id) }); }
  }
  const { PlayerRecovery: ActualRecovery } = require('../src/core/player-recovery.cjs');
  class PlayerRecovery extends ActualRecovery {
    constructor(recover, settings) { super(recover, options.testRecovery ? { ...settings, schedule: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; }, cancel: id => timers.delete(id) } : settings); }
  }
  class Contents extends EventEmitter {
    constructor(){super();this.frame={url:''};this.sent=[];this.muteHistory=[];}
    get mainFrame(){options.onFrameAccess?.(this);return this.frame;}
    set mainFrame(frame){this.frame=frame;}
    focus(){this.focused=true;} executeJavaScript(code){(this.scripts=this.scripts||[]).push(code);return Promise.resolve();}
    setWindowOpenHandler(fn){this.openHandler=fn;} isDestroyed(){return !!this.closed;}close(){if(this.closed)return;if(options.delayPlayerClose&&views.some(v=>v.webContents===this)&&!this.allowClose){this.closing=true;return;}options.onNative?.('close');this.closed=true;const view=views.find(v=>v.webContents===this);if(view&&options.releaseContents)view.webContents=undefined;this.emit('destroyed');options.onClose?.(this,{windows,ipcMain});}setAudioMuted(value){this.muted=value;this.muteHistory.push(value);}getURL(){return this.frame.url;}getTitle(){return '動画名 - bilibili';}
    async loadURL(url){
      options.onNative?.('load');this.loads=(this.loads || 0)+1;this.loading=true;
      this.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false},url,false,true);
      if(views.some(v=>v.webContents===this)&&options.delayPlayerLoad)await new Promise(resolve=>this.finishLoad=resolve);
      if(this.closed)return;
      this.frame.url=url;this.loading=false;this.emit('dom-ready');this.emit('did-finish-load');
    }
    finishClose(){this.allowClose=true;this.close();}
    stop(){options.onNative?.('stop');this.stops=(this.stops || 0)+1;}
    invalidate(){this.repaints=(this.repaints || 0)+1;}
    send(type,value){if(this.closed)throw new Error('Object has been destroyed');void this.mainFrame;this.sent.push({type,value});messages.push({type,value});}
  }
  class Window extends EventEmitter {
    constructor(){super();this.webContents=new Contents();this.children=[];this.contentView={addChildView:v=>this.children.push(v),removeChildView:v=>{options.onNative?.('detach');this.children=this.children.filter(x=>x!==v);}};windows.push(this);}
    isFullScreen(){return !!this.fullscreen;}setFullScreen(value){this.fullscreen=!!value;this.emit(value?'enter-full-screen':'leave-full-screen');}
    isMinimized(){return !!this.minimized;}isMaximized(){return false;}show(){this.visible=true;}hide(){this.visible=false;this.emit('hide');}focus(){this.emit('focus');}close(){this.closed=true;this.emit('closed');}restore(){this.minimized=false;}
    isDestroyed(){return !!this.closed;}getContentSize(){return [1440,900];}async loadURL(url){await this.webContents.loadURL(url);}
    isFocused(){return this.focused !== false;}isVisible(){return this.visible !== false;}
  }
  class View {
    constructor(options){this.options=options;this.webContents=new Contents();views.push(this);}
    setVisible(value){this.visible=value;}setBounds(value){this.bounds=value;}
  }
  class Presence {Configure(){}SetActivity(value){activities.push(value);}Stop(){}}
  class Mini {Update(){}Destroy(){}Restore(){windows[0].show();windows[0].focus();}CanHideToTray(){return options.tray===true;}}
  class Thumbnails {Get(){return new Promise(resolve=>thumbnailDone=resolve);}async Improve(entry,image,file){improveCalls.push({entry,file});return options.improved||image;}async GetPreview(entry,active){previewCalls.push(entry);return active()?'data:image/png;base64,aWNvbg==':null;}}
  const app=new EventEmitter();Object.assign(app,{setName(){},setPath:(key,value)=>paths.set(key,value),commandLine:{appendSwitch:(key,value)=>switches.set(key,value)},requestSingleInstanceLock:()=>true,quit(){},getPath:()=>path.join(root,'data'),getVersion:()=> '0.6.4',getAppPath:()=>path.resolve(__dirname,'..'),whenReady:()=>({then:fn=>{ready=fn();return ready;}})});
  const ipcMain=new EventEmitter();ipcMain.handle=(key,fn)=>handlers.set(key,fn);ipcMain.removeHandler=key=>handlers.delete(key);
  const session=new EventEmitter();session.setPermissionRequestHandler=()=>{};session.setPermissionCheckHandler=()=>{};
  session.preconnect = value => { connections.push(value); if (options.failPreconnect) throw new Error('offline'); };
  session.fetch = async url => options.fetch ? options.fetch(url) : new Response(JSON.stringify({ code: 0, data: new URL(url).pathname.endsWith('/nav') ? { isLogin: loggedIn, mid: 1234, uname: 'user' } : options.details || { title: '動画全体', pages: [{ page: 1, part: '第1曲' }, { page: 2, part: '第2曲' }] } }));
  const electron={app,BrowserWindow:Window,WebContentsView:View,ipcMain,dialog:{showErrorBox:(_title,error)=>assert.fail(error),showOpenDialog:async()=>({canceled:!filePaths.length,filePaths}),showSaveDialog:async(_win,settings)=>{saveDialogs.push(settings);return options.saveDialog?options.saveDialog(settings):{canceled:!savePath,filePath:savePath};}},shell:{},session:{defaultSession:session,fromPartition:()=>session},protocol:{registerSchemesAsPrivileged(){},handle(name,handler){protocols.set(name,handler);}},nativeImage:{createFromDataURL:data=>({isEmpty:()=>false,getSize:()=>({width:1,height:1}),resize:()=>({toPNG:()=>Buffer.from(data.split(',')[1],'base64')})})},net:{},Menu:{setApplicationMenu(){}}};
  electron.net.fetch = options.netFetch;
  electron.crashReporter={start:settings=>{assert.equal(windows.length,0);assert.equal(views.length,0);crashStarts.push(settings);},addExtraParameter(){}};
  const storeModule = require('../src/core/store.cjs'), offlineModule = require('../src/core/offline-library.cjs');
  class TestStore extends storeModule.Store { constructor(...args) { super(...args); activeStore = this; options.setupStore?.(this); } }
  class TestOffline extends offlineModule.OfflineLibrary { constructor(settings) {
    const directory = path.join(root, 'downloads'); options.setupDownloads?.({ store: activeStore, directory });
    super({ ...settings, directory, ...options.downloadOptions }); activeOffline = this;
  } }
  const src=path.resolve(__dirname,'../src'),context={require:name=>name==='electron'?electron:name==='./core/store.cjs'?{...storeModule,Store:TestStore}:name==='./core/offline-library.cjs'?{...offlineModule,OfflineLibrary:TestOffline}:name==='./core/background-mode.cjs'?{BackgroundMode}:name==='./core/player-recovery.cjs'?{PlayerRecovery}:name==='./core/mini-player.cjs'?{MiniPlayer:Mini}:name==='./core/thumbnail.cjs'?{...require('../src/core/thumbnail.cjs'),Thumbnails}:name==='./core/discord.cjs'?{...require('../src/core/discord.cjs'),DiscordPresence:Presence}:require(name.startsWith('.')?path.join(src,name):name),__dirname:src,process:{...process,platform:'linux',env:{},on(){}},URL,Response,Date,structuredClone,setImmediate,clearImmediate,setTimeout,clearTimeout,setInterval:()=>({unref(){}})};
  vm.runInNewContext(fs.readFileSync(path.join(src,'main.cjs'),'utf8'),context);await ready;
  const main=windows[0],event={sender:main.webContents,senderFrame:main.webContents.mainFrame};
  t.after(()=>app.emit('before-quit'));
  const invoke=async(channel,...args)=>{const result=await handlers.get(channel)(event,...args);if(!result.ok)throw new Error(result.error);return result.value;};
  return {store:activeStore,offline:activeOffline,protocols,invoke,views,windows,messages,activities,previewCalls,connections,ipcMain,event,main,root,app,crashStarts,switches,paths,setLogin:value=>loggedIn=value,invokeFrom:async(wc,channel,...args)=>handlers.get(channel)({sender:wc,senderFrame:wc.mainFrame},...args),chooseFiles:files=>filePaths=files,saveDialogs,chooseSave:file=>savePath=file,advance(ms) { const until = now + ms; let next; while ((next = [...timers.entries()].sort((a,b) => a[1].at - b[1].at)[0]) && next[1].at <= until) { now = next[1].at; timers.delete(next[0]); next[1].fn(); } now = until; },finishThumbnail:async value=>{thumbnailDone(value);await new Promise(setImmediate);}};
}
test('moving a playing track preserves its view, media position and the next-track queue', async t=>{
  const h=await MainHarness(t);let state=(await h.invoke('app:state')).state;const source=state.activePlaylistId;
  state=await h.invoke('library:action',{type:'add',playlistId:source,urls:'av123',title:'再生中'});const entry=state.playlists[0].entries[0];
  state=await h.invoke('library:action',{type:'create',name:'移動先'});const target=state.activePlaylistId;
  await h.invoke('library:action',{type:'add',playlistId:target,urls:'av456',title:'次の曲'});
  await h.invoke('player:play',source,entry.id);const view=h.views[0];
  h.ipcMain.emit('media:state',{sender:view.webContents,senderFrame:view.webContents.mainFrame},{url:entry.url,title:entry.title,position:83,duration:311,paused:false});
  const moved=await h.invoke('library:transfer',{playlistId:source,entryId:entry.id,destinationIds:[target],mode:'move'});
  const after=await h.invoke('app:state');assert.equal(after.current.playlistId,target);assert.equal(after.current.entryId,moved.destinations[0].entryId);assert.equal(after.playback.position,83);assert.equal(h.views.length,1);assert.equal(view.webContents.closed,undefined);
  await h.invoke('player:command','previous');assert.equal(h.views.length,1);assert.equal(view.webContents.loads,2);assert.equal((await h.invoke('app:state')).current.entry.videoId,'av456');
});
test('thumbnail mode hides only the video view, preserves playback, and rejects stale artwork after stopping',async t=>{
  const h=await MainHarness(t);let state=(await h.invoke('app:state')).state;const id=state.activePlaylistId;
  state=await h.invoke('library:action',{type:'add',playlistId:id,urls:'av123\nav456'});const entry=state.playlists[0].entries[0];
  await h.invoke('player:play',id,entry.id);const view=h.views[0];
  h.ipcMain.emit('view:bounds',h.event,{x:100,y:100,width:500,height:500,visible:true});assert.equal(view.visible,true);
  h.ipcMain.emit('media:state',{sender:view.webContents,senderFrame:view.webContents.mainFrame},{url:entry.url,title:'曲',position:22,duration:311,paused:false});
  await h.invoke('library:action',{type:'settings',settings:{thumbnailMode:true}});assert.equal(view.visible,false);assert.equal(h.views.length,1);
  await h.finishThumbnail('data:image/png;base64,valid');assert.equal((await h.invoke('app:state')).thumbnail.image,'data:image/png;base64,valid');
  await h.invoke('library:action',{type:'settings',settings:{thumbnailMode:false}});assert.equal(view.visible,true);assert.equal((await h.invoke('app:state')).playback.position,22);
  await h.invoke('library:action',{type:'settings',settings:{thumbnailMode:true}});await h.invoke('player:command','stop');await h.finishThumbnail('stale');assert.equal((await h.invoke('app:state')).thumbnail,null);
  assert.deepEqual(Array.from(view.options.webPreferences.additionalArguments),['--favecus-start-at-zero','--favecus-quality-360p']);
});
test('Bilibili browser notice preserves playback and the native view stays inside its resized slot', async t => {
  const h = await MainHarness(t); let state = (await h.invoke('app:state')).state;
  const id = state.activePlaylistId;
  state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123' });
  const entry = state.playlists[0].entries[0];
  await h.invoke('player:play', id, entry.id); const view = h.views[0];
  h.ipcMain.emit('media:state', { sender: view.webContents, senderFrame: view.webContents.mainFrame }, { url: entry.url, title: '曲', position: 22, duration: 311, paused: false });
  const response = view.webContents.openHandler({ url: 'https://www.bilibili.com/video/av123' });
  assert.equal(response.action, 'deny');
  assert.ok(h.messages.some(m => m.type === 'app:event' && m.value.type === 'notice' && /ブラウザーで開く/.test(m.value.value)));
  h.ipcMain.emit('view:bounds', h.event, { x: 100.25, y: 120.25, width: 500.5, height: 320.5, visible: true });
  assert.deepEqual({ ...view.bounds }, { x: 101, y: 121, width: 499, height: 319 });
  assert.ok(view.bounds.y + view.bounds.height <= 440.75);
  h.ipcMain.emit('view:bounds', h.event, { x: 100.25, y: 120.25, width: 500.5, height: 400.5, visible: true });
  assert.equal(view.bounds.height, 399); assert.equal(view.visible, true);
  assert.equal(h.views.length, 1); assert.equal((await h.invoke('app:state')).playback.position, 22);
});

test('phrase changes refresh the playing title and Discord without replacing the view or seeking', async t => {
  const h = await MainHarness(t); let state = (await h.invoke('app:state')).state; const source = state.activePlaylistId;
  state = await h.invoke('library:action', { type: 'add', playlistId: source, urls: 'av123', title: 'TEST 刻ト詩' }); const entry = state.playlists[0].entries[0];
  state = await h.invoke('library:action', { type: 'create', name: '追加先' }); const target = state.activePlaylistId;
  await h.invoke('player:play', source, entry.id); const view = h.views[0];
  const event = { sender: view.webContents, senderFrame: view.webContents.mainFrame };
  h.ipcMain.emit('media:state', event, { url: entry.url, title: 'TEST 刻ト詩', position: 83, duration: 311, paused: false });
  await h.invoke('library:action', { type: 'settings', settings: { titleCleanupWords: ['TEST'] } });
  let after = await h.invoke('app:state'); assert.equal(after.current.entry.title, '刻ト詩'); assert.equal(after.playback.title, '刻ト詩'); assert.equal(after.playback.position, 83); assert.equal(after.playback.paused, false);
  assert.equal(h.views.length, 1); assert.equal(h.activities.at(-1).details, '刻ト詩');
  h.ipcMain.emit('media:state', event, { url: entry.url, title: 'TEST 刻ト詩', position: 84, duration: 311, paused: false });
  assert.equal((await h.invoke('app:state')).playback.title, '刻ト詩');
  await h.invoke('library:action', { type: 'add', destinationIds: [source, target], urls: 'av456', title: 'TEST 次の曲' });
  assert.equal((await h.invoke('app:state')).playback.position, 84); assert.equal(h.views.length, 1);
  await h.invoke('player:command', 'next'); after = await h.invoke('app:state'); assert.equal(after.current.entry.videoId, 'av456'); assert.equal(after.current.entry.title, '次の曲');
});
test('a title discovered after URL-only registration is filtered before display and persistence', async t => {
  const h = await MainHarness(t); let state = (await h.invoke('app:state')).state; const id = state.activePlaylistId;
  state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123' }); const entry = state.playlists[0].entries[0];
  await h.invoke('player:play', id, entry.id); const view = h.views[0];
  const event = { sender: view.webContents, senderFrame: view.webContents.mainFrame };
  h.ipcMain.emit('media:state', event, { url: entry.url, title: '【純K投屏】「刻ト詩」', position: 2, duration: 311, paused: false });
  const after = await h.invoke('app:state'); assert.equal(after.playback.title, '刻ト詩'); assert.equal(after.state.playlists[0].entries[0].title, '刻ト詩');
  await h.invoke('library:action', { type: 'settings', settings: { titleCleanupWords: ['刻ト詩', '純K投屏', '【', '】', '「', '」'] } });
  h.ipcMain.emit('media:state', event, { url: entry.url, title: '【純K投屏】「刻ト詩」', position: 3, duration: 311, paused: false });
  assert.equal((await h.invoke('app:state')).playback.title, 'av123');
});
test('native background events switch to song mode after the configured wait and returning to video reuses the loaded player', async t => {
  const h = await MainHarness(t); let state = (await h.invoke('app:state')).state; const id = state.activePlaylistId;
  state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123', title: '曲' });
  const entry = state.playlists[0].entries[0]; await h.invoke('player:play', id, entry.id); const view = h.views[0];
  h.ipcMain.emit('view:bounds', h.event, { x: 20, y: 20, width: 500, height: 300, visible: true });
  h.ipcMain.emit('media:state', { sender: view.webContents, senderFrame: view.webContents.mainFrame }, { url: entry.url, title: '曲', position: 172, duration: 311, paused: false });
  h.main.emit('focus'); h.advance(600000); assert.equal(view.visible, true);
  h.main.emit('blur'); h.advance(240000); h.main.emit('minimize'); h.advance(59999); assert.equal(view.visible, true);
  h.advance(1); let after = await h.invoke('app:state'); assert.equal(after.state.settings.thumbnailMode, true); assert.equal(view.visible, false);
  assert.equal(after.playback.position, 172); assert.equal(after.playback.paused, false);
  await h.finishThumbnail('data:image/png;base64,cached'); h.main.emit('focus'); assert.equal(view.visible, false);
  const repaints = view.webContents.repaints;
  await h.invoke('library:action', { type: 'settings', settings: { thumbnailMode: false } });
  after = await h.invoke('app:state'); assert.equal(view.visible, true); assert.equal(h.views.length, 1); assert.equal(view.webContents.loads, 1);
  assert.equal(after.playback.position, 172); assert.equal(after.playback.paused, false); assert.ok(view.webContents.repaints > repaints);
  assert.ok(view.webContents.sent.some(m => m.type === 'media:command' && m.value.type === 'refresh-display'));
  assert.equal(view.webContents.sent.some(m => m.value?.type === 'pause' || m.value?.type === 'seek'), false);
});
test('shuffle button restarts immediately, updates its mode, and a failed start leaves the prior player and queue intact', async t => {
  const h = await MainHarness(t); let state = (await h.invoke('app:state')).state; const id = state.activePlaylistId;
  state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123\nav456\nav789' });
  const first = state.playlists[0].entries[0]; await h.invoke('player:play', id, first.id);
  await h.invoke('library:action', { type: 'settings', settings: { repeat: 'one' } }); await h.invoke('player:shuffle', id);
  let after = await h.invoke('app:state'); assert.equal(after.state.settings.shuffle, true); assert.equal(after.state.settings.repeat, 'off'); assert.equal(h.views.length, 1); assert.equal(h.views[0].webContents.loads, 2);
  const seen = new Set([after.current.entryId]); for (let i = 0; i < 2; i++) { await h.invoke('player:command', 'next'); seen.add((await h.invoke('app:state')).current.entryId); }
  assert.equal(seen.size, 3); await h.invoke('player:shuffle', id); assert.equal(h.views.length, 1); assert.equal(h.views[0].webContents.loads, 5);
  // A missing local file must not replace the valid queue even if it is the drawn first row.
  state = await h.invoke('library:action', { type: 'create', name: 'missing' }); const missingId = state.activePlaylistId;
  const file = path.join(h.root, 'gone.mp3'); fs.writeFileSync(file, 'audio');
  h.chooseFiles([file]); const files = await h.invoke('library:prepare-files', [missingId]);
  const imported = await h.invoke('library:commit-add', files.id, []);
  const missing = imported.state.playlists.find(p => p.id === missingId).entries[0];
  fs.rmSync(path.join(h.root, 'data', 'media', missing.fileName));
  const plan = await h.invoke('library:prepare-add', { type: 'add-videos', destinationIds: [id], videos: [{ url: 'av222', title: '新しい曲' }] });
  await h.invoke('library:commit-add', plan.id, []);
  const before = await h.invoke('app:state');
  await assert.rejects(h.invoke('player:shuffle', missingId), /ファイルが見つかりません/);
  const unchanged = await h.invoke('app:state'); assert.equal(unchanged.current.entryId, before.current.entryId); assert.equal(h.views.length, 1); assert.equal(h.views[0].webContents.loads, 5);
  await h.invoke('player:command', 'next'); assert.equal((await h.invoke('app:state')).current.playlistId, id);
});

test('the browser is login-gated and its toolbar passes the selected part into an add draft without registering it', async t => {
  const h = await MainHarness(t); await assert.rejects(h.invoke('bilibili:browse'), /ログイン/); assert.equal(h.windows.length, 1);
  h.setLogin(true); await h.invoke('bilibili:browse'); assert.equal(h.windows.length, 2);
  const browser = h.windows[1], view = h.views[0]; await view.webContents.loadURL('https://www.bilibili.com/video/av123/?p=2&share_source=x');
  const before = (await h.invoke('app:state')).state.playlists[0].entries.length;
  let result = await h.invokeFrom(browser.webContents, 'browse:add'); assert.equal(result.ok, true);
  const draft = h.messages.find(m => m.type === 'app:event' && m.value.type === 'add-url').value.value;
  assert.deepEqual({ ...draft }, { url: 'https://www.bilibili.com/video/av123/?p=2', title: '第2曲', analyze: true });
  assert.equal((await h.invoke('app:state')).state.playlists[0].entries.length, before); assert.equal(browser.visible, false);
  h.ipcMain.emit('view:bounds', h.event, { x: 0, y: 0, width: 500, height: 300, visible: false, modalOpen: true });
  result = await h.invokeFrom(browser.webContents, 'browse:add'); assert.equal(result.ok, false); assert.match(result.error, /画面を閉じて/);
  result = await h.invokeFrom(view.webContents, 'browse:add'); assert.equal(result.ok, false);
});
test('manual reload keeps the embedded player and selected part across repeated reloads and the next track', async t => {
  const h = await MainHarness(t, { testRecovery: true }); let state = (await h.invoke('app:state')).state; const id = state.activePlaylistId;
  state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'https://www.bilibili.com/video/av123/?p=2\nav456' }); const first = state.playlists[0].entries[0];
  await h.invoke('player:play', id, first.id); const next = (await h.invoke('app:state')).queue.next.id;
  for (let i = 0; i < 3; i++) {
    const old = h.views.at(-1); await h.invoke('player:command', 'reload'); const after = await h.invoke('app:state'), view = h.views.at(-1), url = new URL(view.webContents.getURL());
    assert.equal(after.current.entryId, first.id); assert.equal(after.current.pageMode, false); assert.equal(after.queue.next.id, next); await FlushPlayer();assert.equal(old.webContents.closed, true);
    assert.equal(url.hostname, 'player.bilibili.com'); assert.equal(url.searchParams.get('aid'), '123'); assert.equal(url.searchParams.get('p'), '2');
    h.ipcMain.emit('media:health', { sender: view.webContents, senderFrame: view.webContents.mainFrame }, { url: first.url, ready: true, errorCode: 0 });
  }
  h.advance(60000); await FlushPlayer(); assert.equal(h.views.length, 4);
  await h.invoke('player:command', 'next'); assert.equal((await h.invoke('app:state')).current.entryId, next);
  assert.equal(new URL(h.views.at(-1).webContents.getURL()).hostname, 'player.bilibili.com');
});
test('a stalled embedded player switches to an in-app official player, bounds recovery and ignores stale events', async t => {
  const h = await MainHarness(t, { testRecovery: true }); let state = (await h.invoke('app:state')).state; const id = state.activePlaylistId;
  state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'https://www.bilibili.com/video/av123/?p=2\nav456' }); const [first, second] = state.playlists[0].entries;
  await h.invoke('player:play', id, first.id); const old = h.views[0]; h.advance(20000); await FlushPlayer();
  assert.equal(h.views.length, 2); assert.equal((await h.invoke('app:state')).current.pageMode, false);
  const rebuilt = h.views[1], url = new URL(rebuilt.webContents.getURL());
  await FlushPlayer();assert.equal(old.webContents.closed, true); assert.equal(url.hostname, 'www.bilibili.com'); assert.equal(url.searchParams.get('p'), '2');
  h.ipcMain.emit('media:health', { sender: rebuilt.webContents, senderFrame: rebuilt.webContents.mainFrame }, { url: first.url, ready: false, errorCode: 4 });
  h.advance(60000); await FlushPlayer(); assert.equal(h.views.length, 3);
  assert.equal(h.windows.length, 1); assert.ok(rebuilt.options.webPreferences.additionalArguments.includes('--favecus-official-player'));
  await h.invoke('player:play', id, second.id); const current = h.views.at(-1);
  h.ipcMain.emit('media:health', { sender: old.webContents, senderFrame: old.webContents.mainFrame }, { url: first.url, ready: false, errorCode: 4 });
  h.ipcMain.emit('media:health', { sender: current.webContents, senderFrame: current.webContents.mainFrame }, { url: second.url, ready: true, errorCode: 0 });
  h.advance(60000); await FlushPlayer(); assert.equal(h.views.length, 4); assert.equal((await h.invoke('app:state')).current.entryId, second.id);
  await h.invoke('player:play', id, first.id); await h.invoke('player:command', 'stop'); h.advance(60000); await FlushPlayer(); assert.equal((await h.invoke('app:state')).current, null);
});
test('official page mode is explicit and reload preserves it until the player button is used', async t => {
  const h = await MainHarness(t, { testRecovery: true }); let state = (await h.invoke('app:state')).state; const id = state.activePlaylistId;
  state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'https://www.bilibili.com/video/av123/?p=2' }); const entry = state.playlists[0].entries[0];
  await h.invoke('player:play', id, entry.id); await h.invoke('player:command', 'page-mode');
  const old = h.views.at(-1); await h.invoke('player:command', 'reload');
  await FlushPlayer();assert.equal(old.webContents.closed, true); assert.equal(h.views.at(-1).webContents.getURL(), entry.url); assert.equal((await h.invoke('app:state')).current.pageMode, true);
  h.advance(60000); await FlushPlayer(); assert.equal(h.views.length, 3);
  await h.invoke('player:command', 'page-mode'); await h.invoke('player:command', 'reload');
  assert.equal((await h.invoke('app:state')).current.pageMode, false); assert.equal(new URL(h.views.at(-1).webContents.getURL()).hostname, 'player.bilibili.com');
});
async function EmbeddedPlayer(t, probe) {
  const h = await MainHarness(t, { testRecovery: true }), id = h.store.data.activePlaylistId, probes = [];
  const state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123\nav456' }), entry = state.playlists[0].entries[0];
  await h.invoke('player:play', id, entry.id); const view = h.views.at(-1); view.navigationReady = true;
  h.ipcMain.emit('view:bounds', h.event, { x: 100, y: 100, width: 500, height: 300, visible: true });
  view.webContents.executeJavaScript = async code => { if (/requestVideoFrameCallback/.test(code)) { probes.push(code); return probe(); } return undefined; };
  h.ipcMain.emit('media:health', { sender: view.webContents, senderFrame: view.webContents.mainFrame }, { url: entry.url, ready: true, position: 5, paused: false, ended: false });
  return { h, id, entry, view, probes };
}
// 映像停止の確認は、mainの実際のタイマー（2.5秒後）で動く。
const Delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('067 audio-only playback after returning to video mode (frozen picture) switches to the official player at the same position', async t => {
  const { h, view, probes } = await EmbeddedPlayer(t, () => false), count = h.views.length;
  await h.invoke('library:action', { type: 'settings', settings: { thumbnailMode: true } }); await h.invoke('library:action', { type: 'settings', settings: { thumbnailMode: false } });
  view.navigationReady = true; h.main.emit('show');
  await Delay(1000); assert.equal(probes.length, 0, '戻した直後ではなく、少し待ってから確認する');
  await Delay(2000); await FlushPlayer(); assert.equal(probes.length, 1, '2.5秒後に最初の確認をする');
  await Delay(1800); await FlushPlayer(); assert.equal(probes.length, 2, '止まっていたら間をおいてもう一度確認する（誤検知で復旧を使い切らない）');
  await FlushPlayer();
  assert.ok(h.views.length > count, '映像が止まっていれば、公式プレイヤーで作り直す'); assert.ok(h.views.at(-1).options.webPreferences.additionalArguments.includes('--favecus-official-player'));
});
test('067 a moving picture, a hidden window, thumbnail mode and a replaced view never start a frame-stall recovery', async t => {
  const running = await EmbeddedPlayer(t, () => true), hidden = await EmbeddedPlayer(t, () => false), thumbnail = await EmbeddedPlayer(t, () => false), replaced = await EmbeddedPlayer(t, () => false);
  const counts = [running, hidden, thumbnail, replaced].map(x => x.h.views.length);
  for (const x of [running, hidden, thumbnail, replaced]) { x.view.navigationReady = true; x.h.main.emit('show'); }
  hidden.h.main.visible = false;
  await thumbnail.h.invoke('library:action', { type: 'settings', settings: { thumbnailMode: true } });
  await replaced.h.invoke('player:command', 'stop');
  await Delay(2800); await FlushPlayer(); await FlushPlayer();
  assert.equal(running.probes.length, 1, '映像が進んでいれば確認だけで何もしない'); assert.equal(running.h.views.length, counts[0]);
  assert.equal(hidden.probes.length, 0, 'ウィンドウが隠れているときは確認しない（描画が止まるのが正常）'); assert.equal(hidden.h.views.length, counts[1]);
  assert.equal(thumbnail.probes.length, 0, '曲モードでは確認しない'); assert.equal(thumbnail.h.views.length, counts[2]);
  assert.equal(replaced.probes.length, 0, '再生が止まった・入れ替わった後は確認しない');
});
test('manual reload allows a bounded fresh recovery sequence and retains the internal official player', async t => {
  const h = await MainHarness(t, { testRecovery: true }); let state = (await h.invoke('app:state')).state; const id = state.activePlaylistId;
  state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123' }); const entry = state.playlists[0].entries[0];
  await h.invoke('player:play', id, entry.id);
  const fail = async () => { const wc = h.views.at(-1).webContents; h.ipcMain.emit('media:health', { sender: wc, senderFrame: wc.mainFrame }, { url: entry.url, ready: false, errorCode: 3 }); await FlushPlayer(); };
  await fail(); assert.equal(h.views.length, 2); await fail(); assert.equal(h.views.length, 3); await fail(); assert.equal(h.views.length, 3);
  await h.invoke('player:command', 'reload'); assert.equal(h.views.length, 4);
  await fail(); await fail(); await fail(); h.advance(60000); await FlushPlayer(); assert.equal(h.views.length, 6);
  assert.equal((await h.invoke('app:state')).current.pageMode, false); assert.equal((await h.invoke('app:state')).current.officialPlayer, true);
});
test('list artwork resolves stored entries only and never starts playback or accepts remote IPC', async t => {
  const h = await MainHarness(t); let state = (await h.invoke('app:state')).state; const id = state.activePlaylistId;
  state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123' }); const entry = state.playlists[0].entries[0];
  assert.equal(await h.invoke('library:thumbnail', id, entry.id), 'data:image/png;base64,aWNvbg==');
  assert.equal(h.previewCalls[0].videoId, 'av123'); assert.equal(h.views.length, 0); assert.equal((await h.invoke('app:state')).current, null);
  await assert.rejects(() => h.invoke('library:thumbnail', id, '../secret'));
  await h.invoke('player:play', id, entry.id);
  assert.equal((await h.invokeFrom(h.views[0].webContents, 'library:thumbnail', id, entry.id)).ok, false);
  await h.invoke('library:action', { type: 'create', name: '別のリスト' }); assert.equal(await h.invoke('library:thumbnail', id, entry.id), null);
});
test('published next-track state matches shuffle advancement and updates for repeat-one and stop', async t => {
  const h = await MainHarness(t); let state = (await h.invoke('app:state')).state; const id = state.activePlaylistId;
  await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123\nav456\nav789' });
  await h.invoke('library:action', { type: 'settings', settings: { repeat: 'all' } }); await h.invoke('player:shuffle', id);
  for (let i = 0; i < 8; i++) {
    const preview = (await h.invoke('app:state')).queue; assert.equal(preview.shuffle, true);
    assert.equal((await h.invoke('app:state')).queue.next.id, preview.next.id);
    await h.invoke('player:command', 'next'); assert.equal((await h.invoke('app:state')).current.entryId, preview.next.id);
  }
  await h.invoke('library:action', { type: 'settings', settings: { repeat: 'one' } });
  const after = await h.invoke('app:state'); assert.equal(after.queue.next.id, after.current.entryId);
  await h.invoke('player:command', 'stop'); assert.equal((await h.invoke('app:state')).queue, null);
});

test('parent playback advances across actual owner lists and previews the real next row; all-list playback deduplicates', async t => {
  const h = await MainHarness(t); let state = (await h.invoke('app:state')).state, parent = state.activePlaylistId;
  state = await h.invoke('library:action', { type: 'add', playlistId: parent, urls: 'av1\nav2' });
  state = await h.invoke('library:action', { type: 'create', name: '子', parentId: parent }); const child = state.activePlaylistId;
  state = await h.invoke('library:action', { type: 'add', playlistId: child, urls: 'av3' });
  state = await h.invoke('library:action', { type: 'create', name: '孫', parentId: child }); const grandchild = state.activePlaylistId;
  state = await h.invoke('library:action', { type: 'add', playlistId: grandchild, urls: 'av4' });
  state = await h.invoke('library:action', { type: 'create', name: '他' }); const other = state.activePlaylistId;
  await h.invoke('library:action', { type: 'add', playlistId: other, urls: 'av1\nav5' });
  await h.invoke('library:action', { type: 'playlist-attach', playlistId: other, ids: [child], removeOriginal: false });
  await h.invoke('player:play', parent); const played = [];
  for (let i = 0; i < 4; i++) { const current = await h.invoke('app:state'); played.push(current.current.entry.videoId); if (i < 3) { const next = current.queue.next.id; await h.invoke('player:command', 'next'); assert.equal((await h.invoke('app:state')).current.entryId, next); } }
  assert.deepEqual(played, ['av1', 'av2', 'av3', 'av4']); assert.equal((await h.invoke('app:state')).current.playlistId, grandchild);
  await h.invoke('player:all', false); const all = [];
  for (let i = 0; i < 5; i++) { all.push((await h.invoke('app:state')).current.entry.videoId); if (i < 4) await h.invoke('player:command', 'next'); }
  assert.deepEqual(all, ['av1', 'av2', 'av3', 'av4', 'av5']);
  await h.invoke('player:all', true); const seen = new Set(); for (let i = 0; i < 5; i++) { seen.add((await h.invoke('app:state')).current.entry.videoId); if (i < 4) await h.invoke('player:command', 'next'); } assert.equal(seen.size, 5);
});

test('Bilibili track changes reuse the player, preserve volume, and reject the previous track signals', async t => {
  const h = await MainHarness(t, { testRecovery: true }); const id = (await h.invoke('app:state')).state.activePlaylistId;
  const state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123\nav456\nav789' });
  const [first, second, third] = state.playlists[0].entries;
  assert.deepEqual(h.connections.map(value => value.url), ['https://player.bilibili.com', 'https://api.bilibili.com']);
  await h.invoke('player:play', id, first.id); const view = h.views[0], wc = view.webContents;
  const event = { sender: wc, senderFrame: wc.mainFrame };
  await h.invoke('player:volume', .35);
  await h.invoke('player:command', 'next');
  assert.equal(h.views.length, 1); assert.equal(h.main.children.length, 1); assert.equal(wc.closed, undefined); assert.equal(wc.loads, 2);
  assert.ok(wc.muteHistory.slice(-4).includes(true), 'old document is silenced natively without IPC during navigation');
  assert.equal(wc.sent.filter(message => message.value?.type === 'volume').at(-1).value.value, .35); assert.equal(wc.muted, false);
  h.ipcMain.emit('media:state', event, { url: first.url, position: 99, duration: 99, paused: true, ended: true });
  h.ipcMain.emit('media:health', event, { url: first.url, ready: false, errorCode: 4 });
  await FlushPlayer();
  assert.equal((await h.invoke('app:state')).current.entryId, second.id); assert.equal((await h.invoke('app:state')).playback, null); assert.equal(h.views.length, 1);
  h.ipcMain.emit('media:health', event, { url: second.url, ready: true, errorCode: 0 });
  h.advance(60000); await FlushPlayer(); assert.equal(h.views.length, 1);
  h.ipcMain.emit('media:state', event, { url: second.url, position: 99, duration: 99, paused: true, ended: true });
  await FlushPlayer();
  assert.equal((await h.invoke('app:state')).current.entryId, third.id); assert.equal(h.views.length, 1); assert.equal(wc.loads, 3);
  await h.invoke('player:command', 'previous'); assert.equal((await h.invoke('app:state')).current.entryId, second.id); assert.equal(h.views.length, 1);
});

test('rapid skips do not wait for previous navigation and ignore its late completion, error and media reports', async t => {
  const h = await MainHarness(t); const id = (await h.invoke('app:state')).state.activePlaylistId;
  const state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123\nav456\nav789' });
  const [first, second, third] = state.playlists[0].entries;
  await h.invoke('player:play', id, first.id); const wc = h.views[0].webContents;
  const event = { sender: wc, senderFrame: wc.mainFrame }, pending = [];
  wc.loadURL = url => new Promise((resolve, reject) => pending.push({ url, resolve, reject }));
  const secondLoad = h.invoke('player:command', 'next'); await FlushPlayer();
  const thirdLoad = h.invoke('player:command', 'next'); await FlushPlayer();
  assert.equal(pending.length, 2); assert.equal(h.views.length, 1); assert.equal(wc.muted, true);
  let after = await h.invoke('app:state'); assert.equal(after.current.entryId, third.id); assert.equal(after.playback, null);
  await h.invoke('player:volume', .6); assert.equal(wc.muted, true);
  h.ipcMain.emit('media:state', event, { url: third.url, position: 99, duration: 99, paused: true, ended: true });
  assert.equal((await h.invoke('app:state')).playback, null);
  const notices = h.messages.filter(message => message.value?.type === 'notice').length;
  wc.mainFrame.url = pending[0].url; wc.emit('dom-ready'); wc.emit('did-finish-load');
  assert.equal(wc.muted, true);
  wc.emit('did-fail-load', {}, -105, 'old network failure', pending[0].url, true);
  pending[0].reject(Object.assign(new Error('old failure'), { code: 'ERR_NAME_NOT_RESOLVED' }));
  await secondLoad;
  assert.equal(h.messages.filter(message => message.value?.type === 'notice').length, notices);
  wc.mainFrame.url = pending[1].url; wc.emit('dom-ready'); wc.emit('did-finish-load'); pending[1].resolve(); await thirdLoad;
  assert.equal(wc.muted, false);
  h.ipcMain.emit('media:state', event, { url: second.url, position: 99, duration: 99, paused: true, ended: true });
  h.ipcMain.emit('media:state', event, { url: third.url, position: 1, duration: 100, paused: false });
  after = await h.invoke('app:state'); assert.equal(after.current.entryId, third.id); assert.equal(after.playback.position, 1); assert.equal(after.playback.paused, false);
});

test('source changes rebuild isolated players and a failed preconnection does not prevent playback', async t => {
  const h = await MainHarness(t, { failPreconnect: true }); const id = (await h.invoke('app:state')).state.activePlaylistId;
  const state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123' }); const remote = state.playlists[0].entries[0];
  const file = path.join(h.root, 'music.mp3'); fs.writeFileSync(file, 'audio'); h.chooseFiles([file]);
  const files = await h.invoke('library:prepare-files', [id]); const imported = await h.invoke('library:commit-add', files.id, []);
  const local = imported.state.playlists.find(list => list.id === id).entries.find(entry => entry.type === 'local');
  await h.invoke('player:play', id, remote.id); const first = h.views[0];
  await h.invoke('player:play', id, local.id); const second = h.views[1];
  await FlushPlayer(); assert.equal(first.webContents.closed, true); assert.equal(second.options.webPreferences.partition, undefined);
  assert.ok(second.webContents.getURL().startsWith('favecus://app/local.html?media='));
  await h.invoke('player:play', id, remote.id);
  await FlushPlayer(); assert.equal(second.webContents.closed, true); assert.equal(h.views[2].options.webPreferences.partition, 'persist:favecus-bilibili');
  assert.equal((await h.invoke('app:state')).current.entryId, remote.id);
});

test('track changes resynchronize foreground before the current event without a second player click', async t => {
  const h = await MainHarness(t); const id = (await h.invoke('app:state')).state.activePlaylistId;
  await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123\nav456' }); await h.invoke('player:play', id);
  h.main.emit('blur'); const start = h.messages.length;
  await h.invoke('player:command', 'next');
  const events = h.messages.slice(start).filter(m => m.type === 'app:event').map(m => m.value), current = events.findIndex(e => e.type === 'current');
  assert.ok(current > 0); assert.equal(events.slice(0, current).filter(e => e.type === 'foreground').at(-1).value, true);
  h.main.focused = false; h.main.emit('blur'); const background = h.messages.length; await h.invoke('player:command', 'previous');
  assert.ok(h.messages.slice(background).filter(m => m.value?.type === 'foreground').every(m => m.value.value === false));
  h.main.focused = true; h.main.webContents.emit('focus'); assert.equal(h.messages.filter(m => m.type === 'app:event' && m.value.type === 'foreground').at(-1).value.value, true);
  h.main.emit('blur'); h.views[0].webContents.emit('focus'); assert.equal(h.messages.filter(m => m.type === 'app:event' && m.value.type === 'foreground').at(-1).value.value, true);
  h.main.minimized = true; h.views[0].webContents.emit('focus'); assert.equal(h.messages.filter(m => m.type === 'app:event' && m.value.type === 'foreground').at(-1).value.value, false);
});
test('060 shortcuts clamp volume and send seek/track commands only while the trusted main window is foreground and not modal',async t=>{
 const h=await MainHarness(t);let s=(await h.invoke('app:state')).state,id=s.activePlaylistId;s=await h.invoke('library:action',{type:'add',playlistId:id,urls:'av123\nav456'});await h.invoke('player:play',id,s.playlists[0].entries[0].id);const wc=h.views.at(-1).webContents;
 h.ipcMain.emit('media:state',{sender:wc,senderFrame:wc.mainFrame},{url:s.playlists[0].entries[0].url,position:20,duration:200,paused:false});
 await h.invoke('player:volume',.5);await h.invoke('player:shortcut',{code:'ArrowUp'});assert.equal((await h.invoke('app:state')).state.settings.volume,.52);await h.invoke('player:shortcut',{code:'ArrowDown'});assert.equal((await h.invoke('app:state')).state.settings.volume,.5);
 await h.invoke('player:shortcut',{code:'ArrowRight'});assert.ok(wc.sent.some(e=>e.type==='media:command'&&e.value.type==='seek-relative'&&e.value.value===10));
 h.main.focused=false;assert.equal(await h.invoke('player:shortcut',{code:'ArrowDown'}),false);h.main.focused=true;h.main.minimized=true;assert.equal(await h.invoke('player:shortcut',{code:'Space'}),false);h.main.minimized=false;
 h.ipcMain.emit('view:bounds',h.event,{x:0,y:0,width:200,height:200,visible:true,modalOpen:true});assert.equal(await h.invoke('player:shortcut',{code:'Space'}),false);h.ipcMain.emit('view:bounds',h.event,{x:0,y:0,width:200,height:200,visible:true,modalOpen:false});
 assert.equal((await h.invokeFrom(wc,'player:shortcut',{code:'ArrowUp'})).ok,false);assert.equal(await h.invoke('player:shortcut',{code:'Space',repeat:true}),false);
 await h.invoke('player:shortcut',{code:'ArrowRight',shiftKey:true});assert.equal((await h.invoke('app:state')).current.entryId,s.playlists[0].entries[1].id);
});
test('060 playback stall after readiness resumes at the same position in the internal official player and remembers a working multipart source',async t=>{
 const h=await MainHarness(t,{testRecovery:true});let s=(await h.invoke('app:state')).state,id=s.activePlaylistId;s=await h.invoke('library:action',{type:'add',playlistId:id,urls:'av123\nhttps://www.bilibili.com/video/av123/?p=2'});const [a,b]=s.playlists[0].entries;await h.invoke('player:play',id,a.id);const old=h.views.at(-1).webContents;
 h.ipcMain.emit('media:state',{sender:old,senderFrame:old.mainFrame},{url:a.url,position:72,duration:200,paused:false});h.ipcMain.emit('media:health',{sender:old,senderFrame:old.mainFrame},{url:a.url,ready:true,position:72,paused:false,errorCode:0});h.advance(15000);await FlushPlayer();
 const view=h.views.at(-1),current=(await h.invoke('app:state')).current;assert.equal(current.officialPlayer,true);assert.equal(current.entryId,a.id);assert.ok(view.webContents.sent.some(e=>e.type==='media:command'&&e.value.type==='restore'&&e.value.position===72&&!e.value.paused));
 h.ipcMain.emit('media:state',{sender:view.webContents,senderFrame:view.webContents.mainFrame},{url:a.url,position:75,duration:200,paused:false});await h.invoke('player:command','next');assert.equal((await h.invoke('app:state')).current.entryId,b.id);assert.equal((await h.invoke('app:state')).current.officialPlayer,true);assert.equal(new URL(h.views.at(-1).webContents.getURL()).searchParams.get('p'),'2');assert.equal(h.windows.length,1);
});
test('060 saved video plays through the app protocol and explicit online playback retains the original queue and URL',async t=>{
 const h=await MainHarness(t);let s=(await h.invoke('app:state')).state,id=s.activePlaylistId;s=await h.invoke('library:action',{type:'add',playlistId:id,urls:'av123\nav456'});const e=s.playlists[0].entries[0],directory=path.join(h.root,'downloads');fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'saved.mp4'),'media');const token=require('../src/core/offline-library.cjs').Key(e.url,'video')+'.mp4';fs.writeFileSync(path.join(directory,'index.json'),JSON.stringify({version:1,files:[{token,kind:'video',url:e.url,file:'saved.mp4',bytes:5,height:720}]}));h.chooseFiles([directory]);await h.invoke('downloads:directory');
 await h.invoke('player:play',id,e.id);let a=await h.invoke('app:state');assert.equal(a.current.offline.kind,'video');assert.equal(new URL(h.views.at(-1).webContents.getURL()).protocol,'favecus:');const next=a.queue.next.id;
 await h.invoke('player:command','online');a=await h.invoke('app:state');assert.equal(a.current.offline,null);assert.equal(a.current.entry.url,e.url);assert.equal(a.queue.next.id,next);assert.equal(new URL(h.views.at(-1).webContents.getURL()).hostname,'player.bilibili.com');
});
test('060 official-page av-to-BV redirect preserves the selected song but rejects other parts and videos',async t=>{
 const h=await MainHarness(t,{details:{aid:123,bvid:'BV1oo4y1t7GX',title:'曲',pages:[{page:1,cid:1}]}});let s=(await h.invoke('app:state')).state,id=s.activePlaylistId;s=await h.invoke('library:action',{type:'add',playlistId:id,urls:'av123'});await h.invoke('player:play',id,s.playlists[0].entries[0].id);await FlushPlayer();await h.invoke('player:command','page-mode');const wc=h.views.at(-1).webContents;
 const send=url=>h.ipcMain.emit('media:state',{sender:wc,senderFrame:wc.mainFrame},{url,position:10,duration:200,paused:false});send('https://www.bilibili.com/video/BV1oo4y1t7GX/');assert.equal((await h.invoke('app:state')).playback.position,10);send('https://www.bilibili.com/video/BV1oo4y1t7GX/?p=2');assert.equal((await h.invoke('app:state')).current.entry.videoId,'av123');
 for(const eventName of ['will-navigate','will-redirect'])for(const [url,allowed] of [['https://www.bilibili.com/video/BV1oo4y1t7GX/',true],['https://passport.bilibili.com/login',true],['https://player.bilibili.com/player.html',true],['https://www.bilibili.com/video/av456/',false],['https://www.bilibili.com/video/BV1oo4y1t7GX/?p=2',false],['https://example.org/',false]]){
   let prevented=false;const requested=h.views.at(-1).requestedURL;wc.emit(eventName,{preventDefault(){prevented=true;}},url,false,true);assert.equal(prevented,!allowed,url);if(eventName==='will-redirect')assert.equal(h.views.at(-1).requestedURL,allowed?url:requested);
 }
});
test('060 rapid skips bound metadata prefetch to two outstanding requests without delaying navigation',async t=>{
 let calls=0;const pending=[];const h=await MainHarness(t,{fetch:async url=>new URL(url).pathname.endsWith('/nav')?new Response(JSON.stringify({code:0,data:{isLogin:false}})):new Promise(resolve=>{calls++;pending.push(()=>resolve(new Response(JSON.stringify({code:0,data:{pages:[{page:1,cid:1}]}}))))})});let s=(await h.invoke('app:state')).state,id=s.activePlaylistId;s=await h.invoke('library:action',{type:'add',playlistId:id,urls:Array.from({length:12},(_,i)=>'av'+(600+i)).join('\n')});
 await h.invoke('player:play',id);for(let i=0;i<10;i++)await h.invoke('player:command','next');assert.equal(calls,2);assert.equal((await h.invoke('app:state')).current.entryId,s.playlists[0].entries[10].id);pending.forEach(f=>f());await FlushPlayer();
});

test('recovery tolerates synchronous focus and late IPC from a destroyed view, releases failed renderers and allows reload', async t => {
  const h = await MainHarness(t, { testRecovery: true, onClose(wc, { windows, ipcMain }) {
    windows[0].emit('focus'); wc.emit('focus');
    const stale = { sender: wc, get senderFrame() { throw new Error('Render frame was disposed before WebFrameMain could be accessed'); } };
    for (const channel of ['media:state', 'media:health', 'media:shortcut', 'media:error']) ipcMain.emit(channel, stale, {});
  } });
  let state = (await h.invoke('app:state')).state;
  state = await h.invoke('library:action', { type: 'add', playlistId: state.activePlaylistId, urls: 'av123\nav456' });
  const id = state.activePlaylistId, entry = state.playlists[0].entries[0]; await h.invoke('player:play', id, entry.id);
  h.advance(12000); await FlushPlayer(); assert.equal(h.views.length, 2);
  h.advance(12000); await FlushPlayer(); assert.equal(h.views.length, 3);
  h.advance(12000); await FlushPlayer(); await FlushPlayer(); assert.ok(h.views.at(-1).webContents.closed);
  assert.equal((await h.invoke('app:state')).current.entryId, entry.id);
  h.advance(60000); await FlushPlayer(); assert.equal(h.views.length, 3);
  await h.invoke('player:command', 'toggle'); assert.equal(h.views.length, 4); assert.equal(h.views.at(-1).webContents.closed, undefined);
  await h.invoke('player:command', 'reload'); assert.equal(h.views.length, 5); assert.equal((await h.invoke('app:state')).current.entryId, entry.id);
  await h.invoke('player:command', 'next'); assert.equal((await h.invoke('app:state')).current.entry.videoId, 'av456');
  const log = fs.readFileSync(path.join(h.root, 'data', 'player-diagnostics.jsonl'), 'utf8'); assert.match(log, /recovery/); assert.doesNotMatch(log, /Cookie|SESSDATA/);
});

test('061 saved audio, video and artwork are used by normal and all-playlist playback without Bilibili requests', async t => {
  let requests = 0; const h = await MainHarness(t, { fetch: async () => { requests++; throw new Error('offline'); } });
  let s = (await h.invoke('app:state')).state, id = s.activePlaylistId;
  s = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123' }); const entry = s.playlists[0].entries[0];
  const directory = path.join(h.root, 'downloads'); fs.mkdirSync(directory);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'); fs.writeFileSync(path.join(directory, 'cover.png'), png);
  const records = ['video', 'audio'].map(kind => {
    const ext = kind === 'video' ? 'mp4' : 'm4a', file = `saved.${ext}`; fs.writeFileSync(path.join(directory, file), '0123456789');
    return { token: require('../src/core/offline-library.cjs').Key(entry.url, kind) + '.' + ext, kind, url: entry.url, file, bytes: 10, duration: 20, thumbnail: { file: 'cover.png', bytes: png.length } };
  });
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify({ version: 1, files: records })); h.chooseFiles([directory]); await h.invoke('downloads:directory');
  await h.invoke('player:play', id, entry.id); assert.equal((await h.invoke('app:state')).current.offline.kind, 'video');
  await h.invoke('library:action', { type: 'settings', settings: { thumbnailMode: true } });
  await h.invoke('player:all', false); const snapshot = await h.invoke('app:state'); assert.equal(snapshot.current.offline.kind, 'audio'); assert.equal(snapshot.thumbnail.image, 'data:image/png;base64,' + png.toString('base64'));
  assert.equal(await h.invoke('library:thumbnail', id, entry.id, '*'), snapshot.thumbnail.image); assert.equal(requests, 0);
  const serve = h.protocols.get('favecus'), token = snapshot.current.offline.token;
  const playbackId = new URL(h.views.at(-1).webContents.getURL()).searchParams.get('playback');
  const response = await serve(new Request(`favecus://offline/${token}?playback=${playbackId}`, { headers: { Range: 'bytes=2-5' } })); assert.equal(response.status, 206); assert.equal(await response.text(), '2345');
  const wrong = await serve(new Request(`favecus://offline/${records[0].token}`)); assert.equal(wrong.status, 403);
});

test('062 local track changes reuse the player and retirement closes outside the originating IPC callback', async t => {
  let inCallback = false, closed = 0; const h = await MainHarness(t, { onClose() { assert.equal(inCallback, false); closed++; } }); const id = (await h.invoke('app:state')).state.activePlaylistId;
  const files = ['first.mp3', 'second.mp3'].map(name => { const file = path.join(h.root, name); fs.writeFileSync(file, name); return file; }); h.chooseFiles(files);
  const prepared = await h.invoke('library:prepare-files', [id]), imported = await h.invoke('library:commit-add', prepared.id, []), entries = imported.state.playlists.find(p => p.id === id).entries;
  await h.invoke('player:play', id, entries[0].id); const original = h.views[0]; await h.invoke('player:command', 'next'); assert.equal(h.views.length, 1); assert.equal(original.webContents.loads, 2);
  inCallback = true; original.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -1073741819 }); assert.equal(closed, 0); assert.equal(original.webContents.closed, undefined); inCallback = false;
  await FlushPlayer(); assert.equal(closed, 1); assert.equal((await h.invoke('app:state')).current, null);
  const lines = fs.readFileSync(path.join(h.root, 'data/player-diagnostics.jsonl'), 'utf8').trim().split('\n').map(JSON.parse), crash = lines.find(v => v.reason === 'renderer-exited'); assert.equal(crash.eventCode, 'FP-PLAYER-RENDERER-EXITED'); assert.equal(crash.exitReason, 'crashed'); assert.equal(crash.exitCode, -1073741819); assert.ok(lines.some(v => v.reason === 'track-change' && v.source === 'local'));
  assert.ok(h.messages.some(m => m.value?.type === 'notice' && /FP-PLAYER-RENDERER-EXITED/.test(m.value.value)));
});

function CloseWindow(main) { const event = { prevented: false, preventDefault() { this.prevented = true; } }; main.emit('close', event); return event; }
test('067 the close button hides the window to the tray, keeps playback state and restores through a second launch', async t => {
  const h = await MainHarness(t, { tray: true }), main = h.main;
  const first = CloseWindow(main); assert.equal(first.prevented, true); assert.equal(main.visible, false); assert.ok(!main.closed, 'ウィンドウは破棄しない');
  assert.equal(CloseWindow(main).prevented, true, '繰り返しても同じ');
  h.app.emit('second-instance'); assert.equal(main.visible, true);
});
test('067 closing is allowed while quitting from the tray', async t => {
  const h = await MainHarness(t, { tray: true }); h.app.emit('before-quit'); assert.equal(CloseWindow(h.main).prevented, false);
});
test('067 Windows shutdown, logoff and installer close requests are never blocked by the tray hiding', async t => {
  for (const name of ['query-session-end', 'session-end']) {
    const h = await MainHarness(t, { tray: true }); h.main.emit(name, { reasons: ['close-app'], preventDefault() { assert.fail('終了要求を遅らせない'); } });
    assert.equal(CloseWindow(h.main).prevented, false, name);
  }
});
test('067 the window closes normally when no tray icon could be created, so it can never become unreachable', async t => {
  const h = await MainHarness(t); assert.equal(CloseWindow(h.main).prevented, false); assert.notEqual(h.main.visible, false);
});
async function PlayingView(t, options = {}) {
  const h = await MainHarness(t, options), id = h.store.data.activePlaylistId;
  const state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123\nav456' }), entry = state.playlists[0].entries[0];
  await h.invoke('player:play', id, entry.id); const view = h.views.at(-1);
  h.ipcMain.emit('view:bounds', h.event, { x: 100, y: 100, width: 500, height: 300, visible: true });
  return { h, id, entry, view, slot: { x: 100, y: 100, width: 500, height: 300 } };
}
const EscapeKey = () => ({ stopped: false, preventDefault() { this.stopped = true; } });
test('067 the transport button enlarges the video to the whole window, and Esc (in the video or the main window) restores the slot', async t => {
  const { h, view, slot } = await PlayingView(t);
  assert.equal(await h.invoke('player:fullscreen'), true); assert.equal(h.main.fullscreen, true); assert.deepEqual({ ...view.bounds }, { x: 0, y: 0, width: 1440, height: 900 }); assert.equal(view.visible, true);
  const inView = EscapeKey(); view.webContents.emit('before-input-event', inView, { type: 'keyDown', key: 'Escape' });
  assert.equal(inView.stopped, true); assert.equal(h.main.fullscreen, false); assert.deepEqual({ ...view.bounds }, slot);
  assert.equal(await h.invoke('player:fullscreen'), true); const inMain = EscapeKey(); h.main.webContents.emit('before-input-event', inMain, { type: 'keyDown', key: 'Escape' });
  assert.equal(inMain.stopped, true); assert.equal(h.main.fullscreen, false); assert.deepEqual({ ...view.bounds }, slot);
  const other = EscapeKey(); view.webContents.emit('before-input-event', other, { type: 'keyDown', key: 'Escape' }); assert.equal(other.stopped, false, '拡大中でなければEscを奪わない');
  assert.equal(await h.invoke('player:fullscreen'), true); assert.equal(await h.invoke('player:fullscreen'), false, 'もう一度押すと戻る'); assert.equal(h.main.fullscreen, false);
});
test('067 enlarging is refused while the video is not visible, and a stale enlarged state never survives a modal, thumbnail mode, stop or hiding', async t => {
  const h = await MainHarness(t), id = h.store.data.activePlaylistId;
  const state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123' }), entry = state.playlists[0].entries[0];
  assert.equal(await h.invoke('player:fullscreen'), false); assert.ok(!h.main.fullscreen, '再生がないときは入らない');
  await h.invoke('player:play', id, entry.id); const view = h.views.at(-1);
  assert.equal(await h.invoke('player:fullscreen'), false, '動画が表示されていない（画面側の枠がない）ときは入らない'); assert.ok(!h.main.fullscreen);
  const bounds = value => h.ipcMain.emit('view:bounds', h.event, { x: 100, y: 100, width: 500, height: 300, visible: true, ...value });
  bounds({}); assert.equal(await h.invoke('player:fullscreen'), true);
  bounds({ modalOpen: true, visible: false }); assert.equal(h.main.fullscreen, false, 'モーダルを開く（画面側が動画を表示しない）と解除'); assert.equal(view.visible, false);
  bounds({}); assert.equal(await h.invoke('player:fullscreen'), true);
  h.ipcMain.emit('view:bounds', h.event, { x: 100, y: 100, width: 500, height: 300, visible: true, modalOpen: true }); assert.equal(h.main.fullscreen, false, 'モーダルが開いているという報告だけでも解除');
  bounds({}); assert.equal(await h.invoke('player:fullscreen'), true);
  await h.invoke('library:action', { type: 'settings', settings: { thumbnailMode: true } }); assert.equal(h.main.fullscreen, false, '曲モードで解除'); await h.invoke('library:action', { type: 'settings', settings: { thumbnailMode: false } });
  assert.equal(await h.invoke('player:fullscreen'), true); h.main.emit('hide'); assert.equal(h.main.fullscreen, false, 'ウィンドウを隠すと解除');
  assert.equal(await h.invoke('player:fullscreen'), true); h.main.fullscreen = false; h.main.emit('leave-full-screen'); assert.deepEqual({ ...view.bounds }, { x: 100, y: 100, width: 500, height: 300 }, 'OS側で全画面が解除されたら枠へ戻る');
  assert.equal(await h.invoke('player:fullscreen'), true); await h.invoke('player:command', 'stop'); assert.equal(h.main.fullscreen, false, '停止で解除');
});
test('067 the same enlarged state follows the next track and ends when the player view is stopped', async t => {
  const { h, view } = await PlayingView(t);
  assert.equal(await h.invoke('player:fullscreen'), true);
  await h.invoke('player:command', 'next'); assert.equal(h.views.at(-1), view, '同じ再生画面のまま'); assert.equal(h.main.fullscreen, true); assert.deepEqual({ ...view.bounds }, { x: 0, y: 0, width: 1440, height: 900 });
  await h.invoke('player:command', 'stop'); assert.equal(h.main.fullscreen, false);
});
test('067 Bilibili own fullscreen button enters and leaves the same state; a hidden video leaves HTML fullscreen', async t => {
  const { h, view, slot } = await PlayingView(t);
  view.webContents.emit('enter-html-full-screen'); assert.deepEqual({ ...view.bounds }, { x: 0, y: 0, width: 1440, height: 900 }); assert.ok(!h.main.fullscreen, '窓の全画面はElectronのHTML全画面が行う（アプリは重ねて切り替えない）');
  view.webContents.emit('leave-html-full-screen'); assert.deepEqual({ ...view.bounds }, slot);
  assert.ok(!(view.webContents.scripts || []).some(code => /exitFullscreen/.test(code)), 'ページ側から先に解除された場合は重ねて解除しない');
  view.webContents.emit('enter-html-full-screen'); const esc = EscapeKey(); view.webContents.emit('before-input-event', esc, { type: 'keyDown', key: 'Escape' });
  assert.equal(esc.stopped, true); assert.deepEqual({ ...view.bounds }, slot); assert.ok(view.webContents.scripts.some(code => /exitFullscreen/.test(code)), 'Escを横取りするため、ページのHTML全画面も解除する');
  view.webContents.scripts.length = 0; view.webContents.emit('enter-html-full-screen'); h.main.emit('hide'); assert.ok(view.webContents.scripts.some(code => /exitFullscreen/.test(code)), '隠したときもHTML全画面を解除する');
  h.ipcMain.emit('view:bounds', h.event, { x: 100, y: 100, width: 500, height: 300, visible: false });
  view.webContents.emit('enter-html-full-screen'); assert.ok(view.webContents.scripts.some(code => /exitFullscreen/.test(code)), '見えていない動画ではHTML全画面を解除する'); assert.equal(view.visible, false);
});
test('067 only the local player page may request enlarging or a quality change, and only for the current saved video', async t => {
  const { h, view } = await PlayingView(t);
  const events = () => h.messages.filter(m => m.type === 'app:event' && m.value.type === 'change-quality'), send = (channel, sender = view.webContents) => h.ipcMain.emit(channel, { sender, senderFrame: sender.mainFrame });
  view.navigationReady = true;
  send('media:fullscreen'); assert.ok(!h.main.fullscreen, '公式プレイヤー（player.bilibili.com）の画面からは受け付けない'); send('media:quality'); assert.equal(events().length, 0);
  view.webContents.frame.url = 'favecus://app/local.html?media=00000000-0000-4000-8000-000000000001.mp3';
  send('media:fullscreen', h.main.webContents); assert.ok(!h.main.fullscreen, '再生画面以外の送信元は受け付けない');
  send('media:fullscreen'); assert.equal(h.main.fullscreen, true, 'ローカル再生画面からは受け付ける'); send('media:fullscreen'); assert.equal(h.main.fullscreen, false);
  send('media:fullscreen'); h.main.emit('leave-full-screen'); assert.equal(h.main.fullscreen, true, '遅れて届いた古い全画面解除の通知では、再度入った拡大を解除しない'); h.main.fullscreen = false; h.main.emit('leave-full-screen'); assert.equal(h.main.fullscreen, false);
  send('media:quality'); assert.equal(events().length, 0, '保存済みの動画でないとき（オンライン再生・ローカルファイル）は画質の要求を受け付けない');
});
test('067 a saved video passes its saved height to the local page; the quality request carries no page arguments and leaves enlargement first', async t => {
  const h = await MainHarness(t), id = h.store.data.activePlaylistId;
  const state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123' }), entry = state.playlists[0].entries[0]; SavedTrack(h, entry, 'media', 1080);
  await h.invoke('player:play', id, entry.id); const view = h.views.at(-1); assert.match(view.webContents.getURL(), /favecus:\/\/app\/local\.html\?offline=[a-f0-9]{64}\.mp4&playback=[a-f0-9-]{36}&kind=video&height=1080$/);
  h.ipcMain.emit('view:bounds', h.event, { x: 100, y: 100, width: 500, height: 300, visible: true }); view.navigationReady = true;
  const events = () => h.messages.filter(m => m.type === 'app:event' && m.value.type === 'change-quality');
  assert.equal(await h.invoke('player:fullscreen'), true);
  h.ipcMain.emit('media:quality', { sender: view.webContents, senderFrame: view.webContents.mainFrame }, { playlistId: 'attacker', entryId: 'x' });
  assert.equal(events().length, 1); assert.deepEqual({ ...events()[0].value.value }, { playlistId: id, entryId: entry.id }, 'ページの引数ではなくmainの現在の曲を使う');
  assert.equal(h.main.fullscreen, false, '保存画面を開く前に拡大を解除する');
});
test('063 contents released during close never get dereferenced again and views are detached once', async t => {
  let closes = 0, detaches = 0;
  const h = await MainHarness(t, { releaseContents: true, onNative(action) { if (action === 'close') closes++; if (action === 'detach') detaches++; } });
  const id = (await h.invoke('app:state')).state.activePlaylistId;
  await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123\nav456' });
  await h.invoke('player:play', id); const original = h.views[0], oldContents = original.webContents;
  await h.invoke('player:command', 'reload'); await FlushPlayer();
  assert.equal(original.webContents, undefined); assert.equal(oldContents.closed, true);
  assert.equal(closes, 1); assert.equal(detaches, 1); assert.equal(h.main.children.length, 1);
  await h.invoke('player:command', 'next'); assert.equal((await h.invoke('app:state')).current.entry.videoId, 'av456');
  h.app.emit('before-quit'); await FlushPlayer();
  assert.equal(closes, 2); assert.equal(detaches, 2); assert.equal(h.main.children.length, 0);
});

test('063 ended notifications do not navigate in the native callback and duplicate events advance once', async t => {
  let inCallback = false;
  const h = await MainHarness(t, { onNative(action) { assert.equal(inCallback, false, action); } });
  const id = (await h.invoke('app:state')).state.activePlaylistId;
  const state = await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123\nav456\nav789' });
  await h.invoke('player:play', id); const wc = h.views[0].webContents;
  const event = { sender: wc, senderFrame: wc.mainFrame }, ended = { url: state.playlists[0].entries[0].url, position: 100, duration: 100, paused: true, ended: true };
  inCallback = true;
  h.ipcMain.emit('media:state', event, ended); h.ipcMain.emit('media:state', event, ended);
  assert.equal(wc.loads, 1); inCallback = false;
  await FlushPlayer();
  assert.equal(wc.loads, 2); assert.equal((await h.invoke('app:state')).current.entry.videoId, 'av456');
  inCallback = true; wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 }); inCallback = false;
  await FlushPlayer(); await FlushPlayer();
  assert.equal(h.main.children.length, 1);
});

test('063 rapid requests coalesce and stop cancels pending navigation', async t => {
  const h = await MainHarness(t); const id = (await h.invoke('app:state')).state.activePlaylistId;
  await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123\nav456\nav789' });
  await h.invoke('player:play', id); const wc = h.views[0].webContents;
  const second = h.invoke('player:command', 'next'), third = h.invoke('player:command', 'next');
  assert.equal(wc.loads, 1); await Promise.all([second, third]);
  assert.equal(wc.loads, 2); assert.equal((await h.invoke('app:state')).current.entry.videoId, 'av789');
  const pending = h.invoke('player:command', 'previous'); await h.invoke('player:command', 'stop'); await pending; await FlushPlayer();
  assert.equal((await h.invoke('app:state')).current, null); assert.equal(wc.loads, 2); assert.equal(h.main.children.length, 0);
});

test('cancelled parallel play preserves the newest queue and all-play restores shuffle after failure', async t => {
  const h = await MainHarness(t), id = h.store.data.activePlaylistId;
  await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123\nav456' });
  const [first, second] = h.store.Playlist(id).entries;
  const a = h.invoke('player:play', id, first.id), b = h.invoke('player:play', id, second.id);
  assert.equal((await a).cancelled, true); await b;
  assert.equal((await h.invoke('app:state')).current.entryId, second.id);
  assert.equal((await h.invoke('app:state')).queue.timeline.current.id, second.id);
  await h.invoke('library:action', { type: 'settings', settings: { shuffle: true } });
  await h.invoke('library:action', { type: 'remove-many', playlistId: id, entryIds: [first.id, second.id] });
  await assert.rejects(h.invoke('player:all', false), /再生する曲がありません/);
  assert.equal(h.store.data.settings.shuffle, true);
});

test('closing the main window during a pending play creates no view and local redirects are refused', async t => {
  const h = await MainHarness(t), id = h.store.data.activePlaylistId;
  const local = path.join(h.root, 'safe.mp3'); fs.writeFileSync(local, 'audio'); await h.store.AddFiles([id], [local]);
  await h.invoke('player:play', id); const wc = h.views[0].webContents, requested = h.views[0].requestedURL;
  let prevented = false; wc.emit('will-redirect', { preventDefault() { prevented = true; } }, 'https://www.bilibili.com/video/av123/', false, true);
  assert.equal(prevented, true); assert.equal(h.views[0].requestedURL, requested);
  const pending = h.invoke('player:play', id);
  h.main.closed = true;
  assert.equal((await pending).cancelled, true);
  assert.equal(h.views.length, 1);
});

test('063 unexpectedly destroyed contents can be recovered without reading the missing view property', async t => {
  const h = await MainHarness(t, { releaseContents: true, testRecovery: true }); const id = (await h.invoke('app:state')).state.activePlaylistId;
  await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123' }); await h.invoke('player:play', id);
  const original = h.views[0]; original.webContents.close();
  assert.equal(original.webContents, undefined); await FlushPlayer(); await FlushPlayer();
  assert.equal(h.views.length, 2); assert.equal(h.main.children.length, 1);
  assert.equal((await h.invoke('app:state')).current.officialPlayer, true);
});

test('063 crash diagnostics start before any window with local-only reports and runtime metadata', async t => {
  const h = await MainHarness(t);
  assert.equal(h.crashStarts.length, 1); assert.equal(h.crashStarts[0].uploadToServer, false); assert.equal(h.crashStarts[0].submitURL, undefined);
  assert.equal(h.paths.get('crashDumps'), path.join(h.root, 'data/crashes'));
  assert.equal(h.switches.get('enable-logging'), 'file');
  const record = JSON.parse(fs.readFileSync(path.join(h.root, 'data/player-diagnostics.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(record.started, true); assert.equal(record.error, null); assert.equal(record.reason, 'diagnostics-start'); assert.ok(record.memory.rss > 0);
});

for (const source of ['bilibili', 'local']) test(`064 ${source} navigation defers frame IPC while focus, bounds, volume and toggle change`, async t => {
  const unsafe = [];
  const h = await MainHarness(t, { delayPlayerLoad: true, onFrameAccess(wc) { if (wc.loading) unsafe.push(wc.loads); } });
  const id = (await h.invoke('app:state')).state.activePlaylistId;
  if (source === 'bilibili') await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123\nav456' });
  else {
    const files = ['first.mp3', 'second.mp3'].map(name => { const file = path.join(h.root, name); fs.writeFileSync(file, 'audio'); return file; });
    h.chooseFiles(files); const plan = await h.invoke('library:prepare-files', [id]); await h.invoke('library:commit-add', plan.id, []);
  }
  const first = h.invoke('player:play', id); await FlushPlayer();
  const view = h.views[0], wc = view.webContents;
  const exercise = async volume => {
    h.main.emit('focus'); h.main.emit('restore');
    h.ipcMain.emit('view:bounds', h.event, { x: 20, y: 20, width: 500, height: 300, visible: true, modalOpen: true });
    await h.invoke('library:action', { type: 'settings', settings: { volume } });
    await h.invoke('player:command', 'toggle');
    assert.equal(wc.muted, true); assert.deepEqual(unsafe, []);
  };
  await exercise(.24); wc.finishLoad(); await first;
  assert.equal(wc.muted, false);
  assert.equal(wc.sent.filter(m => m.type === 'media:command' && m.value.type === 'volume').at(-1).value.value, .24);
  assert.equal(wc.sent.filter(m => m.type === 'media:shortcuts').at(-1).value.enabled, false);
  assert.equal(wc.sent.filter(m => m.value?.type === 'toggle').length, 1);
  const oldEvent = { sender: wc, senderFrame: wc.mainFrame }, before = wc.sent.length;
  const next = h.invoke('player:command', 'next'); await FlushPlayer();
  h.ipcMain.emit('media:state', oldEvent, { url: wc.getURL(), duration: 100, position: 100, ended: true, paused: true });
  await exercise(.62); assert.equal(wc.sent.length, before);
  wc.finishLoad(); await next;
  assert.deepEqual(unsafe, []); assert.equal(h.views.length, 1); assert.equal(wc.loads, 2);
  assert.equal(wc.sent.filter(m => m.type === 'media:command' && m.value.type === 'volume').at(-1).value.value, .62);
  const pending = h.invoke('player:command', 'previous'); await FlushPlayer();
  await h.invoke('player:command', 'toggle'); await h.invoke('player:command', 'stop'); await FlushPlayer();
  wc.finishLoad(); await pending;
  assert.deepEqual(unsafe, []); assert.equal((await h.invoke('app:state')).current, null); assert.equal(h.main.children.length, 0);
  const log = fs.readFileSync(path.join(h.root, 'data/player-diagnostics.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.filter(r => r.reason === 'document-ready').length, 2);
  assert.equal(log.filter(r => r.reason === 'navigation-start').length, 3);
});

test('064 renderer-initiated main-frame navigation closes the media IPC gate until the accepted document returns', async t => {
  const unsafe = [];
  const h = await MainHarness(t, { onFrameAccess(wc) { if (wc.loading) unsafe.push(true); } });
  const id = (await h.invoke('app:state')).state.activePlaylistId;
  await h.invoke('library:action', { type: 'add', playlistId: id, urls: 'av123' }); await h.invoke('player:play', id);
  const wc = h.views[0].webContents, sent = wc.sent.length;
  wc.loading = true; wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  h.main.emit('focus'); await h.invoke('library:action', { type: 'settings', settings: { volume: .36 } });
  assert.equal(wc.sent.length, sent); assert.equal(wc.muted, true); assert.deepEqual(unsafe, []);
  wc.loading = false; wc.emit('dom-ready');
  assert.equal(wc.muted, false); assert.ok(wc.sent.length > sent);
});
