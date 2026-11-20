'use strict';
const { test }=require('node:test'), assert=require('node:assert/strict');
const { Needs } = require('./support-env.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {SelectStreams,MediaURL,SignQuery,BilibiliDownloadSource}=require('../src/core/bilibili-download.cjs');
const {DownloadStream,Assemble}=require('../src/core/download-transfer.cjs'),{OfflineLibrary,Key,SafeName}=require('../src/core/offline-library.cjs');
const {ParseBilibili}=require('../src/core/urls.cjs'),{PlaylistBrowser}=require('../src/ui/playlist-reader.js');
const signal=()=>new AbortController().signal;
function Temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'favecus-download-'));t.after(()=>fs.rmSync(root,{force:true,recursive:true}));return root;}
const stream=(id,height,codecs,bandwidth)=>({id,height,codecs,bandwidth,baseUrl:`https://a.bilivideo.com/${id}-${codecs}`,backupUrl:[`https://b.bilivideo.com/${id}`]});
const info={dash:{video:[stream(16,360,'avc1',100000),stream(64,720,'avc1',500000),stream(80,1080,'avc1',1000000),stream(64,720,'hev1',200000)],audio:[stream(1,0,'mp4a',64000),stream(2,0,'mp4a',128000),stream(3,0,'mp4a',320000)]}};
test('download selects compact compatible H264 and AAC streams, prefers <=720p and <=192kbps and rejects protection flags',()=>{
 const p=SelectStreams(info,'video');assert.equal(p.height,720);assert.match(p.streams[0].urls[0],/64-avc1/);assert.match(p.streams[1].urls[0],/2-mp4a/);
 assert.equal(SelectStreams(info,'video',360).height,360);assert.equal(SelectStreams(info,'audio').streams.length,1);
 for(const flag of ['is_preview','is_drm','drm_tech_type'])assert.throws(()=>SelectStreams({...info,[flag]:'1'},'video'),/保護/);
 for(const url of ['https://bilivideo.com.evil.test/a','https://a@a.bilivideo.com/a','http://localhost/a','file:///secret'])assert.throws(()=>MediaURL(url));
 assert.equal(MediaURL('http://a.bilivideo.com/a'),'https://a.bilivideo.com/a');assert.equal(SafeName('CON'),'_CON');
});
test('download metadata selects the exact part CID and stops instead of retrying authentication and rate errors',async()=>{
 const calls=[];const source=new BilibiliDownloadSource(async(url,options)=>{calls.push(url);assert.equal(options.credentials,'include');return new Response(JSON.stringify({code:0,data:url.includes('web-interface/view')?{pages:[{page:1,cid:10},{page:2,cid:20,duration:120}]}:info}));});
 const p=await source.Resolve(ParseBilibili('https://www.bilibili.com/video/av123/?p=2'),'video',signal(),{});assert.equal(new URL(calls[1]).searchParams.get('cid'),'20');assert.equal(p.duration,120);
 let count=0;const blocked=new BilibiliDownloadSource(async()=>{count++;return new Response('',{status:412});});await assert.rejects(blocked.Resolve(ParseBilibili('av123'),'video',signal()),e=>e.stopBatch===true);assert.equal(count,1);
 const signed=SignQuery({foo:"a!'b"},{img_url:'https://i0.hdslb.com/'+ 'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'},1000);assert.match(signed,/foo=ab&wts=1&w_rid=[a-f0-9]{32}$/);
});
test('stream download retries a truncated backup, validates redirect hosts and never leaves incomplete files',async t=>{
 const root=Temp(t),file=path.join(root,'stream.bin');let calls=0;
 const fetch=async(url,options)=>{calls++;assert.equal(options.credentials,'omit');return new Response(calls===1?'bad':'good',{headers:{'content-length':'4'}});};
 assert.equal(await DownloadStream(fetch,{urls:['https://a.bilivideo.com/a','https://b.bilivideo.com/a']},file,'https://www.bilibili.com/',signal(),()=>{}),4);assert.equal(fs.readFileSync(file,'utf8'),'good');assert.equal(calls,2);fs.rmSync(file);
 await assert.rejects(DownloadStream(async()=>new Response('',{status:302,headers:{location:'https://evil.test/secret'}}),{urls:['https://a.bilivideo.com/a']},file,'https://www.bilibili.com/',signal(),()=>{}),/配信先/);assert.equal(fs.existsSync(file),false);
 calls=0;await assert.rejects(DownloadStream(async()=>{calls++;return new Response('',{status:429});},{urls:['https://a.bilivideo.com/a','https://b.bilivideo.com/a']},file,'',signal(),()=>{}),e=>e.stopBatch===true);assert.equal(calls,1);
});
test('stream cancellation removes partial bytes promptly',async t=>{
 const root=Temp(t),file=path.join(root,'partial'),controller=new AbortController();
 await assert.rejects(DownloadStream(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2]));}})),{urls:['https://a.bilivideo.com/a']},file,'',controller.signal,()=>controller.abort(new Error('cancelled'))));assert.equal(fs.existsSync(file),false);
});
function Manager(t,overrides={}){
 const root=Temp(t),directory=path.join(root,'downloads'),settingsFile=path.join(root,'settings.json');let resolves=0;
 const options={directory,settingsFile,ffmpeg:process.execPath,fetch:()=>{},resolve:async(e,kind)=>{resolves++;return {kind,height:720,url:e.url,duration:1,layout:'dash',streams:[{urls:[]}]}},transfer:async(_fetch,_stream,file)=>{fs.writeFileSync(file,'raw');return 3},assemble:async(_exe,_plan,_files,dest)=>{fs.writeFileSync(dest,'saved media');return 1},...overrides};
 return{root,directory,options,library:new OfflineLibrary(options),resolves:()=>resolves};
}
test('batch storage deduplicates canonical URLs, preserves originals, skips completed matches after restart and switches saved format',async t=>{
 const h=Manager(t),e={...ParseBilibili('av123'),title:'曲A'},entries=[e,{...e,url:e.url+'?tracking=x'},{type:'local'}];
 h.library.Start(entries,{kind:'video',playlistId:'p',playlistName:'親/子'});await h.library.done;assert.equal(h.library.job.completed,1);assert.equal(h.resolves(),1);const saved=h.library.Find(e);assert.equal(fs.readFileSync(saved.path,'utf8'),'saved media');assert.equal(entries[0].url,e.url);
 const restarted=new OfflineLibrary(h.options);restarted.Start([e],{kind:'video',playlistId:'p',playlistName:'親/子'});await restarted.done;assert.equal(restarted.job.skipped,1);assert.equal(h.resolves(),1);
 restarted.Start([e],{kind:'audio',playlistId:'p',playlistName:'親/子'});await restarted.done;assert.equal(restarted.Find(e,'audio').kind,'audio');assert.equal(restarted.Find(e,'video').kind,'video');assert.equal(fs.readdirSync(path.join(h.directory,'.partial')).length,0);
});
test('cancelled saves clean staging files while committed tracks remain playable',async t=>{
 let reached,finish;const gate=new Promise(r=>reached=r),h=Manager(t,{resolve:async(e,kind,abort)=>{reached();await new Promise(r=>finish=r);abort.throwIfAborted();return{kind}}});
 h.library.Start([ParseBilibili('av123')],{kind:'video',playlistId:'p',playlistName:'p'});await gate;assert.throws(()=>h.library.SetDirectory(h.root));h.library.Cancel();finish();await h.library.done;assert.equal(h.library.job.status,'cancelled');assert.equal(h.library.Snapshot().available.length,0);
});
test('corrupt catalog and symlink paths cannot silently overwrite or escape the chosen root', { skip: Needs.symlink }, async t=>{
 const h=Manager(t),e=ParseBilibili('av123');h.library.Start([e],{kind:'video',playlistId:'p',playlistName:'p'});await h.library.done;
 const r=h.library.Find(e),index=path.join(h.directory,'index.json'),old=fs.readFileSync(index);fs.rmSync(r.path);fs.symlinkSync(process.execPath,r.path);assert.equal(h.library.File(r.token),null);
 fs.writeFileSync(index,'invalid');const bad=new OfflineLibrary(h.options);assert.throws(()=>bad.Start([e],{kind:'video'}),/保存一覧/);assert.equal(fs.readFileSync(index,'utf8'),'invalid');fs.writeFileSync(index,old);assert.ok(new OfflineLibrary(h.options).indexError);
});
test('real FFmpeg remux retains encoded audio and video packets without re-encoding', { skip: Needs.ffmpeg }, async t=>{
 const root=Temp(t),ffmpeg='/usr/bin/ffmpeg';assert.ok(fs.existsSync(ffmpeg),'FFmpeg is required for release validation');
 const v=path.join(root,'v.mp4'),a=path.join(root,'a.m4a'),mp4=path.join(root,'output.mp4'),m4a=path.join(root,'output.m4a');
 for(const args of [['-f','lavfi','-i','color=c=purple:s=160x90:r=25:d=1','-c:v','libx264',v],['-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','aac','-b:a','128k',a]]){const r=spawnSync(ffmpeg,['-nostdin','-v','error',...args]);assert.equal(r.status,0,r.stderr?.toString());}
 await Assemble(ffmpeg,{kind:'video',layout:'dash',duration:1},[v,a],mp4,signal());await Assemble(ffmpeg,{kind:'audio',layout:'dash',duration:1},[a],m4a,signal());
 const hash=(file,select)=>{const r=spawnSync(ffmpeg,['-v','error','-i',file,'-map',select,'-c','copy','-f','streamhash','-hash','sha256','-']);assert.equal(r.status,0,r.stderr?.toString());return r.stdout.toString().split('SHA256=')[1].trim();};
 assert.equal(hash(v,'0:v:0'),hash(mp4,'0:v:0'));assert.equal(hash(a,'0:a:0'),hash(mp4,'0:a:0'));assert.equal(hash(a,'0:a:0'),hash(m4a,'0:a:0'));
});
test('import browser remembers edited names through selection and preserves the original if cleared',()=>{
 const b=new PlaylistBrowser({}),e={...ParseBilibili('av123'),title:'original'};b.selected.set(e.url,e.title);b.Rename(e,'名前を指定');assert.equal(b.selected.get(e.url),'名前を指定');b.Rename(e,'');assert.equal(b.selected.get(e.url),'original');b.Rename(e,'a'.repeat(300));assert.equal(b.Title(e).length,180);
});
