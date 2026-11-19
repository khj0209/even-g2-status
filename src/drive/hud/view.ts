import { compass, interpolate, localOffset, projectOnSegment } from '../core/geo';
import { displayLimit, displaySpeed, formatClock, formatDistance, KMH_PER_MPS, unitLabel } from '../core/format';
import type { CameraAlert, Fix, LatLon, ManeuverIcon, MinimapPoint, MinimapView, NavProgress, OverviewView, SectionStatus, Settings } from '../core/types';
import type { RoadData } from '../services/roads';
import type { Route } from '../services/routing';
import { MINIMAP, OVERVIEW } from './layout';

export interface HudInput {
  /** Latest fix, or null when GPS is missing/stale. */
  fix: Fix | null;
  /** Speed limit of the current road in km/h. */
  limit: number | null;
  camera: CameraAlert | null;
  nav: NavProgress | null;
  /** Active route, for the minimap. Null when not navigating. */
  route: Route | null;
  /** Map data around the car, for the minimap. */
  roads?: RoadData;
  /** Inside a section speed check. */
  section?: SectionStatus | null;
  /** A short message to show in the info line for a moment (menu feedback, warnings). */
  flash?: string | null;
  /** Night: dim the whole HUD. */
  dim?: boolean;
  settings: Settings;
  now: Date;
}

/** Everything the HUD shows, already formatted. Pure data so it can be tested without a display. */
export interface HudView {
  speed: string;
  unit: string;
  /** Driving faster than limit + tolerance. */
  over: boolean;
  limit: number | null;
  nav: { icon: ManeuverIcon; dist: string } | null;
  /** One line above the cluster: road and arrival while guiding, otherwise clock and heading. */
  info: string;
  /** Short camera / section warning, e.g. "단속 300 m", or empty. Lines split by "\n". */
  alert: string;
  /** Section average over its limit. */
  sectionOver: boolean;
  dim: boolean;
  /** Null without a position. */
  minimap: MinimapView | null;
  /** Null when not navigating. */
  overview: OverviewView | null;
}

/** Where the car sits in the minimap: centred, low, so most of the view is ahead. */
const CAR = { x: MINIMAP.w / 2, y: 68 };
/** The view in car-relative pixels, with a small margin so lines run off the edge cleanly. */
const VIEW = { left: -CAR.x - 4, right: MINIMAP.w - CAR.x + 4, top: -CAR.y - 4, bottom: MINIMAP.h - CAR.y + 4 };

/** Metres per pixel: zoom out at speed so a turn shows up early enough to matter. */
export function minimapScale(kmh: number): number {
  return kmh < 50 ? 3 : kmh < 90 ? 4.5 : 7;
}

/** Distance travelled to the point on the route closest to `fix` (same approach as RouteTracker). */
function travelledAt(route: Route, fix: Fix): number {
  const { points, cum } = route;
  let best = { dist: Infinity, seg: 0, t: 0 };
  for (let i = 0; i + 1 < points.length; i++) {
    const p = projectOnSegment(fix, points[i], points[i + 1]);
    if (p.dist < best.dist) best = { dist: p.dist, seg: i, t: p.t };
  }
  return cum[best.seg] + best.t * (cum[best.seg + 1] - cum[best.seg]);
}

/**
 * Vertices spanning `travelled ± radius` along the route. Picked by cumulative distance, not raw
 * distance from the car, so a long unsplit leg (demo routes; occasionally a real one) still yields
 * a line through the box instead of vanishing because both its vertices sit outside `radius`.
 */
function routeWindow(route: Route, travelled: number, radius: number): LatLon[] {
  const { points, cum } = route;
  const lo = travelled - radius;
  const hi = travelled + radius;
  let start = 0;
  while (start + 1 < points.length && cum[start + 1] < lo) start++;
  let end = points.length - 1;
  while (end > 0 && cum[end - 1] > hi) end--;
  return points.slice(start, end + 1);
}

/** A small number that changes whenever the given object is replaced (new map data, new route). */
const versions = new WeakMap<object, number>();
let nextVersion = 1;
function dataVersion(o: object | null | undefined): number {
  if (!o) return 0;
  let v = versions.get(o);
  if (v == null) versions.set(o, (v = nextVersion++));
  return v;
}

const inView = (p: MinimapPoint) => p.x >= VIEW.left && p.x <= VIEW.right && p.y >= VIEW.top && p.y <= VIEW.bottom;

/** Whether segment a–b could cross the view (bounding-box test; the canvas clips the rest). */
function segmentNearView(a: MinimapPoint, b: MinimapPoint): boolean {
  return (
    Math.max(a.x, b.x) >= VIEW.left &&
    Math.min(a.x, b.x) <= VIEW.right &&
    Math.max(a.y, b.y) >= VIEW.top &&
    Math.min(a.y, b.y) <= VIEW.bottom
  );
}

