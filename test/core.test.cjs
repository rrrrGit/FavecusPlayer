'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { ParseBilibili, PlayerURL, IsAllowedRemote } = require('../src/core/urls.cjs');
const { Store, ValidateLibrary } = require('../src/core/store.cjs');
const { Queue } = require('../src/core/queue.cjs');
const { EncodeFrame, FrameDecoder, DiscordPresence, BuildActivity } = require('../src/core/discord.cjs');
const { ParseRange, MediaResponse } = require('../src/core/files.cjs');

function Temp(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-test-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; }
test('media response releases short-lived requests exactly once on HEAD, invalid range and missing data', async t => {
  const file = path.join(Temp(t), 'media.mp4'); fs.writeFileSync(file, 'media');
  for (const [name, options, status] of [[file, { method: 'HEAD' }, 200], [file, { headers: { Range: 'bytes=99-' } }, 416], [file + '.missing', {}, 404]]) {
    let releases = 0; const response = await MediaResponse(new Request('http://example.test', options), name, () => releases++); assert.equal(response.status, status); assert.equal(releases, 1);
  }
});
test('media response releases a stream when consumed or cancelled and on an already-aborted request', { timeout: 3000 }, async t => {
  const file = path.join(Temp(t), 'media.mp4'); fs.writeFileSync(file, Buffer.alloc(1024 * 1024));
  for (const action of ['read', 'cancel', 'abort']) {
    let releases = 0, complete; const released = new Promise(resolve => complete = resolve), controller = new AbortController(); if (action === 'abort') controller.abort();
    const response = await MediaResponse(new Request('http://example.test', { signal: controller.signal }), file, () => { releases++; complete(); });
    if (action === 'read') await response.arrayBuffer(); else if (action === 'cancel') await response.body.cancel(); else await assert.rejects(response.arrayBuffer());
    await released; assert.equal(releases, 1, action);
  }
});

