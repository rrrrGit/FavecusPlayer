'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Store } = require('../src/core/store.cjs');
const { ParseBilibili, SharedURL } = require('../src/core/urls.cjs');
const { BilibiliAccount, CollectionURL } = require('../src/core/bilibili.cjs');
const { ReadWholeList } = require('../src/ui/playlist-reader.js');
const { NormalizeMedia } = require('../src/core/playback.cjs');
const { MiniBounds, ExpandBounds } = require('../src/core/window-placement.cjs');
function Temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-030-')); t.after(() => fs.rmSync(root, { recursive:true, force:true })); return root; }
const SHARE = '【【樱之刻】游戏原声】 https://www.bilibili.com/video/BV1oo4y1t7GX/?p=3&share_source=copy_web&vd_source=private';
function Legacy(t) {
  const root = Temp(t), store = new Store(root), id = store.data.activePlaylistId;
  store.Apply({type:'add', playlistId:id, urls:'av123\nhttps://www.bilibili.com/video/BV1oo4y1t7GX/?p=3',title:''});
  store.Apply({type:'settings',settings:{volume:.37,repeat:'all',discordEnabled:true,discordClientId:'123456789012345678'}});
  const media = `${randomUUID()}.mp3`;fs.writeFileSync(path.join(store.media,media),'original media bytes');
  const old = store.Snapshot();old.version=1;old.bridgeToken='a'.repeat(64);old.settings.bridgeEnabled=true;
  delete old.identityVersion; delete old.videoAliases;
  for (const p of old.playlists) for (const entry of p.entries) delete entry.mediaId;
  old.playlists[0].entries.splice(1,0,{id:randomUUID(),type:'youtube',videoId:'abcdefghijk',url:'https://www.youtube.com/watch?v=abcdefghijk',title:'old song'});
  old.playlists[0].entries.push({id:randomUUID(),type:'local',fileName:media,title:'元の曲'});
  const bytes = JSON.stringify(old,null,2);fs.writeFileSync(store.file,bytes);
  return {root,id,store,old,bytes,media};
}
test('Bilibili sharing text preserves part, strips tracking, and uses its title', t => {
  const parsed = ParseBilibili(SHARE);assert.equal(parsed.part,3);assert.equal(parsed.url,'https://www.bilibili.com/video/BV1oo4y1t7GX/?p=3');
  const store = new Store(Temp(t)), id=store.data.activePlaylistId;
  // 共有文の抽出だけを確認する。0.4.4の自動消去は専用テストで検証する。
  store.Apply({ type: 'settings', settings: { titleCleanupWords: [] } });
  store.Apply({type:'add',playlistId:id,urls:SHARE});assert.equal(store.Playlist(id).entries[0].title,'【樱之刻】游戏原声');
  for(const bad of ['https://evil.test/video/BV1oo4y1t7GX',`${SHARE} https://evil.test/`,'https://evil@www.bilibili.com/video/BV1oo4y1t7GX','https://www.bilibili.com/video/BV1oo4y1t7GX/?p=0'])assert.throws(()=>ParseBilibili(bad));
  assert.throws(()=>SharedURL('x'.repeat(9000)));
});
test('upgrading 0.2.0 preserves playlist IDs/order/files/settings and an exact original backup', t => {
  const {root,id,store,old,bytes,media}=Legacy(t), upgraded=new Store(root);
  const backup=fs.readdirSync(root).filter(n=>n.startsWith('library.pre-0.5.0-'));
  assert.equal(backup.length,1);assert.equal(fs.readFileSync(path.join(root,backup[0]),'utf8'),bytes);
  assert.equal(upgraded.data.version,3);assert.equal(upgraded.data.activePlaylistId,id);
  assert.equal(upgraded.data.identityVersion,2);assert.ok(upgraded.Playlist(id).entries.every(e=>typeof e.mediaId==='string'));
  assert.deepEqual(upgraded.Playlist(id).entries.map(e=>e.id),old.playlists[0].entries.filter(e=>e.type!=='youtube').map(e=>e.id));
  assert.equal(upgraded.Playlist(id).entries[1].part,3);assert.equal(upgraded.data.settings.volume,.37);assert.equal(upgraded.data.settings.discordClientId,old.settings.discordClientId);
  assert.equal(fs.readFileSync(path.join(store.media,media),'utf8'),'original media bytes');assert.equal(upgraded.data.bridgeToken,undefined);assert.equal(upgraded.data.settings.bridgeEnabled,undefined);
  new Store(root);assert.equal(fs.readdirSync(root).filter(n=>n.startsWith('library.pre-0.5.0-')).length,1);
});
test('migration aborts if it cannot preserve the original backup, without overwriting data', t => {
  const {root,store,bytes}=Legacy(t), original=fs.copyFileSync;
  fs.copyFileSync=(source,target,...args)=>{if(String(target).includes('pre-0.5.0-'))throw new Error('disk full');return original(source,target,...args);};
  try {assert.throws(()=>new Store(root),/バックアップ/);}finally{fs.copyFileSync=original;}
  assert.equal(fs.readFileSync(store.file,'utf8'),bytes);
});
test('importing old exports excludes removed entries and keeps source media and JSON',async t=>{
  const {root,old,bytes}=Legacy(t), file=path.join(root,'favecus-player-library.json');fs.writeFileSync(file,bytes);
  const next=new Store(path.join(root,'next')),result=await next.Import(file);
  assert.equal(result.skipped,1);assert.equal(result.missing,0);assert.equal(fs.readFileSync(file,'utf8'),bytes);
  assert.equal(next.Playlist(next.data.activePlaylistId).entries.length,old.playlists[0].entries.length-1);
});
test('selected videos add atomically, keep part titles, and do not overwrite existing names',t=>{
  const root=Temp(t),s=new Store(root),id=s.data.activePlaylistId;
  s.Apply({type:'add',playlistId:id,urls:'av123',title:'自分の名前'});
  s.Apply({type:'add-videos',playlistId:id,videos:[{url:'av123',title:'外部の名前'},{url:SHARE,title:'パート3'},{url:SHARE,title:'重複'}]});
  assert.deepEqual(new Store(root).Playlist(id).entries.map(e=>e.title),['自分の名前','パート3']);
  assert.throws(()=>s.Apply({type:'add-videos',playlistId:id,videos:[{url:'av200',title:'valid'},{url:'https://evil.test',title:'invalid'}]}));
  assert.equal(s.Playlist(id).entries.length,2);
});
function API(route) { return new BilibiliAccount(async (raw, options)=>{const url=new URL(raw);assert.equal(url.origin,'https://api.bilibili.com');assert.equal(options.credentials,'include');const data=await route(url);return {ok:true,json:async()=>({code:0,data})};}); }
test('multipart URLs return every page in order with their individual names',async()=>{
  const calls=[],data={bvid:'BV1oo4y1t7GX',title:'音楽集',owner:{name:'投稿者'},pages:Array.from({length:65},(_,i)=>({page:i+1,part:`曲${i+1}`}))};
  const api=API(u=>{calls.push(u);return data;});const sources=await api.Lists(SHARE);
  assert.equal(sources.length,1);assert.equal(sources[0].kind,'parts');
  const all=await ReadWholeList(page=>api.ListVideos(sources[0],page));
  assert.equal(all.videos.length,65);assert.equal(all.videos[2].part,3);assert.equal(all.videos[64].title,'曲65');assert.equal(calls.length,1);
});
test('a video can offer both multipart and collection sources, with complete embedded episode order',async()=>{
  const api=API(()=>({bvid:'BV1oo4y1t7GX',title:'test',owner:{mid:99},pages:[{page:1},{page:2}],ugc_season:{id:5,mid:99,title:'合集',ep_count:3,sections:[{episodes:[{aid:33,title:'先頭'},{aid:11,title:'次'}]},{episodes:[{aid:22,title:'最後'}]}]}}));
  const sources=await api.Lists('BV1oo4y1t7GX');assert.deepEqual(sources.map(s=>s.kind),['parts','season']);
  const all=await ReadWholeList(page=>api.ListVideos(sources[1],page));assert.deepEqual(all.videos.map(v=>v.videoId),['av33','av11','av22']);
});
test('direct favorites, series and collection URLs are parsed with validated hosts',()=>{
  assert.deepEqual(CollectionURL('https://space.bilibili.com/123/favlist?fid=456'),{kind:'favorite',id:'456',title:'收藏夹'});
  assert.equal(CollectionURL('https://www.bilibili.com/list/ml456').id,'456');
  assert.equal(CollectionURL('https://space.bilibili.com/123/lists/789?type=season').id,'789');
  assert.equal(CollectionURL('https://space.bilibili.com/123/lists?sid=789&type=season').kind,'season');
  assert.equal(CollectionURL('https://www.bilibili.com/list/123?sid=789&business=space_series').kind,'series');
  assert.equal(CollectionURL('https://www.bilibili.com/medialist/play/123?business_id=789&business=space_series').mid,'123');
  assert.equal(CollectionURL('https://space.bilibili.com/123/channel/collectiondetail?sid=789').mid,'123');
  assert.equal(CollectionURL('https://evil.test/123/favlist?fid=456'),null);
});
test('direct collection import paginates the API and skips unavailable entries',async()=>{
  const calls=[],api=API(u=>{calls.push(u);const page=Number(u.searchParams.get('page_num'));return {meta:{name:'合集'},page:{total:31},archives:page===1?Array.from({length:30},(_,i)=>({aid:i+1,title:`動画${i}`})):[{title:'削除済み'}]};});
  const all=await ReadWholeList(page=>api.ListVideos({kind:'season',id:'7',mid:'8'},page));
  assert.equal(all.videos.length,30);assert.equal(all.skipped,1);assert.equal(calls.length,2);assert.equal(calls[1].searchParams.get('page_num'),'2');
  await assert.rejects(()=>api.ListVideos({kind:'series',id:'../secret',mid:'8'}));
});
test('unknown membership and login/API failures produce an error instead of a partial list',async()=>{
  await assert.rejects(()=>API(()=>({pages:[{page:1}],title:'single'})).Lists('BV1oo4y1t7GX'),/見つけられません/);
  const locked=new BilibiliAccount(async()=>({ok:true,json:async()=>({code:-101})}));
  await assert.rejects(()=>locked.Videos('123',1),/ログイン/);
  const denied=new BilibiliAccount(async()=>({ok:false,status:412}));await assert.rejects(()=>denied.Lists(SHARE),/412/);
  await assert.rejects(()=>ReadWholeList(async page=>{if(page===2)throw new Error('network lost');return {videos:[{url:'av1'}],hasMore:true};}),/network lost/);
});
test('whole-list loading stops on cancellation and detects repeated or excessive pages',async()=>{
  let count=0,active=true;
  const result=await ReadWholeList(async()=>{count++;active=false;return {videos:[{url:'av1'}],hasMore:true};},()=>assert.fail('canceled progress'),()=>active);
  assert.equal(result,null);assert.equal(count,1);
  await assert.rejects(()=>ReadWholeList(async()=>({videos:[{url:'av1'}],hasMore:true})),/同じページ/);
  await assert.rejects(()=>ReadWholeList(async()=>({videos:[],hasMore:true})),/途中/);
  await assert.rejects(()=>ReadWholeList(async()=>({videos:[],hasMore:false,total:10001})),/10000/);
});
test('media state rejects retired services and sanitizes non-finite positions',()=>{
  assert.throws(()=>NormalizeMedia({title:'old'},'youtube'));
  const data=NormalizeMedia({title:'曲\0名',position:NaN,duration:Infinity,paused:false},'local');assert.equal(data.title,'曲 名');assert.equal(data.position,0);assert.equal(data.duration,0);assert.equal(data.paused,false);
});
test('mini-player position and expanded volume panel stay within the selected work area',()=>{
  for (const work of [{x:0,y:0,width:1920,height:1032},{x:-1280,y:-100,width:1280,height:720},{x:1920,y:0,width:600,height:950}]) {
    const closed=MiniBounds(work,{x:work.x+work.width-90,y:work.y+work.height+5,width:24,height:24});
    const opened=ExpandBounds(closed,work,true),restored=ExpandBounds(opened,work,false);
    assert.equal(opened.y+opened.height,closed.y+closed.height);assert.deepEqual(restored,closed);
    assert.ok(opened.x>=work.x&&opened.x+opened.width<=work.x+work.width);assert.ok(opened.y>=work.y&&opened.y+opened.height<=work.y+work.height);
  }
});
function MiniHarness(fail=false, options={}) {
  const handlers=new Map(), calls=[],screen=new EventEmitter();screen.getDisplayMatching=()=>({workArea:{x:0,y:0,width:1920,height:1032}});
  let finish;const loading=new Promise(resolve=>finish=resolve);
  class Window extends EventEmitter {
    constructor(options={}){super();this.options=options;this.bounds={x:0,y:0,width:430,height:64};this.webContents=new EventEmitter();this.webContents.mainFrame={url:'favecus://app/mini.html'};this.webContents.setWindowOpenHandler=()=>{};this.webContents.send=(...args)=>calls.push(args);}
    getBounds(){return this.bounds;}setBounds(v){this.bounds=v;}isDestroyed(){return !!this.dead;}isMinimized(){return false;}isVisible(){return !!this.visible;}show(){this.visible=true;}hide(){this.visible=false;}focus(){}destroy(){this.dead=true;}restore(){}async loadURL(){if(fail)throw new Error('load failed');await loading;}
  }
  class Tray extends EventEmitter {setToolTip(){}getBounds(){return {x:1800,y:1040,width:20,height:20};}isDestroyed(){return false;}destroy(){this.dead=true;}}
  const main=new Window();main.visible=true;const electron={BrowserWindow:Window,Tray,Menu:{buildFromTemplate:v=>v},screen,ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)},app:{quit(){},getPath:()=>os.tmpdir()}};
  const context={module:{exports:{}},require:name=>name==='electron'?electron:require(name.startsWith('.')?path.resolve(__dirname,'../src/core',name):name),__dirname:path.resolve(__dirname,'../src/core'),process};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/core/mini-player.cjs'),'utf8'),context);
  const mini=new context.module.exports.MiniPlayer(main,()=>({title:'曲名',volume:.3,canToggle:true,canStop:true,paused:false}),async v=>{calls.push(['command',v]);},v=>{calls.push(['volume',v]);},v=>{calls.push(['notice',v]);},{platform:'linux',...options});
  return {mini,main,handlers,calls,finish};
}
test('mini-player waits for its UI before hiding the main window, restores it and restricts IPC',async()=>{
  const {mini,main,handlers,calls,finish}=MiniHarness();const showing=mini.Show();assert.equal(main.visible,true);finish();await showing;assert.equal(main.visible,false);assert.equal(mini.window.visible,true);assert.equal(mini.window.options.movable,false);
  const frame=mini.window.webContents.mainFrame,event={sender:mini.window.webContents,senderFrame:frame};
  assert.equal((await handlers.get('mini:command')(event,'toggle')).ok,true);assert.ok(calls.some(c=>c[0]==='command'&&c[1]==='toggle'));
  for(const command of ['previous','next']) { assert.equal((await handlers.get('mini:command')(event,command)).ok,true);assert.ok(calls.some(c=>c[0]==='command'&&c[1]===command)); }
  assert.equal((await handlers.get('mini:command')(event,'open-url')).ok,false);
  assert.equal((await handlers.get('mini:command')({sender:main.webContents,senderFrame:frame},'stop')).ok,false);
  assert.equal((await handlers.get('mini:state')({...event,senderFrame:{url:'https://www.bilibili.com/'} })).ok,false);
  await handlers.get('mini:restore')(event);assert.equal(main.visible,true);assert.equal(mini.window.visible,false);
  mini.Destroy();assert.equal(handlers.size,0);
});
test('a failed mini-player load keeps the main window accessible',async()=>{
  const {mini,main}=MiniHarness(true);await assert.rejects(()=>mini.Show(),/開けません/);assert.equal(main.visible,true);assert.equal(mini.window,null);mini.Destroy();
});
class FakeTaskbar {
  constructor(exe,state,settings,action,status,failure){Object.assign(this,{exe,state,settings,action,status,failure});}
  Show(){this.connection={};return new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});}
  Stop(){this.connection=null;this.reject?.(new Error('closed'));}
  Update(){}
}
test('embedded mini hides the main window only after attachment and restores on helper failure',async()=>{
  const h=MiniHarness(false,{platform:'win32',TaskbarPlayer:FakeTaskbar});const showing=h.mini.Show();
  assert.equal(h.main.visible,true);assert.equal(h.mini.window,null);h.mini.taskbar.resolve(true);await showing;assert.equal(h.main.visible,false);
  await h.mini.taskbar.action('next');await h.mini.taskbar.action('volume',.5);assert.ok(h.calls.some(c=>c[0]==='command'&&c[1]==='next'));assert.ok(h.calls.some(c=>c[0]==='volume'&&c[1]===.5));
  h.mini.taskbar.failure(new Error('connection lost'));assert.equal(h.main.visible,true);assert.equal(h.mini.taskbar.connection,null);h.mini.Destroy();
});
test('failed attachment falls back after floating UI loads and remains restorable',async()=>{
  const h=MiniHarness(false,{platform:'win32',TaskbarPlayer:FakeTaskbar});const showing=h.mini.Show();h.mini.taskbar.reject(new Error('parent error'));
  await Promise.resolve();assert.equal(h.main.visible,true);h.finish();await showing;assert.equal(h.main.visible,false);assert.equal(h.mini.window.visible,true);
  assert.ok(h.calls.some(c=>c[0]==='notice'&&c[1].includes('parent error')));h.mini.Restore();assert.equal(h.main.visible,true);h.mini.Destroy();
});
test('restore or destroy while connecting cancels late hiding of the main window',async()=>{
  for(const action of ['Restore','Destroy']){
    const h=MiniHarness(false,{platform:'win32',TaskbarPlayer:FakeTaskbar});const showing=h.mini.Show();h.mini[action]();h.mini.taskbar.resolve(true);await showing;
    assert.equal(h.main.visible,true);assert.equal(h.mini.window,null);h.mini.Destroy();
  }
});
test('067 the tray can host a hidden main window only while its icon exists and the player is alive',()=>{
  const {mini}=MiniHarness();assert.equal(mini.CanHideToTray(),true);
  mini.tray.isDestroyed=()=>true;assert.equal(mini.CanHideToTray(),false,'アイコンが破棄された');
  const {mini:other}=MiniHarness();other.tray=null;assert.equal(other.CanHideToTray(),false,'アイコンを作れなかった');
  const {mini:last}=MiniHarness();last.Destroy();assert.equal(last.CanHideToTray(),false,'終了処理後');
});
test('disabling embedding during connection opens floating mode and preserves recovery',async()=>{
  const settings={taskbarEmbed:true};const h=MiniHarness(false,{platform:'win32',TaskbarPlayer:FakeTaskbar,settings:()=>settings});const showing=h.mini.Show();
  settings.taskbarEmbed=false;const configuring=h.mini.Configure();h.finish();await Promise.all([showing,configuring]);assert.equal(h.mini.taskbar.connection,null);assert.equal(h.mini.window.visible,true);
  h.mini.Restore();assert.equal(h.main.visible,true);h.mini.Destroy();
});

