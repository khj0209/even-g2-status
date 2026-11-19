import { distance } from '../core/geo';
import type { Fix, SectionStatus } from '../core/types';
import type { RoadData } from './roads';
import { CAM_SECTION_END, CAM_SECTION_START } from './tileformat';

/** Passing a camera means coming within this distance of it. */
const PASS_DIST = 30;
/** Without a known section length, give up after this long. */
const MAX_SECTION_MS = 60 * 60 * 1000;

/**
 * Section speed checks (구간단속): from the start camera on, the average speed is what is enforced.
 * Started by passing a section-start camera, ended by passing a section-end camera, by going well
 * past the section's length, or after an hour.
 */
export class SectionTracker {
  private active: { startOdo: number; startTs: number; limit: number | null; length: number } | null = null;

  /** `odometer`: metres driven so far (any origin), from the trip recorder. */
  update(fix: Fix, odometer: number, data: RoadData): SectionStatus | null {
    const now = fix.ts;
    const near = (kind: number) => data.cameras.find((c) => (c.kind ?? 0) === kind && distance(fix, c) < PASS_DIST);
    if (!this.active) {
      const start = near(CAM_SECTION_START);
      if (!start) return null;
      this.active = { startOdo: odometer, startTs: now, limit: start.maxspeed, length: start.section ?? 0 };
    }
    const a = this.active;
    const travelled = odometer - a.startOdo;
    const ended =
      (travelled > 200 && near(CAM_SECTION_END)) ||
      (a.length > 0 && travelled > a.length + 500) ||
      now - a.startTs > MAX_SECTION_MS;
    if (ended) {
      this.active = null;
      return null;
    }
    const secs = (now - a.startTs) / 1000;
    return {
      limit: a.limit,
      avgKmh: secs > 3 ? (travelled / secs) * 3.6 : 0,
      remaining: a.length > 0 ? Math.max(0, a.length - travelled) : null,
    };
  }
}
