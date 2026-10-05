import test from 'node:test';
import assert from 'node:assert/strict';
import { ClockPresentation } from '../public/presentation.js';

async function exercise(run, supported = true) {
  const previous = globalThis.performance; let mono = 1000, entries = 0, exits = 0, activations = 0;
  globalThis.performance = { now: () => mono };
  class Element extends EventTarget {
    hidden = false; attributes = new Map(); textContent = '';
    setAttribute(name, value) { this.attributes.set(name, value); }
  }
  const document = new EventTarget(), [stage, clock, loader, progress, status, start, message] = Array.from({ length: 7 }, () => new Element());
  stage.ownerDocument = document; stage.setAttribute('aria-busy', 'true'); message.hidden = true;
  if (supported) {
    stage.requestFullscreen = () => { entries++; document.fullscreenElement = stage; return Promise.resolve(); };
    document.exitFullscreen = () => { exits++; document.fullscreenElement = null; return Promise.resolve(); };
  }
  const presentation = new ClockPresentation(stage, clock, loader, progress, status, start, message, () => activations++);
  try { await run({ stage, clock, loader, progress, status, start, message, presentation, document,
    advance: ms => mono += ms, counts: () => ({ entries, exits, activations }) }); }
  finally { presentation.dispose(); globalThis.performance = previous; }
}

test('double click enters fullscreen for the complete composition and toggles back', () => exercise(async ({ stage, clock, document, advance, counts }) => {
  clock.dispatchEvent(new Event('dblclick', { cancelable: true }));
  assert.equal(document.fullscreenElement, stage); assert.equal(counts().entries, 1);
  advance(500); clock.dispatchEvent(new Event('dblclick'));
  assert.equal(document.fullscreenElement, null); assert.equal(counts().exits, 1);
}));

test('a double touch and its synthesized dblclick request fullscreen only once', () => exercise(async ({ clock, advance, counts }) => {
  const tap = () => { const event = new Event('pointerup', { cancelable: true }); Object.assign(event, { pointerType: 'touch', isPrimary: true, clientX: 200, clientY: 150 }); clock.dispatchEvent(event); return event; };
  tap(); advance(150); assert.equal(tap().defaultPrevented, true);
  clock.dispatchEvent(new Event('dblclick')); assert.equal(counts().entries, 1);
}));

test('context menu and native dragging are suppressed inside the clock', () => exercise(async ({ stage, clock }) => {
  assert.equal(stage.dispatchEvent(new Event('contextmenu', { cancelable: true })), false);
  assert.equal(clock.dispatchEvent(new Event('dragstart', { cancelable: true })), false);
}));

test('unsupported fullscreen provides feedback while retaining the complete clock', () => exercise(async ({ clock, message, loader, presentation, counts }) => {
  presentation.reveal(); clock.dispatchEvent(new Event('dblclick'));
  assert.equal(message.hidden, false); assert.equal(loader.hidden, true); assert.equal(counts().entries, 0);
}, false));

test('loader shows activation affordance and becomes hidden only on explicit reveal', () => exercise(async ({ presentation, loader, progress, start, stage }) => {
  presentation.update(540, 540, true, true, true);
  assert.equal(loader.hidden, false); assert.equal(progress.value, 99); assert.equal(start.hidden, false);
  presentation.reveal(); assert.equal(loader.hidden, true); assert.equal(stage.attributes.get('aria-busy'), 'false');
}));
