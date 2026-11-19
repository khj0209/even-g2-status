import { angleDiff, bearing, distance, projectOnSegment } from '../core/geo';
import type { CameraAlert, Fix, LatLon } from '../core/types';
import { alongPath, pathAhead, type PathRef } from './matching';

/** A road with a tagged speed limit (km/h). */
export interface RoadWay {
  id?: number;
  maxspeed: number;
  points: LatLon[];
}

export interface Camera extends LatLon {
  id?: number;
  maxspeed: number | null;
  /** CAM_* from tileformat; a plain speed camera if absent. */
  kind?: number;
  /** Section length in metres at a section start. */
  section?: number;
}

/** Any drivable road, for drawing the minimap. */
export interface MapWay {
  id?: number;
  major: boolean;
  points: LatLon[];
}

export interface Building {
  id?: number;
  points: LatLon[];
}

export interface RoadData {
  /** Roads with a tagged limit, for speed-limit matching. */
  ways: RoadWay[];
  cameras: Camera[];
  /** All drivable roads around the car, for the minimap. */
  map: MapWay[];
  /** Building outlines around the car (closed polygons), for the minimap. */
  buildings: LatLon[][];
}

export const emptyRoadData = (): RoadData => ({ ways: [], cameras: [], map: [], buildings: [] });

import { DRIVABLE, MAJOR, parseMaxspeed } from './tileformat';

export { DRIVABLE, parseMaxspeed };

/**
 * Public Overpass servers, tried in order. They are free and often overloaded (timeouts, 429, 502),
 * so a failed request moves on to the next one, and whichever answered last is tried first.
 */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const REQUEST_TIMEOUT_MS = 30000;

export function parseOverpass(json: any): RoadData {
  const data = emptyRoadData();
  for (const el of json?.elements ?? []) {
    if (el.type === 'way' && Array.isArray(el.geometry)) {
      const points: LatLon[] = el.geometry.map((g: any) => ({ lat: g.lat, lon: g.lon }));
      const maxspeed = parseMaxspeed(el.tags?.maxspeed);
      if (maxspeed) data.ways.push({ id: el.id, maxspeed, points });
      const highway = String(el.tags?.highway ?? '');
      if (DRIVABLE.test(highway)) data.map.push({ id: el.id, major: MAJOR.test(highway), points });
    } else if (el.type === 'node') {
      data.cameras.push({ id: el.id, lat: el.lat, lon: el.lon, maxspeed: parseMaxspeed(el.tags?.maxspeed) });
    }
  }
  return data;
}

export function parseBuildings(json: any): Building[] {
  const out: Building[] = [];
  for (const el of json?.elements ?? [])
    if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 3)
      out.push({ id: el.id, points: el.geometry.map((g: any) => ({ lat: g.lat, lon: g.lon })) });
  return out;
}

const MATCH_DIST = 30;
const MATCH_ANGLE = 35;

/**
 * Speed limit of the road we are most likely on: the closest way within 30 m whose direction
 * agrees with our heading (either way along it). Without a heading, closest way wins.
 */
export function matchLimit(data: RoadData, fix: Fix): number | null {
  let best: { score: number; maxspeed: number } | null = null;
  for (const way of data.ways) {
    for (let i = 0; i + 1 < way.points.length; i++) {
      const a = way.points[i];
      const b = way.points[i + 1];
      const { dist } = projectOnSegment(fix, a, b);
      if (dist > MATCH_DIST) continue;
      let score = dist;
      if (fix.heading != null) {
        const off = Math.abs(angleDiff(fix.heading, bearing(a, b)));
        const along = Math.min(off, 180 - off);
        if (along > MATCH_ANGLE) continue;
        score += along / 3; // prefer well-aligned roads at junctions
      }
      if (!best || score < best.score) best = { score, maxspeed: way.maxspeed };
    }
  }
  return best?.maxspeed ?? null;
}

const CAMERA_ALERT_DIST = 600;
const CAMERA_CONE = 25;
/**
 * A camera counts as "on our road" within this distance of it. Cameras in OpenStreetMap usually sit
 * on the road line itself; official coordinates are often at the roadside.
 */
const ON_ROAD_DIST = 18;

/**
 * Closest camera on the road ahead. With `ref` (where the car is matched on the map) only cameras
 * on that road or route within 600 m count, measured along the road, so cameras on side roads,
 * parallel roads or the far carriageway of a divided road aren't announced. Without it (no match,
 * e.g. crawling), the fallback is anything roughly straight ahead.
 */
export function cameraAhead(data: RoadData, fix: Fix, ref: PathRef | null = null): CameraAlert | null {
  if (ref) {
    const path = pathAhead(ref, CAMERA_ALERT_DIST);
    let best: CameraAlert | null = null;
    for (const cam of data.cameras) {
      if (distance(fix, cam) > CAMERA_ALERT_DIST + ON_ROAD_DIST) continue;
      const at = alongPath(path, cam);
      if (!at || at.off > ON_ROAD_DIST || at.along < 15) continue;
      if (!best || at.along < best.dist) best = { dist: at.along, limit: cam.maxspeed, kind: cam.kind ?? 0 };
    }
    return best;
  }
  if (fix.heading == null) return null;
  let best: CameraAlert | null = null;
  for (const cam of data.cameras) {
    const dist = distance(fix, cam);
    if (dist > CAMERA_ALERT_DIST || dist < 15) continue;
    if (Math.abs(angleDiff(fix.heading, bearing(fix, cam))) > CAMERA_CONE) continue;
    if (!best || dist < best.dist) best = { dist, limit: cam.maxspeed, kind: cam.kind ?? 0 };
  }
  return best;
}

