import { angleDiff, bearing, destination, distance, interpolate, projectOnSegment } from '../core/geo';
import type { Fix, LatLon } from '../core/types';

/** A position on a polyline, with the direction of travel along it. */
export interface PathRef {
  points: LatLon[];
  /** Segment index: the position lies between points[seg] and points[seg + 1]. */
  seg: number;
  /** 0..1 along that segment. */
  t: number;
  /** Travelling in the direction of increasing point index. */
  forward: boolean;
}

export function pointOnPath(ref: PathRef): LatLon {
  return interpolate(ref.points[ref.seg], ref.points[ref.seg + 1], ref.t);
}

/** Direction of travel at the position, degrees clockwise from north. */
export function bearingOnPath(ref: PathRef): number {
  const a = ref.points[ref.seg];
  const b = ref.points[ref.seg + 1];
  return ref.forward ? bearing(a, b) : bearing(b, a);
}

/** Heading must agree with the road to within this many degrees (either way along it). */
const MAX_ANGLE = 35;

/**
 * Closest place on any of `paths` within `maxDist` metres whose direction agrees with the heading.
 * `prefer` (the path matched last time) gets a small bonus so the match doesn't flip between two
 * parallel roads (e.g. a road and its frontage road) on every fix.
 */
export function matchToPaths(fix: Fix, paths: LatLon[][], maxDist: number, prefer?: LatLon[] | null): PathRef | null {
  if (fix.heading == null) return null;
  let best: { score: number; ref: PathRef } | null = null;
  for (const points of paths) {
    for (let i = 0; i + 1 < points.length; i++) {
      const { dist, t } = projectOnSegment(fix, points[i], points[i + 1]);
      if (dist > maxDist) continue;
      const off = Math.abs(angleDiff(fix.heading, bearing(points[i], points[i + 1])));
      const along = Math.min(off, 180 - off);
      if (along > MAX_ANGLE) continue;
      const score = dist + along / 3 - (points === prefer ? 5 : 0);
      if (!best || score < best.score) best = { score, ref: { points, seg: i, t, forward: off <= 90 } };
    }
  }
  return best?.ref ?? null;
}

/** Move `meters` along the path in the direction of travel. `ended` if the path ran out first. */
export function advance(ref: PathRef, meters: number): { ref: PathRef; ended: boolean; left: number } {
  const { points, forward } = ref;
  let seg = ref.seg;
  let t = ref.t;
  let left = meters;
  for (;;) {
    const len = distance(points[seg], points[seg + 1]);
    // Metres from the current position to the end of this segment, in the direction of travel.
    const room = len * (forward ? 1 - t : t);
    if (left <= room || len === 0) {
      if (len > 0) t += ((forward ? 1 : -1) * left) / len;
      return { ref: { points, seg, t, forward }, ended: false, left: 0 };
    }
    left -= room;
    const next = forward ? seg + 1 : seg - 1;
    if (next < 0 || next + 1 >= points.length) {
      return { ref: { points, seg, t: forward ? 1 : 0, forward }, ended: true, left };
    }
    seg = next;
    t = forward ? 0 : 1;
  }
}

/** Snap only when moving: below this (m/s) the heading isn't trustworthy enough to pick a road. */
const MIN_SNAP_SPEED = 2;
const ROUTE_SNAP_DIST = 30;
const ROAD_SNAP_DIST = 20;

/**
 * Map matching: puts each fix on the most plausible road (the active route first, then any nearby
 * road) and takes the heading from the road, so the minimap, turn distances and limit lookups don't
 * wobble with GPS scatter between buildings. Fixes it can't place confidently pass through unchanged.
 */
export class MapMatcher {
  /** Where the last fix was matched, for extrapolating through tunnels. */
  last: PathRef | null = null;

  snap(fix: Fix, route: LatLon[] | null, roads: LatLon[][]): Fix {
    this.last = null;
    if ((fix.speed ?? 0) < MIN_SNAP_SPEED) return fix;
    const prefer = this.prev;
    const ref =
      (route && matchToPaths(fix, [route], ROUTE_SNAP_DIST)) || matchToPaths(fix, roads, ROAD_SNAP_DIST, prefer);
    this.prev = ref?.points ?? null;
    if (!ref) return fix;
    this.last = ref;
    return { ...fix, ...pointOnPath(ref), heading: bearingOnPath(ref) };
  }

  private prev: LatLon[] | null = null;

  /** The road the last fix was matched to (identity only), or null. */
  get road(): LatLon[] | null {
    return this.prev;
  }
}

/** Start extrapolating after this long without a fix (GPS normally arrives every 0.5–1 s). */
export const DR_START_MS = 2500;
/** Give up after this long: long enough for most tunnels (서울 우면산터널 ~2 km ≈ 2 min). */
export const DR_MAX_MS = 150000;
/** Below this (m/s, ~11 km/h) don't extrapolate: the car may well have stopped. */
const DR_MIN_SPEED = 3;

/**
 * Dead reckoning: where the car probably is `elapsedMs` after the last real fix, assuming it kept
 * its speed and followed the road it was matched to (straight on along the last heading once that
 * road ends or if it wasn't matched). Null if there's nothing sensible to extrapolate.
 */
export function deadReckon(last: Fix, ref: PathRef | null, elapsedMs: number, now: number): Fix | null {
  if (elapsedMs < DR_START_MS || elapsedMs > DR_MAX_MS) return null;
  if (last.speed == null || last.speed < DR_MIN_SPEED) return null;
  const meters = last.speed * (elapsedMs / 1000);
  let pos: LatLon;
  let heading: number;
  if (ref) {
    const moved = advance(ref, meters);
    pos = pointOnPath(moved.ref);
    heading = bearingOnPath(moved.ref);
    if (moved.ended && moved.left > 0) pos = destination(pos, heading, moved.left);
  } else if (last.heading != null) {
    heading = last.heading;
    pos = destination(last, heading, meters);
  } else return null;
  return { ...pos, speed: last.speed, heading, ts: now, estimated: true };
}

/**
 * The road ahead of a matched position as a polyline of `meters`, following the matched way (or
 * route) and carrying straight on past its end — roads are often split into several ways at
 * junctions, and the next one isn't known yet.
 */
export function pathAhead(ref: PathRef, meters: number): LatLon[] {
  const { points, forward } = ref;
  const out: LatLon[] = [pointOnPath(ref)];
  let cur = out[0];
  let left = meters;
  for (let i = forward ? ref.seg + 1 : ref.seg; left > 0 && i >= 0 && i < points.length; i += forward ? 1 : -1) {
    const d = distance(cur, points[i]);
    if (d >= left) {
      out.push(destination(cur, bearing(cur, points[i]), left));
      return out;
    }
    if (d > 0) out.push(points[i]);
    left -= d;
    cur = points[i];
  }
  if (left > 0) {
    const dir = out.length >= 2 ? bearing(out[out.length - 2], cur) : bearingOnPath(ref);
    out.push(destination(cur, dir, left));
  }
  return out;
}

/** How far along `path` the point lies, and how far off it, or null if it's beyond either end. */
export function alongPath(path: LatLon[], p: LatLon): { along: number; off: number } | null {
  let best: { along: number; off: number } | null = null;
  let walked = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const len = distance(path[i], path[i + 1]);
    const { dist, t } = projectOnSegment(p, path[i], path[i + 1]);
    const endClamped = (i === 0 && t === 0) || (i + 2 === path.length && t === 1);
    if (!endClamped && (!best || dist < best.off)) best = { along: walked + t * len, off: dist };
    walked += len;
  }
  return best;
}
