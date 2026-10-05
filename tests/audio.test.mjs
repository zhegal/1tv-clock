import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopAudio } from '../public/audio.js';
import { phaseAt, phaseError } from '../public/time.js';
class Param {
  value=1; events=[];
  setValueAtTime(value,time){this.value=value;this.events.push(['set',value,time]);}
  linearRampToValueAtTime(value,time){this.value=value;this.events.push(['ramp',value,time]);}
  cancelScheduledValues(time){this.events.push(['cancel',time]);}
}
class Source extends EventTarget {
  playbackRate=new Param(); disconnected=false; startArgs=null; stopAt=null;
  connect(){} disconnect(){this.disconnected=true;}
  start(...args){this.startArgs=args;}
  stop(time){this.stopAt=time;}
}
class Context extends EventTarget {
  state='suspended'; currentTime=0; baseLatency=.01; outputLatency=.03; destination={};
  sources=[]; gains=[]; resumeCalls=0; blocked=true;
  createBufferSource(){const s=new Source();this.sources.push(s);return s;}
  createGain(){const g={gain:new Param(),connect(){},disconnect(){this.disconnected=true;}};this.gains.push(g);return g;}
  resume(){
    this.resumeCalls++;
    if(this.blocked)return new Promise(resolve=>{(this.waiters??=[]).push(resolve);});
    this.state='running';this.dispatchEvent(new Event('statechange'));
    for(const resolve of this.waiters||[])resolve();this.waiters=[];
    return Promise.resolve();
  }
  close(){this.state='closed';return Promise.resolve();}
}
const drain = async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
function setup() {
  const win=new EventTarget();win.AudioContext=Context;globalThis.window=win;
  let wall=20_000;
  const audio=new LoopAudio('day',()=>wall,()=>{});audio.context=new Context();
  audio.buffer={duration:60,sampleRate:48000};
  return {audio,ctx:audio.context,setWall:n=>wall=n};
}
test('blocked autoplay is bounded; later gesture starts at wall phase plus output latency', async()=>{
  const {audio,ctx,setWall}=setup();audio.installUnlock();audio.resume(false);
  for(let i=0;i<1000;i++)audio.resume(false);
  assert.equal(ctx.resumeCalls,1); assert.equal(audio.voices.size,0);
  setWall(27_350);ctx.blocked=false;audio.resume(true);await drain();
  assert.equal(ctx.resumeCalls,2);assert.equal(audio.status,'running');assert.equal(audio.voices.size,1);
  assert.equal(audio.listenerController,null);
  // Audible playback will start 80ms later: schedule offset must account for it.
  assert.ok(Math.abs(ctx.sources[0].startArgs[1]-27.43)<1e-6);
  audio.dispose();await drain();assert.equal(audio.voices.size,0);assert.equal(ctx.state,'closed');
});
test('thousands of normal loops reuse one source and never accumulate nodes', ()=>{
  const {audio,ctx,setWall}=setup();ctx.state='running';setWall(0);audio.sync();
  for(let i=1;i<=10000;i++){
    ctx.currentTime=i*60;setWall(i*60_000);audio.sync();
  }
  assert.equal(ctx.sources.length,1);assert.equal(audio.voices.size,1);assert.equal(audio.restarts,1);
  assert.ok(Math.abs(phaseError(audio.phase(),phaseAt(600000000)))<1e-6);
  audio.dispose();
});
test('unlocked audio stays silent behind the loader and starts at current time on reveal', async()=>{
  const {audio,ctx,setWall}=setup();audio.enabled=false;ctx.blocked=false;
  audio.resume(true);await drain();audio.sync(true);audio.start();
  assert.equal(ctx.state,'running');assert.equal(ctx.sources.length,0);
  ctx.currentTime=8;setWall(49_200);audio.enabled=true;audio.sync(true);
  assert.equal(ctx.sources.length,1);assert.ok(Math.abs(ctx.sources[0].startArgs[1]-49.28)<1e-6);
  audio.dispose();
});
test('wall time jump crossfades with old voice stopped and disconnected', ()=>{
  const {audio,ctx,setWall}=setup();ctx.state='running';audio.sync();
  audio.lastRestart=-Infinity;ctx.currentTime=1;setWall(26_000);audio.sync(true);
  assert.equal(ctx.sources.length,2);assert.equal(audio.voices.size,2);
  assert.ok(ctx.sources[0].stopAt>ctx.sources[1].startArgs[0]);
  ctx.sources[0].dispatchEvent(new Event('ended'));
  assert.equal(audio.voices.size,1);assert.equal(ctx.sources[0].disconnected,true);assert.equal(ctx.gains[0].disconnected,true);
  assert.ok(Math.abs(phaseError(audio.phase(),26))<1e-6);
  audio.dispose();
});
test('soft drift rate changes maintain the exact source phase anchor', ()=>{
  const {audio,ctx,setWall}=setup();ctx.state='running';audio.sync();
  ctx.currentTime=1;setWall(20_950);audio.sync();
  assert.ok(Math.abs(audio.voice.rate-.999)<1e-9);const before=audio.voicePhase(2);
  ctx.currentTime=2;setWall((before-.04)*1000);audio.sync();
  assert.equal(audio.voice.rate,1);assert.ok(Math.abs(phaseError(before,audio.voicePhase(2)))<1e-9);
  assert.equal(ctx.sources.length,1);audio.dispose();
});
test('suspended context resumes at current phase after sleep', async()=>{
  const {audio,ctx,setWall}=setup();ctx.state='running';audio.sync();
  ctx.state='suspended';audio.lastRestart=-Infinity;setWall(205_000);ctx.blocked=false;
  audio.sync(true);await drain();
  assert.equal(ctx.state,'running');assert.equal(ctx.sources.length,2);
  assert.ok(Math.abs(phaseError(audio.phase(),25))<1e-6);audio.dispose();
});
test('audio tries decode failures and invalid decoded duration sequentially, then retains only successful WAV', async()=>{
  const previousFetch=globalThis.fetch;
  const {audio,ctx}=setup();audio.buffer=null;
  audio.candidates=[{file:'bad.ogg',format:'opus'},{file:'padded.ogg',format:'opus'},{file:'day.wav',format:'wav'}];
  const fetched=[];let decoding=false;
  globalThis.fetch=async url=>{assert.equal(decoding,false);fetched.push(String(url).split('/').at(-1));return {ok:true,arrayBuffer:async()=>fetched.length};};
  ctx.decodeAudioData=async id=>{decoding=true;await Promise.resolve();decoding=false;if(id===1)throw new Error('decode failed');return {duration:id===2?60.010666:60,sampleRate:48000};};
  try {
    await audio.load();assert.deepEqual(fetched,['bad.ogg','padded.ogg','day.wav']);
    assert.equal(audio.selected.format,'wav');assert.equal(audio.buffer.duration,60);assert.equal(audio.fallbacks,2);assert.equal(audio.error,'');
    await audio.load();assert.equal(fetched.length,3);
  } finally {audio.dispose();globalThis.fetch=previousFetch;}
});
test('successful compact audio never downloads the WAV candidate', async()=>{
  const previousFetch=globalThis.fetch;const {audio,ctx}=setup();audio.buffer=null;
  audio.candidates=[{file:'night.ogg',format:'opus'},{file:'night.wav',format:'wav'}];const fetched=[];
  globalThis.fetch=async url=>{fetched.push(url);return {ok:true,arrayBuffer:async()=>new ArrayBuffer(1)};};
  ctx.decodeAudioData=async()=>({duration:60,sampleRate:44100});
  try {await audio.load();assert.equal(audio.selected.format,'opus');assert.equal(fetched.length,1);assert.equal(audio.voices.size,0);} finally {audio.dispose();globalThis.fetch=previousFetch;}
});
