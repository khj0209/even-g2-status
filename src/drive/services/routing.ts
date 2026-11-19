import { angleDiff, bearing, distance, projectOnSegment } from '../core/geo';
import type { LatLon, ManeuverIcon, NavProgress } from '../core/types';

export interface Step {
  icon: ManeuverIcon;
  /** Road entered after the manoeuvre. */
  name: string;
  /** Metres from the route start to the manoeuvre point. */
  at: number;
}

export interface Route {
  points: LatLon[];
  /** Cumulative metres at each point. */
  cum: number[];
  steps: Step[];
  distance: number;
  /** Seconds. */
  duration: number;
}

export interface Place extends LatLon {
  name: string;
}

function cumulative(points: LatLon[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distance(points[i - 1], points[i]));
  return cum;
}

const MODIFIER_ICON: Record<string, ManeuverIcon> = {
  uturn: 'uturn',
  'sharp left': 'sharp-left',
  left: 'left',
  'slight left': 'slight-left',
  straight: 'straight',
  'slight right': 'slight-right',
  right: 'right',
  'sharp right': 'sharp-right',
};

/** Convert an OSRM `/route` response (steps=true, geometries=geojson, overview=full). */
export function osrmToRoute(json: any): Route {
  const r = json?.routes?.[0];
  if (!r) throw new Error(json?.message || '경로를 찾을 수 없습니다');
  const points: LatLon[] = r.geometry.coordinates.map(([lon, lat]: [number, number]) => ({ lat, lon }));
  const steps: Step[] = [];
  let at = 0;
  for (const leg of r.legs)
    for (const s of leg.steps) {
      const { type, modifier } = s.maneuver;
      let icon: ManeuverIcon | null;
      if (type === 'depart') icon = null;
      else if (type === 'arrive') icon = 'arrive';
      else if (type === 'roundabout' || type === 'rotary') icon = 'roundabout';
      else {
        icon = MODIFIER_ICON[modifier] ?? 'straight';
        // "Road changes name, keep going straight" is noise on a HUD.
        if (icon === 'straight' && (type === 'new name' || type === 'continue')) icon = null;
      }
      if (icon) steps.push({ icon, name: s.name || s.ref || '', at });
      at += s.distance;
    }
  // Step distances are measured on OSRM's geometry; rescale onto ours so they line up.
  const cum = cumulative(points);
  const total = cum[cum.length - 1];
  const k = at > 0 ? total / at : 1;
  for (const s of steps) s.at *= k;
  return { points, cum, steps, distance: total, duration: r.duration };
}

/** Build a route from a bare polyline, deriving turns from the corner angles (used by demo mode). */
export function routeFromPolyline(points: LatLon[], names: string[] = [], speedMps = 12): Route {
  const cum = cumulative(points);
  const steps: Step[] = [];
  for (let i = 1; i + 1 < points.length; i++) {
    const turn = angleDiff(bearing(points[i - 1], points[i]), bearing(points[i], points[i + 1]));
    const mag = Math.abs(turn);
    if (mag < 20) continue;
    const side = turn > 0 ? 'right' : 'left';
    const icon: ManeuverIcon = mag > 160 ? 'uturn' : mag > 120 ? `sharp-${side}` : mag > 50 ? side : `slight-${side}`;
    steps.push({ icon, name: names[steps.length] ?? '', at: cum[i] });
  }
  const total = cum[cum.length - 1];
  steps.push({ icon: 'arrive', name: '', at: total });
  return { points, cum, steps, distance: total, duration: total / speedMps };
}

export type TrackResult =
  | { state: 'guiding'; progress: NavProgress }
  | { state: 'off-route' }
  | { state: 'arrived' };

const OFF_ROUTE_DIST = 60;
const OFF_ROUTE_FIXES = 4;
const ARRIVE_DIST = 30;

/** Follows the car along a route and reports the next manoeuvre. */
export class RouteTracker {
  private seg = 0;
  private offCount = 0;

  constructor(readonly route: Route) {}

