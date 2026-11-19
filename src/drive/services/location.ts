import { AppLocationAccuracy, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { angleDiff, bearing, destination, distance } from '../core/geo';
import type { Fix, LatLon } from '../core/types';
import { demoFix, inDemoTunnel } from './demo';

export interface LocationSource {
  start(onFix: (fix: Fix) => void): void;
  stop(): void;
}

const valid = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * Only fixes worse than this (metres, 1σ) are skipped outright. Poorer fixes below it are still
 * used, but weighted down by the position filter, so the HUD keeps going in urban canyons instead
 * of losing GPS whenever accuracy dips.
 */
const MAX_ACCURACY = 150;
/** A filtered position this far from a new fix is abandoned for the fix (a real jump, not noise). */
const FILTER_RESET_DIST = 150;
/** A jump implying more than this (m/s, ~250 km/h) is a glitch, not driving. */
const MAX_PLAUSIBLE_SPEED = 70;
/** After this many rejected jumps in a row, accept the new place (e.g. leaving a long tunnel). */
const MAX_REJECTS = 3;
/** m/s²: a hard stop is ~8; GPS speed jumping faster than this is a glitch. */
const MAX_PLAUSIBLE_ACCEL = 8;
/** Window for deriving speed from positions when the platform gives none. */
const DERIVE_WINDOW_MS = 3000;
/** Below this the car is treated as stopped: GPS drifts a few km/h when standing still. */
const STOPPED_KMH = 3;
/** The shown speed only moves once the measurement differs by this much, so 59/60 doesn't flicker. */
const HYSTERESIS_KMH = 0.7;

/**
 * Cleans up raw position fixes for the HUD:
 * - drops duplicates, out-of-order fixes, inaccurate fixes and impossible jumps,
 * - fills in speed/heading when the platform does not report them (speed over a short window,
 *   which is far steadier than differencing two 1 s fixes),
 * - smooths speed lightly and holds the shown value steady through GPS jitter.
 * Heading is only trusted while moving; at standstill the last heading is kept.
 */
export class FixNormalizer {
  private history: Fix[] = [];
  /** Filtered position and when it was last updated. */
  private pos: (LatLon & { ts: number; P: number; heading: number | null }) | null = null;
  private heading: number | null = null;
  private smoothed: number | null = null;
  private shownKmh: number | null = null;
  private rejects = 0;

  /** The cleaned fix, or null if this one should be ignored. */
  next(input: Fix): Fix | null {
    const raw = { ...input, ts: normalizeTimestamp(input.ts) };
    if (raw.accuracy != null && raw.accuracy > MAX_ACCURACY) return null;
    const prev = this.history[this.history.length - 1];
    if (prev && raw.ts <= prev.ts) return null;
    if (prev) {
      const implied = distance(prev, raw) / ((raw.ts - prev.ts) / 1000);
      if (implied > MAX_PLAUSIBLE_SPEED && ++this.rejects <= MAX_REJECTS) return null;
      if (implied > MAX_PLAUSIBLE_SPEED) this.history = []; // accepted relocation: start over
    }
    this.rejects = 0;

    const platformSpeed = valid(raw.speed) ? raw.speed : null;
    let speed = platformSpeed;
    let heading = valid(raw.heading) ? raw.heading : null;
    const base = this.history.find((f) => raw.ts - f.ts <= DERIVE_WINDOW_MS) ?? prev;
    if (base && base !== raw) {
      const d = distance(base, raw);
      if (speed == null) speed = d / ((raw.ts - base.ts) / 1000);
      // With a poor fix, a short move is mostly noise: demand more movement before trusting a course.
      if (heading == null && d > 3 + (raw.accuracy ?? 0) / 2) heading = bearing(base, raw);
    }
    this.history = [...this.history.filter((f) => raw.ts - f.ts <= DERIVE_WINDOW_MS), raw];

    // GPS course is noise when crawling. Judge that on the measured speed, not the smoothed one,
    // which lags behind for a moment after stopping.
    if (speed != null && speed < 1.5) heading = null;
    if (speed != null) speed = this.smooth(speed, raw.ts - (prev?.ts ?? raw.ts), platformSpeed != null);
    if (heading != null) this.heading = heading;
    return { ...raw, ...this.filterPosition(raw, speed), speed, heading: this.heading };
  }

  /**
   * A small Kalman-style filter. Each fix is blended with where the car should be by now (last
   * position carried on at the current speed and heading), weighted by how much each is trusted:
   * - driving straight with good GPS, the prediction is already right, so nothing lags;
   * - when the heading swings (a turn), the prediction is distrusted and the fix taken almost as is;
   * - a fix that disagrees with the prediction far more than its accuracy explains is a glitch and
   *   only nudges the position; one more than 150 m off is a real jump and is followed at once.
   */
  private filterPosition(raw: Fix, speed: number | null): LatLon {
    const prev = this.pos;
    const R = Math.max(raw.accuracy ?? 8, 3) ** 2;
    if (!prev) {
      this.pos = { lat: raw.lat, lon: raw.lon, ts: raw.ts, P: R, heading: this.heading };
      return { lat: raw.lat, lon: raw.lon };
    }
    const dt = Math.max(0, (raw.ts - prev.ts) / 1000);
    let pred: LatLon = prev;
    if (speed != null && speed > 1 && this.heading != null) pred = destination(prev, this.heading, speed * dt);
    // Uncertainty of the prediction: grows with time (speed errors), and a lot in a turn.
    let P = prev.P + (3 * dt) ** 2;
    const turned = prev.heading != null && this.heading != null && Math.abs(angleDiff(prev.heading, this.heading)) > 15;
    if (turned) P += 30 ** 2;
    const innov = distance(pred, raw);
    let out: LatLon;
    if (innov > FILTER_RESET_DIST) {
      out = { lat: raw.lat, lon: raw.lon };
      P = R;
    } else {
      let k = P / (P + R);
      if (innov ** 2 > 9 * (P + R)) k *= 0.3; // beyond 3σ: a glitch
      out = { lat: pred.lat + k * (raw.lat - pred.lat), lon: pred.lon + k * (raw.lon - pred.lon) };
      P = (1 - k) * P;
    }
    this.pos = { ...out, ts: raw.ts, P, heading: this.heading };
    return out;
  }


  /**
   * Exponential smoothing only where needed (implausible jumps in Doppler speed: 0.5 s; speed derived
   * from positions: 1.2 s), then hysteresis on the shown value.
   */
  private smooth(mps: number, dtMs: number, fromPlatform: boolean): number {
    // Doppler speed from the platform is already clean: pass it straight through unless the change
    // is more than a car can do (a glitch), so the speedometer doesn't lag. Speed derived from
    // positions is noisier and always gets a little smoothing.
    const plausible =
      this.smoothed != null && dtMs > 0 && Math.abs(mps - this.smoothed) / (dtMs / 1000) <= MAX_PLAUSIBLE_ACCEL;
    const tau = fromPlatform ? (plausible ? 0 : 500) : 1200;
    const alpha = this.smoothed == null || dtMs <= 0 || tau === 0 ? 1 : 1 - Math.exp(-dtMs / tau);
    this.smoothed = this.smoothed == null ? mps : this.smoothed + alpha * (mps - this.smoothed);
    let kmh = this.smoothed * 3.6;
    if (kmh < STOPPED_KMH) kmh = 0;
    if (this.shownKmh == null || kmh === 0 || Math.abs(kmh - this.shownKmh) >= HYSTERESIS_KMH) this.shownKmh = kmh;
    return this.shownKmh / 3.6;
  }
}

/** Some hosts report seconds instead of milliseconds, or a skewed clock; staleness needs ms on our clock. */
function normalizeTimestamp(ts: number): number {
  const now = Date.now();
  const ms = ts > 0 && ts < 1e12 ? ts * 1000 : ts;
  return Number.isFinite(ms) && Math.abs(ms - now) < 30000 ? ms : now;
}

/** Plain browser geolocation, for running the page outside the Even App. */
export class BrowserLocationSource implements LocationSource {
  private watch: number | null = null;

  start(onFix: (fix: Fix) => void): void {
    if (!navigator.geolocation) return;
    this.watch = navigator.geolocation.watchPosition(
      (p) =>
        onFix({
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          speed: p.coords.speed,
          heading: p.coords.heading,
          accuracy: p.coords.accuracy,
          ts: p.timestamp,
        }),
      (e) => console.warn('[location]', e.message),
      { enableHighAccuracy: true, maximumAge: 0 },
    );
  }

  stop(): void {
    if (this.watch != null) navigator.geolocation.clearWatch(this.watch);
    this.watch = null;
  }
}

/**
 * Phone GPS through the Even App (keeps working with the WebView in the background).
 * Falls back to browser geolocation where the host lacks the location API (e.g. the simulator).
 */
export class BridgeLocationSource implements LocationSource {
  private off: (() => void) | null = null;
  private fallback: BrowserLocationSource | null = null;
  constructor(private bridge: EvenAppBridge) {}

  start(onFix: (fix: Fix) => void): void {
    this.off = this.bridge.onAppLocationChanged((l) =>
      onFix({
        lat: l.latitude,
        lon: l.longitude,
        speed: l.speed ?? null,
        heading: l.heading ?? null,
        accuracy: l.accuracy,
        ts: l.timestamp ?? Date.now(),
      }),
    );
    this.bridge
      .startAppLocationUpdates({ accuracy: AppLocationAccuracy.High, intervalMs: 500, distanceFilter: 0 })
      .catch(() => false)
      .then((ok) => {
        if (ok || !this.off) return;
        console.warn('[location] Even App location unavailable, using browser geolocation');
        this.fallback = new BrowserLocationSource();
        this.fallback.start(onFix);
      });
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.fallback?.stop();
    this.fallback = null;
    void this.bridge.stopAppLocationUpdates().catch(() => false);
  }
}

/** Replays the built-in demo drive at 1 Hz, looping. */
export class DemoLocationSource implements LocationSource {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(onFix: (fix: Fix) => void): void {
    let t = 0;
    const tick = () => {
      const fix = demoFix(t++, Date.now());
      if (fix.speed === 0 && t > 5) t = 0;
      if (!inDemoTunnel(fix)) onFix(fix); // no GPS in the tunnel
    };
    tick();
    this.timer = setInterval(tick, 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
