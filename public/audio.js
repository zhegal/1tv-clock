import { assetURL } from './media.js';
import { LOOP, phaseAt, phaseError, audioCorrection, modulo } from './time.js';

export class LoopAudio {
  constructor(mode, wallNow, changed, candidates = [{ file: `${mode}.wav`, format: 'wav', url: assetURL(`${mode}.wav`) }]) {
    this.candidates = candidates; this.selected = null; this.fallbacks = 0; this.fallbackReason = '';
    this.mode = mode; this.wallNow = wallNow; this.changed = changed;
    this.context = null; this.buffer = null; this.voice = null;
    this.voices = new Set(); this.status = 'loading'; this.error = '';
    this.loading = false; this.loadAttempts = 0; this.nextLoad = 0;
    this.nextResume = 0; this.resumePending = false; this.resumeAttempt = 0; this.lastRestart = -Infinity; this.restarts = 0;
    this.listenerController = null; this.abort = new AbortController(); this.disposed = false;
    this.enabled = true;
    this.gesture = () => this.resume(true);
  }
  init() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) { this.status = 'unavailable'; this.changed(); return; }
    try {
      this.context = new Context({ latencyHint: 'interactive', sampleRate: 48000 });
      this.context.addEventListener('statechange', () => {
        if (this.disposed) return;
        if (this.context.state === 'running') {
          this.status = this.buffer ? 'running' : 'loading'; this.removeUnlock(); this.sync(false);
        } else { this.status = this.context.state; this.installUnlock(); }
        this.changed();
      }, { signal: this.abort.signal });
      this.installUnlock();
      this.resume(false); // Attempt autoplay before and independently of buffer download.
      this.load();
    } catch (error) { this.status = 'unavailable'; this.error = String(error); this.changed(); }
  }
  installUnlock() {
    if (this.listenerController || this.disposed) return;
    this.listenerController = new AbortController();
    const options = { passive: true, signal: this.listenerController.signal };
    // Keep listeners only until resume succeeds. A blocked attempt must not
    // consume the first usable gesture, including touch-only older engines.
    for (const name of ['pointerdown', 'touchstart', 'keydown']) window.addEventListener(name, this.gesture, options);
  }
  removeUnlock() { this.listenerController?.abort(); this.listenerController = null; }
  resume(gesture = false) {
    const ctx = this.context; if (!ctx || this.disposed || ctx.state === 'closed') return;
    if (ctx.state === 'running') { this.removeUnlock(); this.sync(false); return; }
    if (!gesture && (this.resumePending || performance.now() < this.nextResume)) return;
    this.nextResume = performance.now() + 5000; this.resumePending = true; const attempt = ++this.resumeAttempt;
    // Invoke resume in the synchronous user activation call stack. Some
    // browsers leave this promise pending until activation; never await it in
    // a render/recovery path and always allow a later gesture to call resume.
    try {
      ctx.resume().then(() => {
        if (this.disposed) return;
        if (ctx.state === 'running') { this.removeUnlock(); this.sync(false); }
        else this.installUnlock();
        this.changed();
      }).catch((error) => { this.error = String(error); this.installUnlock(); this.changed(); }).finally(() => { if (attempt === this.resumeAttempt) this.resumePending = false; });
    } catch (error) { this.resumePending = false; this.error = String(error); this.installUnlock(); }
  }
  async load() {
    if (this.loading || this.buffer || !this.context || this.disposed) return;
    this.loading = true; this.loadAttempts++;
    try {
      let lastError = new Error('No supported audio source');
      for (const candidate of this.candidates) {
        if (this.disposed) return;
        const request = new AbortController();
        const abortRequest = () => request.abort();
        this.abort.signal.addEventListener('abort', abortRequest, { once: true });
        let timeout;
        try {
          // Bound download AND decode, and never download candidates in parallel.
          const attempt = async () => {
            const response = await fetch(candidate.url || assetURL(candidate.file), { signal: request.signal });
            if (!response.ok) throw new Error(`${candidate.file} HTTP ${response.status}`);
            return this.context.decodeAudioData(await response.arrayBuffer());
          };
          const buffer = await Promise.race([attempt(), new Promise((_, reject) => {
            timeout = setTimeout(() => { request.abort(); reject(new Error(`${candidate.file} timeout`)); }, 20000);
          })]);
          if (this.disposed) return;
          if (Math.abs(buffer.duration - LOOP) > 1e-9) throw new Error(`${candidate.file}: decoded audio is not a 60-second loop`);
          this.buffer = buffer; this.selected = candidate; this.error = ''; this.loadAttempts = 0;
          if (this.context.state === 'running') this.sync(false);
          else { this.status = this.context.state; this.installUnlock(); }
          return;
        } catch (error) {
          lastError = error;
          if (!this.disposed) { this.fallbacks++; this.fallbackReason = `${candidate.file}: ${error}`; }
        } finally {
          clearTimeout(timeout); request.abort(); this.abort.signal.removeEventListener('abort', abortRequest);
        }
      }
      throw lastError;
    } catch (error) {
      if (!this.disposed) {
        this.error = String(error); this.status = 'load-error';
        this.nextLoad = performance.now() + Math.min(60000, 1000 * 2 ** Math.min(this.loadAttempts, 6));
      }
    } finally { this.loading = false; this.changed(); }
  }

  outputTime() {
    const ctx = this.context;
    if (typeof ctx.getOutputTimestamp === 'function') {
      const stamp = ctx.getOutputTimestamp();
      const age = performance.now() - stamp.performanceTime;
      const estimate = stamp.contextTime + age / 1000;
      if (stamp.contextTime > 0 && stamp.performanceTime > 0 && age >= 0 && age < 250 && estimate <= ctx.currentTime + 0.02) return estimate;
    }
    return ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
  }
  voicePhase(contextTime) {
    return this.voice ? modulo(this.voice.phase + (contextTime - this.voice.anchor) * this.voice.rate) : null;
  }
  phase() { return this.context?.state === 'running' && this.voice ? this.voicePhase(this.outputTime()) : null; }
  start() {
    const ctx = this.context;
    if (!this.enabled || !this.buffer || ctx.state !== 'running' || this.disposed) return;
    const now = ctx.currentTime; const when = now + 0.04;
    const offset = phaseAt(this.wallNow() + (when - this.outputTime()) * 1000);
    const source = ctx.createBufferSource(); source.buffer = this.buffer;
    source.loop = true; source.loopStart = 0; source.loopEnd = LOOP;
    const gain = ctx.createGain(); source.connect(gain); gain.connect(ctx.destination);
    const voice = { source, gain, phase: offset, anchor: when, rate: 1 };
    gain.gain.setValueAtTime(0, now); gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(1, when + 0.03);
    source.addEventListener('ended', () => {
      source.disconnect(); gain.disconnect(); this.voices.delete(voice);
      if (this.voice === voice) { this.voice = null; this.status = 'stopped'; }
    }, { once: true });
    this.voices.add(voice); source.start(when, offset);
    if (this.voice) {
      const previous = this.voice;
      // Old source holds a constant gain of 1 outside a start transition.
      const oldGain = Math.min(1, Math.max(0, (now - previous.anchor) / 0.03));
      previous.gain.gain.cancelScheduledValues(now);
      previous.gain.gain.setValueAtTime(oldGain, now);
      previous.gain.gain.setValueAtTime(oldGain, when);
      previous.gain.gain.linearRampToValueAtTime(0, when + 0.03);
      previous.source.stop(when + 0.035);
    }
    this.voice = voice; this.lastRestart = performance.now(); this.restarts++;
    this.status = 'running'; this.changed();
  }
  sync(force = false) {
    if (!this.context || this.disposed) return;
    if (!this.buffer && performance.now() >= this.nextLoad) this.load();
    if (!this.enabled) return;
    if (this.context.state !== 'running') { this.installUnlock(); this.resume(false); return; }
    this.removeUnlock(); if (!this.buffer) return;
    if (!this.voice) { this.start(); return; }
    const error = phaseError(this.phase(), phaseAt(this.wallNow()));
    const correction = audioCorrection(error);
    // A source already at the correct phase need not be replaced on focus.
    if ((correction.restart || (force && Math.abs(error) > 0.06)) && performance.now() - this.lastRestart > 1000) { this.start(); return; }
    const now = this.context.currentTime;
    if (correction.rate !== this.voice.rate) {
      this.voice.phase = this.voicePhase(now); this.voice.anchor = now;
      this.voice.rate = correction.rate; this.voice.source.playbackRate.setValueAtTime(correction.rate, now);
    }
  }
  dispose() {
    this.disposed = true; this.abort.abort(); this.removeUnlock();
    for (const voice of this.voices) { try { voice.source.stop(); } catch {} voice.source.disconnect(); voice.gain.disconnect(); }
    this.voices.clear(); this.voice = null; this.context?.close().catch(() => {});
  }
}
