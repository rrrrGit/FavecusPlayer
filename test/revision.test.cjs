'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { Store, ValidateSettings } = require('../src/core/store.cjs');
const { ParseVideo } = require('../src/core/urls.cjs');
const { BuildActivity } = require('../src/core/discord.cjs');
const { ConvertWma } = require('../src/core/audio-import.cjs');
const { TransportState, HasPlayback } = require('../src/ui/transport-model.js');
const { BilibiliAccount } = require('../src/core/bilibili.cjs');
const { Install, Hash, Download, ValidatePayload, Preflight, SafeRelative, PSQuote } = require('../scripts/install-core.cjs');
function Temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-revision-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('new playlists accept Bilibili only and reject removed service URLs atomically', t => {
  const root = Temp(t), store = new Store(root), id = store.data.activePlaylistId;
  store.Apply({ type: 'add', playlistId: id, urls: 'BV1B7411m7LV\nhttps://www.bilibili.com/video/BV1B7411m7LV/?p=2' });
  assert.deepEqual(new Store(root).Playlist(id).entries.map(e => e.part), [1, 2]);
  for (const url of ['https://youtu.be/abcdefghijk','https://music.youtube.com/watch?v=abcdefghijk']) assert.throws(() => ParseVideo(url));
  assert.throws(() => store.Apply({ type:'add', playlistId:id, urls:'av100\nhttps://www.youtube.com/watch?v=abcdefghijk' }));
  assert.equal(store.Playlist(id).entries.length, 2);
});
test('drag placement inserts before or after and survives restart', t => {
  const root = Temp(t), store = new Store(root), id = store.data.activePlaylistId;
  store.Apply({ type: 'add', playlistId: id, urls: 'av100\nav200\nav300\nav400' });
  const [a,b,c,d] = store.Playlist(id).entries;
  store.Apply({ type: 'reorder', playlistId: id, entryId: a.id, targetId: c.id, after: true });
  assert.deepEqual(store.Playlist(id).entries.map(e => e.id), [b.id,c.id,a.id,d.id]);
  store.Apply({ type: 'reorder', playlistId: id, entryId: d.id, targetId: b.id, after: false });
  assert.deepEqual(new Store(root).Playlist(id).entries.map(e => e.id), [d.id,b.id,c.id,a.id]);
  assert.throws(() => store.Apply({ type: 'reorder', playlistId: id, entryId: 'missing', targetId: b.id }));
});
test('transport controls only Bilibili or local entries and can start an idle playlist', () => {
  const idle = TransportState({ current:null, playback:{title:'old',duration:10}, entries:[{id:'a'}] });
  assert.equal(idle.data,null); assert.equal(idle.canStart,true); assert.equal(idle.canSeek,false);
  assert.equal(HasPlayback({source:'youtube',playlistId:'legacy'}),false);
  for (const source of ['bilibili','local']) {
    const active = TransportState({current:{source,playlistId:'p'},playback:{duration:20},entries:[]});
    assert.equal(active.canSeek,true);assert.equal(active.canStart,false);
  }
});
test('master volume persists, clamps range, and old saved settings default to full volume', t => {
  assert.equal(ValidateSettings({}).volume,1); assert.equal(ValidateSettings({volume:-5}).volume,0); assert.equal(ValidateSettings({volume:100}).volume,1);
  const root=Temp(t),store=new Store(root);store.Apply({type:'settings',settings:{volume:.37}});assert.equal(new Store(root).data.settings.volume,.37);
});
test('Discord displays the song details in the member list and uses Listening for every source', () => {
  for(const source of ['bilibili','local']) { const activity=BuildActivity({source,title:'刻ト詩',paused:false,position:4,duration:311},true);assert.equal(activity.type,2);assert.equal(activity.status_display_type,2);assert.equal(activity.details,'刻ト詩'); }
});
test('media controls seek by time, skip by ten seconds, clamp edges and reject invalid seek values', () => {
  const handlers={},messages=[];let volume=.6;
  const media={paused:true,readyState:2,duration:100,currentTime:40,ended:false,playbackRate:1,play(){this.paused=false;return Promise.resolve();},pause(){this.paused=true;},get volume(){return volume;},set volume(v){volume=v;}};

  const sandbox={require:()=>({ipcRenderer:{on:(k,fn)=>handlers[k]=fn,send:(...args)=>messages.push(args)}}),document:{querySelectorAll:()=>[media],querySelector:()=>null,title:'Test - bilibili',addEventListener(){}},location:{hostname:'www.bilibili.com',protocol:'https:',href:'https://www.bilibili.com/video/BV1oo4y1t7GX/'},window:{addEventListener(){}},setInterval(){},Date};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/preloads/media.cjs'),'utf8'),sandbox);
  const command=value=>handlers['media:command']({},value);
  command({type:'seek',value:81});assert.equal(media.currentTime,81);command({type:'seek-relative',value:10});assert.equal(media.currentTime,91);
  command({type:'seek-relative',value:10});assert.equal(media.currentTime,100);command({type:'seek',value:-3});assert.equal(media.currentTime,0);
  command({type:'volume',value:.2});assert.equal(media.volume,.2);command({type:'toggle'});assert.equal(media.paused,false);command({type:'pause'});assert.equal(media.paused,true);
  command({type:'seek',value:NaN});assert.equal(media.currentTime,0);command({type:'volume',value:0});assert.equal(media.muted,true);command({type:'volume',value:.3});assert.equal(media.muted,false);assert.ok(messages.some(m=>m[0]==='media:state'));
});
test('Bilibili account responses are scoped, sanitized and can page favorites', async () => {
  const calls=[];const account=new BilibiliAccount(async raw=>{const url=new URL(raw);calls.push(url);
    const data=url.pathname.endsWith('/nav')?{isLogin:true,mid:1234,uname:'本人'}:url.pathname.includes('created')?{list:[{id:987,title:'音楽',media_count:21}]}:{has_more:true,medias:[{bvid:'BV1B7411m7LV',title:'曲',upper:{name:'投稿者'}},{bvid:'invalid',title:'bad'}]};return {ok:true,json:async()=>({code:0,data})};});
  assert.equal((await account.Profile()).name,'本人');assert.equal((await account.Folders())[0].id,'987');
  const result=await account.Videos('987',2);assert.equal(result.videos.length,1);assert.equal(result.hasMore,true);assert.equal(calls.at(-1).searchParams.get('pn'),'2');
  await assert.rejects(()=>account.Videos('../etc',1));await assert.rejects(()=>new BilibiliAccount(async()=>({ok:true,json:async()=>({code:-101})})).Folders());
});
test('WMA is converted to valid FLAC, is playable by a decoder and leaves the original unchanged', async t => {
  const ffmpeg=process.env.FAVECUS_TEST_FFMPEG || '/usr/bin/ffmpeg';if(!fs.existsSync(ffmpeg)){t.skip('FFmpeg is not installed in the test environment');return;}
  const root=Temp(t),source=path.join(root,'input.wma');
  assert.equal(spawnSync(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','wmav2',source]).status,0);
  const before=await Hash(source),store=new Store(path.join(root,'library'),{convertWma:(s,d)=>ConvertWma(ffmpeg,s,d)});
  await store.AddFiles(store.data.activePlaylistId,[source]);const entry=store.Playlist(store.data.activePlaylistId).entries[0],output=path.join(store.media,entry.fileName);
  assert.equal(path.extname(output),'.flac');assert.equal(fs.readFileSync(output).subarray(0,4).toString(),'fLaC');assert.equal(await Hash(source),before);
  assert.equal(spawnSync(ffmpeg,['-nostdin','-v','error','-i',output,'-f','null','-']).status,0);
  const bad=path.join(root,'bad.wma');fs.writeFileSync(bad,'broken');await assert.rejects(()=>ConvertWma(ffmpeg,bad,path.join(root,'bad.flac')));assert.equal(fs.existsSync(path.join(root,'bad.flac.partial')),false);
});
async function Payload(parent,version='0.2.0') {
  const payload=path.join(parent,`payload-${version}`);fs.mkdirSync(payload,{recursive:true});
  const files={'app/package.json':JSON.stringify({name:'favecus-player',version}),'app/src/main.cjs':'test main','app/docs/GUIDE.html':'guide','FavecusPlayer.exe':'new launcher','bootstrap/node.exe':'test node','bootstrap/NODE-LICENSE.txt':'test license'};
  const manifest={product:'favecus-player',version,files:[]};
  for(const [name,data]of Object.entries(files)){const target=path.join(payload,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data);manifest.files.push({path:name,sha256:await Hash(target)});}
  fs.writeFileSync(path.join(payload,'manifest.json'),JSON.stringify(manifest));return payload;
}
test('installer downloads reject changed bytes before they can be used',async t=>{
  const root=Temp(t),data=Buffer.from('expected');const {createHash}=require('node:crypto');
  const asset={name:'test',url:'https://example.test/archive',size:data.length,sha256:createHash('sha256').update(data).digest('hex')};
  await Download(asset,path.join(root,'ok'),()=>{},async()=>new Response(data));
  await assert.rejects(()=>Download(asset,path.join(root,'bad'),()=>{},async()=>new Response(Buffer.from('modified'))));
  assert.equal(SafeRelative('../outside'),false);assert.equal(SafeRelative('app/../../outside'),false);assert.equal(PSQuote("O'Brien"),"'O''Brien'");
});
test('installer refuses unrelated directories and altered payloads',async t=>{
  const root=Temp(t),payload=await Payload(root),target=path.join(root,'unrelated');fs.mkdirSync(target);fs.writeFileSync(path.join(target,'my-file.txt'),'keep');
  await assert.rejects(()=>Preflight(target,'patch'));await assert.rejects(()=>Preflight(target,'setup'));
  fs.appendFileSync(path.join(payload,'app/src/main.cjs'),'altered');await assert.rejects(()=>ValidatePayload(payload));assert.equal(fs.readFileSync(path.join(target,'my-file.txt'),'utf8'),'keep');
});
test('legacy installation upgrades without touching media or original source, and failed switching restores the working version',async t=>{
  const root=Temp(t),target=path.join(root,'Favecus Player'),payload=await Payload(root);fs.mkdirSync(path.join(target,'src'),{recursive:true});
  fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name:'favecus-player',version:'0.1.0'}));fs.writeFileSync(path.join(target,'src/main.cjs'),'old source');
  fs.mkdirSync(path.join(target,'media'));fs.writeFileSync(path.join(target,'media/user.mp4'),'user media');
  const deps={runtimes:async()=>{}};
  const installed=await Install({root:target,payload,mode:'patch',dependencies:deps});
  assert.equal(fs.readFileSync(path.join(target,'runtime/config/active.txt'),'utf8').trim(),installed.app);assert.equal(fs.readFileSync(path.join(target,'media/user.mp4'),'utf8'),'user media');assert.equal(fs.readFileSync(path.join(target,'src/main.cjs'),'utf8'),'old source');
  const next=await Payload(root,'0.3.0'),before=fs.readFileSync(path.join(target,'runtime/config/active.txt'),'utf8');
  await assert.rejects(()=>Install({root:target,payload:next,mode:'patch',dependencies:{...deps,beforeSwitch:async()=>{throw new Error('simulated failure');}}}));
  assert.equal(fs.readFileSync(path.join(target,'runtime/config/active.txt'),'utf8'),before);assert.equal(JSON.parse(fs.readFileSync(path.join(target,'runtime/config/favecus-player-install.json'),'utf8')).version,'0.2.0');assert.equal(fs.existsSync(path.join(target,'.setup-lock')),false);
});
test('a failed first download can be retried in the same install directory',async t=>{
  const root=Temp(t),target=path.join(root,'FavecusPlayer'),payload=await Payload(root);
  await assert.rejects(()=>Install({root:target,payload,mode:'setup',dependencies:{runtimes:async()=>{throw new Error('offline');}}}));
  assert.equal(fs.existsSync(path.join(target,'active.txt')),false);assert.equal(fs.existsSync(path.join(target,'.setup-lock')),false);
  const recovered=await Install({root:target,payload,mode:'setup',dependencies:{runtimes:async()=>{}}});
  assert.equal(recovered.version,'0.2.0');
});
test('repeated updates reuse app and remove recognized legacy versions without touching unrelated files', async t => {
  const root=Temp(t),target=path.join(root,'FavecusPlayer'),deps={runtimes:async()=>{}};
  const first=await Payload(root,'0.4.1');await Install({root:target,payload:first,mode:'setup',dependencies:deps});
  const oldName='app-0.4.1-1789011606542';fs.renameSync(path.join(target,'app'),path.join(target,oldName));
  fs.writeFileSync(path.join(target,'active.txt'),oldName+'\r\n');
  const marker=JSON.parse(fs.readFileSync(path.join(target,'runtime/config/favecus-player-install.json')));marker.app=oldName;fs.writeFileSync(path.join(target,'favecus-player-install.json'),JSON.stringify(marker));
  const backup=path.join(target,'.backups','1789011606542-12345678-1234-1234-1234-123456789abc');fs.mkdirSync(backup,{recursive:true});fs.writeFileSync(path.join(backup,'favecus-player-install.json'),JSON.stringify(marker));
  fs.mkdirSync(path.join(target,'app-0.1.0-1789011606000'));fs.writeFileSync(path.join(target,'app-0.1.0-1789011606000','personal.txt'),'keep');
  fs.mkdirSync(path.join(target,'media'));fs.writeFileSync(path.join(target,'media','keep.mp4'),'user media');
  for (const version of ['0.4.2','0.4.3','0.4.4']) {
    const result=await Install({root:target,payload:await Payload(root,version),mode:'patch',dependencies:deps});
    assert.equal(result.app,'app');assert.equal(fs.readFileSync(path.join(target,'runtime/config/active.txt'),'utf8').trim(),'app');
    assert.equal(JSON.parse(fs.readFileSync(path.join(target,'app/package.json'))).version,version);
    assert.equal(fs.existsSync(path.join(target,oldName)),false);assert.equal(fs.existsSync(path.join(target,'.backups')),false);
    assert.deepEqual(fs.readdirSync(path.join(target,'runtime')).filter(n=>n.startsWith('.setup-stage-')),[]);
    assert.deepEqual(fs.readdirSync(target).filter(n=>n.startsWith('.setup-stage-')),[]);
  }
  assert.equal(fs.readFileSync(path.join(target,'app-0.1.0-1789011606000/personal.txt'),'utf8'),'keep');assert.equal(fs.readFileSync(path.join(target,'media/keep.mp4'),'utf8'),'user media');
});
test('failed fixed-directory replacement restores the entire app and metadata before removing temporary files', async t => {
  const root=Temp(t),target=path.join(root,'FavecusPlayer'),deps={runtimes:async()=>{}};
  await Install({root:target,payload:await Payload(root,'0.4.2'),mode:'setup',dependencies:deps});
  fs.writeFileSync(path.join(target,'app/src/main.cjs'),'previous working code');
  const names=['app/package.json','app/src/main.cjs','FavecusPlayer.exe','runtime/config/active.txt','runtime/config/favecus-player-install.json','runtime/config/Start.cmd'];
  const before=names.map(n=>fs.readFileSync(path.join(target,n)));
  await assert.rejects(Install({root:target,payload:await Payload(root,'0.4.3'),mode:'patch',dependencies:{...deps,beforeSwitch:async()=>{throw new Error('switch failure');}}}),/switch failure/);
  for(const [i,n] of names.entries())assert.deepEqual(fs.readFileSync(path.join(target,n)),before[i]);
  assert.deepEqual(fs.readdirSync(path.join(target,'runtime')).filter(n=>n.startsWith('.setup-stage-')),[]);
});
test('fixed app directory conflicts and legacy symlinks do not overwrite or remove unrelated data', async t => {
  const root=Temp(t),target=path.join(root,'FavecusPlayer'),deps={runtimes:async()=>{}};
  await Install({root:target,payload:await Payload(root,'0.4.2'),mode:'setup',dependencies:deps});
  const outside=path.join(root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep'),'keep');
  fs.symlinkSync(outside,path.join(target,'app-0.1.0-1789011606542'),'dir');
  await Install({root:target,payload:await Payload(root,'0.4.3'),mode:'patch',dependencies:deps});assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'),'keep');
  fs.writeFileSync(path.join(target,'app/package.json'),JSON.stringify({name:'another-app',version:'1.0.0'}));
  await assert.rejects(Preflight(target,'patch'),/確認できません/);assert.equal(JSON.parse(fs.readFileSync(path.join(target,'app/package.json'))).name,'another-app');
});

test('0.5.1 installs only the branded launcher and restores it on update failure', async t => {
  const root = Temp(t), target = path.join(root, 'installed'), deps = { runtimes: async () => {} };
  async function Branded(version, value) {
    const payload = await Payload(root, version), file = path.join(payload, 'FavecusPlayer.exe'); fs.writeFileSync(file, value);
    const manifestFile = path.join(payload, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile)); manifest.files.find(x => x.path === 'FavecusPlayer.exe').sha256 = await Hash(file); fs.writeFileSync(manifestFile, JSON.stringify(manifest)); return payload;
  }
  await Install({ root: target, payload: await Branded('0.5.0', 'brand v1'), mode: 'setup', dependencies: deps });
  assert.ok(fs.existsSync(path.join(target, 'FavecusPlayer.exe'))); assert.match(fs.readFileSync(path.join(target, 'runtime/config/Start.cmd'), 'utf8'), /FavecusPlayer\.exe/);
  await assert.rejects(Install({ root: target, payload: await Branded('0.5.1', 'brand v2'), mode: 'patch', dependencies: { ...deps, beforeSwitch: () => { throw new Error('fail'); } } }), /fail/);
  assert.equal(fs.readFileSync(path.join(target, 'FavecusPlayer.exe'), 'utf8'), 'brand v1'); assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'app/package.json'))).version, '0.5.0');
});
test('0.5.1 renames legacy installation folders and markers and restores the old folder on failure', async t => {
  const base = Temp(t), old = path.join(base, 'FocusPlayer'), target = path.join(base, 'FavecusPlayer'), deps = { runtimes: async () => {} };
  fs.mkdirSync(path.join(old, 'app/src'), { recursive: true });
  fs.writeFileSync(path.join(old, 'app/package.json'), JSON.stringify({ name: 'focus-player', version: '0.5.0' })); fs.writeFileSync(path.join(old, 'app/src/main.cjs'), 'old source');
  fs.writeFileSync(path.join(old, 'FocusPlayer.exe'), 'old executable'); fs.writeFileSync(path.join(old, 'active.txt'), 'app');
  fs.writeFileSync(path.join(old, 'focus-player-install.json'), JSON.stringify({ product: 'focus-player', version: '0.5.0' }));
  fs.writeFileSync(path.join(old, 'my-file.txt'), 'keep'); const payload = await Payload(base, '0.5.1');
  await assert.rejects(Install({ root: old, payload, mode: 'patch', dependencies: { ...deps, beforeSwitch: () => { throw new Error('failed switch'); } } }), /failed switch/);
  assert.equal(fs.existsSync(target), false); assert.equal(fs.readFileSync(path.join(old, 'FocusPlayer.exe'), 'utf8'), 'old executable'); assert.equal(fs.readFileSync(path.join(old, 'app/src/main.cjs'), 'utf8'), 'old source');
  const result = await Install({ root: old, payload, mode: 'patch', dependencies: deps }); assert.equal(result.root, target); assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(path.join(target, 'FocusPlayer.exe')), false); assert.equal(fs.existsSync(path.join(target, 'focus-player-install.json')), false);
  assert.equal(fs.readFileSync(path.join(target, 'my-file.txt'), 'utf8'), 'keep'); assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'runtime/config/favecus-player-install.json'))).previousRoot, old);
});

