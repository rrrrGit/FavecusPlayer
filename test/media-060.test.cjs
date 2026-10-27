'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function Harness(argv=['--favecus-quality-360p']){
 let now=0,items=[],clicked=0,style;const windowEvents={},events={},commands={},messages=[],intervals=[];
 const media={readyState:2,duration:200,currentTime:20,paused:true,ended:false,volume:1,playbackRate:1,play(){this.paused=false;return Promise.resolve()},pause(){this.paused=true}};
 const item={textContent:'流畅 360P',getAttribute:()=>null,classList:{contains:()=>false},click(){clicked++}};
 const player={classList:{add(){}},querySelector:()=>media};
 const context={process:{argv},require:()=>({ipcRenderer:{on:(k,f)=>commands[k]=f,send:(...a)=>messages.push(a)}}),location:{protocol:'https:',href:'https://www.bilibili.com/video/av123/?p=2'},document:{querySelectorAll:q=>q==='video, audio'?[media]:items,querySelector:q=>q==='#bilibili-player'?player:null,getElementById:()=>style,createElement:()=>({}),head:{append:v=>style=v},addEventListener:(k,f)=>events[k]=f,title:'曲'},window:{addEventListener:(k,f)=>windowEvents[k]=f},Date:{now:()=>now},setInterval:f=>intervals.push(f)};
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/preloads/media.cjs'),'utf8'),context);windowEvents.DOMContentLoaded();return{media,messages,events,windowEvents,item,clicked:()=>clicked,style:()=>style,items:v=>items=v,tick:ms=>{now=ms;intervals.forEach(f=>f())},command:v=>commands['media:command']({},v),keys:v=>commands['media:shortcuts']({},v)};
}
test('initial 360p selection handles a delayed quality menu once and preserves trusted user choices and account windows',()=>{
 const h=Harness();assert.equal(h.clicked(),0);h.items([h.item]);h.tick(1000);assert.equal(h.clicked(),1);h.tick(2000);assert.equal(h.clicked(),1);
 const manual=Harness();manual.events.pointerdown({isTrusted:true,target:{closest:()=>true}});manual.items([manual.item]);manual.tick(1000);assert.equal(manual.clicked(),0);
 const account=Harness([]);account.items([account.item]);account.tick(1000);assert.equal(account.clicked(),0);const late=Harness();late.items([late.item]);late.tick(21000);assert.equal(late.clicked(),0);
});
test('media shortcut capture permits trusted configured keys only, suppresses repeated toggle and never intercepts typing',()=>{
 const h=Harness();h.keys({enabled:true,bindings:{toggle:'Space',forward:'ArrowRight'}});const press=extra=>{const e={code:'Space',isTrusted:true,target:{closest:()=>false},preventDefault(){this.prevented=true},stopImmediatePropagation(){},...extra};h.windowEvents.keydown(e);return e};press();assert.equal(h.messages.filter(m=>m[0]==='media:shortcut').length,1);assert.equal(press({repeat:true}).prevented,true);press({isTrusted:false});press({target:{closest:()=>true}});h.keys({enabled:false});press();assert.equal(h.messages.filter(m=>m[0]==='media:shortcut').length,1);
});
test('internal official player keeps fitting within its view and restores paused or playing positions after late metadata',()=>{
 const h=Harness(['--favecus-start-at-zero','--favecus-official-player']);assert.match(h.style().textContent,/width:100vw/);h.media.readyState=0;h.command({type:'restore',position:72,paused:false});h.tick(1000);h.media.readyState=2;h.tick(2000);assert.equal(h.media.currentTime,72);assert.equal(h.media.paused,false);h.tick(4000);assert.equal(h.media.currentTime,72);h.command({type:'restore',position:99,paused:true});assert.equal(h.media.currentTime,99);assert.equal(h.media.paused,true);
});
