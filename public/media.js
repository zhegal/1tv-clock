// Delivery choices never participate in clock state or phase calculations.
const qualities = ['auto', 'high', 'medium', 'low'];
export function parseQuality(value) { return qualities.includes(value) ? value : 'auto'; }
export function assetURL(file, moduleURL = import.meta.url) { return new URL(`./assets/${file}`, moduleURL).href; }
export function chooseQuality(requested, hints = {}) {
  requested = parseQuality(requested);
  if (requested !== 'auto') return requested;
  const physical = Math.max(1, hints.width || 1440) * Math.max(1, hints.dpr || 1);
  let quality = physical <= 640 ? 'low' : physical <= 960 ? 'medium' : 'high';
  if (hints.saveData || ['slow-2g', '2g'].includes(hints.effectiveType)) quality = 'low';
  else if (hints.effectiveType === '3g' && quality === 'high') quality = 'medium';
  return quality;
}
export function videoCandidates(manifest, requested, hints, supports = () => true) {
  const selected = chooseQuality(requested, hints);
  // Change only on a failed source, never on resize or network fluctuations.
  const order = ['high', 'medium', 'low'];
  return order.slice(order.indexOf(selected)).filter(name => {
    const entry = manifest.video[name]; return entry && supports(entry.mime);
  }).map(name => ({ name, ...manifest.video[name] }));
}
export function audioCandidates(manifest, mode, supports = () => true) {
  const entries = [...manifest.audio[mode === 'night' ? 'night' : 'day']];
  // A WAV decode is always worth trying, even if canPlayType is inconclusive.
  return entries.filter(entry => entry.format === 'wav' || supports(entry.mime)).map(entry => ({ ...entry, url: assetURL(entry.file) }));
}

export function bufferedAhead(video) {
  const ranges = video.buffered;
  if (!ranges) return video.readyState >= 4 ? 2 : 0;
  for (let i = 0; i < ranges.length; i++) {
    if (video.currentTime < ranges.start(i) || video.currentTime >= ranges.end(i)) continue;
    let ahead = ranges.end(i) - video.currentTime;
    if (video.loop && Number.isFinite(video.duration) && ranges.end(i) >= video.duration - 0.001) {
      for (let j = 0; j < ranges.length; j++) if (ranges.start(j) < 0.001) { ahead += ranges.end(j); break; }
    }
    return ahead;
  }
  return 0;
}
