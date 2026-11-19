/**
 * Driving mode: hands the glasses from the status HUD to the Drive HUD and back.
 *
 * - Manual: the glasses menu ("운전 모드"), or the phone's DRIVE button. Ends from the Drive
 *   HUD's menu ("운전 모드 끝내기"), a double tap, or the phone.
 * - Automatic (setting): while the glasses are worn, GPS speed is sampled every 30 s; two samples
 *   in a row at or above the threshold start driving mode. An automatically started driving mode
 *   ends by itself when the Drive HUD closes the trip (stopped for 5 minutes).
 * - Leaving by hand while still moving pauses the automatic start for a while, so it doesn't
 *   jump straight back (e.g. a passenger who wants the status HUD).
 */

export interface StatusSide {
  suspend(): void;
  resume(): Promise<void>;
  /** Glasses worn and app in the foreground (worth polling GPS for). */
  isWorn(): boolean;
}

export interface DriveSide {
  startDriving(onExit: () => void): void;
  stopDriving(): void;
  onTripEnd(fn: () => void): void;
}

export type DriveState = 'off' | 'manual' | 'auto';

export const POLL_MS = 30_000;
/** Samples in a row at/above the threshold before starting automatically. */
export const AUTO_HITS = 2;
/** After a manual exit, don't start automatically again for this long. */
export const AUTO_SNOOZE_MS = 15 * 60_000;

export class DriveController {
  state: DriveState = 'off';
  private hits = 0;
  private snoozeUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private listeners = new Set<() => void>();

  constructor(
    private status: StatusSide,
    private drive: DriveSide,
    private opts: {
      getSpeed: () => Promise<number | null>;
      settings: () => { auto: boolean; autoKmh: number };
      now?: () => number;
    },
  ) {
    drive.onTripEnd(() => {
      if (this.state === 'auto') void this.exit('trip-end');
    });
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  /** Start sampling speed for the automatic start. */
  startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async enter(kind: 'manual' | 'auto' = 'manual'): Promise<void> {
    if (this.state !== 'off') return;
    this.state = kind;
    this.hits = 0;
    this.status.suspend();
    this.drive.startDriving(() => void this.exit('wearer'));
    this.emit();
  }

  /** `reason`: 'wearer'/'phone' are manual exits (snooze auto start), 'trip-end' is automatic. */
  async exit(reason: 'wearer' | 'phone' | 'trip-end' = 'phone'): Promise<void> {
    if (this.state === 'off') return;
    this.state = 'off';
    this.hits = 0;
    if (reason !== 'trip-end') this.snoozeUntil = this.now() + AUTO_SNOOZE_MS;
    this.drive.stopDriving();
    await this.status.resume();
    this.emit();
  }

  async toggle(): Promise<void> {
    if (this.state === 'off') await this.enter('manual');
    else await this.exit('phone');
  }

  /** One automatic-start sample. Exposed for tests; normally run by startPolling(). */
  async poll(): Promise<void> {
    const { auto, autoKmh } = this.opts.settings();
    if (this.polling || this.state !== 'off' || !auto || !this.status.isWorn() || this.now() < this.snoozeUntil) {
      this.hits = 0;
      return;
    }
    this.polling = true;
    try {
      const speed = await this.opts.getSpeed();
      if (speed !== null && speed * 3.6 >= autoKmh) this.hits++;
      else this.hits = 0;
      if (this.hits >= AUTO_HITS) await this.enter('auto');
    } finally {
      this.polling = false;
    }
  }
}
