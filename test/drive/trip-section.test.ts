import { describe, expect, it } from 'vitest';
import type { Fix } from '../../src/drive/core/types';
import { emptyRoadData } from '../../src/drive/services/roads';
import { SectionTracker } from '../../src/drive/services/section';
import { CAM_SECTION_END, CAM_SECTION_START } from '../../src/drive/services/tileformat';
import { TripRecorder, type Trip } from '../../src/drive/services/trip';

const M = 1 / 111195;
const T0 = Date.UTC(2026, 10, 19, 0, 0);
/** Driving north from 37.5°N at `mps`, sampled each second. */
const at = (s: number, mps: number, from = 0): Fix => ({ lat: 37.5 + (from + s * mps) * M, lon: 127, speed: mps, heading: 0, ts: T0 + s * 1000 });

describe('TripRecorder', () => {
  it('records a trip and closes it after five minutes standing', () => {
    const done: Trip[] = [];
    const r = new TripRecorder((t) => done.push(t));
    for (let s = 0; s <= 120; s++) r.update(at(s, 15)); // 2 min at 54 km/h = 1.8 km
    expect(r.current!.distance).toBeCloseTo(1800, -1);
    expect(r.odometer).toBeCloseTo(1800, -1);
    for (let s = 121; s <= 121 + 310; s++) r.update({ ...at(120, 15), speed: 0, ts: T0 + s * 1000 });
    expect(r.current).toBeNull();
    expect(done).toHaveLength(1);
    expect(done[0].maxKmh).toBeCloseTo(54, 0);
    expect(done[0].movingMs).toBeCloseTo(120000, -3);
  });

  it('does not keep very short trips, or start without moving', () => {
    const done: Trip[] = [];
    const r = new TripRecorder((t) => done.push(t));
    for (let s = 0; s < 10; s++) r.update(at(s, 1));
    expect(r.current).toBeNull();
    for (let s = 10; s < 20; s++) r.update(at(s, 10));
    r.finish();
    expect(done).toHaveLength(0); // ~100 m
  });
});

describe('SectionTracker', () => {
  const data = {
    ...emptyRoadData(),
    cameras: [
      { lat: 37.5 + 100 * M, lon: 127, maxspeed: 80, kind: CAM_SECTION_START, section: 2000 },
      { lat: 37.5 + 2100 * M, lon: 127, maxspeed: 80, kind: CAM_SECTION_END },
    ],
  };

  it('averages speed from the start camera and ends at the end camera', () => {
    const tr = new SectionTracker();
    const r = new TripRecorder(() => {});
    let status = null;
    for (let s = 0; s <= 90; s++) {
      const f = at(s, 25); // 90 km/h
      r.update(f);
      status = tr.update(f, r.odometer, data);
      if (s === 2) expect(status).toBeNull(); // 50 m: not yet at the start camera (100 m)
      if (s === 40) {
        expect(status!.avgKmh).toBeCloseTo(90, 0);
        expect(status!.remaining).toBeCloseTo(2000 - (1000 - 100), -2);
        expect(status!.limit).toBe(80);
      }
    }
    expect(status).toBeNull(); // passed the end camera at 2100 m
  });
});