test('unified URL reader distinguishes a video, its related parts and a direct collection without changing its part', async () => {
  let calls = 0;
  const account = new BilibiliAccount(async url => { calls++; return new Response(JSON.stringify({ code: 0, data: { bvid: 'BV1oo4y1t7GX', title: '全体', pages: [{ page: 1, part: '最初', duration: 120 }, { page: 2, part: '次', duration: 321 }], owner: { mid: 23 } } })); });
  const video = await account.Resolve('https://www.bilibili.com/video/BV1oo4y1t7GX/?p=2&share_source=x');
  assert.equal(video.kind, 'playlist'); assert.equal(video.video.part, 2); assert.equal(video.video.title, '次'); assert.equal(video.video.duration, 321); assert.equal(video.sources[0].kind, 'parts');
  const list = await account.Resolve('https://space.bilibili.com/23/favlist?fid=321'); assert.equal(list.kind, 'playlist'); assert.equal(list.sources[0].id, '321'); assert.equal(calls, 1);
  const batch = await account.Resolve('av123\nav456'); assert.equal(batch.kind, 'videos'); assert.equal(batch.videos.length, 2);
  await assert.rejects(account.Resolve('av123\nhttps://space.bilibili.com/23/favlist?fid=321'), /1件ずつ/);
});
test('one-page videos stay single unless a collection is attached, including list URLs containing a current video', async () => {
  const single = API(() => ({ title: '単体', pages: [{ page: 1, duration: 12 }], owner: { mid: 42 } }));
  assert.equal((await single.Resolve('av123')).kind, 'video');
  const collection = API(() => ({ title: '合集の動画', pages: [{ page: 1 }], owner: { mid: 42 }, ugc_season: { id: 51, title: '合集', ep_count: 2 } }));
  const result = await collection.Resolve('av123'); assert.equal(result.kind, 'playlist'); assert.equal(result.sources[0].kind, 'season');
  const list = await single.Resolve('https://www.bilibili.com/list/42?sid=51&business=space_collection&bvid=BV1oo4y1t7GX');
  assert.equal(list.kind, 'playlist'); assert.equal(list.sources[0].id, '51');
});
test('app data rename migration preserves exact bytes and refuses destructive merge when both directories exist', t => {
  const { PrepareDataDirectory } = require('../src/core/data-migration.cjs');
  const root = Temp(t), old = path.join(root, 'Focus Player'), store = new Store(old);
  store.Apply({ type: 'add', playlistId: store.data.activePlaylistId, urls: 'av123' });
  store.data.settings.discordImageKey = 'focus_player_music';
  store.Save();
  const bytes = fs.readFileSync(store.file), partition = path.join(old, 'Partitions/focus-bilibili');
  fs.mkdirSync(partition, { recursive: true });
  fs.writeFileSync(path.join(partition, 'Cookies'), 'account bytes');
  const directory = PrepareDataDirectory(root);
  assert.equal(fs.existsSync(old), false);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'library.json')), bytes);
  assert.equal(fs.readFileSync(path.join(directory, 'Partitions/favecus-bilibili/Cookies'), 'utf8'), 'account bytes');
  const next = new Store(directory);
  assert.equal(next.data.settings.discordImageKey, 'favecus_player_music');
  assert.equal(next.data.playlists[0].entries[0].videoId, 'av123');
  next.Apply({ type: 'settings', settings: { discordImageKey: 'my_custom_image' } });
  assert.equal(PrepareDataDirectory(root), directory);
  assert.equal(new Store(directory).data.settings.discordImageKey, 'my_custom_image');

  const conflictRoot = Temp(t);
  for (const name of ['Focus Player', 'Favecus Player']) {
    const folder = path.join(conflictRoot, name);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'library.json'), name);
  }
  assert.throws(() => PrepareDataDirectory(conflictRoot), /両方/);
  for (const name of ['Focus Player', 'Favecus Player']) assert.equal(fs.readFileSync(path.join(conflictRoot, name, 'library.json'), 'utf8'), name);
});
