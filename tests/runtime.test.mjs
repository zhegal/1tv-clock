import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { statesAt } from '../public/time.js';

// Exercise the complete scheduler/render/media/lifecycle wiring without a
// browser dependency. Actual browser rendering is verified separately.
async function exerciseRuntime(query, expectedProfile, injectFailure = false, slowImage = false) {
  const originals = Object.fromEntries(['window','document','location','Image','fetch','setTimeout','clearTimeout','performance'].map(k=>[k,globalThis[k]]));
  const originalDateNow=Date.now;
  let wall=new Date(2026,9,5,8,58,37,420).getTime(), mono=10000, timerId=0;
  const timers=new Map(), draws=[];
  class Element extends EventTarget {
    hidden=false; attributes=new Map(); classList={values:new Set(),add(v){this.values.add(v);},remove(v){this.values.delete(v);},contains(v){return this.values.has(v);}};
    children=[];append(el){this.children.push(el);} set textContent(value){this.text=value;} get textContent(){return this.text;}
    setAttribute(name,value){this.attributes.set(name,value);} removeAttribute(name){this.attributes.delete(name);if(name==='src')this.src='';}
  }
  const window=new EventTarget();
  const videos=[new Element(),new Element()];let video=videos[0];videos[0].id='background';videos[1].id='background-next';video.classList.add('is-active');
  let rejectOldPlay, autoplayBlocked=query.includes('blocked-test=1');
  for(const element of videos){
    Object.assign(element,{currentTime:0,duration:60,readyState:4,paused:true,seeking:false,playbackRate:1,error:null,buffered:{length:1,start:()=>0,end:()=>60},frames:new Map(),frameId:0});
    element.play=()=>{if(autoplayBlocked)return Promise.reject(Object.assign(new Error('activation required'),{name:'NotAllowedError'}));element.paused=false;if(injectFailure && element.src.endsWith('background-high.mp4'))return new Promise((_,reject)=>{rejectOldPlay=reject;});return Promise.resolve();};
    element.pause=()=>{element.paused=true;element.dispatchEvent(new Event('pause'));};
    element.load=()=>{element.error=null;element.currentTime=0;element.paused=true;if(element.src)element.dispatchEvent(new Event('loadedmetadata'));};
    element.requestVideoFrameCallback=fn=>{const id=++element.frameId;element.frames.set(id,fn);return id;};element.cancelVideoFrameCallback=id=>element.frames.delete(id);
  }
  const present=element=>{const callbacks=[...element.frames];element.frames.clear();for(const [,fn]of callbacks)fn(mono,{mediaTime:element.currentTime});};
  const canvas=new Element();canvas.getContext=()=>({clearRect(){draws.push('clear');},drawImage(img){draws.push(img.src);}});
  const document=new EventTarget();document.hidden=false;document.visibilityState='visible';document.body=new Element();
  const elements=Object.fromEntries(['stage','clock','loader','load-progress','load-status','start-playback','fullscreen-message'].map(id=>[id,new Element()]));
  for(const element of Object.values(elements))element.ownerDocument=document;
  document.getElementById=id=>videos.find(el=>el.id===id)||(id==='hands'?canvas:elements[id]);document.createElement=()=>new Element();
  const manifest=JSON.parse(await readFile(new URL('../public/assets/manifest.json',import.meta.url)));
  globalThis.window=window;globalThis.document=document;globalThis.location={search:query};
  let releaseImage, releaseBackground;
  const backgroundFile=manifest.hands.hour[(statesAt(wall).hour+3)%240].file;
  globalThis.Image=class{decode(){if(slowImage&&!releaseImage)return new Promise(resolve=>{releaseImage=resolve;});if(query.includes('background-test=1')&&this.src.endsWith(backgroundFile)&&!releaseBackground)return new Promise(resolve=>{releaseBackground=resolve;});return Promise.resolve();}};
  const media=JSON.parse(await readFile(new URL('../public/assets/media-manifest.json',import.meta.url)));
  globalThis.fetch=async url=>({ok:true,json:async()=>String(url).endsWith('media-manifest.json')?media:manifest});
  globalThis.setTimeout=(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;};globalThis.clearTimeout=id=>timers.delete(id);
  globalThis.performance={now:()=>mono};Date.now=()=>wall;
  const drain=async()=>{for(let i=0;i<4000;i++)await Promise.resolve();};
  const tick=()=>{const scheduled=[...timers].filter(([,t])=>t.delay<=1001&&t.delay!==150);assert.equal(scheduled.length,1);const [id,t]=scheduled[0];timers.delete(id);t.fn();};
  try {
    await import(`../public/clock.js?runtime-test-${encodeURIComponent(query)}`);await drain();
    assert.ok(video.src.endsWith('background-low.mp4'),'startup uses the lightest supported profile');
    assert.equal(elements.loader.hidden,false,'loader waits for a presented frame');
    if(autoplayBlocked){assert.equal(elements['start-playback'].hidden,false);assert.equal(video.paused,true);autoplayBlocked=false;elements['start-playback'].dispatchEvent(new Event('click'));await drain();}
    present(video);await drain();
    if(slowImage){assert.equal(elements.loader.hidden,false,'video cannot reveal partly loaded hands');wall+=1500;mono+=1500;video.currentTime+=1.5;releaseImage();await drain();assert.equal(elements.loader.hidden,false,'old presented frame cannot reveal unsynchronized content');present(video);await drain();}
    assert.equal(elements.loader.hidden,true,'complete clock is revealed together');
    if(query.includes('background-test=1')){
      tick();
      const data=JSON.parse(document.body.children[0].children.at(-1).textContent);
      assert.equal(data.startupReady,true);assert.ok(data.decodedStates<540,'distant state does not delay startup');
      mono+=60000;wall+=60000;video.currentTime=(video.currentTime+60)%60;tick();const state=statesAt(wall);
      assert.ok(draws.at(-1).endsWith(`sec-${String(state.second).padStart(3,'0')}.png`));
      assert.ok(draws.at(-2).endsWith(`min-${String(state.minute).padStart(3,'0')}.png`));
      releaseBackground();await drain();
    }
    if(expectedProfile!=='low'){
      let pending=videos.find(el=>el!==video);
      if(injectFailure){pending.error={code:4};pending.dispatchEvent(new Event('error'));await drain();mono+=100;wall+=100;video.currentTime+=.1;tick();await drain();pending=videos.find(el=>el!==video);}
      present(pending);await drain();video=videos.find(el=>el.classList.contains('is-active'));
      if(injectFailure){rejectOldPlay(Object.assign(new Error('old source failed'),{name:'NotSupportedError'}));await drain();}
    }
    assert.equal(document.body.children.length,query.includes('debug=1')?1:0,'production has no debug UI');
    assert.ok(video.src.endsWith(`background-${expectedProfile}.mp4`));
    assert.equal(video.paused,false);
    assert.ok(Math.abs(video.currentTime-((wall%60000)/1000))<1e-6);
    const initialDrawCount=draws.length;
    // A repeated callback within one second must not redraw any layer.
    mono+=20;wall+=20;video.currentTime+=.02;tick();assert.equal(draws.length,initialDrawCount);
    if(injectFailure){const data=JSON.parse(document.body.children[0].children.at(-1).textContent);assert.equal(data.videoFallbacks,1);assert.equal(data.videoError,'');assert.equal(data.videoRetries,0);}
    // A 500ms dropped callback crosses the second boundary. State comes
    // directly from wall time rather than taking one animation step.
    const boundaryDelay=1000-(wall%1000)+5;mono+=boundaryDelay;wall+=boundaryDelay;video.currentTime+=boundaryDelay/1000;tick();
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
test('startup waits for delayed hand decoding and a fresh synchronized video frame',()=>exerciseRuntime('?quality=high&debug=1&slow-test=1','high',false,true));
test('blocked mobile autoplay keeps the loader visible until its start button is used',()=>exerciseRuntime('?quality=low&debug=1&blocked-test=1','low'));
test('distant hand states load after startup without freezing the next minute',()=>exerciseRuntime('?quality=low&debug=1&background-test=1','low'));
