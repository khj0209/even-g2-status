import { describe, expect, it } from 'vitest';
import { distance } from '../../src/drive/core/geo';
import type { Fix, LatLon } from '../../src/drive/core/types';
import { advance, deadReckon, DR_MAX_MS, MapMatcher, matchToPaths, pointOnPath } from '../../src/drive/services/matching';

const M = 1 / 111195; // degrees latitude per metre
const MLON = M / Math.cos((37.5 * Math.PI) / 180); // degrees longitude per metre at 37.5°N
const T = Date.now();
const fix = (lat: number, lon: number, heading: number | null, speed = 15): Fix => ({ lat, lon, heading, speed, ts: T });

// East–west road along 37.5°N, and a north–south road crossing it at 127.0.
const eastWest: LatLon[] = [
  { lat: 37.5, lon: 126.99 },
  { lat: 37.5, lon: 127.0 },
  { lat: 37.5, lon: 127.01 },
];
const northSouth: LatLon[] = [
  { lat: 37.49, lon: 127.0 },
  { lat: 37.51, lon: 127.0 },
];

describe('matchToPaths', () => {
  it('picks the road that agrees with the heading at a junction', () => {
    const near = fix(37.5 + 5 * M, 127.0 + 5 * MLON, 92);
    expect(matchToPaths(near, [eastWest, northSouth], 20)?.points).toBe(eastWest);
    expect(matchToPaths({ ...near, heading: 3 }, [eastWest, northSouth], 20)?.points).toBe(northSouth);
  });

  it('knows which way along the road the car is going', () => {
    expect(matchToPaths(fix(37.5, 127.005, 90), [eastWest], 20)?.forward).toBe(true);
    expect(matchToPaths(fix(37.5, 127.005, 270), [eastWest], 20)?.forward).toBe(false);
  });

  it('does not match a road too far away, or without a heading', () => {
    expect(matchToPaths(fix(37.5 + 40 * M, 127.005, 90), [eastWest], 20)).toBeNull();
    expect(matchToPaths(fix(37.5, 127.005, null), [eastWest], 20)).toBeNull();
  });

  it('sticks with the previous road when a parallel one is about as close', () => {
    const frontage: LatLon[] = eastWest.map((p) => ({ lat: p.lat + 16 * M, lon: p.lon }));
    const between = fix(37.5 + 9 * M, 127.005, 90); // 9 m from the main road, 7 m from the frontage road
    expect(matchToPaths(between, [eastWest, frontage], 20)?.points).toBe(frontage);
    expect(matchToPaths(between, [eastWest, frontage], 20, eastWest)?.points).toBe(eastWest);
  });
});

describe('MapMatcher', () => {
  it('puts a scattered fix on the road and takes the heading from it', () => {
    const m = new MapMatcher();
    const snapped = m.snap(fix(37.5 + 12 * M, 127.005, 80), null, [eastWest]);
    expect(snapped.lat).toBeCloseTo(37.5, 6);
    expect(snapped.heading).toBeCloseTo(90, 0);
    expect(m.last).not.toBeNull();
  });

  it('prefers the active route over other roads', () => {
    const m = new MapMatcher();
    const route = eastWest.map((p) => ({ lat: p.lat + 25 * M, lon: p.lon }));
    const snapped = m.snap(fix(37.5 + 8 * M, 127.005, 90), route, [eastWest]);
    expect(snapped.lat).toBeCloseTo(37.5 + 25 * M, 6);
  });

  it('leaves slow fixes alone', () => {
    const m = new MapMatcher();
    const slow = fix(37.5 + 12 * M, 127.005, 80, 1);
    expect(m.snap(slow, null, [eastWest])).toBe(slow);
    expect(m.last).toBeNull();
  });
});

describe('advance', () => {
  it('walks along the polyline across vertices, both ways', () => {
    const start = matchToPaths(fix(37.5, 126.995, 90), [eastWest], 20)!;
    const ahead = pointOnPath(advance(start, 1000).ref);
    expect(distance(ahead, { lat: 37.5, lon: 126.995 + 1000 * MLON })).toBeLessThan(2);
    const back = matchToPaths(fix(37.5, 127.005, 270), [eastWest], 20)!;
    expect(pointOnPath(advance(back, 600).ref).lon).toBeCloseTo(127.005 - 600 * MLON, 5);
  });

  it('reports running off the end', () => {
    const start = matchToPaths(fix(37.5, 127.009, 90), [eastWest], 20)!;
    const r = advance(start, 200);
    expect(r.ended).toBe(true);
    expect(r.left).toBeGreaterThan(100);
  });
});

describe('deadReckon', () => {
  const last = fix(37.5, 126.995, 90, 20); // 72 km/h eastbound
  const ref = matchToPaths(last, [eastWest], 20);

  it('waits briefly before estimating, then follows the road at the last speed', () => {
    expect(deadReckon(last, ref, 1000, T + 1000)).toBeNull();
    const est = deadReckon(last, ref, 10000, T + 10000)!;
    expect(est.estimated).toBe(true);
    expect(distance(est, last)).toBeCloseTo(200, -1);
    expect(est.heading).toBeCloseTo(90, 0);
  });

  it('carries straight on past the end of the matched road', () => {
    // 1.8 km at 20 m/s; the road ends ~1.32 km ahead, so the last ~480 m are straight on, still east.
    const est = deadReckon(last, ref, 90000, T + 90000)!;
    expect(est.lon).toBeGreaterThan(127.01);
    expect(distance(est, last)).toBeCloseTo(1800, -1);
    expect(est.lat).toBeCloseTo(37.5, 5);
  });

  it('falls back to the heading without a road, and gives up when slow or after too long', () => {
    expect(distance(deadReckon(last, null, 5000, T + 5000)!, last)).toBeCloseTo(100, -1);
    expect(deadReckon({ ...last, speed: 1 }, ref, 5000, T + 5000)).toBeNull();
    expect(deadReckon({ ...last, heading: null }, null, 5000, T + 5000)).toBeNull();
    expect(deadReckon(last, ref, DR_MAX_MS + 1, T)).toBeNull();
  });
});
