import { statesAt, phaseAt, phaseError, videoCorrection, ClockMonitor, modulo } from './time.js';
import { LoopAudio } from './audio.js';
import { VideoLoop, VideoUpgrade } from './video.js';
import { ClockPresentation } from './presentation.js';
import { parseQuality, chooseQuality, assetURL, videoCandidates, audioCandidates, bufferedAhead } from './media.js';

const query = new URLSearchParams(location.search);
const debug = query.get('debug') === '1';
const requestedQuality = parseQuality(query.get('quality'));
const mode = query.get('audio') === 'night' ? 'night' : 'day';
let video = document.getElementById('background');
const videoNodes = [video, document.getElementById('background-next')];
// Set the IDL properties as well as HTML attributes for native autoplay.
for (const element of videoNodes) { element.muted = true; element.defaultMuted = true; element.controls = false; }
const canvas = document.getElementById('hands');
const context = canvas.getContext('2d');
const wallNow = () => Date.now();
const monitor = new ClockMonitor(wallNow(), performance.now());
const events = new AbortController();
const images = new Map();
let media, mediaLoading = false, mediaAttempts = 0, nextMedia = 0, mediaError = '';
let profiles = [], profileIndex = -1, selectedVideo = null, videoFallbacks = 0, videoFallbackReason = '';
let selectionHints = {};
let manifest, lastKey = '', lastPaint = 0, timer, stopped = false;
let decoded = 0, assetError = '', loading = false, assetAttempts = 0, nextAssets = 0;
let lastCheck = -Infinity, videoInitialized = false, videoError = '';
let videoGeneration = 0;
let nextVideoRetry = 0, videoAttempts = 0, playPending = false, videoSeeks = 0, videoAutoplayBlocked = false;
let progressPhase = null, progressMono = 0, lastSeek = -Infinity, videoProgressed = false;
let stallReported = false, recovering = false, output, debugUpdates = 0;
let frameRequest = null, lastPresented = performance.now(), presentedTime = null, qualityFrames = null;
let videoLoops = 0, videoLoopGapMs = null, videoMaxLoopGapMs = 0, videoNativeSeeks = 0;
let lastVideoSeek = null;
let upgrade = null, upgradeNextIndex = 0, videoUpgrades = 0, upgradeError = '';
const presentation = new ClockPresentation(...['stage','clock','loader','load-progress','load-status','start-playback','fullscreen-message'].map(id => document.getElementById(id)), activate);
const audio = new LoopAudio(mode, wallNow, () => { updateStartup(); if (debug) updateDebug(); });
audio.enabled = false;
function resetVideoState() {
  videoGeneration++; playPending = false; videoInitialized = false;
  lastSeek = -Infinity; nextVideoRetry = 0; progressPhase = null;
  progressMono = lastPresented = performance.now(); stallReported = false; videoProgressed = false;
}
let videoLoop = new VideoLoop(video, resetVideoState, wallNow, () => syncVideo(false));

function updateStartup() {
  if (stopped || presentation.shown) return;
  const frameReady = typeof video.requestVideoFrameCallback === 'function'
    ? presentedTime !== null && performance.now() - lastPresented < 250 && Math.abs(phaseError(presentedTime, phaseAt(wallNow()))) < 0.15
    : videoProgressed;
  const videoReady = videoInitialized && video.readyState >= 3 && !video.paused && !video.seeking && frameReady && bufferedAhead(video) >= 1.5 && Math.abs(phaseError(video.currentTime, phaseAt(wallNow()))) < 0.12;
  const audioReady = !!audio.buffer || audio.status === 'unavailable' || audio.status === 'load-error';
  presentation.update(decoded, 540, videoReady, audioReady, videoAutoplayBlocked, !!(assetError || mediaError || videoError));
  if (decoded === 540 && videoReady && audioReady && !document.hidden) {
    paint(); presentation.reveal(); audio.enabled = true; audio.sync(true); maybeUpgrade();
  }
}
function maybeUpgrade() {
  if (stopped || !presentation.shown || upgrade || upgradeNextIndex >= profileIndex) return;
  if (videoLoop.loading || bufferedAhead(video) < 5) return;
  const index = upgradeNextIndex++, element = videoNodes.find(candidate => candidate !== video);
  const candidate = new VideoUpgrade(element, profiles[index], prepared => {
    if (stopped || upgrade !== candidate) { prepared.dispose(); return; }
    const previousVideo = video, previousLoop = videoLoop;
    if (frameRequest !== null) previousVideo.cancelVideoFrameCallback?.(frameRequest);
    frameRequest = null; video = prepared.video; videoLoop = prepared.loop;
    videoLoop.onFallback = resetVideoState; videoLoop.onReady = () => syncVideo(false);
    selectedVideo = profiles[index]; profileIndex = index; videoGeneration++; playPending = false;
    videoInitialized = true; lastSeek = performance.now(); presentedTime = prepared.presented?.time ?? video.currentTime;
    lastPresented = progressMono = performance.now(); progressPhase = video.currentTime; stallReported = false; videoProgressed = true;
    videoError = ''; videoAttempts = 0; nextVideoRetry = 0;
    previousVideo.id = 'background-next'; video.id = 'background';
    video.classList.add('is-active'); previousVideo.classList.remove('is-active');
    upgrade = null; videoUpgrades++; paint(); observePresentation();
    previousLoop.dispose(); previousVideo.pause(); previousVideo.removeAttribute('src'); previousVideo.load();
    if (debug) updateDebug();
  }, reason => {
    if (upgrade !== candidate || stopped) return;
    upgrade = null; upgradeError = reason; videoFallbacks++;
    videoFallbackReason = `${profiles[index].name}: upgrade failed; keeping ${selectedVideo.name}`;
    if (debug) updateDebug();
  }, wallNow);
  upgrade = candidate;
}

