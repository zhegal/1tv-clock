import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuality, chooseQuality, videoCandidates, audioCandidates, assetURL } from '../public/media.js';
import { statesAt, phaseAt } from '../public/time.js';
import { buildPages } from '../scripts/build-pages.mjs';
import { readFile, mkdtemp, cp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const manifest = JSON.parse(await readFile(new URL('../public/assets/media-manifest.json', import.meta.url)));

test('quality parsing and explicit precedence; auto uses physical width and optional connection', () => {
  for (const q of ['auto','high','medium','low']) assert.equal(parseQuality(q),q);
  for (const q of [null,'','HIGH','nonsense']) assert.equal(parseQuality(q),'auto');
  assert.equal(chooseQuality('auto',{width:390,dpr:1}),'low');
  assert.equal(chooseQuality('auto',{width:390,dpr:2}),'medium');
  assert.equal(chooseQuality('auto',{width:390,dpr:3}),'high');
  assert.equal(chooseQuality('auto',{width:1440,dpr:2,saveData:true}),'low');
  assert.equal(chooseQuality('auto',{width:1440,effectiveType:'3g'}),'medium');
  assert.equal(chooseQuality('unknown',{}),'high');
  assert.equal(chooseQuality('high',{width:100,saveData:true}),'high');
});

test('video candidates descend through supported production profiles', () => {
  assert.deepEqual(Object.keys(manifest.video),['high','medium','low']);
  assert.deepEqual(videoCandidates(manifest,'high',{}).map(x=>x.name),['high','medium','low']);
  assert.deepEqual(videoCandidates(manifest,'medium',{}).map(x=>x.name),['medium','low']);
  assert.deepEqual(videoCandidates(manifest,'low',{}).map(x=>x.name),['low']);
  assert.deepEqual(videoCandidates(manifest,'high',{},mime=>mime.includes('64001f')).map(x=>x.name),['low']);
});

test('day/night candidate order and quality leave clock state and phase independent', () => {
  for (const mode of ['day','night']) for (const q of ['auto','high','medium','low']) {
    const entries=audioCandidates(manifest,mode);
    assert.deepEqual(entries.map(x=>x.file),[`${mode}.ogg`,`${mode}.wav`]);
    assert.equal(audioCandidates(manifest,mode,()=>false)[0].format,'wav');
    for (const epoch of [0,59999,60000,86399999]) {
      const state=statesAt(epoch), phase=phaseAt(epoch);
      chooseQuality(q,{width:390,dpr:3});
      assert.deepEqual(statesAt(epoch),state);assert.equal(phaseAt(epoch),phase);
    }
  }
});

test('dynamic assets resolve within a project subpath', () => {
  assert.equal(assetURL('night.ogg','https://example.github.io/channel-one-clock/media.js'),'https://example.github.io/channel-one-clock/assets/night.ogg');
  assert.equal(assetURL('hands/hour-001.png','https://example.github.io/channel-one-clock/media.js'),'https://example.github.io/channel-one-clock/assets/hands/hour-001.png');
});

test('Pages build copies the complete static product without changing manifests', async () => {
  const temp=await mkdtemp(join(tmpdir(),'channel-one-pages-'));
  try {
    const source=join(temp,'public'), output=join(temp,'site');
    await cp(new URL('../public/',import.meta.url),source,{recursive:true});
    assert.equal(await buildPages(source,output),559);
    assert.equal(await readFile(join(output,'assets/media-manifest.json'),'utf8'),await readFile(join(source,'assets/media-manifest.json'),'utf8'));
    const inputFiles=(await readdir(source,{recursive:true})).sort();
    const outputFiles=(await readdir(output,{recursive:true})).filter(x=>x!=='.nojekyll').sort();
    assert.deepEqual(outputFiles,inputFiles);
    assert.ok(outputFiles.includes('assets/night.ogg'));
  } finally { await rm(temp,{recursive:true,force:true}); }
});