test('0.6.1 moves launch metadata below runtime, keeps the root clean and rolls back both layouts on failure', async t => {
  const base = Temp(t), root = path.join(base, 'FavecusPlayer'), deps = { runtimes: async () => {} };
  await Install({ root, payload: await Payload(base, '0.6.0'), mode: 'setup', dependencies: deps });
  for (const name of ['active.txt', 'favecus-player-install.json', 'Start.cmd']) fs.renameSync(path.join(root, 'runtime/config', name), path.join(root, name));
  fs.mkdirSync(path.join(root, 'downloads'), { recursive: true }); fs.writeFileSync(path.join(root, 'downloads/keep.m4a'), 'media');
  const before = ['active.txt', 'favecus-player-install.json', 'Start.cmd'].map(name => fs.readFileSync(path.join(root, name)));
  const next = await Payload(base, '0.6.1');
  await assert.rejects(Install({ root, payload: next, mode: 'patch', dependencies: { ...deps, afterSwitch() { throw new Error('late failure'); } } }), /late failure/);
  for (const [i, name] of ['active.txt', 'favecus-player-install.json', 'Start.cmd'].entries()) assert.deepEqual(fs.readFileSync(path.join(root, name)), before[i]);
  assert.equal(fs.existsSync(path.join(root, 'runtime/config/active.txt')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'app/package.json'))).version, '0.6.0');
  await Install({ root, payload: next, mode: 'patch', dependencies: deps });
  assert.ok(fs.readdirSync(root, { withFileTypes: true }).every(file => file.isDirectory() || file.name.endsWith('.exe')));
  assert.equal(fs.readFileSync(path.join(root, 'runtime/config/active.txt'), 'utf8').trim(), 'app');
  assert.match(fs.readFileSync(path.join(root, 'runtime/config/Start.cmd'), 'utf8'), /\.\.\\\.\.\\FavecusPlayer\.exe/);
  assert.equal(fs.readFileSync(path.join(root, 'downloads/keep.m4a'), 'utf8'), 'media');
  await Install({ root, payload: await Payload(base, '0.6.2'), mode: 'patch', dependencies: deps });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'runtime/config/favecus-player-install.json'))).version, '0.6.2');
});

