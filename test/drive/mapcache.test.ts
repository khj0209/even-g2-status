import { describe, expect, it } from 'vitest';
import type { Fix } from '../../src/drive/core/types';
import { encodeTile } from '../../src/drive/services/tileformat';
import {
  MemoryTileStore,
  mergeTiles,
  RoadDataService,
  routeTiles,
  tileOf,
  tileQuery,
  tilesAround,
  type TileStore,
} from '../../src/drive/services/mapcache';

const settle = async () => {
  for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
};

const fix = (lat = 37.5355, lon = 126.6431, kmh = 30): Fix => ({ lat, lon, speed: kmh / 3.6, heading: 0, ts: Date.now() });

/** Fake Overpass: answers by layer, and records every query. */
function fakeOverpass(status = 200) {
  const queries: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    if (url.includes('github.io')) return new Response('', { status: 404 }); // no pre-built tiles
    const q = decodeURIComponent(String(init.body)).slice(5);
    queries.push(q);
    if (status !== 200) return new Response('', { status });
    const g = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }];
    // Same ids from every tile, like a way crossing tile borders.
    const elements = q.includes('[building]')
      ? [{ type: 'way', id: 3, geometry: g }]
      : [
          { type: 'way', id: 1, tags: { highway: 'primary', maxspeed: '50' }, geometry: g },
          { type: 'way', id: 2, tags: { highway: 'residential' }, geometry: g },
        ];
    return new Response(JSON.stringify({ elements }));
  }) as typeof fetch;
  return { fetchFn, queries };
}

describe('tiles', () => {
  it('maps positions to ~1.1 km tiles and asks for a tile by its box', () => {
    const t = tileOf({ lat: 37.5355, lon: 126.6431 });
    expect(t).toEqual({ x: 3753, y: 10131 });
    const b = '37.5300,126.6375,37.5400,126.6500';
    const roads = tileQuery('roads', t);
    expect(roads).toContain(`way(${b})[highway~"^(motorway`);
    expect(roads).toContain(`way(${b})[highway][maxspeed]`);
    expect(roads).toContain(`node(${b})[highway=speed_camera]`);
    expect(tileQuery('buildings', t)).toContain('way(37.5300,126.6375,37.5400,126.6500)[building];out skel geom qt;');
    expect(tilesAround({ lat: 37.5355, lon: 126.6431 })).toHaveLength(9);
    expect(tilesAround({ lat: 37.5355, lon: 126.6431 }, 3)).toHaveLength(49);
  });

  it('covers a route with a corridor of tiles, including long straight segments', () => {
    // 5 km due east along 37.535°N: tiles in that row, plus the row 500 m north or south as needed.
    const tiles = routeTiles([
      { lat: 37.535, lon: 126.6 },
      { lat: 37.535, lon: 126.6566 },
    ]);
    const cols = new Set(tiles.map((t) => t.y));
    for (let y = tileOf({ lat: 37.535, lon: 126.6 }).y; y <= tileOf({ lat: 37.535, lon: 126.6566 }).y; y++) expect(cols.has(y)).toBe(true);
    expect(tiles.length).toBeLessThan(25);
  });

  it('merges tiles without duplicating ways that cross tile borders', () => {
    const w = { id: 9, maxspeed: 50, points: [] };
    const merged = mergeTiles([{ ways: [w] }, { ways: [w], cameras: [{ lat: 0, lon: 0, maxspeed: null }] }, { buildings: [{ id: 4, points: [] }] }]);
    expect(merged.ways).toHaveLength(1);
    expect(merged.cameras).toHaveLength(1);
    expect(merged.buildings).toHaveLength(1);
  });
});

