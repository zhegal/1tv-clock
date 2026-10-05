export const LOOP = 60;
export const modulo = (n, base = LOOP) => ((n % base) + base) % base;
export const phaseAt = (wallMs) => modulo(wallMs / 1000);
// Positive error: actual media leads the authoritative wall clock.
export const phaseError = (actual, expected) => modulo(actual - expected + LOOP / 2) - LOOP / 2;
export function statesAt(wallMs) {
  const date = new Date(wallMs);
  const second = date.getSeconds();
  const minute = date.getMinutes();
  const hour = date.getHours() % 12;
  return { second, minute: minute * 4 + Math.floor(second / 15), hour: hour * 20 + Math.floor(minute / 3) };
}
export function videoCorrection(error) {
  if (Math.abs(error) > 0.35) return { seek: true, rate: 1 };
  // 35ms deadband absorbs frame quantization and currentTime precision.
  return { seek: false, rate: Math.abs(error) <= 0.035 ? 1 : Math.max(0.97, Math.min(1.03, 1 - error * 0.12)) };
}
export function audioCorrection(error) {
  if (Math.abs(error) > 0.18) return { restart: true, rate: 1 };
  return { restart: false, rate: Math.abs(error) <= 0.015 ? 1 : Math.max(0.998, Math.min(1.002, 1 - error * 0.02)) };
}
// Compare the two independent clocks only to detect jumps/sleep. Every rendered
// hand state and expected media phase is always recomputed from Date.now().
export class ClockMonitor {
  constructor(wallMs, monoMs) { this.wall = wallMs; this.mono = monoMs; }
  sample(wallMs, monoMs) {
    const wallDelta = wallMs - this.wall;
    const monoDelta = monoMs - this.mono;
    this.wall = wallMs; this.mono = monoMs;
    return Math.abs(wallDelta - monoDelta) > 200 || monoDelta > 2500;
  }
}