function selectVideo(index) {
  selectedVideo = profiles[index]; profileIndex = index;
  if (!selectedVideo) { videoError = 'No supported video source'; return; }
  recovering = true; videoGeneration++; playPending = false; videoInitialized = false; lastSeek = -Infinity;
  nextVideoRetry = 0; progressPhase = null; progressMono = performance.now(); lastPresented = progressMono;
  videoProgressed = false;
  if (frameRequest !== null && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frameRequest);
  frameRequest = null; presentedTime = null; stallReported = false;
  videoLoop.load(selectedVideo); recovering = false;
  syncVideo(true); playVideo();
}
async function loadMedia() {
  if (mediaLoading || media || stopped) return;
  mediaLoading = true; mediaAttempts++;
  const request = new AbortController(), timeout = setTimeout(() => request.abort(), 15000);
  try {
    const response = await fetch(assetURL('media-manifest.json'), { signal: request.signal });
    if (!response.ok) throw new Error(`Media manifest HTTP ${response.status}`);
    const data = await response.json();
    if (stopped) return;
    const connection = globalThis.navigator?.connection;
    selectionHints = { width: video.getBoundingClientRect?.().width || 1440, dpr: globalThis.devicePixelRatio || 1,
      saveData: !!connection?.saveData, effectiveType: connection?.effectiveType || null };
    const supports = mime => typeof video.canPlayType !== 'function' || video.canPlayType(mime) !== '';
    profiles = videoCandidates(data, requestedQuality, selectionHints, supports);
    const preferred = chooseQuality(requestedQuality, selectionHints);
    if (profiles[0] && profiles[0].name !== preferred) { videoFallbacks++; videoFallbackReason = `${preferred}: unavailable or unsupported; selected ${profiles[0].name}`; }
    audio.candidates = audioCandidates(data, mode, supports);
    media = data; mediaError = ''; selectVideo(profiles.length - 1); audio.init();
  } catch (error) {
    mediaError = String(error); nextMedia = performance.now() + Math.min(60000, 1000 * 2 ** Math.min(mediaAttempts, 6));
  } finally { clearTimeout(timeout); mediaLoading = false; if (debug) updateDebug(); }
}