describe('RoadDataService', () => {
  it('downloads the 3×3 tiles around the car, roads before buildings', async () => {
    const { fetchFn, queries } = fakeOverpass();
    const svc = new RoadDataService(fetchFn, ['a'], new MemoryTileStore(), 0);
    svc.update(fix());
    expect(svc.statusText()).toContain('제한속도 받는 중');
    await settle();
    expect(queries).toHaveLength(18);
    expect(queries.slice(0, 9).every((q) => q.includes('[maxspeed]'))).toBe(true);
    expect(svc.data.ways).toHaveLength(1); // deduplicated across the 9 tiles
    expect(svc.data.map).toHaveLength(2);
    expect(svc.statusText()).toBe('제한속도 1 · 도로 2 · 건물 1 · 저장된 구역 18 · 도로 원본: 공개 서버');
  });

  it('reuses stored tiles instead of downloading again', async () => {
    const store = new MemoryTileStore();
    const first = fakeOverpass();
    const a = new RoadDataService(first.fetchFn, ['a'], store, 0);
    a.update(fix());
    await settle();
    const second = fakeOverpass();
    const b = new RoadDataService(second.fetchFn, ['a'], store, 0);
    b.update(fix());
    await settle();
    expect(second.queries).toHaveLength(0);
    expect(b.data.map).toHaveLength(2);
  });

  it('skips buildings at speed', async () => {
    const { fetchFn, queries } = fakeOverpass();
    const svc = new RoadDataService(fetchFn, ['a'], new MemoryTileStore(), 0);
    svc.update(fix(37.5355, 126.6431, 90));
    await settle();
    expect(queries.some((q) => q.includes('[building]'))).toBe(false);
    expect(svc.statusText()).toContain('건물 고속 주행 중 생략');
  });

  it('prefetches an area into storage (buildings only nearby) and reports progress', async () => {
    const store = new MemoryTileStore();
    const { fetchFn, queries } = fakeOverpass();
    const svc = new RoadDataService(fetchFn, ['a'], store, 0);
    svc.prefetchArea({ lat: 37.5355, lon: 126.6431 }, 3000);
    expect(svc.statusText()).toContain('미리 받기 0/58'); // 49 road tiles + 9 building tiles
    await settle();
    expect(queries).toHaveLength(58);
    expect(await store.count()).toBe(58);
    expect(svc.statusText()).not.toContain('미리 받기');
  });

  it('serves the car before prefetching', async () => {
    const { fetchFn, queries } = fakeOverpass();
    const svc = new RoadDataService(fetchFn, ['a'], new MemoryTileStore(), 0);
    svc.prefetchArea({ lat: 37.6, lon: 126.7 }, 3000);
    svc.update(fix());
    await settle();
    const carTile = tileOf(fix());
    const firstCar = queries.findIndex((q) => q.includes(`${(carTile.x * 0.01).toFixed(4)},${(carTile.y * 0.0125).toFixed(4)}`));
    expect(firstCar).toBeLessThan(5); // at most the one prefetch request already in flight
  });

  it('shows the error and keeps going when downloads fail', async () => {
    const { fetchFn } = fakeOverpass(502);
    const svc = new RoadDataService(fetchFn, ['a'], new MemoryTileStore(), 0);
    svc.update(fix());
    await settle();
    expect(svc.statusText()).toContain('오류: a 502');
    expect(svc.statusText()).toContain('제한속도 받는 중');
    // Refused for load: the queue pauses instead of firing the remaining tiles at the server.
    expect(svc.statusText()).toMatch(/서버 혼잡, \d+초 후 다시 시도/);
  });

  it('works without storage that keeps anything', async () => {
    const broken: TileStore = {
      get: () => Promise.reject(new Error('no db')),
      put: () => Promise.reject(new Error('no db')),
      count: () => Promise.reject(new Error('no db')),
      clear: () => Promise.reject(new Error('no db')),
    };
    const { fetchFn } = fakeOverpass();
    const svc = new RoadDataService(fetchFn, ['a'], broken, 0);
    svc.update(fix());
    await settle();
    expect(svc.data.ways).toHaveLength(1);
  });
});