test('062 destination selection is idempotent and archives only recognized program-only nested installations', async t => {
  const { ResolveInstallRoot } = require('../scripts/install-core.cjs'); const parent = Temp(t), root = path.join(parent, 'FavecusPlayer'), payload = await Payload(parent, '0.6.2'), dependencies = { runtimes: async () => {} };
  assert.equal(await ResolveInstallRoot(parent, 'setup'), root); assert.equal(await ResolveInstallRoot(root, 'setup'), root);
  await Install({ root, payload, mode: 'setup', selection: true, dependencies });
  const nested = path.join(root, 'FavecusPlayer'); await Install({ root: nested, payload, mode: 'setup', dependencies });
  assert.equal(await ResolveInstallRoot(nested, 'patch'), root);
  const result = await Install({ root: nested, payload, mode: 'patch', selection: true, dependencies });
  assert.equal(result.root, root); assert.equal(fs.existsSync(nested), false); assert.equal(result.notes.length, 1);
  assert.deepEqual(fs.readdirSync(root).sort(), ['FavecusPlayer.exe', 'app', 'downloads', 'runtime'].sort());
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'runtime/config/favecus-player-install.json'))); assert.ok(marker.previousRoots.includes(nested)); assert.ok(fs.existsSync(path.join(root, marker.archivedInstallations[0].to, 'app/package.json')));
  await Install({ root, payload, mode: 'patch', dependencies }); const again = JSON.parse(fs.readFileSync(path.join(root, 'runtime/config/favecus-player-install.json'))); assert.deepEqual(again.archivedInstallations, marker.archivedInstallations);
});
test('062 failed nested cleanup rolls back both installations and their launch metadata', async t => {
  const parent = Temp(t), root = path.join(parent, 'FavecusPlayer'), old = await Payload(parent, '0.6.1'), next = await Payload(parent, '0.6.2'), runtimes = async () => {};
  await Install({ root, payload: old, mode: 'setup', dependencies: { runtimes } }); const nested = path.join(root, 'FavecusPlayer'); await Install({ root: nested, payload: old, mode: 'setup', dependencies: { runtimes } });
  const before = fs.readFileSync(path.join(root, 'runtime/config/favecus-player-install.json'), 'utf8');
  for (const hook of ['afterArchive', 'afterSwitch']) {
    await assert.rejects(Install({ root, payload: next, mode: 'patch', dependencies: { runtimes, [hook]: () => { throw new Error('interrupted'); } } }), /interrupted/);
    for (const folder of [root, nested]) assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'app/package.json'))).version, '0.6.1');
    assert.equal(fs.readFileSync(path.join(root, 'runtime/config/favecus-player-install.json'), 'utf8'), before);
  }
});
test('062 nested downloads and unrelated personal files are kept in place', async t => {
  const parent = Temp(t), root = path.join(parent, 'FavecusPlayer'), payload = await Payload(parent, '0.6.2'), dependencies = { runtimes: async () => {} };
  await Install({ root, payload, mode: 'setup', dependencies }); const nested = path.join(root, 'FavecusPlayer'); await Install({ root: nested, payload, mode: 'setup', dependencies });
  fs.writeFileSync(path.join(nested, 'downloads/song.mp4'), 'keep'); const result = await Install({ root, payload, mode: 'patch', dependencies }); assert.ok(result.notes.some(n => n.includes('そのまま'))); assert.equal(fs.readFileSync(path.join(nested, 'downloads/song.mp4'), 'utf8'), 'keep');
  fs.rmSync(path.join(nested, 'downloads/song.mp4')); fs.writeFileSync(path.join(nested, 'private.txt'), 'keep'); await Install({ root, payload, mode: 'patch', dependencies }); assert.equal(fs.readFileSync(path.join(nested, 'private.txt'), 'utf8'), 'keep');
});
test('062 nested symbolic links cannot be followed by the installer', async t => {
  const parent = Temp(t), root = path.join(parent, 'FavecusPlayer'), payload = await Payload(parent, '0.6.2'), dependencies = { runtimes: async () => {} };
  await Install({ root, payload, mode: 'setup', dependencies }); const outside = path.join(parent, 'outside'); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(root, 'FavecusPlayer'));
  await assert.rejects(Install({ root, payload, mode: 'patch', dependencies }), /リンク先/); assert.deepEqual(fs.readdirSync(outside), []);
});
test('062 missing previous default download roots rebase, while existing or custom folders remain selected', t => {
  const { OfflineLibrary } = require('../src/core/offline-library.cjs'); const root = Temp(t), directory = path.join(root, 'downloads'), settingsFile = path.join(root, 'settings.json'), previous = path.join(root, 'FavecusPlayer/downloads');
  fs.writeFileSync(settingsFile, JSON.stringify({ directory: previous, preferSaved: false })); const moved = new OfflineLibrary({ directory, settingsFile, previousDirectories: [previous] }); assert.equal(moved.directory, directory); assert.equal(moved.preferSaved, false);
  fs.mkdirSync(previous, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify({ directory: previous })); assert.equal(new OfflineLibrary({ directory, settingsFile, previousDirectories: [previous] }).directory, previous);
  const custom = path.join(root, 'custom'); fs.writeFileSync(settingsFile, JSON.stringify({ directory: custom })); assert.equal(new OfflineLibrary({ directory, settingsFile, previousDirectories: [previous] }).directory, custom);
});