  update(pos: LatLon): TrackResult {
    const { points, cum, steps, distance: total, duration } = this.route;
    // Look a little behind and well ahead of the last matched segment; fall back to the whole route.
    let best = this.nearest(pos, Math.max(0, this.seg - 2), Math.min(points.length - 1, this.seg + 40));
    if (best.dist > OFF_ROUTE_DIST) best = this.nearest(pos, 0, points.length - 1);

    if (best.dist > OFF_ROUTE_DIST) {
      if (++this.offCount >= OFF_ROUTE_FIXES) return { state: 'off-route' };
    } else {
      this.offCount = 0;
      this.seg = best.seg;
    }

    const travelled = cum[best.seg] + best.t * (cum[best.seg + 1] - cum[best.seg]);
    const remainingDist = Math.max(0, total - travelled);
    if (remainingDist < ARRIVE_DIST && best.dist <= OFF_ROUTE_DIST) return { state: 'arrived' };

    const next = steps.find((s) => s.at > travelled + 5) ?? steps[steps.length - 1];
    return {
      state: 'guiding',
      progress: {
        icon: next.icon,
        distToManeuver: Math.max(0, next.at - travelled),
        roadName: next.name,
        remainingDist,
        remainingTime: total > 0 ? (duration * remainingDist) / total : 0,
      },
    };
  }

  private nearest(pos: LatLon, from: number, to: number) {
    const { points } = this.route;
    let best = { dist: Infinity, seg: from, t: 0 };
    for (let i = from; i < to; i++) {
      const p = projectOnSegment(pos, points[i], points[i + 1]);
      if (p.dist < best.dist) best = { dist: p.dist, seg: i, t: p.t };
    }
    return best;
  }
}

const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const TMAP_ROUTE_URL = 'https://apis.openapi.sk.com/tmap/routes?version=1';
const TMAP_POI_URL = 'https://apis.openapi.sk.com/tmap/pois';

const FETCH_TIMEOUT_MS = 10000;

/**
 * A hung request (dead connection, a request the host's network layer never forwards, …) would
 * otherwise leave the UI stuck on "경로 탐색 중…" forever, since a plain `fetch` has no timeout
 * of its own. This fails it fast with a clear error instead.
 */
async function fetchTimed(fetchFn: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('서버 응답이 없습니다 (시간 초과)');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn codes shared by Tmap's car/pedestrian guidance. Codes outside this map (lane-change,
 * crosswalk, waypoint markers, …) are dropped rather than guessed, since a wrong arrow on a
 * driving HUD is worse than a missing one.
 */
const TMAP_TURN_ICON: Record<number, ManeuverIcon> = {
  12: 'left',
  13: 'right',
  14: 'uturn',
  16: 'sharp-left',
  17: 'slight-left',
  18: 'slight-right',
  19: 'sharp-right',
  // Forks: "오른쪽/왼쪽". 117/118 are what Tmap uses at expressway junctions (JC), so dropping
  // them would leave the HUD silent exactly where a missed exit costs the most.
  43: 'slight-right',
  44: 'slight-left',
  117: 'slight-right',
  118: 'slight-left',
  // Expressway (101–106) and urban-expressway (111–116) entrances/exits: right, left, ahead.
  101: 'slight-right',
  102: 'slight-left',
  103: 'straight',
  104: 'slight-right',
  105: 'slight-left',
  106: 'straight',
  111: 'slight-right',
  112: 'slight-left',
  113: 'straight',
  114: 'slight-right',
  115: 'slight-left',
  116: 'straight',
  // Rotary exits at 1 to 12 o'clock.
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [131 + i, 'roundabout' as const])),
  201: 'arrive',
};
// Not mapped on purpose: 11 (straight on), 119–124 (underpass, overpass, tunnel, bridge…), 200 (start),
// 185+ (waypoints, tollgates, rest areas). They are informational, not a manoeuvre to prepare for.

