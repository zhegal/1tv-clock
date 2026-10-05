// Validate static runtime URLs and video Range requests.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.argv[2] || 'http://127.0.0.1:4175/channel-one-clock/';
const hands=JSON.parse(await readFile(new URL('../public/assets/manifest.json',import.meta.url)));
const media=JSON.parse(await readFile(new URL('../public/assets/media-manifest.json',import.meta.url)));
const files=['index.html','clock.css','clock.js','audio.js','media.js','time.js','assets/poster.jpg','assets/manifest.json','assets/media-manifest.json',...Object.values(hands.hands).flat().map(x=>'assets/'+x.file),...['high','medium','low'].map(k=>'assets/'+media.video[k].file),...Object.values(media.audio).flat().map(x=>'assets/'+x.file)];
let index=0;
await Promise.all(Array.from({length:8},async()=>{while(index<files.length){const file=files[index++];const response=await fetch(new URL(file,base),{method:'HEAD'});assert.equal(response.status,200,file);assert.ok(Number(response.headers.get('content-length'))>0,file);}}));
const deployed=await (await fetch(new URL('assets/media-manifest.json',base))).json();assert.deepEqual(deployed,media);
for(const row of Object.values(deployed.video)){
 const response=await fetch(new URL('assets/'+row.file,base),{headers:{Range:'bytes=0-63'}});assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,64);
}
console.log(`${files.length} subpath URLs return 200; MP4 Range 206.`);
