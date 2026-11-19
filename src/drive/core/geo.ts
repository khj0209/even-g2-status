import type { LatLon } from './types';

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function distance(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing a→b, degrees clockwise from north in [0, 360). */
export function bearing(a: LatLon, b: LatLon): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Signed smallest difference b − a in (−180, 180]. Positive = b is clockwise (to the right) of a. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export interface Projection {
  /** Metres from p to the closest point on the segment. */
  dist: number;
  /** Position along the segment, 0..1. */
  t: number;
}

/** Closest point on segment a–b to p (flat-earth approximation, fine at road scale). */
export function projectOnSegment(p: LatLon, a: LatLon, b: LatLon): Projection {
  const kx = R * rad(1) * Math.cos(rad(p.lat));
  const ky = R * rad(1);
  const ax = (a.lon - p.lon) * kx;
  const ay = (a.lat - p.lat) * ky;
  const bx = (b.lon - p.lon) * kx;
  const by = (b.lat - p.lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return { dist: Math.hypot(ax + t * dx, ay + t * dy), t };
}

export function interpolate(a: LatLon, b: LatLon, t: number): LatLon {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

/** East/north offset of `to` from `from`, in metres (flat-earth approximation, fine at road scale). */
export function localOffset(from: LatLon, to: LatLon): { east: number; north: number } {
  const kx = R * rad(1) * Math.cos(rad(from.lat));
  const ky = R * rad(1);
  return { east: (to.lon - from.lon) * kx, north: (to.lat - from.lat) * ky };
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compass(heading: number): string {
  return COMPASS[Math.round((((heading % 360) + 360) % 360) / 45) % 8];
}

/** The point `meters` away from `p` on initial bearing `bearingDeg` (flat-earth, fine for a few km). */
export function destination(p: LatLon, bearingDeg: number, meters: number): LatLon {
  const b = rad(bearingDeg);
  return {
    lat: p.lat + deg((meters * Math.cos(b)) / R),
    lon: p.lon + deg((meters * Math.sin(b)) / (R * Math.cos(rad(p.lat)))),
  };
}
