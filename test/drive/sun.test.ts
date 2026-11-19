import { describe, expect, it } from 'vitest';
import { isDark, sunAltitude } from '../../src/drive/core/sun';

const seoul = { lat: 37.57, lon: 126.98 };

describe('sunAltitude', () => {
  it('is high at noon in summer and below the horizon at midnight', () => {
    // 2026-06-21 12:30 KST (03:30 UTC): about 76° in Seoul.
    expect(sunAltitude(new Date(Date.UTC(2026, 5, 21, 3, 30)), seoul)).toBeCloseTo(75.8, 0);
    expect(sunAltitude(new Date(Date.UTC(2026, 5, 21, 15, 0)), seoul)).toBeLessThan(-20);
  });

  it('crosses the horizon around sunset', () => {
    // Seoul sunset on 2026-11-18 is about 17:20 KST (08:20 UTC).
    expect(sunAltitude(new Date(Date.UTC(2026, 10, 18, 8, 0)), seoul)).toBeGreaterThan(0);
    expect(sunAltitude(new Date(Date.UTC(2026, 10, 18, 8, 40)), seoul)).toBeLessThan(0);
  });

  it('calls it dark only after twilight', () => {
    expect(isDark(new Date(Date.UTC(2026, 10, 18, 8, 25)), seoul)).toBe(false);
    expect(isDark(new Date(Date.UTC(2026, 10, 18, 9, 30)), seoul)).toBe(true);
  });
});
