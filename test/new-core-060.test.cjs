'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { PlayCounts } = require('../src/core/play-counts.cjs'), { Queue } = require('../src/core/queue.cjs'), { PlayerRecovery } = require('../src/core/player-recovery.cjs');
const { Store, ValidateLibrary } = require('../src/core/store.cjs'), { ValidateIcon } = require('../src/core/playlist-icon.cjs');
const { PlayerURL, ParseBilibili } = require('../src/core/urls.cjs'), { BuildActivity } = require('../src/core/discord.cjs');
function Temp(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(),'favecus-060-')); t.after(() => fs.rmSync(p,{recursive:true,force:true})); return p; }
test('play counts require real progression, survive restart, share canonical songs across lists and reset independently of playlists', t => {
 const root=Temp(t), file=path.join(root,'counts.json'), stats=new PlayCounts(file), e=ParseBilibili('av123'); let now=0; stats.now=()=>now;
 const report=(position,extra={})=>{ now+=1000; stats.Observe({position,duration:200,paused:false,...extra}); };
 stats.Begin(e); report(0); report(100); report(100); report(101); assert.equal(stats.Count(e),0); report(102);report(103); assert.equal(stats.Count(e),1);
 report(104);report(105);assert.equal(stats.Count(e),1);
 const next=new PlayCounts(file);assert.equal(next.Count({...e,id:'different',playlistId:'different'}),1);assert.equal(next.Count(ParseBilibili(e.url+'?p=2')),0);
 stats.Begin(e);report(0);report(1,{paused:true});report(1,{paused:true});report(1);report(2);report(3);assert.equal(stats.Count(e),1);report(4);assert.equal(stats.Count(e),2);
 stats.Reset();assert.equal(new PlayCounts(file).Count(e),0);report(5);assert.equal(stats.Count(e),0);
 stats.Begin(e);report(0,{duration:0,ended:true});assert.equal(stats.Count(e),0);
});
test('weighted shuffle favors rarely played songs without losing any track or redrawing an existing preview', () => {
 let seed=3;const rng=()=>((seed=seed*16807%2147483647)/2147483647), counts={a:0,b:20,c:5}, q=new Queue(rng,e=>1/(1+counts[e.id])), entries=['a','b','c'].map(id=>({id}));let first={a:0,b:0,c:0};
 for(let i=0;i<1000;i++){q.ShuffleStart('p',entries);first[q.ids[0]]++;assert.equal(new Set(q.ids).size,3);}
 assert.ok(first.a>first.b*8);assert.ok(first.c>first.b*1.5);const future=q.Timeline('all').upcoming;counts.a=1000;assert.deepEqual(q.Timeline('all').upcoming,future);const clone=q.Clone();assert.equal(clone.Move(1,'all'),future[0]);
});
test('watchdog watches progress after ready, respects a deliberate pause, and cancels stale deadlines', async () => {
 let serial=0;const timers=new Map(), calls=[];const r=new PlayerRecovery((...a)=>calls.push(a),{schedule:fn=>{timers.set(++serial,fn);return serial},cancel:id=>timers.delete(id)});
 r.Begin(1,true);r.Observe(1,{ready:true,paused:false,position:2,errorCode:0});const old=[...timers.values()][0];r.Observe(1,{ready:true,paused:false,position:3,errorCode:0});assert.equal(timers.size,1);
 r.Observe(1,{ready:true,paused:true,position:3,errorCode:0});assert.equal(timers.size,0);r.Observe(1,{ready:true,paused:false,position:3,errorCode:0});assert.equal(timers.size,1);
 [...timers.values()][0]();await Promise.resolve();assert.deepEqual(calls,[[1,'stalled']]);r.Begin(2,true);old();await Promise.resolve();assert.equal(calls.length,1);r.Cancel();
});
test('playlist PNG icon is constrained, persists on a playlist and survives fresh-ID import', t => {
 const s=new Store(Temp(t)),id=s.data.activePlaylistId, bytes=fs.readFileSync(path.join(__dirname,'../build/music.png'));
 const small=Buffer.alloc(24);bytes.copy(small,0,0,8);small.writeUInt32BE(64,16);small.writeUInt32BE(64,20);const icon='data:image/png;base64,'+small.toString('base64');
 assert.equal(ValidateIcon(icon),icon);s.Apply({type:'playlist-properties',playlistId:id,includeInAll:true,icon});assert.equal(new Store(s.directory).Playlist(id).icon,icon);assert.equal(ValidateLibrary(s.Snapshot(),true)[0].icon,icon);
 assert.throws(()=>ValidateIcon('data:image/svg+xml,<svg>'));small.writeUInt32BE(5000,16);assert.throws(()=>ValidateIcon('data:image/png;base64,'+small.toString('base64')));
 const before=s.Snapshot();assert.throws(()=>s.Apply({type:'playlist-properties',playlistId:id,includeInAll:true,icon:'https://bad.test/a.png'}));assert.deepEqual(s.Snapshot(),before);
});
test('Bilibili embedded URL specifies the matching part CID and still defaults to 360p',()=>{
 const e=ParseBilibili('https://www.bilibili.com/video/av123/?p=2');const u=new URL(PlayerURL(e,{pages:[{page:1,cid:100},{page:2,cid:200}]}));assert.equal(u.searchParams.get('cid'),'200');assert.equal(u.searchParams.get('p'),'2');assert.equal(u.searchParams.get('qn'),'16');
});
test('Discord uses a public thumbnail and part link while retaining the icon fallback and rejecting local or unsafe links',()=>{
 const m={source:'bilibili',title:'刻ト詩',paused:false,position:20,duration:300,thumbnailURL:'http://i0.hdslb.com/a.jpg',videoURL:'https://www.bilibili.com/video/av123/?p=2&tracking=x'};
 const a=BuildActivity(m,false);assert.equal(a.assets.large_image,'favecus_player_music');assert.equal(a.assets.small_image,'https://i0.hdslb.com/a.jpg');assert.equal(a.assets.small_url,'https://www.bilibili.com/video/av123/?p=2');assert.equal(a.buttons,undefined);
 const b=BuildActivity({...m,thumbnailURL:'file:///secret',videoURL:'https://evil.test'},false);assert.equal(b.assets.large_image,'favecus_player_music');assert.equal(b.buttons,undefined);assert.equal(BuildActivity({...m,source:'local'},false).buttons,undefined);
});