test('Bilibili URL preserves the selected part and removes tracking', () => {
  const entry = ParseBilibili('https://www.bilibili.com/video/BV1B7411m7LV/?p=3&spm_id_from=abc');
  assert.equal(entry.part, 3); assert.equal(entry.url, 'https://www.bilibili.com/video/BV1B7411m7LV/?p=3');
  const player = new URL(PlayerURL(entry));
  assert.equal(player.origin, 'https://player.bilibili.com'); assert.equal(player.searchParams.get('p'), '3');
  assert.equal(player.searchParams.get('danmaku'), '0'); assert.equal(player.searchParams.get('autoplay'), '1');
  assert.equal(ParseBilibili(player.href).url, entry.url);
});
test('BV/av identifiers work and unsafe hosts, schemes and part values fail', () => {
  assert.equal(ParseBilibili('BV1B7411m7LV').videoId, 'BV1B7411m7LV');
  assert.equal(new URL(PlayerURL(ParseBilibili('av12345'))).searchParams.get('aid'), '12345');
  for (const input of ['javascript:alert(1)', 'file:///etc/passwd', 'https://www.bilibili.com.evil.test/video/BV1B7411m7LV', 'https://evil.test@www.bilibili.com/video/BV1B7411m7LV', 'https://www.bilibili.com/video/BV1B7411m7LV?p=0', 'https://www.bilibili.com/video/BV1B7411m7LV?p=NaN']) assert.throws(() => ParseBilibili(input));
  assert.equal(IsAllowedRemote('https://accounts.google.com/', 'youtube'), false);
  assert.equal(IsAllowedRemote('https://accounts.google.com.evil.test/', 'youtube'), false);
});
test('queue stops at the end, repeats one automatically and keeps manual next', () => {
  const q = new Queue(); q.Start('list', [{id:'a'},{id:'b'},{id:'c'}], 'b', false);
  assert.equal(q.Move(1, 'one', true), 'b'); assert.equal(q.Move(1, 'one', false), 'c');
  assert.equal(q.Move(1, 'off', true), null); assert.equal(q.Move(1, 'all', true), 'a');
  assert.equal(q.Move(-1, 'all'), 'c');
});
test('shuffle contains every item once and previous retraces that order', () => {
  const q = new Queue(() => .25), entries = ['a','b','c','d'].map(id => ({id}));
  q.Start('list', entries, 'c', true); assert.equal(q.ids[0], 'c'); assert.equal(new Set(q.ids).size, 4);
  const next = q.Move(1, 'off'); assert.notEqual(next, 'c'); assert.equal(q.Move(-1, 'off'), 'c');
});
test('playlists persist titles/order/settings and reject an entire invalid add batch', t => {
  const root = Temp(t), store = new Store(root), id = store.data.activePlaylistId;
  store.Apply({ type:'add', playlistId:id, urls:'BV1B7411m7LV\nav12345' });
  const entryId = store.Playlist(id).entries[1].id;
  store.Apply({ type:'title', playlistId:id, entryId, title:'お気に入りの音楽' });
  store.Apply({ type:'move', playlistId:id, entryId, direction:-1 });
  assert.throws(() => store.Apply({ type:'add', playlistId:id, urls:'av222\ninvalid' }));
  const restored = new Store(root);
  assert.equal(restored.Playlist(id).entries.length, 2); assert.equal(restored.Playlist(id).entries[0].title, 'お気に入りの音楽');
  assert.equal(Object.hasOwn(restored.Snapshot(), 'bridgeToken'), false);
});
test('a corrupt primary store restores the backup and preserves damaged bytes', t => {
  const root = Temp(t), store = new Store(root), id = store.data.activePlaylistId;
  store.Apply({type:'rename', playlistId:id, name:'バックアップ'});
  store.Apply({type:'rename', playlistId:id, name:'現在'});
  fs.writeFileSync(store.file, '{broken');
  const restored = new Store(root);
  assert.equal(restored.Playlist(id).name, 'バックアップ'); assert.match(restored.warning, /バックアップ/);
  assert.ok(fs.readdirSync(root).some(x => x.includes('.damaged-')));
});
test('export and import carry media bytes and keep account/Discord keys out', async t => {
  const root = Temp(t), store = new Store(path.join(root, 'first')), id = store.data.activePlaylistId;
  const media = path.join(root, 'sample.mp4'); fs.writeFileSync(media, 'test media bytes');
  await store.AddFiles(id, [media]); store.Apply({type:'add',playlistId:id,urls:'BV1B7411m7LV'});
  const exported = await store.Export(root), manifest = path.join(exported.folder, 'favecus-player-library.json');
  const raw = fs.readFileSync(manifest,'utf8'); assert.ok(!raw.includes('bridgeToken')); assert.ok(!raw.includes('settings'));
  const second = new Store(path.join(root, 'second')); const result = await second.Import(manifest);
  assert.equal(result.missing,0); assert.equal(second.data.playlists.length,2);
  const added = second.Playlist(second.data.activePlaylistId); assert.equal(added.id,id);
  assert.equal(fs.readFileSync(path.join(second.media,added.entries[0].fileName),'utf8'),'test media bytes');
  assert.equal(added.entries[1].videoId,'BV1B7411m7LV');
});
test('import blocks traversal and does not follow media symlinks', async t => {
  for (const name of ['../../secret.mp4','C:\\secret.mp4','file:///etc/passwd']) assert.throws(() => ValidateLibrary({version:1,playlists:[{entries:[{type:'local',fileName:name}]}]}));
  const root=Temp(t), source=path.join(root,'package'), filename='12345678-1234-1234-1234-123456789012.mp4';
  fs.mkdirSync(path.join(source,'media'),{recursive:true}); fs.writeFileSync(path.join(root,'secret'),'private');
  try { fs.symlinkSync(path.join(root,'secret'),path.join(source,'media',filename)); }
  catch(error) { if(['EPERM','EACCES','ENOSYS'].includes(error.code)) { t.skip('This OS does not permit symlink creation for this user'); return; } throw error; }
  const manifest=path.join(source,'favecus-player-library.json');
  fs.writeFileSync(manifest,JSON.stringify({version:1,playlists:[{name:'test',entries:[{type:'local',fileName:filename}]}]}));
  const store=new Store(path.join(root,'app')); const result=await store.Import(manifest);
  assert.equal(result.missing,1); assert.equal(fs.readdirSync(store.media).length,0);
});
test('media ranges support seeking, suffix ranges, and reject invalid ranges', async t => {
  assert.deepEqual(ParseRange('bytes=3-5',10),{start:3,end:5}); assert.deepEqual(ParseRange('bytes=-3',10),{start:7,end:9});
  for (const value of ['bytes=15-','bytes=4-2','bytes=0-1,4-5','bytes=-0']) assert.throws(()=>ParseRange(value,10));
  const file=path.join(Temp(t),'movie.mp4'); fs.writeFileSync(file,'0123456789');
  const response=await MediaResponse(new Request('http://example.test',{headers:{Range:'bytes=3-5'}}),file);
  assert.equal(response.status,206); assert.equal(await response.text(),'345'); assert.equal(response.headers.get('content-range'),'bytes 3-5/10');
});
test('Discord frames tolerate fragmented and joined input', () => {
  const first=EncodeFrame(1,{evt:'READY'}), second=EncodeFrame(3,{ping:1}), decoder=new FrameDecoder();
  assert.deepEqual(decoder.Push(first.subarray(0,3)),[]);
  assert.deepEqual(decoder.Push(Buffer.concat([first.subarray(3),second])),[{opcode:1,data:{evt:'READY'}},{opcode:3,data:{ping:1}}]);
  const invalid=Buffer.alloc(8);invalid.writeUInt32LE(2*1024*1024,4); assert.throws(()=>new FrameDecoder().Push(invalid));
});
test('Discord activity uses real time and clears for pause, ads, or ended playback', () => {
  const media={source:'bilibili',title:'曲名',artist:'作者',position:12,duration:200,paused:false};
  const value=BuildActivity(media,true,1000000); assert.equal(value.type,2); assert.deepEqual(value.timestamps,{start:988,end:1188});
  assert.equal(BuildActivity({...media,paused:true},true),null); assert.equal(BuildActivity({...media,isAd:true},false),null); assert.equal(BuildActivity({...media,ended:true},false),null);
  assert.equal(BuildActivity({...media,playbackRate:2},false).timestamps,undefined);
  assert.ok(Buffer.byteLength(BuildActivity({...media,title:'長い日本語'.repeat(100)},false).details)<=120);
});
test('Discord frame exchange over mock transport handshakes, sends and clears', {timeout:8000}, async t => {
  const server=net.createServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const socketPath={host:'127.0.0.1',port:server.address().port};
  t.after(()=>server.close()); let connection;
  const commands=[]; let resolveSet,resolveClear;
  const sent=new Promise(r=>resolveSet=r), cleared=new Promise(r=>resolveClear=r);
  server.on('connection',socket=>{
    connection=socket; const decoder=new FrameDecoder();
    socket.on('data',chunk=>{ for(const frame of decoder.Push(chunk)) {
      commands.push(frame);
      if(frame.opcode===0) socket.write(EncodeFrame(1,{evt:'READY'}));
      if(frame.data?.cmd==='SET_ACTIVITY') { if(frame.data.args.activity) resolveSet(frame.data); else resolveClear(frame.data); }
    }});
  });
  const client=new DiscordPresence(()=>{}, {paths:[socketPath]}); t.after(()=>{client.Stop();connection?.destroy();});
  client.SetActivity({details:'動画名',state:'Bilibili',type:3}); client.Configure(true,'123456789012345678');
  const message=await sent; assert.equal(message.args.activity.details,'動画名');assert.equal(commands[0].data.client_id,'123456789012345678');
  client.SetActivity(null); const clear=await cleared;assert.equal(clear.args.activity,null);
});
