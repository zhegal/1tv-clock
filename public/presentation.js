export class ClockPresentation {
  constructor(stage, clock, loader, progress, status, start, message, activate) {
    Object.assign(this, { stage, clock, loader, progress, status, start, message, activate });
    this.events = new AbortController(); this.shown = false; this.percent = -1; this.lastTap = null;
    const listen = (target, name, fn, options = {}) => target.addEventListener(name, fn, { ...options, signal: this.events.signal });
    listen(stage, 'contextmenu', event => event.preventDefault());
    listen(clock, 'dragstart', event => event.preventDefault());
    listen(clock, 'click', activate);
    listen(clock, 'dblclick', event => { event.preventDefault(); this.toggleFullscreen(); });
    listen(clock, 'pointerup', event => {
      if (event.pointerType !== 'touch' || !event.isPrimary) return;
      const now = performance.now(), previous = this.lastTap;
      this.lastTap = { time: now, x: event.clientX, y: event.clientY };
      if (previous && now - previous.time < 350 && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 32) {
        event.preventDefault(); this.lastTap = null; this.toggleFullscreen();
      }
    });
    // Some touch engines synthesize dblclick after the two pointerup events.
    listen(start, 'click', activate);
    const document = stage.ownerDocument;
    const fullscreenChanged = () => stage.setAttribute('data-fullscreen', (document.fullscreenElement || document.webkitFullscreenElement) === stage ? 'true' : 'false');
    listen(document, 'fullscreenchange', fullscreenChanged);
    listen(document, 'webkitfullscreenchange', fullscreenChanged);
  }
  update(decoded, total, videoReady, audioReady, blocked = false, retrying = false) {
    if (this.shown) return;
    const percent = Math.min(99, Math.floor(decoded / total * 65 + (videoReady ? 25 : 0) + (audioReady ? 10 : 0)));
    if (percent !== this.percent) { this.percent = percent; this.progress.value = percent; }
    this.start.hidden = !blocked;
    const text = blocked ? 'Нажмите, чтобы запустить часы.' : retrying ? 'Загрузка продолжается…' : decoded < total ? 'Подготавливаем изображение…' : !videoReady ? 'Подготавливаем фон…' : 'Синхронизируем часы…';
    if (this.status.textContent !== text) this.status.textContent = text;
  }
  reveal() {
    this.shown = true; this.progress.value = 100; this.stage.setAttribute('aria-busy', 'false'); this.loader.hidden = true;
  }
  toggleFullscreen() {
    if (performance.now() - (this.lastFullscreenAt ?? -Infinity) < 400) return;
    this.lastFullscreenAt = performance.now(); this.activate();
    const document = this.stage.ownerDocument;
    const current = document.fullscreenElement || document.webkitFullscreenElement;
    const action = current ? document.exitFullscreen || document.webkitExitFullscreen : this.stage.requestFullscreen || this.stage.webkitRequestFullscreen;
    if (!action) { this.unavailable(); return; }
    try { Promise.resolve(action.call(current ? document : this.stage)).catch(() => this.unavailable()); }
    catch { this.unavailable(); }
  }
  unavailable() {
    this.message.hidden = false; clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => { this.message.hidden = true; }, 4000);
  }
  dispose() { this.events.abort(); clearTimeout(this.messageTimer); }
}
