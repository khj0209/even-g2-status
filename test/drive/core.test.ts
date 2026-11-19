import { describe, expect, it } from 'vitest';
import { angleDiff, bearing, compass, distance, projectOnSegment } from '../../src/drive/core/geo';
import { displaySpeed, formatDistance } from '../../src/drive/core/format';

const seoul = { lat: 37.5665, lon: 126.978 };

describe('geo', () => {
  it('measures distance and bearing', () => {
    const north = { lat: seoul.lat + 0.009, lon: seoul.lon };
    expect(distance(seoul, north)).toBeCloseTo(1000.8, 0);
    expect(bearing(seoul, north)).toBeCloseTo(0, 5);
    expect(bearing(seoul, { lat: seoul.lat, lon: seoul.lon + 0.01 })).toBeCloseTo(90, 1);
  });

  it('gives signed angle differences across north', () => {
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(-20);
    expect(angleDiff(0, 180)).toBe(180);
  });

  it('projects a point onto a segment', () => {
    const a = seoul;
    const b = { lat: seoul.lat, lon: seoul.lon + 0.01 };
    const p = { lat: seoul.lat + 0.0001, lon: seoul.lon + 0.005 };
    const r = projectOnSegment(p, a, b);
    expect(r.t).toBeCloseTo(0.5, 2);
    expect(r.dist).toBeCloseTo(11.1, 0);
    expect(projectOnSegment({ lat: seoul.lat, lon: seoul.lon - 0.01 }, a, b).t).toBe(0);
  });

  it('names compass points', () => {
    expect([0, 44, 90, 200, 359].map(compass)).toEqual(['N', 'NE', 'E', 'S', 'N']);
  });
});

describe('format', () => {
  it('rounds speed and suppresses standstill jitter', () => {
    expect(displaySpeed(0.4, 'kmh')).toBe(0);
    expect(displaySpeed(27.78, 'kmh')).toBe(100);
    expect(displaySpeed(27.78, 'mph')).toBe(62);
  });

  it('formats distances coarsely', () => {
    expect(formatDistance(4, 'kmh')).toBe('10 m');
    expect(formatDistance(87, 'kmh')).toBe('90 m');
    expect(formatDistance(337, 'kmh')).toBe('350 m');
    expect(formatDistance(1234, 'kmh')).toBe('1.2 km');
    expect(formatDistance(14200, 'kmh')).toBe('14 km');
    expect(formatDistance(100, 'mph')).toBe('350 ft');
    expect(formatDistance(3000, 'mph')).toBe('1.9 mi');
  });
});