/** Split a projected polyline into the runs that pass through the view. */
function clip(points: MinimapPoint[]): MinimapPoint[][] {
  const runs: MinimapPoint[][] = [];
  let run: MinimapPoint[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    if (segmentNearView(points[i], points[i + 1])) {
      if (!run.length) run.push(points[i]);
      run.push(points[i + 1]);
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

/** Point `at` metres along the route. */
function pointAlong(route: Route, at: number): LatLon {
  const { points, cum } = route;
  let i = 0;
  while (i + 2 < points.length && cum[i + 1] < at) i++;
  const len = cum[i + 1] - cum[i];
  return interpolate(points[i], points[i + 1], len > 0 ? Math.min(1, Math.max(0, (at - cum[i]) / len)) : 0);
}

/**
 * Car-centred, heading-up map: surrounding roads, the route ahead, the next turn, the destination
 * and speed cameras. Null without a position.
 */
function buildMinimap(input: HudInput): MinimapView | null {
  const { fix, route, nav, roads } = input;
  if (!fix) return null;
  const headingKnown = fix.heading != null;
  const h = ((fix.heading ?? 0) * Math.PI) / 180;
  const cosH = Math.cos(h);
  const sinH = Math.sin(h);
  const scale = minimapScale((fix.speed ?? 0) * KMH_PER_MPS);
  const project = (p: LatLon): MinimapPoint => {
    const { east, north } = localOffset(fix, p);
    return { x: (east * cosH - north * sinH) / scale, y: -(east * sinH + north * cosH) / scale };
  };
  // Far enough to reach every corner of the view.
  const radius = Math.hypot(Math.max(CAR.x, MINIMAP.w - CAR.x), Math.max(CAR.y, MINIMAP.h - CAR.y)) * scale + 20;

  const view: MinimapView = {
    scale,
    buildings: [],
    roads: [],
    route: [],
    turn: null,
    dest: null,
    cameras: [],
    headingKnown,
    // Position quantised to about a pixel and heading to 3°, so standing still or GPS jitter
    // doesn't resend the image; map data and route identity so new downloads always show.
    key: [
      Math.round(fix.lat / (scale * 9e-6)),
      Math.round(fix.lon / (scale * 1.13e-5)),
      Math.round((fix.heading ?? 0) / 3),
      scale,
      dataVersion(roads),
      dataVersion(route),
      nav ? Math.round(nav.distToManeuver / scale) : '',
    ].join(','),
  };

  for (const outline of roads?.buildings ?? []) {
    const points = outline.map(project);
    if (points.some((p, i) => i > 0 && segmentNearView(points[i - 1], p))) view.buildings.push(points);
  }

  for (const way of roads?.map ?? [])
    for (const points of clip(way.points.map(project))) view.roads.push({ major: way.major, points });
  // Major roads last so they draw over the minor ones they cross.
  view.roads.sort((a, b) => Number(a.major) - Number(b.major));

  for (const cam of roads?.cameras ?? []) {
    const p = project(cam);
    if (inView(p)) view.cameras.push(p);
  }

  if (route && route.points.length >= 2) {
    // While guiding, reuse the tracker's position along the route: it searches near the last match,
    // so a route that doubles back near itself can't make the minimap jump to the wrong stretch.
    const travelled = nav ? route.distance - nav.remainingDist : travelledAt(route, fix);
    view.route = routeWindow(route, travelled, radius).map(project);
    if (nav) {
      const turn = project(pointAlong(route, travelled + nav.distToManeuver));
      if (inView(turn)) view.turn = turn;
    }
    const dest = project(route.points[route.points.length - 1]);
    if (inView(dest)) view.dest = dest;
  }
  return view;
}

/** The route projected into the overview box once per route (it never changes while guiding). */
interface OverviewGeom {
  points: MinimapPoint[];
  project(p: LatLon): MinimapPoint;
}
const overviewGeoms = new WeakMap<Route, OverviewGeom>();
const OVERVIEW_PAD = 10;

function overviewGeom(route: Route): OverviewGeom {
  const cached = overviewGeoms.get(route);
  if (cached) return cached;
  const lat0 = route.points.reduce((s, p) => s + p.lat, 0) / route.points.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  const xs = route.points.map((p) => p.lon * kx);
  const ys = route.points.map((p) => p.lat * ky);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const innerW = OVERVIEW.w - 2 * OVERVIEW_PAD;
  const innerH = OVERVIEW.h - 2 * OVERVIEW_PAD;
  // Same scale both ways (no distortion), centred; a degenerate route doesn't divide by zero.
  const scale = Math.min(innerW / Math.max(maxX - minX, 1), innerH / Math.max(maxY - minY, 1));
  const ox = OVERVIEW_PAD + (innerW - (maxX - minX) * scale) / 2;
  const oy = OVERVIEW_PAD + (innerH - (maxY - minY) * scale) / 2;
  const project = (p: LatLon): MinimapPoint => ({ x: ox + (p.lon * kx - minX) * scale, y: oy + (maxY - p.lat * ky) * scale });
  const geom = { points: route.points.map(project), project };
  overviewGeoms.set(route, geom);
  return geom;
}

/** Drop points less than a pixel from the last one kept: a long route has thousands. */
function thin(points: MinimapPoint[]): MinimapPoint[] {
  const out: MinimapPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(p.x - last.x) + Math.abs(p.y - last.y) >= 1) out.push(p);
  }
  const end = points[points.length - 1];
  if (end && out[out.length - 1] !== end) out.push(end);
  return out;
}

/** Whole route, north-up, split into driven and remaining parts, with the car and destination. */
function buildOverview(input: HudInput): OverviewView | null {
  const { route, nav, fix } = input;
  if (!route || route.points.length < 2) return null;
  const geom = overviewGeom(route);
  const travelled = nav ? route.distance - nav.remainingDist : fix ? travelledAt(route, fix) : 0;
  let i = 0;
  while (i + 2 < route.points.length && route.cum[i + 1] <= travelled) i++;
  const split = geom.project(pointAlong(route, travelled));
  const car = fix ? geom.project(fix) : null;
  const dest = geom.points[geom.points.length - 1];
  return {
    done: thin([...geom.points.slice(0, i + 1), split]),
    ahead: thin([split, ...geom.points.slice(i + 1)]),
    car,
    heading: fix?.heading ?? null,
    dest,
    key: [
      dataVersion(route),
      Math.round(split.x),
      Math.round(split.y),
      car ? `${Math.round(car.x)},${Math.round(car.y)}` : '',
      fix?.heading != null ? Math.round(fix.heading / 15) : '',
    ].join('|'),
  };
}

export function buildView(input: HudInput): HudView {
  const { fix, camera, nav, settings, now } = input;
  const { unit } = settings;
  const kmh = fix?.speed != null ? fix.speed * KMH_PER_MPS : null;
  const cam = settings.cameraAlerts ? camera : null;
  // Where the road itself has no tagged limit, the limit enforced by an upcoming camera still applies.
  const limit = input.limit ?? cam?.limit ?? null;

  let info: string;
  if (!fix) info = `${formatClock(now)}  GPS 없음`;
  else if (nav) {
    const eta = formatClock(new Date(now.getTime() + nav.remainingTime * 1000));
    info = [nav.roadName, `${formatDistance(nav.remainingDist, unit)} · ${eta} 도착`].filter(Boolean).join('  ');
  } else info = [formatClock(now), fix.heading != null ? compass(fix.heading) : ''].filter(Boolean).join('  ');
  // Say so when the position is extrapolated (GPS lost in a tunnel), so it isn't taken as measured.
  if (fix?.estimated) info = `GPS 추정 · ${info}`;
  if (input.flash) info = input.flash;

  const sec = input.section;
  const sectionOver = !!sec && sec.limit != null && sec.avgKmh > sec.limit + settings.overspeedTolerance;
  let alert = '';
  if (sec) {
    const avg = `평균 ${displaySpeed(sec.avgKmh / KMH_PER_MPS, unit)}${sectionOver ? ' !' : ''}`;
    alert = `${sec.remaining != null ? `구간 ${formatDistance(sec.remaining, unit)}` : '구간단속'}\n${avg}`;
  } else if (cam) {
    const label = ['단속', '구간단속', '구간 끝', '신호단속'][cam.kind ?? 0] ?? '단속';
    alert = `${label}\n${formatDistance(cam.dist, unit)}`;
  }

  return {
    speed: fix?.speed != null ? String(displaySpeed(fix.speed, unit)) : '--',
    unit: unitLabel(unit),
    over: kmh != null && limit != null && kmh > limit + settings.overspeedTolerance,
    limit: limit != null ? displayLimit(limit, unit) : null,
    nav: nav && { icon: nav.icon, dist: formatDistance(nav.distToManeuver, unit) },
    info,
    alert,
    sectionOver,
    dim: !!input.dim,
    minimap: buildMinimap(input),
    overview: buildOverview(input),
  };
}

/** Holds the shown limit steady through GPS jitter and short gaps in map data. */
export class LimitFilter {
  /** The limit on show, for when there's no position to look one up for. */
  get current(): number | null {
    return this.shown;
  }

  private shown: number | null = null;
  private candidate: number | null = null;
  private count = 0;

  /** `newRoad`: the car was just matched onto a different road, so a new limit is expected now. */
  next(raw: number | null, newRoad = false): number | null {
    if (newRoad && raw != null) {
      this.shown = raw;
      this.candidate = null;
      this.count = 0;
      return raw;
    }
    if (raw === this.shown) {
      this.count = 0;
      return this.shown;
    }
    if (raw !== this.candidate) {
      this.candidate = raw;
      this.count = 0;
    }
    // A new limit must repeat twice; losing the limit entirely takes much longer, so a fix that
    // lands off the road for a moment doesn't blank the sign.
    if (++this.count >= (raw == null ? 10 : 2)) {
      this.shown = raw;
      this.count = 0;
    }
    return this.shown;
  }
}