async function imageFor(entry) {
  if (images.has(entry.file)) return;
  const image = new Image(); image.decoding = 'async'; image.src = assetURL(entry.file);
  const timeout = new Promise((_, reject) => { image._timer = setTimeout(() => reject(new Error(`PNG timeout: ${entry.file}`)), 15000); });
  try {
    const decode = typeof image.decode === 'function' ? image.decode() : new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
    await Promise.race([decode, timeout]);
    if (stopped) return;
    images.set(entry.file, image); decoded++; paint(); updateStartup();
  } finally { clearTimeout(image._timer); image.onload = null; image.onerror = null; }
}
async function loadAssets() {
  if (loading || stopped) return;
  loading = true; assetAttempts++;
  try {
    if (!manifest) {
      const request = new AbortController(); const timeout = setTimeout(() => request.abort(), 15000);
      try {
        const response = await fetch(assetURL('manifest.json'), { signal: request.signal });
        if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
        manifest = await response.json();
      } finally { clearTimeout(timeout); }
    }
    const state = statesAt(wallNow());
    // Decode current states first; each frame is painted only when all three
    // are ready. Then preload every remaining state with bounded concurrency.
    await Promise.all(['hour', 'min', 'sec'].map(kind => imageFor(manifest.hands[kind][state[{ hour: 'hour', min: 'minute', sec: 'second' }[kind]]])));
    const entries = Object.values(manifest.hands).flat().filter(entry => !images.has(entry.file));
    let index = 0; const failures = [];
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (index < entries.length && !stopped) {
        const entry = entries[index++]; try { await imageFor(entry); } catch (error) { failures.push(String(error)); }
      }
    }));
    if (failures.length) throw new Error(failures[0]);
    assetError = ''; assetAttempts = 0;
  } catch (error) {
    assetError = String(error); nextAssets = performance.now() + Math.min(60000, 1000 * 2 ** Math.min(assetAttempts, 6));
  } finally { loading = false; if (!stopped) { paint(); updateStartup(); } }
}
function paint() {
  if (!manifest || stopped) return;
  const state = statesAt(wallNow());
  const key = `${state.hour}/${state.minute}/${state.second}`;
  if (key === lastKey) return;
  const entries = [manifest.hands.hour[state.hour], manifest.hands.min[state.minute], manifest.hands.sec[state.second]];
  if (entries.some(entry => !images.has(entry.file))) return;
  context.clearRect(0, 0, 1440, 1080);
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  for (const entry of entries) context.drawImage(images.get(entry.file), entry.x, entry.y, entry.width, entry.height);
  lastKey = key; lastPaint = performance.now();
}
function videoRetry() {
  videoAttempts++; nextVideoRetry = performance.now() + Math.min(60000, 1000 * 2 ** Math.min(videoAttempts, 6));
}
function playVideo() {
  if (!selectedVideo || playPending || stopped || videoAutoplayBlocked || performance.now() < nextVideoRetry) return;
  playPending = true; const generation = videoGeneration;
  try {
    Promise.resolve(video.play()).then(() => {
      if (generation !== videoGeneration || stopped) return;
      videoError = ''; videoAutoplayBlocked = false; videoAttempts = 0; nextVideoRetry = 0;
    }).catch(error => { if (generation !== videoGeneration || stopped) return; videoError = String(error); if (error.name === 'NotAllowedError') videoAutoplayBlocked = true; else videoRetry(); updateStartup(); }).finally(() => { if (generation === videoGeneration) playPending = false; });
  } catch (error) { playPending = false; videoError = String(error); videoRetry(); }
}
function seekVideo() {
  const mono = performance.now();
  if (video.readyState < 1 || video.seeking || mono - lastSeek < 1500) return;
  try {
    // Measure now, not the time before loading/network recovery.
    const target = videoLoop.seekTarget(phaseAt(wallNow()));
    if (videoLoop.mode === 'continuous') {
      const ranges = video.buffered;
      if (!Array.from({ length: ranges.length }, (_, i) => target >= ranges.start(i) && target < ranges.end(i)).some(Boolean)) return;
    }
    video.currentTime = target; video.playbackRate = 1;
    if (debug) lastVideoSeek = { target, actual: video.currentTime, ready: video.readyState };
    lastSeek = mono; videoSeeks++;
    videoInitialized = video.seeking || Math.abs(phaseError(video.currentTime, target)) < 0.06;
    progressPhase = null; progressMono = mono;
  } catch (error) { videoError = String(error); }
}
function observePresentation() {
  if (typeof video.requestVideoFrameCallback === 'function') {
    if (frameRequest !== null) return;
    frameRequest = video.requestVideoFrameCallback((_, metadata) => {
      frameRequest = null;
      if (debug && presentedTime !== null && modulo(presentedTime) > 59 && modulo(metadata.mediaTime) < 1) {
        videoLoops++; videoLoopGapMs = Math.round(performance.now() - lastPresented);
        videoMaxLoopGapMs = Math.max(videoMaxLoopGapMs, videoLoopGapMs);
      }
      if (presentedTime === null || Math.abs(phaseError(metadata.mediaTime, presentedTime)) > 0.005) {
        presentedTime = metadata.mediaTime; lastPresented = performance.now();
      }
      if (!presentation.shown) updateStartup();
      if (!stopped) observePresentation();
    });
  } else if (typeof video.getVideoPlaybackQuality === 'function') {
    const count = video.getVideoPlaybackQuality().totalVideoFrames;
    if (count !== qualityFrames) { qualityFrames = count; lastPresented = performance.now(); }
  } else {
    // Older engines expose only currentTime; bounded stall events/load are
    // still supported, without requiring a browser-specific branch.
    if (progressPhase !== null) lastPresented = progressMono;
  }
}
function syncVideo(force = false) {
  if (stopped || !selectedVideo) return;
  const mono = performance.now();
  videoLoop.maintain();
  observePresentation();
  if (video.error && profileIndex + 1 < profiles.length) {
    videoFallbacks++; videoFallbackReason = `${selectedVideo.name}: media error ${video.error.code}`;
    selectVideo(profileIndex + 1); return;
  }
  if (video.error || (!videoLoop.loading && stallReported && mono - lastPresented > 8000)) {
    if (mono >= nextVideoRetry) {
      recovering = true; videoInitialized = false; playPending = false;
      videoGeneration++; videoRetry(); videoLoop.load(selectedVideo); recovering = false; stallReported = false;
      progressPhase = null; progressMono = mono; lastPresented = mono;
      if (frameRequest !== null && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frameRequest);
      frameRequest = null; presentedTime = null;
    }
    return;
  }
  if (video.readyState < 1) {
    if (!videoLoop.loading && mono - progressMono > 20000 && mono >= nextVideoRetry) { videoGeneration++; playPending = false; videoRetry(); videoLoop.load(selectedVideo); progressMono = mono; }
    return;
  }
  if (!videoInitialized) seekVideo();
  if (video.paused && !document.hidden) playVideo();
  const error = phaseError(video.currentTime, phaseAt(wallNow()));
  if (!videoAutoplayBlocked && !video.seeking && video.readyState >= 3 && mono - lastSeek >= 1500) {
    const correction = videoCorrection(error);
    if (correction.seek || (force && Math.abs(error) > 0.06)) seekVideo();
    else if (video.playbackRate !== correction.rate) video.playbackRate = correction.rate;
  }
  if (!document.hidden && !video.paused && mono - lastPresented > 5000) stallReported = true;
  // Fallback progress tracking for engines without presentation observation.
  if (progressPhase === null || Math.abs(phaseError(video.currentTime, progressPhase)) > 0.015) {
    if (progressPhase !== null) videoProgressed = true;
    progressPhase = video.currentTime; progressMono = mono;
  } else if (!document.hidden && !video.paused && !video.seeking && mono - progressMono > 5000) stallReported = true;
}
function recover() {
  if (stopped || document.hidden) return;
  lastPresented = performance.now(); progressMono = lastPresented; stallReported = false; paint(); syncVideo(true); audio.resume(false); audio.sync(true);
  lastCheck = performance.now(); schedule();
}
function tick() {
  if (stopped) return;
  const wall = wallNow(), mono = performance.now(); const jumped = monitor.sample(wall, mono);
  paint();
  if (!document.hidden && (jumped || mono - lastCheck >= 1000)) {
    if (jumped) { lastPresented = mono; progressMono = mono; stallReported = false; }
    syncVideo(jumped); audio.sync(jumped); lastCheck = mono;
    if (!media && !mediaLoading && mono >= nextMedia) loadMedia();
    if (decoded < 540 && !loading && mono >= nextAssets) loadAssets();
    updateStartup(); maybeUpgrade();
  }
  if (debug) updateDebug();
  schedule();
}
function schedule() {
  clearTimeout(timer); if (stopped) return;
  // setTimeout is only a wakeup. Never increment seconds or media position.
  // Near a boundary, retry promptly to absorb low-resolution Date.now().
  const remaining = 1000 - ((wallNow() % 1000 + 1000) % 1000);
  timer = setTimeout(tick, document.hidden ? 1000 : Math.min(1000, Math.max(4, remaining + 1)));
}
function updateDebug() {
  if (!output) return;
  const wall = wallNow(), ap = audio.phase(), vp = modulo(video.currentTime);
  const data = {
    requestedQuality, selectedVideoProfile: selectedVideo?.name || null,
    startupReady: presentation.shown, loadingProgress: presentation.progress.value,
    fullscreenActive: (document.fullscreenElement || document.webkitFullscreenElement) === presentation.stage,
    targetVideoProfile: profiles[0]?.name || null, pendingVideoProfile: upgrade?.profile.name || null,
    videoUpgrades, upgradeError,
    videoResolution: selectedVideo ? `${selectedVideo.width}×${selectedVideo.height}` : null,
    videoFormat: selectedVideo?.mime || null, videoBytes: selectedVideo?.bytes || null,
    selectionHints, videoFallbacks, videoFallbackReason, mediaError,
    audioFormat: audio.selected?.format || null, audioSource: audio.selected?.file || null,
    audioBytes: audio.selected?.bytes || null, audioDecodedDuration: audio.buffer?.duration || null,
    audioFallbacks: audio.fallbacks, audioFallbackReason: audio.fallbackReason,
    wallTime: new Date(wall).toISOString(), localTime: new Date(wall).toLocaleTimeString(), performanceMs: Math.round(performance.now()),
    states: statesAt(wall), paintedStates: lastKey, decodedStates: decoded, assetError,
    expectedPhase: +phaseAt(wall).toFixed(3), videoPhase: +vp.toFixed(3), videoDriftMs: Math.round(phaseError(vp, phaseAt(wall)) * 1000),
    videoRate: +video.playbackRate.toFixed(4), videoReady: video.readyState, videoPaused: video.paused, videoSeeking: video.seeking,
    videoSeeks, videoNativeSeeks, videoLoops, videoLoopGapMs, videoMaxLoopGapMs,
    videoLoopMode: videoLoop.mode, videoLoopError: videoLoop.error,
    lastVideoSeek, videoBufferEnd: videoLoop.end, videoBufferLoading: videoLoop.loading,
    videoAutoplayBlocked, videoRetries: videoAttempts, videoError, lastPresentedMs: Math.round(lastPresented),
    audioMode: mode, audioState: audio.context?.state || audio.status, audioPhase: ap === null ? null : +ap.toFixed(3),
    audioDriftMs: ap === null ? null : Math.round(phaseError(ap, phaseAt(wall)) * 1000), avDriftMs: ap === null ? null : Math.round(phaseError(ap, vp) * 1000),
    audioRate: audio.voice?.rate || null, audioStarts: audio.restarts, liveAudioVoices: audio.voices.size, audioError: audio.error,
    unlockListeners: !!audio.listenerController, visibility: document.visibilityState, lastPaintMs: Math.round(lastPaint), debugUpdates: ++debugUpdates,
  };
  output.textContent = JSON.stringify(data, null, 2);
}
if (debug) {
  const panel = document.createElement('aside'); panel.id = 'debug';
  const controls = [['Pause video', () => video.pause()], ['Suspend audio', () => audio.context?.suspend()], ['Video +5s', () => { video.currentTime = videoLoop.seekTarget(modulo(video.currentTime + 5)); }], ['Resync', recover]];
  for (const [label, action] of controls) { const button = document.createElement('button'); button.textContent = label; button.addEventListener('click', action, { signal: events.signal }); panel.append(button); }
  output = document.createElement('pre'); output.id = 'diagnostics'; panel.append(output); document.body.append(panel);
}
const listen = (target, name, fn) => target.addEventListener(name, fn, { signal: events.signal });
for (const element of videoNodes) {
const activeListen = (name, fn) => listen(element, name, event => { if (element === video) fn(event); });
activeListen('loadedmetadata', () => { seekVideo(); playVideo(); });
activeListen('canplay', () => { syncVideo(false); playVideo(); updateStartup(); });
activeListen('playing', () => { stallReported = false; progressMono = performance.now(); progressPhase = null; });
activeListen('seeked', () => { if (video.paused) playVideo(); });
activeListen('seeking', () => { videoNativeSeeks++; });
activeListen('pause', () => { if (!recovering && !document.hidden) playVideo(); });
activeListen('ended', () => { seekVideo(); playVideo(); });
activeListen('stalled', () => { stallReported = true; });
activeListen('error', () => {
  videoError = `Video error ${video.error?.code || 'unknown'}`;
  if (videoLoop.mode === 'continuous') videoLoop.fallback(new Error(videoError), videoLoop.generation);
  else syncVideo(false);
});
}
listen(document, 'visibilitychange', recover);
listen(window, 'pageshow', recover);
listen(window, 'focus', recover);
listen(window, 'online', () => { nextAssets = 0; nextMedia = 0; audio.nextLoad = 0; nextVideoRetry = 0; recover(); });
// Muted video normally autoplays. If the host explicitly blocks even silent
// video, wait invisibly for activation instead of seeking a paused image.
function activate() {
  // Preserve the synchronous user-activation stack on low-power iOS devices.
  videoAutoplayBlocked = false; nextVideoRetry = 0;
  audio.resume(true);
  unlockVideo(); upgrade?.play(); updateStartup();
}
function unlockVideo() {
  if (video.paused) { videoAutoplayBlocked = false; nextVideoRetry = 0; seekVideo(); playVideo(); }
}
for (const name of ['pointerdown', 'touchstart', 'keydown']) listen(window, name, unlockVideo);
listen(window, 'pagehide', event => {
  if (event.persisted) return; // bfcache restores the same listeners/context.
  stopped = true; clearTimeout(timer); events.abort(); audio.dispose(); videoLoop.dispose(); images.clear();
  upgrade?.dispose(); presentation.dispose();
  if (frameRequest !== null && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frameRequest);
});
loadMedia(); loadAssets(); schedule(); updateDebug();
