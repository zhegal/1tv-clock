import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { VideoLoop } from '../public/video.js';

const profile = {
  file: 'test.mp4', mime: 'video/mp4', fragmented: true, bytes: 7, initBytes: 1,
  segments: [{ start: 1, end: 3, time: 0 }, { start: 3, end: 5, time: 20 }, { start: 5, end: 7, time: 40 }],
};
const file = new Uint8Array([255, 0, 0, 1, 1, 2, 2]);

async function exercise(run, { range = true, fail = false, supported = true, replaceOnReady = false } = {}) {
  const original = { MediaSource: globalThis.MediaSource, fetch: globalThis.fetch,
    create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const ranges = [], appends = [], revokes = [], urls = [];
  let fallbacks = 0, seeks = 0, position = 0;
  const video = { load() {}, buffered: { length: 0, start: () => 0, end: () => 0 },
    get currentTime() { return position; }, set currentTime(value) { seeks++; position = value; } };
  class Buffer extends EventTarget {
    timestampOffset = 0; start = Infinity; end = 0;
    appendBuffer(bytes) {
      if (fail) { queueMicrotask(() => this.dispatchEvent(new Event('error'))); return; }
      if (bytes[0] !== 255) {
        const start = bytes[0] * 20 + this.timestampOffset;
        appends.push(start); this.start = Math.min(this.start, start); this.end = Math.max(this.end, start + 20);
        video.buffered = { length: 1, start: () => this.start, end: () => this.end };
      }
      queueMicrotask(() => this.dispatchEvent(new Event('updateend')));
    }
    remove(_, end) { this.start = Math.max(this.start, end); queueMicrotask(() => this.dispatchEvent(new Event('updateend'))); }
  }
  globalThis.MediaSource = class extends EventTarget {
    static isTypeSupported() { return supported; }
    addSourceBuffer() { return new Buffer(); }
  };
  globalThis.fetch = async (url, options) => {
    urls.push(url);
    const match = options.headers.Range.match(/bytes=(\d+)-(\d+)/);
    const start = +match[1], end = +match[2] + 1; ranges.push([start, end]);
    const bytes = range ? file.slice(start, end) : file;
    return { ok: true, status: range ? 206 : 200, arrayBuffer: async () => bytes.buffer };
  };
  URL.createObjectURL = source => { queueMicrotask(() => source.dispatchEvent(new Event('sourceopen'))); return 'blob:video'; };
  URL.revokeObjectURL = url => revokes.push(url);
  const loop = new VideoLoop(video, () => fallbacks++, () => 52000, () => {
    if (replaceOnReady) { replaceOnReady = false; loop.load({ ...profile, file: 'replacement.mp4' }); }
  });
  const drain = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  try {
    loop.load(profile); await drain();
    await run({ loop, video, ranges, appends, revokes, urls, drain,
      advance: value => { position = value; loop.maintain(); }, counts: () => ({ seeks, fallbacks }) });
  } finally {
    loop.dispose(); globalThis.MediaSource = original.MediaSource; globalThis.fetch = original.fetch;
    URL.createObjectURL = original.create; URL.revokeObjectURL = original.revoke;
  }
}

test('continuous video starts at the current phase and reuses cached media across 100 minutes without seeking', () => exercise(async ({ loop, video, ranges, appends, advance, drain, counts }) => {
  assert.equal(loop.mode, 'continuous'); assert.equal(video.loop, false);
  assert.deepEqual(ranges, [[0, 1], [5, 7], [1, 5]]);
  assert.equal(ranges.reduce((n, [start, end]) => n + end - start, 0), profile.bytes, 'startup downloads the asset exactly once');
  assert.deepEqual(appends, [40, 60, 80, 100]);
  assert.equal(loop.seekTarget(0.01), 60.01);
  advance(119.99); await drain(); assert.equal(loop.seekTarget(0.01), 120.01);
  assert.equal(loop.seekTarget(59.9), 119.9);
  for (let minute = 2; minute < 102; minute++) { advance(minute * 60 + 45); await drain(); }
  assert.equal(ranges.length, 3, 'later minutes never fetch video again');
  assert.equal(loop.chunks.reduce((n, chunk) => n + chunk.byteLength, 0), profile.bytes);
  assert.ok(video.buffered.end(0) - video.buffered.start(0) <= 85, 'old video data is removed');
  assert.deepEqual(counts(), { seeks: 0, fallbacks: 0 });
}));

test('a host that ignores Range downloads the video once', () => exercise(async ({ loop, ranges, appends }) => {
  assert.equal(loop.mode, 'continuous'); assert.equal(ranges.length, 1);
  assert.deepEqual(appends, [40, 60, 80, 100]);
}, { range: false }));

test('switching source on the first decoded fragment stops the old loading sequence', () => exercise(async ({ loop, urls, counts }) => {
  assert.equal(loop.profile.file, 'replacement.mp4'); assert.equal(loop.mode, 'continuous');
  assert.equal(urls.filter(url => url.endsWith('/test.mp4')).length, 2);
  assert.equal(urls.filter(url => url.endsWith('/replacement.mp4')).length, 3);
  assert.equal(counts().fallbacks, 0);
}, { replaceOnReady: true }));

test('a MediaSource buffer error falls back to native playback and releases its resources', () => exercise(async ({ loop, video, revokes, counts }) => {
  assert.equal(loop.mode, 'native'); assert.equal(video.loop, true);
  assert.ok(video.src.endsWith('/assets/test.mp4')); assert.equal(loop.chunks, null);
  assert.deepEqual(revokes, ['blob:video']); assert.equal(counts().fallbacks, 1);
}, { fail: true }));

test('browsers without MediaSource H.264 support retain native playback', () => exercise(async ({ loop, video, ranges }) => {
  assert.equal(loop.mode, 'native'); assert.equal(video.loop, true); assert.equal(ranges.length, 0);
}, { supported: false }));

test('disposed source cannot replace a newer native source when an old fetch resolves', () => exercise(async ({ loop, video, drain }) => {
  let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  loop.load(profile); await drain();
  loop.load({ ...profile, file: 'replacement.mp4', fragmented: false });
  finish({ ok: true, status: 206, arrayBuffer: async () => file.slice(0, 1).buffer });
  await drain(); assert.equal(loop.mode, 'native'); assert.ok(video.src.endsWith('/assets/replacement.mp4'));
}));

test('all production fragment ranges cover one complete 60-second asset', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/assets/media-manifest.json', import.meta.url)));
  for (const profile of Object.values(manifest.video)) {
    const url = new URL(`../public/assets/${profile.file}`, import.meta.url);
    assert.equal((await stat(url)).size, profile.bytes);
    const bytes = await readFile(url);
    assert.equal(profile.duration, 60); assert.equal(profile.frames, 3000); assert.equal(profile.fps, 50);
    assert.equal(profile.segments.length, 30);
    let end = profile.initBytes;
    for (const [index, segment] of profile.segments.entries()) {
      assert.equal(segment.start, end); assert.equal(segment.time, index * 2);
      assert.equal(bytes.toString('ascii', segment.start + 4, segment.start + 8), 'moof'); end = segment.end;
    }
    assert.equal(end, bytes.length);
  }
});