/**
 * Keeps a camera warning on until the camera is actually passed. A fresh lookup each second would
 * make it blink whenever the heading wobbles. Once the car is matched to a road that the camera
 * isn't on (it turned off), the warning goes.
 */
export class CameraTracker {
  private cam: Camera | null = null;

  next(data: RoadData, fix: Fix, ref: PathRef | null = null): CameraAlert | null {
    if (this.cam) {
      const cam = this.cam;
      const straight = distance(fix, cam);
      const off = fix.heading == null ? 0 : Math.abs(angleDiff(fix.heading, bearing(fix, cam)));
      const at = ref ? alongPath(pathAhead(ref, CAMERA_ALERT_DIST), cam) : null;
      // Close by, a momentary mismatch shouldn't drop it; further out, trust the road match.
      const leftRoad = ref != null && straight > 60 && (!at || at.off > ON_ROAD_DIST * 2);
      // Passed (now behind us), turned away, or out of range: let it go.
      if (straight < 15 || off > 100 || straight > CAMERA_ALERT_DIST + 150 || leftRoad) this.cam = null;
      else return { dist: at && at.off <= ON_ROAD_DIST * 2 ? at.along : straight, limit: cam.maxspeed, kind: cam.kind ?? 0 };
    }
    const found = cameraAhead(data, fix, ref);
    if (!found) return null;
    this.cam =
      data.cameras.find((c) => {
        if (ref) {
          const at = alongPath(pathAhead(ref, CAMERA_ALERT_DIST), c);
          return !!at && Math.abs(at.along - found.dist) < 0.5;
        }
        return Math.abs(distance(fix, c) - found.dist) < 0.5;
      }) ?? null;
    return found;
  }
}

/** Turns the various ways a request can fail into a short message for the phone page. */
function describe(e: unknown): string {
  if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) return '시간 초과';
  if (e instanceof TypeError) return '연결 실패'; // fetch's network error (offline, blocked, DNS)
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^HTTP /, '');
}

/** "overpass-api.de" from the endpoint URL, for short error messages. */
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^(www|maps)\./, '');
  } catch {
    return url;
  }
};

/** Every server failed. `busy` when they were refusing for load (429/502/503/504), not e.g. offline. */
export class OverpassError extends Error {
  constructor(
    message: string,
    readonly busy: boolean,
  ) {
    super(message);
  }
}

/**
 * Sends Overpass queries one at a time (public servers limit how many a client may run at once,
 * and answer extra ones with 429), failing over between servers.
 */
export class OverpassClient {
  private chain: Promise<unknown> = Promise.resolve();
  private preferred = 0;
  private lastStart = 0;

  /** `minGapMs`: least time between two requests, so a long queue doesn't hammer the servers. */
  constructor(
    private fetchFn: typeof fetch,
    private endpoints = OVERPASS_ENDPOINTS,
    private minGapMs = 1000,
  ) {}

  run(query: string): Promise<any> {
    const result = this.chain.then(() => this.tryAll(query));
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async tryAll(query: string): Promise<any> {
    const errors: string[] = [];
    let busy = 0;
    for (let k = 0; k < this.endpoints.length; k++) {
      const i = (this.preferred + k) % this.endpoints.length;
      const wait = this.lastStart + this.minGapMs - Date.now();
      // With the phone screen off, browsers stretch timers to as much as a minute; requests are
      // already sparse then (one per new tile), so skip the courtesy gap rather than stall.
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (wait > 0 && !hidden) await new Promise((r) => setTimeout(r, wait));
      this.lastStart = Date.now();
      try {
        const r = await this.fetchFn(this.endpoints[i], {
          // Without a timeout a hung request would block every request queued behind it.
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        });
        if (!r.ok) {
          if ([429, 502, 503, 504].includes(r.status)) busy++;
          throw new Error(`HTTP ${r.status}`);
        }
        const json = await r.json();
        // Overpass reports a query that ran out of time or memory as 200 with a "remark".
        if (!Array.isArray(json?.elements) || (json.remark && !json.elements.length))
          throw new Error(json?.remark ? '서버 처리 시간 초과' : '잘못된 응답');
        this.preferred = i;
        return json;
      } catch (e) {
        errors.push(`${hostOf(this.endpoints[i])} ${describe(e)}`);
        console.warn('[overpass]', this.endpoints[i], e);
      }
    }
    // Name every server's failure: "overpass-api.de 504, private.coffee 연결 실패, …".
    throw new OverpassError(errors.join(', '), busy > 0);
  }
}