/** Convert a Tmap `/tmap/routes` GeoJSON response into a Route. */
export function tmapToRoute(json: any): Route {
  const features: any[] = json?.features ?? [];
  if (!features.length) throw new Error(json?.error?.message || '경로를 찾을 수 없습니다');
  const points: LatLon[] = [];
  const rawSteps: { icon: ManeuverIcon; name: string; idx: number }[] = [];
  let duration = 0;
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    if (f.geometry?.type === 'LineString') {
      for (const [lon, lat] of f.geometry.coordinates) points.push({ lat, lon });
    } else if (f.geometry?.type === 'Point') {
      const p = f.properties ?? {};
      if (typeof p.totalTime === 'number') duration = p.totalTime;
      const icon = TMAP_TURN_ICON[p.turnType];
      if (icon) {
        const next = features.slice(i + 1).find((g) => g.geometry?.type === 'LineString');
        rawSteps.push({ icon, name: next?.properties?.name || '', idx: points.length });
      }
    }
  }
  const cum = cumulative(points);
  const total = cum[cum.length - 1] ?? 0;
  const steps: Step[] = rawSteps.map((s) => ({ icon: s.icon, name: s.name, at: cum[Math.min(s.idx, cum.length - 1)] }));
  return { points, cum, steps, distance: total, duration };
}

export async function fetchRoute(from: LatLon, to: LatLon, apiKey = '', fetchFn: typeof fetch = fetch): Promise<Route> {
  if (apiKey) {
    const res = await fetchTimed(fetchFn, TMAP_ROUTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', appKey: apiKey },
      body: JSON.stringify({
        startX: from.lon,
        startY: from.lat,
        endX: to.lon,
        endY: to.lat,
        reqCoordType: 'WGS84GEO',
        resCoordType: 'WGS84GEO',
        searchOption: '0',
        // Current traffic in the route and its duration, so ETAs and the faster-route check use it.
        trafficInfo: 'Y',
        sort: 'index',
      }),
    });
    if (!res.ok) throw new Error(`경로 서버 오류 (HTTP ${res.status})`);
    return tmapToRoute(await res.json());
  }
  const url = `${OSRM_URL}/${from.lon},${from.lat};${to.lon},${to.lat}?steps=true&overview=full&geometries=geojson`;
  const res = await fetchTimed(fetchFn, url);
  if (!res.ok) throw new Error(`경로 서버 오류 (HTTP ${res.status})`);
  return osrmToRoute(await res.json());
}

/** Free-text destination search, biased towards (but not limited to) the area around `near`. */
export async function searchPlaces(
  query: string,
  near: LatLon | null,
  apiKey = '',
  fetchFn: typeof fetch = fetch,
): Promise<Place[]> {
  if (apiKey) {
    const params = new URLSearchParams({ version: '1', searchKeyword: query, count: '6' });
    if (near) {
      params.set('searchtypCd', 'R');
      params.set('centerLon', String(near.lon));
      params.set('centerLat', String(near.lat));
      params.set('radius', '20');
    }
    const res = await fetchTimed(fetchFn, `${TMAP_POI_URL}?${params}`, { headers: { appKey: apiKey, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`검색 서버 오류 (HTTP ${res.status})`);
    // Tmap answers "no results" with 204 and an empty body, which res.json() would choke on.
    const body = res.status === 204 ? '' : await res.text();
    const json = body ? JSON.parse(body) : null;
    const pois: any[] = json?.searchPoiInfo?.pois?.poi ?? [];
    return pois.map((p) => ({
      name: p.name,
      lat: parseFloat(p.frontLat || p.noorLat),
      lon: parseFloat(p.frontLon || p.noorLon),
    }));
  }
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '6', 'accept-language': 'ko' });
  if (near) {
    const d = 0.5;
    params.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
  }
  const res = await fetchTimed(fetchFn, `${NOMINATIM_URL}?${params}`);
  if (!res.ok) throw new Error(`검색 서버 오류 (HTTP ${res.status})`);
  const json = await res.json();
  return (json as any[]).map((p) => ({ name: p.display_name, lat: parseFloat(p.lat), lon: parseFloat(p.lon) }));
}
