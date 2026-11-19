import type { LatLon } from './types';

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/**
 * Sun's altitude above the horizon in degrees (NOAA's simplified solar position; good to well
 * under a degree, plenty for "is it dark?").
 */
export function sunAltitude(date: Date, p: LatLon): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = (date.getTime() - start) / 86400000; // fractional day of year, UTC
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const g = ((2 * Math.PI) / 365) * (day - 1 + (hour - 12) / 24);
  const eqTime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  const solarMinutes = hour * 60 + eqTime + 4 * p.lon;
  const hourAngle = rad(solarMinutes / 4 - 180);
  const lat = rad(p.lat);
  const cosZenith = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  return 90 - deg(Math.acos(Math.max(-1, Math.min(1, cosZenith))));
}

/** Dark enough to dim the HUD: the sun a few degrees below the horizon (late civil twilight). */
export const isDark = (date: Date, p: LatLon) => sunAltitude(date, p) < -4;
