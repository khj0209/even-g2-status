import { distance } from '../core/geo';
import type { Fix, LatLon } from '../core/types';

const NEAR_TO_ROAD_URL = 'https://apis.openapi.sk.com/tmap/road/nearToRoad';

export interface TmapRoad {
  /** km/h; null if Tmap has no limit for this link. */
  limit: number | null;
  roadName: string;
  linkId: string;
}

/**
 * Tmap "가까운 도로 찾기" (nearToRoad) response → the road's limit. The link's limit is in
 * `resultData.header.speed`; 0 or missing means unknown.
 */
export function parseNearToRoad(json: any): TmapRoad | null {
  const h = json?.resultData?.header;
  if (!h) return null;
  const speed = Number(h.speed);
  return {
    limit: Number.isFinite(speed) && speed > 0 ? speed : null,
    roadName: String(h.roadName ?? ''),
    linkId: String(h.linkId ?? ''),
  };
}

/** Ask again after this far on the same road, or right away once the matched road changes. */
const REFRESH_DIST = 400;
/** But never more often than this, to stay inside the free daily quota. */
const MIN_INTERVAL_MS = 5000;
/** Use an answer only this close to where it was asked, and only this recently. */
const VALID_DIST = 500;
const VALID_MS = 3 * 60 * 1000;
/** After a failure (bad key, quota, network), leave Tmap alone for a while. */
const ERROR_BACKOFF_MS = 60 * 1000;

/**
 * Speed limits from Tmap, for anyone who has entered a Tmap key. Asked sparingly: when the car
 * moves onto a different road, or has gone 400 m on the same one. Kept in memory only: Tmap's terms
 * don't allow keeping its data for more than 24 hours.
 */
export class TmapLimitService {
  private road: TmapRoad | null = null;
  private at: (LatLon & { ts: number }) | null = null;
  private roadKey: unknown = null;
  private lastCall = 0;
  private busy = false;
  private retryAt = 0;
  error = '';
  calls = 0;

  constructor(private fetchFn: typeof fetch = (...a) => fetch(...a)) {}

  /**
   * Call on every real fix. `roadKey` identifies the road the fix was matched to (any value that
   * changes when the road does), or null if unmatched.
   */
  update(fix: Fix, apiKey: string, roadKey: unknown): void {
    if (!apiKey || fix.estimated || this.busy) return;
    const now = Date.now();
    if (now < this.retryAt || now - this.lastCall < MIN_INTERVAL_MS) return;
    const moved = !this.at || distance(this.at, fix) > REFRESH_DIST;
    const newRoad = roadKey != null && roadKey !== this.roadKey;
    if (!moved && !newRoad && now - (this.at?.ts ?? 0) < VALID_MS) return;
    this.busy = true;
    this.lastCall = now;
    this.calls++;
    const params = new URLSearchParams({ version: '1', lat: fix.lat.toFixed(6), lon: fix.lon.toFixed(6) });
    this.fetchFn(`${NEAR_TO_ROAD_URL}?${params}`, {
      headers: { appKey: apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    })
      .then(async (r) => {
        if (r.status === 204) return null; // no road near this point
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return parseNearToRoad(await r.json());
      })
      .then((road) => {
        this.road = road;
        this.at = { lat: fix.lat, lon: fix.lon, ts: Date.now() };
        this.roadKey = roadKey;
        this.error = '';
      })
      .catch((e) => {
        this.error = e instanceof DOMException ? '시간 초과' : e instanceof Error ? e.message : String(e);
        this.retryAt = Date.now() + ERROR_BACKOFF_MS;
      })
      .finally(() => (this.busy = false));
  }

  /** Tmap's limit for where the car is, if a recent answer applies here. */
  limitAt(p: LatLon): number | null {
    if (!this.road || !this.at) return null;
    if (Date.now() - this.at.ts > VALID_MS || distance(this.at, p) > VALID_DIST) return null;
    return this.road.limit;
  }

  statusText(): string {
    if (this.error) return `Tmap 제한속도 오류: ${this.error}`;
    return this.calls ? `Tmap 제한속도 사용 (${this.calls}회 조회)` : 'Tmap 제한속도 대기';
  }
}
