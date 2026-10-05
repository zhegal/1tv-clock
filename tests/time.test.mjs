import test from 'node:test';
import assert from 'node:assert/strict';
import { statesAt, phaseAt, phaseError, videoCorrection, audioCorrection, ClockMonitor } from '../public/time.js';
const at = (h, m, s, ms = 0) => new Date(2026, 9, 5, h, m, s, ms).getTime();
test('minute and hour boundaries use the 240-state hand sequences', () => {
  assert.deepEqual(statesAt(at(8,58,14,999)), {second:14,minute:232,hour:179});
  assert.deepEqual(statesAt(at(8,58,15)), {second:15,minute:233,hour:179});
  assert.deepEqual(statesAt(at(8,58,30)), {second:30,minute:234,hour:179});
  assert.deepEqual(statesAt(at(8,58,45)), {second:45,minute:235,hour:179});
  assert.deepEqual(statesAt(at(8,59,59,999)), {second:59,minute:239,hour:179});
  assert.deepEqual(statesAt(at(9,0,0)), {second:0,minute:0,hour:180});
  assert.equal(statesAt(at(8,56,59,999)).hour, 178);
  assert.equal(statesAt(at(8,57,0)).hour, 179);
  assert.deepEqual(statesAt(at(12,0,0)), {second:0,minute:0,hour:0});
  assert.deepEqual(statesAt(at(23,59,59)), {second:59,minute:239,hour:239});
});
test('each hand state is selected, with no missing or out-of-range state over 24h', () => {
  const seen = {second:new Set(), minute:new Set(), hour:new Set()};
  for (let h=0;h<24;h++) for (let m=0;m<60;m++) for (let s=0;s<60;s++) {
    const state = statesAt(at(h,m,s));
    assert.equal(state.second,s); assert.equal(state.minute,m*4+Math.floor(s/15));
    assert.equal(state.hour,(h%12)*20+Math.floor(m/3));
    for (const key in seen) seen[key].add(state[key]);
  }
  assert.equal(seen.second.size,60); assert.equal(seen.minute.size,240); assert.equal(seen.hour.size,240);
});
test('circular media errors cross the seam without triggering a false 60s seek', () => {
  assert.ok(Math.abs(phaseError(59.99,.01)+.02)<1e-9);
  assert.ok(Math.abs(phaseError(.01,59.99)-.02)<1e-9);
  assert.ok(Math.abs(phaseAt(at(8,58,37,420))-37.42)<1e-6);
  assert.equal(phaseAt(at(8,59,0)),0);
  assert.equal(videoCorrection(phaseError(.01,59.99)).seek,false);
  assert.equal(audioCorrection(phaseError(.005,59.995)).restart,false);
});
test('seek only for large drift; rates correct in the right direction and stay bounded', () => {
  assert.deepEqual(videoCorrection(.01),{seek:false,rate:1});
  assert.ok(videoCorrection(.1).rate<1); assert.ok(videoCorrection(-.1).rate>1);
  assert.equal(videoCorrection(.36).seek,true);
  assert.equal(audioCorrection(.181).restart,true);
  assert.equal(audioCorrection(-.1).rate,1.002); assert.equal(audioCorrection(.1).rate,.998);
});
test('sleep, background throttling and forward/backward system corrections are detected', () => {
  const monitor = new ClockMonitor(10000,1000);
  assert.equal(monitor.sample(11000,2000),false);
  assert.equal(monitor.sample(12000,3000),false);
  assert.equal(monitor.sample(16000,4000),true);
  assert.equal(monitor.sample(13000,5000),true);
  assert.equal(monitor.sample(313000,305000),true);
  assert.deepEqual(statesAt(at(12,36,5)),{second:5,minute:144,hour:12});
});