describe('pre-built tiles', () => {
  const BASE = 'https://example.github.io/tiles';
  /** Serves an index and one roads tile from the "repository", and buildings from "Overpass". */
  function fake(opts: { index?: boolean; overpassStatus?: number } = {}) {
    const urls: string[] = [];
    const car = tileOf(fix());
    const fetchFn = (async (url: string) => {
      urls.push(url);
      if (url === `${BASE}/index.json`)
        return opts.index === false ? new Response('', { status: 404 }) : new Response(JSON.stringify({ version: 1, built: '2026-11-18' }));
      if (url.startsWith(BASE)) {
        if (url !== `${BASE}/v1/${car.x}/${car.y}.json`) return new Response('', { status: 404 });
        return new Response(
          encodeTile(
            [
              { drivable: true, major: true, maxspeed: 60, points: [{ lat: 37.535, lon: 126.64 }, { lat: 37.536, lon: 126.641 }] },
              { drivable: false, major: false, maxspeed: 30, points: [{ lat: 37.535, lon: 126.64 }, { lat: 37.534, lon: 126.64 }] },
            ],
            [{ lat: 37.5355, lon: 126.6431, maxspeed: 50 }],
          ),
        );
      }
      if (opts.overpassStatus) return new Response('', { status: opts.overpassStatus });
      return new Response(JSON.stringify({ elements: [{ type: 'way', id: 3, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }] }] }));
    }) as typeof fetch;
    return { fetchFn, urls };
  }

  it('takes roads, limits and cameras from the repository, and only buildings from Overpass', async () => {
    const { fetchFn, urls } = fake();
    const svc = new RoadDataService(fetchFn, ['overpass'], new MemoryTileStore(), 0, BASE);
    svc.update(fix());
    await settle();
    expect(urls.filter((u) => u.startsWith(BASE + '/v1/'))).toHaveLength(9);
    expect(urls.filter((u) => u === 'overpass')).toHaveLength(9); // buildings
    expect(svc.data.ways.map((w) => w.maxspeed).sort()).toEqual([30, 60]);
    expect(svc.data.map).toHaveLength(1); // the non-drivable way only carries a limit
    expect(svc.data.cameras[0].maxspeed).toBe(50);
    expect(svc.statusText()).toContain('도로 원본: 저장소 (2026-11-18)');
  });

  it('falls back to Overpass for roads when the repository has no tiles', async () => {
    const { fetchFn, urls } = fake({ index: false });
    const svc = new RoadDataService(fetchFn, ['overpass'], new MemoryTileStore(), 0, BASE);
    svc.update(fix());
    await settle();
    expect(urls.filter((u) => u.startsWith(BASE + '/v1/'))).toHaveLength(0);
    expect(urls.filter((u) => u === 'overpass')).toHaveLength(18);
    expect(svc.statusText()).toContain('도로 원본: 공개 서버');
  });

  it('keeps loading repository tiles while Overpass is refusing', async () => {
    const { fetchFn } = fake({ overpassStatus: 504 });
    const svc = new RoadDataService(fetchFn, ['overpass'], new MemoryTileStore(), 0, BASE);
    svc.update(fix());
    await settle();
    expect(svc.data.ways).toHaveLength(2);
    expect(svc.statusText()).toMatch(/서버 혼잡/);
  });

  it('uses Overpass outside Korea', async () => {
    const { fetchFn, urls } = fake();
    const svc = new RoadDataService(fetchFn, ['overpass'], new MemoryTileStore(), 0, BASE);
    svc.update({ ...fix(), lat: 48.85, lon: 2.35 });
    await settle();
    expect(urls.filter((u) => u.startsWith(BASE + '/v1/'))).toHaveLength(0);
  });
});

describe('refreshing stored tiles', () => {
  it('re-downloads stored roads made before the latest repository build', async () => {
    const BASE = 'https://example.github.io/t';
    const store = new MemoryTileStore();
    const car = tileOf(fix());
    // Stored yesterday, with no cameras.
    await store.put(`v2:roads:${car.x}:${car.y}`, { savedAt: Date.now() - 86400000, data: { ways: [], cameras: [], map: [] } });
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      if (url === `${BASE}/index.json`) return new Response(JSON.stringify({ version: 1, built: 'x', generated: new Date().toISOString() }));
      if (url === `${BASE}/v1/${car.x}/${car.y}.json`) return new Response(encodeTile([], [{ lat: 37.5355, lon: 126.6431, maxspeed: 50 }]));
      if (url.startsWith(BASE)) return new Response('', { status: 404 });
      return new Response(JSON.stringify({ elements: [] }));
    }) as typeof fetch;
    const svc = new RoadDataService(fetchFn, ['overpass'], store, 0, BASE);
    svc.update(fix());
    await settle();
    expect(urls).toContain(`${BASE}/v1/${car.x}/${car.y}.json`);
    expect(svc.data.cameras).toHaveLength(1);
  });
});
