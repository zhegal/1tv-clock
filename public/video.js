import { LOOP, phaseAt, phaseError, videoCorrection } from './time.js';
import { assetURL, bufferedAhead } from './media.js';

// Keep consecutive copies on one decoder timeline. Native <video loop> seeks
// back to zero and can stop presenting frames while the decoder restarts.
export class VideoLoop {
  constructor(video, onFallback = () => {}, wallNow = () => Date.now(), onReady = () => {}) {
    this.video = video; this.onFallback = onFallback;
    this.wallNow = wallNow;
    this.onReady = onReady;
    this.mode = 'native'; this.error = ''; this.generation = 0;
  }
  load(profile) {
    this.dispose(); this.profile = profile; this.error = '';
    const Media = globalThis.MediaSource;
    if (!profile.fragmented || !profile.segments?.length || !Media?.isTypeSupported(profile.mime)) return this.native();
    const generation = this.generation;
    try {
      this.mode = 'continuous'; this.source = new Media();
      this.request = new AbortController(); this.chunks = []; this.end = 0; this.busy = this.loading = true;
      this.url = URL.createObjectURL(this.source);
      this.source.addEventListener('sourceopen', () => {
        this.fill(generation).catch(error => this.fallback(error, generation));
      }, { once: true, signal: this.request.signal });
      this.video.loop = false; this.video.src = this.url; this.video.load();
    } catch (error) { this.fallback(error, generation); }
  }
  native() {
    this.mode = 'native'; this.video.loop = true;
    this.video.src = assetURL(this.profile.file); this.video.load();
  }
  fallback(error, generation) {
    if (generation !== this.generation) return;
    this.dispose(); this.error = String(error); this.onFallback(); this.native();
  }
  async fill(generation) {
    this.buffer = this.source.addSourceBuffer(this.profile.mime);
    this.source.duration = Infinity;
    const request = this.request;
    const timeout = setTimeout(() => request.abort(), 60000);
    try {
      this.chunks[0] = await this.readRange(0, this.profile.initBytes);
      if (generation !== this.generation) return;
      await this.update(() => this.buffer.appendBuffer(this.chunks[0]));
      if (generation !== this.generation) return;
      const segments = this.profile.segments;
      const phase = phaseAt(this.wallNow());
      const first = Math.max(0, segments.findLastIndex(segment => segment.time <= phase));
      // Fetch the current phase first, then the next minute's beginning. A
      // late-minute visit need not download the preceding 55 MB before playing.
      let offset = 0;
      for (let step = 0; step < segments.length; step++) {
        const index = (first + step) % segments.length;
        if (index === 0 && step > 0) offset = LOOP;
        const segment = segments[index];
        this.chunks[index + 1] ??= await this.readRange(segment.start, segment.end);
        if (generation !== this.generation) return;
        this.buffer.timestampOffset = offset;
        await this.update(() => this.buffer.appendBuffer(this.chunks[index + 1]));
        if (generation !== this.generation) return;
        if (step === 0) this.onReady();
        if (generation !== this.generation) return;
      }
      // Complete the second copy from cached tail fragments when we started
      // mid-minute. All later repetitions use this same in-memory asset.
      if (first > 0) for (let index = first; index < segments.length; index++) {
        await this.update(() => this.buffer.appendBuffer(this.chunks[index + 1]));
        if (generation !== this.generation) return;
      }
      if (generation !== this.generation) return;
      this.end = first > 0 ? LOOP * 2 : LOOP; this.busy = this.loading = false; this.maintain();
    } finally { clearTimeout(timeout); }
  }
  async readRange(start, end) {
    const profile = this.profile, chunks = this.chunks, signal = this.request.signal;
    const response = await fetch(assetURL(profile.file), {
      signal, headers: { Range: `bytes=${start}-${end - 1}` },
    });
    if (!response.ok) throw new Error(`Video HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status === 200 && bytes.byteLength === profile.bytes) {
      // Static hosts may ignore Range. Cache that one full response and avoid
      // downloading it again for each fragment.
      chunks[0] = bytes.subarray(0, profile.initBytes);
      profile.segments.forEach((segment, i) => {
        chunks[i + 1] = bytes.subarray(segment.start, segment.end);
      });
      return bytes.subarray(start, end);
    }
    if (bytes.byteLength !== end - start) throw new Error('Incomplete video range');
    return bytes;
  }
  update(action) {
    const buffer = this.buffer, signal = this.request.signal;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        buffer.removeEventListener('updateend', done); buffer.removeEventListener('error', failed);
        signal.removeEventListener('abort', aborted); clearTimeout(timeout);
      };
      const done = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Video buffer append failed')); };
      const aborted = () => { cleanup(); reject(new Error('Video buffer cancelled')); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Video buffer timeout')); }, 15000);
      buffer.addEventListener('updateend', done, { once: true });
      buffer.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', aborted, { once: true });
      try { if (signal.aborted) aborted(); else action(); } catch (error) { cleanup(); reject(error); }
    });
  }
  maintain() {
    if (this.mode !== 'continuous' || this.busy || !this.end || this.end - this.video.currentTime > 20) return;
    this.busy = true;
    const generation = this.generation;
    this.appendCycle(generation).catch(error => this.fallback(error, generation));
  }
  async appendCycle(generation) {
    // Limit decoded-media storage; retain a little history for clock recovery.
    const before = this.video.currentTime - 4;
    if (before > 0) await this.update(() => this.buffer.remove(0, before));
    if (generation !== this.generation) return;
    this.buffer.timestampOffset = this.end;
    for (const chunk of this.chunks) {
      await this.update(() => this.buffer.appendBuffer(chunk));
      if (generation !== this.generation) return;
    }
    this.end += LOOP; this.busy = false;
  }
  seekTarget(phase) {
    if (this.mode !== 'continuous') return phase;
    const ranges = this.video.buffered, current = this.video.currentTime;
    const candidates = [];
    for (let i = 0; i < ranges.length; i++) {
      const first = Math.max(0, Math.ceil((ranges.start(i) - phase) / LOOP));
      const last = Math.floor((ranges.end(i) - phase - 0.001) / LOOP);
      for (let cycle = first; cycle <= last; cycle++) candidates.push(cycle * LOOP + phase);
    }
    return candidates.sort((a, b) => Math.abs(a - current) - Math.abs(b - current))[0] ?? phase;
  }
  dispose() {
    this.generation++; this.request?.abort();
    if (this.url) URL.revokeObjectURL(this.url);
    this.request = null; this.url = null; this.source = null; this.buffer = null;
    this.chunks = null; this.busy = this.loading = false; this.end = 0;
  }
}

// Prepare a second decoder while the current clock remains visible. Hand it
// over only after it has presented an aligned frame with enough data ahead.
export class VideoUpgrade {
  constructor(video, profile, ready, failed, wallNow = () => Date.now()) {
    Object.assign(this, { video, profile, ready, failed, wallNow });
    this.events = new AbortController(); this.stopped = false; this.initialized = false;
    this.lastSeek = -Infinity; this.playPending = false; this.playGeneration = 0;
    this.presented = null; this.frameRequest = null; this.started = performance.now();
    this.loop = new VideoLoop(video, () => { this.initialized = false; this.playGeneration++; this.playPending = false; this.lastSeek = -Infinity; }, wallNow, () => this.check());
    for (const name of ['loadedmetadata', 'canplay', 'playing', 'seeked']) video.addEventListener(name, () => this.check(), { signal: this.events.signal });
    video.addEventListener('error', () => {
      if (this.loop.mode === 'continuous') this.loop.fallback(new Error('Upgrade media error'), this.loop.generation);
      else this.fail('Upgrade media error');
    }, { signal: this.events.signal });
    this.loop.load(profile); this.check();
  }
  play() {
    if (this.playPending || this.stopped || !this.video.paused) return;
    this.playPending = true; const generation = this.playGeneration;
    try {
      Promise.resolve(this.video.play()).catch(error => {
        if (!this.stopped && generation === this.playGeneration) this.fail(String(error));
      }).finally(() => { if (generation === this.playGeneration) this.playPending = false; });
    } catch (error) { this.fail(String(error)); }
  }
  seek() {
    const video = this.video, mono = performance.now();
    if (video.readyState < 1 || video.seeking || mono - this.lastSeek < 1000) return;
    const target = this.loop.seekTarget(phaseAt(this.wallNow()));
    if (this.loop.mode === 'continuous' && !Array.from({ length: video.buffered.length }, (_, i) => target >= video.buffered.start(i) && target < video.buffered.end(i)).some(Boolean)) return;
    try {
      video.currentTime = target; video.playbackRate = 1; this.lastSeek = mono; this.presented = null;
      this.initialized = video.seeking || Math.abs(phaseError(video.currentTime, target)) < 0.06;
    } catch (error) { this.fail(String(error)); }
  }
  observe() {
    if (this.frameRequest !== null || typeof this.video.requestVideoFrameCallback !== 'function') return;
    this.frameRequest = this.video.requestVideoFrameCallback((_, metadata) => {
      this.frameRequest = null; this.presented = { time: metadata.mediaTime, mono: performance.now() };
      this.check();
    });
  }
  check() {
    clearTimeout(this.timer);
    if (this.stopped) return;
    if (performance.now() - this.started > 45000) { this.fail('Upgrade timeout'); return; }
    this.loop.maintain();
    if (!this.initialized) this.seek();
    if (this.stopped) return;
    this.play(); this.observe();
    const video = this.video, error = phaseError(video.currentTime, phaseAt(this.wallNow()));
    if (video.readyState >= 3 && !video.seeking) {
      const correction = videoCorrection(error);
      if (correction.seek) this.seek(); else video.playbackRate = correction.rate;
      const presented = this.presented && performance.now() - this.presented.mono < 250 && Math.abs(phaseError(this.presented.time, phaseAt(this.wallNow()))) < 0.12;
      // Engines without frame callbacks must show actual timeline progress.
      const progressed = typeof video.requestVideoFrameCallback !== 'function' && this.previousTime !== undefined && Math.abs(phaseError(video.currentTime, this.previousTime)) > 0.015;
      if (this.initialized && !video.paused && Math.abs(error) < 0.1 && bufferedAhead(video) >= 1.5 && (presented || progressed)) {
        this.detach(); this.ready(this); return;
      }
    }
    this.previousTime = video.currentTime;
    if (!this.stopped) this.timer = setTimeout(() => this.check(), 150);
  }
  fail(reason) {
    if (this.stopped) return;
    this.dispose(); this.failed(reason);
  }
  detach() {
    this.stopped = true; this.events.abort(); clearTimeout(this.timer);
    if (this.frameRequest !== null) this.video.cancelVideoFrameCallback?.(this.frameRequest);
    this.frameRequest = null;
  }
  dispose() {
    this.detach(); this.loop.dispose(); this.video.pause();
    this.video.removeAttribute('src'); this.video.load();
  }
}
