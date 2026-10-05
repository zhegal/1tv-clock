import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { statesAt } from '../public/time.js';

// Exercise the complete scheduler/render/media/lifecycle wiring without a
// browser dependency. Actual browser rendering is verified separately.
async function exerciseRuntime(query, expectedProfile, injectFailure = false) {
  const originals = Object.fromEntries(['window','document','location','Image','fetch','setTimeout','clearTimeout','performance'].map(k=>[k,globalThis[k]]));
  const originalDateNow=Date.now;
  let wall=new Date(2026,9,5,8,58,37,420).getTime(), mono=10000, timerId=0;
  const timers=new Map(), draws=[];
  class Element extends EventTarget {
    children=[];append(el){this.children.push(el);} set textContent(value){this.text=value;} get textContent(){return this.text;}
  }
  const window=new EventTarget();
  const video=new Element();Object.assign(video,{currentTime:0,readyState:4,paused:true,seeking:false,playbackRate:1,error:null});
  let rejectOldPlay;
  video.play=()=>{video.paused=false;if(injectFailure && video.src.endsWith('background-high.mp4'))return new Promise((_,reject)=>{rejectOldPlay=reject;});return Promise.resolve();};video.load=()=>{video.error=null;};
  const canvas=new Element();canvas.getContext=()=>({clearRect(){draws.push('clear');},drawImage(img){draws.push(img.src);}});
  const document=new EventTarget();document.hidden=false;document.visibilityState='visible';document.body=new Element();
  document.getElementById=id=>id==='background'?video:canvas;document.createElement=()=>new Element();
  const manifest=JSON.parse(await readFile(new URL('../public/assets/manifest.json',import.meta.url)));
  globalThis.window=window;globalThis.document=document;globalThis.location={search:query};
  globalThis.Image=class{decode(){return Promise.resolve();}};
  const media=JSON.parse(await readFile(new URL('../public/assets/media-manifest.json',import.meta.url)));
  globalThis.fetch=async url=>({ok:true,json:async()=>String(url).endsWith('media-manifest.json')?media:manifest});
  globalThis.setTimeout=(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;};globalThis.clearTimeout=id=>timers.delete(id);
  globalThis.performance={now:()=>mono};Date.now=()=>wall;
  const drain=async()=>{for(let i=0;i<600;i++)await Promise.resolve();};
  const tick=()=>{const scheduled=[...timers].filter(([,t])=>t.delay<=1001);assert.equal(scheduled.length,1);const [id,t]=scheduled[0];timers.delete(id);t.fn();};
  try {
    await import(`../public/clock.js?runtime-test-${encodeURIComponent(query)}`);await drain();
    if(injectFailure){video.error={code:4};video.dispatchEvent(new Event('error'));rejectOldPlay(Object.assign(new Error('old source failed'),{name:'NotSupportedError'}));await drain();}
    assert.equal(document.body.children.length,query.includes('debug=1')?1:0,'production has no debug UI');
    assert.ok(video.src.endsWith(`background-${expectedProfile}.mp4`));
    assert.equal(video.paused,false);
    assert.ok(Math.abs(video.currentTime-37.42)<1e-6);
    const initialDrawCount=draws.length;
    // A repeated callback within one second must not redraw any layer.
    mono+=100;wall+=100;video.currentTime+=.1;tick();assert.equal(draws.length,initialDrawCount);
    if(injectFailure){const data=JSON.parse(document.body.children[0].children.at(-1).textContent);assert.equal(data.videoFallbacks,1);assert.equal(data.videoError,'');assert.equal(data.videoRetries,0);}
    // A 500ms dropped callback crosses the second boundary. State comes
    // directly from wall time rather than taking one animation step.
    mono+=500;wall+=500;video.currentTime+=.5;tick();
    let state=statesAt(wall);assert.ok(draws.at(-1).endsWith(`sec-${String(state.second).padStart(3,'0')}.png`));
    // Freeze the browser for five minutes and thirteen seconds.
    mono+=313000;wall+=313000;tick();state=statesAt(wall);
    assert.ok(draws.at(-1).endsWith(`sec-${String(state.second).padStart(3,'0')}.png`));
    assert.ok(draws.at(-3).endsWith(`hour-${String(state.hour).padStart(3,'0')}.png`));
    assert.ok(Math.abs(video.currentTime-((wall%60000)/1000))<1e-6);
    // Backward system correction and event-driven recovery.
    wall-=172350;mono+=100;window.dispatchEvent(new Event('focus'));state=statesAt(wall);
    assert.ok(draws.at(-1).endsWith(`sec-${String(state.second).padStart(3,'0')}.png`));
    // Seek cooldown intentionally preserves the native pipeline briefly.
    mono+=2000;wall+=2000;window.dispatchEvent(new Event('pageshow'));
    assert.ok(Math.abs(video.currentTime-((wall%60000)/1000))<1e-6);
    document.hidden=true;document.visibilityState='hidden';wall+=300000;mono+=300000;
    document.hidden=false;document.visibilityState='visible';document.dispatchEvent(new Event('visibilitychange'));
    state=statesAt(wall);assert.ok(draws.at(-2).endsWith(`min-${String(state.minute).padStart(3,'0')}.png`));
    // Teardown removes timers; a persisted pagehide would instead retain them.
    const hide=new Event('pagehide');hide.persisted=false;window.dispatchEvent(hide);assert.equal(timers.size,0);
  } finally { Date.now=originalDateNow;for(const [k,v] of Object.entries(originals))globalThis[k]=v; }
}
for (const [query,profile] of [['?audio=unknown','high'],['?audio=day&quality=high','high'],['?audio=night&quality=medium','medium'],['?quality=low','low'],['?audio=night&quality=bogus','high']]) {
  test(`runtime phase and lifecycle remain correct for ${query}`,()=>exerciseRuntime(query,profile));
}
test('late play rejection from failed source cannot poison the new video profile',()=>exerciseRuntime('?quality=high&debug=1','medium',true));
