'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { Store, ValidateSettings } = require('../src/core/store.cjs');
const { ReadJSON, ExportJSON } = require('../src/core/library-json.cjs');
const { BuildActivity } = require('../src/core/discord.cjs');
const { ImageURL, RemoteImage, LocalImage, Thumbnails } = require('../src/core/thumbnail.cjs');
const { APP_ID, RelaunchDetails } = require('../src/core/windows-identity.cjs');
function Temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-040-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function Lists(t) {
  const root = Temp(t), store = new Store(root), source = store.data.activePlaylistId;
  store.Apply({ type: 'add', playlistId: source, urls: '【中文 樱之刻 🎵】 https://www.bilibili.com/video/BV1oo4y1t7GX/?p=3&share_source=复制链接' });
  store.Apply({ type: 'create', name: '移動先A' }); const a = store.data.activePlaylistId;
  store.Apply({ type: 'create', name: '移動先B' }); const b = store.data.activePlaylistId;
  return { root, store, source, a, b, entryId: store.Playlist(source).entries[0].id };
}
test('one track copies into multiple lists, deduplicates canonical parts and preserves existing custom titles', t => {
  const { root, store, source, a, b, entryId } = Lists(t);
  store.Apply({ type: 'add', playlistId: a, urls: 'https://www.bilibili.com/video/BV1oo4y1t7GX/?p=3', title: '自分の名前' });
  const result = store.Transfer({ playlistId: source, entryId, destinationIds: [a,b,b], mode: 'copy' });
  assert.equal(result.added,1); assert.equal(result.skipped,1); assert.equal(result.destinations.length,2);
  assert.equal(store.Playlist(a).entries[0].title,'自分の名前'); assert.equal(store.Playlist(source).entries.length,1);
  const restored = new Store(root); assert.equal(restored.Playlist(b).entries[0].part,3); assert.equal(restored.Playlist(b).entries[0].title,'中文 樱之刻 🎵');
  assert.equal(new Set(restored.data.playlists.flatMap(p=>p.entries.map(e=>e.id))).size,3);
});
test('move validates every destination before removing a track and rolls back on save failure', t => {
  const { store, source, a, b, entryId } = Lists(t), before = store.Snapshot();
  for (const destinationIds of [[a,'missing'], [source], []]) assert.throws(()=>store.Transfer({playlistId:source,entryId,destinationIds,mode:'move'}));
  assert.deepEqual(store.Snapshot(),before);
  const save = store.Save; store.Save = ()=>{throw new Error('disk full');};
  assert.throws(()=>store.Transfer({playlistId:source,entryId,destinationIds:[a,b],mode:'move'}),/disk full/); store.Save = save;
  assert.deepEqual(store.Snapshot(),before);
  const result = store.Transfer({playlistId:source,entryId,destinationIds:[a,b],mode:'move'});
  assert.equal(result.moved,true); assert.equal(store.Playlist(source).entries.length,0); assert.equal(result.destinations.length,2);
});
test('local copies share the original media bytes, and export/import round-trip all references', async t => {
  const { root, store, source, a, b } = Lists(t), file = path.join(root,'自分の音楽.mp3'); fs.writeFileSync(file,'original bytes');
  await store.AddFiles(source,[file]); const entry = store.Playlist(source).entries.at(-1);
  store.Transfer({playlistId:source,entryId:entry.id,destinationIds:[a,b],mode:'copy'});
  assert.equal(fs.readdirSync(store.media).length,1);
  const { folder } = await store.Export(root), exported = path.join(folder,'favecus-player-library.json'), bytes = fs.readFileSync(exported);
  assert.ok([...bytes].every(n=>n<128)); assert.ok(bytes.includes(Buffer.from('\\u6a31'))); assert.ok(!bytes.includes(Buffer.from('share_source')));
  const next = new Store(path.join(root,'imported')); const result = await next.Import(exported); assert.equal(result.missing,0);
  assert.equal(fs.readdirSync(next.media).length,1); assert.equal(fs.readFileSync(path.join(next.media,fs.readdirSync(next.media)[0]),'utf8'),'original bytes');
  assert.equal(result.state.playlists.flatMap(p=>p.entries).filter(e=>e.type==='local').length,3);
  assert.ok(result.state.playlists.some(p=>p.entries.some(e=>e.title==='中文 樱之刻 🎵')));
});
test('Unicode JSON escapes and UTF-8 / UTF-16 BOMs preserve Japanese, Chinese and supplementary characters', () => {
  const value = { title:'刻ト詩 / 樱之刻 🎵 𠮷', url:'https://www.bilibili.com/video/av123/?p=2' };
  const text = JSON.stringify(value), utf16be = Buffer.from(text,'utf16le').swap16();
  for (const bytes of [Buffer.from(ExportJSON(value)),Buffer.from('\ufeff'+text),Buffer.concat([Buffer.from([255,254]),Buffer.from(text,'utf16le')]),Buffer.concat([Buffer.from([254,255]),utf16be])]) assert.deepEqual(ReadJSON(bytes),value);
  assert.throws(()=>ReadJSON(Buffer.from([0x7b,0x81,0x7d])),/文字コード/);
});
test('Discord uses the uploaded art key and paused position stays fixed without a live timestamp', () => {
  const media = { source:'bilibili', title:'刻ト詩', position:176.4, duration:311, paused:true };
  const first = BuildActivity(media,false,1000000,'my_music');
  assert.equal(first.assets.large_image,'my_music'); assert.equal(first.state,'一時停止 · 02:56 / 05:11 · Bilibili');
  assert.equal(first.timestamps,undefined); assert.deepEqual(BuildActivity(media,false,1006000,'my_music'),first);
  assert.equal(BuildActivity(media,true),null);
  const resumed = BuildActivity({...media,paused:false},false,1000000);
  assert.deepEqual(resumed.timestamps,{start:823,end:1134}); assert.equal(resumed.assets.large_image,'favecus_player_music');
  assert.equal(ValidateSettings({discordImageKey:' MY_MUSIC '}).discordImageKey,'my_music'); assert.throws(()=>ValidateSettings({discordImageKey:'https://evil.test/pic'}));
});
function MediaHarness(enabled = true) {
  let now = 0, load; const events = new Map(), commands = {}, messages = [], intervals = [];
  const media = { paused:true,readyState:2,duration:311,currentTime:176,ended:false,playbackRate:1,volume:1,play(){this.paused=false;return Promise.resolve();},pause(){this.paused=true;} };
  const sandbox = { process:{argv:enabled?['--favecus-start-at-zero']:[]}, require:()=>({ipcRenderer:{on:(key,fn)=>commands[key]=fn,send:(...args)=>messages.push(args)}}), document:{querySelectorAll:()=>[media],querySelector:()=>null,title:'曲 - bilibili',addEventListener:(key,fn)=>events.set(key,fn)},location:{protocol:'https:',href:'https://www.bilibili.com/video/av123/'},window:{addEventListener:(key,fn)=>{if(key==='DOMContentLoaded')load=fn;}},setInterval:(fn,ms)=>intervals.push({fn,ms}),Date:{now:()=>now} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/preloads/media.cjs'),'utf8'),sandbox); load();
  return { media, messages, event:type=>events.get(type)?.({type}), tick:value=>{now=value;intervals.forEach(({fn})=>fn());}, command:value=>commands['media:command']({},value) };
}
test('new playback resets saved history at metadata and late initial seek, then allows natural time and pause/resume', () => {
  const h = MediaHarness(); h.event('loadedmetadata'); assert.equal(h.media.currentTime,0);
  h.media.paused=false;h.event('playing');h.media.currentTime=176;h.event('seeked');assert.equal(h.media.currentTime,0);
  h.media.currentTime=1;h.tick(1000);assert.equal(h.media.currentTime,1);
  h.media.currentTime=1.6;h.tick(1600);h.command({type:'pause'});h.tick(10000);h.command({type:'toggle'});h.event('playing');assert.equal(h.media.currentTime,1.6);
  const fresh = MediaHarness(); fresh.event('loadedmetadata'); assert.equal(fresh.media.currentTime,0);
});
test('explicit seeking is honored during initialization, and account windows keep their own playback position', () => {
  const h=MediaHarness();h.event('loadedmetadata');h.event('playing');h.command({type:'seek',value:90});h.tick(200);assert.equal(h.media.currentTime,90);
  const account=MediaHarness(false);account.event('loadedmetadata');account.event('playing');account.tick(200);assert.equal(account.media.currentTime,176);
  const early=MediaHarness();early.media.paused=false;early.tick(200);assert.equal(early.media.currentTime,0);early.media.currentTime=2;early.tick(2200);assert.equal(early.media.currentTime,2);
});
test('refresh-display reports the existing frame without changing playback position, volume or paused state', () => {
  const h = MediaHarness(); h.event('loadedmetadata'); h.event('playing'); h.command({ type: 'seek', value: 123 }); h.tick(300000);
  for (const paused of [true, false]) {
    h.media.paused = paused; h.media.volume = .42;
    h.media.play = h.media.pause = () => assert.fail('display refresh must not toggle playback');
    h.command({ type: 'refresh-display' }); assert.equal(h.media.currentTime, 123); assert.equal(h.media.paused, paused); assert.equal(h.media.volume, .42);
    assert.equal(h.messages.at(-1)[1].position, 123);
  }
});
test('media preparation reports metadata-only, playable and decoder-error states without forcing playback', () => {
  const h = MediaHarness(); h.media.readyState = 1; h.event('loadedmetadata');
  const latest = () => h.messages.filter(([type]) => type === 'media:health').at(-1)[1];
  assert.equal(latest().ready, false); h.media.readyState = 2; h.tick(2000); assert.equal(latest().ready, true); assert.equal(h.media.paused, true);
  h.media.error = { code: 3 }; h.tick(4000); assert.equal(latest().ready, false); assert.equal(latest().errorCode, 3);
});
test('thumbnail fetching validates the host, caps response size and reuses cached art', async () => {
  const png=fs.readFileSync(path.join(__dirname,'../build/music.png'));let details=0,requests=0;
  const thumbs=new Thumbnails({Details:async()=>{details++;return {pic:'http://i0.hdslb.com/music.png'};}},async(url,options)=>{requests++;assert.equal(url,'https://i0.hdslb.com/music.png');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');return new Response(png);},'', '');
  const entry={type:'bilibili',videoId:'av123'};
  const image=await thumbs.Get(entry);assert.ok(image.startsWith('data:image/png;base64,'));assert.equal(await thumbs.Get(entry),image);assert.equal(details,1);assert.equal(requests,1);
  for(const url of ['https://i0.hdslb.com.evil.test/pic','file:///secret','https://name@i0.hdslb.com/pic','https://i0.hdslb.com:9000/pic'])assert.throws(()=>ImageURL(url));
  await assert.rejects(()=>RemoteImage(async()=>new Response('<svg/>'),'https://i0.hdslb.com/pic'),/画像形式/);
  await assert.rejects(()=>RemoteImage(async()=>new Response(png,{headers:{'content-length':4*1024*1024}}),'https://i0.hdslb.com/pic'));
  const unavailable=new Thumbnails({Details:async()=>{throw new Error('HTTP 412');}},()=>assert.fail('no image request'),'','');assert.equal(await unavailable.Get(entry),null);
});
test('local video thumbnail is decoded from an actual file without modifying it', async t => {
  const ffmpeg=process.env.FAVECUS_TEST_FFMPEG || '/usr/bin/ffmpeg';if(!fs.existsSync(ffmpeg)){t.skip('FFmpeg not installed');return;}
  const root=Temp(t),file=path.join(root,'video.mp4');
  assert.equal(spawnSync(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=purple:s=320x180:d=0.2','-c:v','libx264',file]).status,0);
  const before=fs.readFileSync(file),image=await LocalImage(ffmpeg,file);assert.ok(image.startsWith('data:image/png;base64,'));assert.deepEqual(fs.readFileSync(file),before);
});
test('taskbar relaunch uses the Favecus launcher and matching AppUserModelID', () => {
  const details=RelaunchDetails('C:\\My Music\\FavecusPlayer','C:\\runtime\\electron.exe','C:\\apps\\0.4.0','C:\\icon.ico');
  assert.equal(details.appId,APP_ID);assert.equal(details.relaunchCommand,'"C:\\My Music\\FavecusPlayer\\FavecusPlayer.exe"');
  assert.equal(details.relaunchDisplayName,'Favecus Player');assert.equal(details.appIconPath,'C:\\My Music\\FavecusPlayer\\FavecusPlayer.exe');
});

test('the playback speed chosen in the app is applied at once and put back when the site resets it on load or play', () => {
  const h = MediaHarness(false);
  h.command({ type: 'rate', value: 1.5 }); assert.equal(h.media.playbackRate, 1.5);
  h.media.playbackRate = 1; h.event('loadedmetadata'); assert.equal(h.media.playbackRate, 1.5, '読み込みのあと');
  h.media.playbackRate = 1; h.event('playing'); assert.equal(h.media.playbackRate, 1.5, '再生が始まったあと');
  h.command({ type: 'rate', value: 99 }); assert.equal(h.media.playbackRate, 4, '範囲の上限');
  h.command({ type: 'rate', value: 'fast' }); assert.equal(h.media.playbackRate, 4, '数でない値は、無視する');
  h.command({ type: 'rate', value: 1 }); assert.equal(h.media.playbackRate, 1);
});
