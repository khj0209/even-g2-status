import { distance } from '../core/geo';
import type { Fix } from '../core/types';

export interface Trip {
  start: number;
  end: number;
  /** Metres. */
  distance: number;
  /** Time spent moving, ms. */
  movingMs: number;
  maxKmh: number;
}

/** A trip starts once the car moves faster than this (m/s, ~11 km/h)… */
const START_SPEED = 3;
/** …and ends after standing still this long. */
const END_AFTER_MS = 5 * 60 * 1000;
const MOVING_SPEED = 1.5;
/** Ignore steps longer than this between fixes (a gap or a glitch, not driving). */
const MAX_STEP = 2000;
export const MAX_TRIPS = 30;

/** Odometer and trip log. Feed it every position shown, including estimated ones in tunnels. */
export class TripRecorder {
  /** Metres since the app started. */
  odometer = 0;
  current: Trip | null = null;
  private last: Fix | null = null;
  private stoppedSince: number | null = null;

  constructor(private onTripEnd: (trip: Trip) => void) {}

  update(fix: Fix): void {
    const last = this.last;
    this.last = fix;
    if (!last || fix.ts <= last.ts) return;
    const d = distance(last, fix);
    const dt = fix.ts - last.ts;
    const speed = fix.speed ?? d / (dt / 1000);
    if (d < MAX_STEP) this.odometer += d;

    if (!this.current) {
      if (speed > START_SPEED) this.current = { start: last.ts, end: fix.ts, distance: 0, movingMs: 0, maxKmh: 0 };
      else return;
    }
    const t = this.current;
    if (d < MAX_STEP) t.distance += d;
    t.end = fix.ts;
    if (speed > MOVING_SPEED) {
      t.movingMs += dt;
      this.stoppedSince = null;
    } else this.stoppedSince ??= fix.ts;
    t.maxKmh = Math.max(t.maxKmh, speed * 3.6);
    if (this.stoppedSince != null && fix.ts - this.stoppedSince > END_AFTER_MS) this.finish();
  }

  /** Close the current trip (also when the app stops). Trips under 300 m aren't kept. */
  finish(): void {
    const t = this.current;
    this.current = null;
    this.stoppedSince = null;
    if (t && t.distance >= 300) this.onTripEnd(t);
  }
}
