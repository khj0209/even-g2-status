/**
 * Experimental drowsiness warning from the glasses' motion sensor.
 *
 * The SDK reports three numbers (x, y, z) without saying what they measure, so the detector is
 * calibrated by the wearer: parked, they nod twice, and the axis that moved most — and in which
 * direction — becomes "head dropping". While driving, a head drop well past half that nod's depth
 * that lasts, then comes back, counts as a nod; two within 90 s, or one held for 2.5 s, raise the
 * warning. Turning the head to check mirrors mostly moves a different axis.
 */

export interface DrowsyCalibration {
  axis: 0 | 1 | 2;
  /** +1 if dropping the head increases the value on that axis, −1 if it decreases it. */
  sign: 1 | -1;
  /** How far a deliberate nod moved that axis. */
  amp: number;
}

const BASELINE_TAU_MS = 10000;
const NOD_MIN_MS = 400;
const LONG_DROP_MS = 2500;
const NOD_WINDOW_MS = 90000;
const COOLDOWN_MS = 3 * 60 * 1000;
/** Only watch while actually driving. */
const MIN_KMH = 20;

/** Records a calibration: call add() for a few seconds while the wearer nods, then finish(). */
export class DrowsyCalibrator {
  private samples: number[][] = [];

  add(v: number[]): void {
    this.samples.push(v);
  }

  get count(): number {
    return this.samples.length;
  }

  finish(): DrowsyCalibration | null {
    if (this.samples.length < 5) return null;
    let best: DrowsyCalibration | null = null;
    for (const axis of [0, 1, 2] as const) {
      const vals = this.samples.map((s) => s[axis]).sort((a, b) => a - b);
      const median = vals[Math.floor(vals.length / 2)];
      const lo = vals[0] - median;
      const hi = vals[vals.length - 1] - median;
      const amp = Math.max(Math.abs(lo), Math.abs(hi));
      if (!best || amp > best.amp) best = { axis, sign: Math.abs(hi) >= Math.abs(lo) ? 1 : -1, amp };
    }
    return best && best.amp > 0 ? best : null;
  }
}

export class DrowsinessDetector {
  private baseline: number | null = null;
  private lastTs = 0;
  private downSince: number | null = null;
  private nods: number[] = [];
  private alertedAt = -Infinity;

  constructor(private cal: DrowsyCalibration) {}

  /** Feed one sensor sample. Returns true when the wearer should be warned. */
  sample(v: number[], ts: number, speedKmh: number): boolean {
    const value = v[this.cal.axis];
    const dt = this.lastTs ? ts - this.lastTs : 0;
    this.lastTs = ts;
    if (this.baseline == null) {
      this.baseline = value;
      return false;
    }
    const dev = this.cal.sign * (value - this.baseline);
    const down = dev > 0.5 * this.cal.amp;
    // Follow slow posture changes, but not the head drop itself.
    if (!down) this.baseline += (1 - Math.exp(-dt / BASELINE_TAU_MS)) * (value - this.baseline);
    if (speedKmh < MIN_KMH) {
      this.downSince = null;
      return false;
    }

    let warn = false;
    if (down) {
      this.downSince ??= ts;
      if (ts - this.downSince > LONG_DROP_MS) warn = true;
    } else if (this.downSince != null && dev < 0.25 * this.cal.amp) {
      if (ts - this.downSince >= NOD_MIN_MS) this.nods.push(ts);
      this.downSince = null;
    }
    this.nods = this.nods.filter((t) => ts - t < NOD_WINDOW_MS);
    if (this.nods.length >= 2) warn = true;
    if (warn && ts - this.alertedAt > COOLDOWN_MS) {
      this.alertedAt = ts;
      this.nods = [];
      return true;
    }
    return false;
  }
}
