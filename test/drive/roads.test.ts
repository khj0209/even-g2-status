import { describe, expect, it } from 'vitest';
import type { Fix } from '../../src/drive/core/types';
import { matchToPaths } from '../../src/drive/services/matching';
import { CameraTracker, emptyRoadData, OverpassClient, parseBuildings, cameraAhead, matchLimit, parseMaxspeed, parseOverpass, type RoadData } from '../../src/drive/services/roads';

const fix = (lat: number, lon: number, heading: number | null): Fix => ({ lat, lon, heading, speed: 15, ts: 0 });

describe('parseMaxspeed', () => {
  it('reads km/h and mph, rejects non-numeric', () => {
    expect(parseMaxspeed('50')).toBe(50);
    expect(parseMaxspeed('60 km/h')).toBe(60);
    expect(parseMaxspeed('30 mph')).toBe(48);
    expect(parseMaxspeed('signals')).toBeNull();
    expect(parseMaxspeed(undefined)).toBeNull();
  });
});

describe('overpass', () => {
  it('parses ways with limits and cameras', () => {
    const data = parseOverpass({
      elements: [
        { type: 'way', tags: { maxspeed: '50' }, geometry: [{ lat: 1, lon: 2 }, { lat: 1, lon: 3 }] },
        { type: 'way', tags: { maxspeed: 'none' }, geometry: [{ lat: 1, lon: 2 }, { lat: 1, lon: 3 }] },
        { type: 'node', lat: 5, lon: 6, tags: { highway: 'speed_camera', maxspeed: '60' } },
        { type: 'node', lat: 7, lon: 8, tags: { highway: 'speed_camera' } },
      ],
    });
    expect(data.ways).toHaveLength(1);
    expect(data.ways[0].maxspeed).toBe(50);
    expect(data.map).toEqual([]); // no highway tags on these test ways
    expect(data.cameras).toEqual([
      { lat: 5, lon: 6, maxspeed: 60 },
      { lat: 7, lon: 8, maxspeed: null },
    ]);
  });
});

// An east–west 50 road crossed by a north–south 30 road at (37.5, 127.0).
const data: RoadData = {
  ways: [
    { maxspeed: 50, points: [{ lat: 37.5, lon: 126.99 }, { lat: 37.5, lon: 127.01 }] },
    { maxspeed: 30, points: [{ lat: 37.49, lon: 127.0 }, { lat: 37.51, lon: 127.0 }] },
  ],
  cameras: [{ lat: 37.5, lon: 127.004, maxspeed: 50 }],
  map: [],
  buildings: [],
};

describe('map roads', () => {
  it('keeps drivable roads for the minimap, marking the major ones', () => {
    const geometry = [{ lat: 1, lon: 2 }, { lat: 1, lon: 3 }];
    const data = parseOverpass({
      elements: [
        { type: 'way', tags: { highway: 'primary' }, geometry },
        { type: 'way', tags: { highway: 'residential', maxspeed: '30' }, geometry },
        { type: 'way', tags: { highway: 'motorway_link' }, geometry },
        { type: 'way', tags: { highway: 'footway' }, geometry },
        { type: 'way', tags: { highway: 'service' }, geometry },
      ],
    });
    expect(data.map.map((w) => w.major)).toEqual([true, false, true]);
    expect(data.ways).toHaveLength(1);
  });
});

describe('buildings', () => {
  it('keeps closed outlines and skips broken ones', () => {
    const sq = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
      { lat: 1, lon: 1 },
      { lat: 0, lon: 0 },
    ];
    expect(
      parseBuildings({ elements: [{ type: 'way', id: 7, geometry: sq }, { type: 'way', geometry: sq.slice(0, 2) }, { type: 'way' }] }),
    ).toEqual([{ id: 7, points: sq }]);
  });
});

describe('matchLimit', () => {
  it('uses heading to pick the right road at a junction', () => {
    expect(matchLimit(data, fix(37.50002, 127.00002, 90))).toBe(50);
    expect(matchLimit(data, fix(37.50002, 127.00002, 270))).toBe(50);
    expect(matchLimit(data, fix(37.50002, 127.00002, 0))).toBe(30);
  });

  it('returns null away from any tagged road', () => {
    expect(matchLimit(data, fix(37.505, 127.005, 90))).toBeNull();
  });

  it('falls back to the nearest road without a heading', () => {
    expect(matchLimit(data, fix(37.5001, 127.003, null))).toBe(50);
  });
});

describe('cameraAhead', () => {
  it('reports a camera in front, not behind or without heading', () => {
    const ahead = cameraAhead(data, fix(37.5, 127.001, 90));
    expect(ahead?.limit).toBe(50);
    expect(ahead?.dist).toBeGreaterThan(250);
    expect(ahead?.dist).toBeLessThan(280);
    expect(cameraAhead(data, fix(37.5, 127.001, 270))).toBeNull();
    expect(cameraAhead(data, fix(37.5, 127.001, null))).toBeNull();
    expect(cameraAhead(data, fix(37.5, 126.99, 90))).toBeNull(); // too far
  });
});

describe('CameraTracker', () => {
  it('keeps warning through heading wobble until the camera is passed', () => {
    const t = new CameraTracker();
    expect(t.next(data, fix(37.5, 127.001, 90))?.dist).toBeGreaterThan(250);
    // Heading swings 40° off (outside the 25° cone a fresh lookup needs): still warning.
    const wobble = t.next(data, fix(37.5, 127.002, 130));
    expect(wobble?.limit).toBe(50);
    expect(wobble!.dist).toBeLessThan(200);
    // Driven past it: gone.
    expect(t.next(data, fix(37.5, 127.0045, 90))).toBeNull();
  });
});

describe('OverpassClient', () => {
  it('fails over to the next server and then prefers the one that answered', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      return url === 'a' ? new Response('', { status: 502 }) : new Response(JSON.stringify({ elements: [] }));
    }) as typeof fetch;
    const client = new OverpassClient(fetchFn, ['a', 'b'], 0);
    expect(await client.run('q')).toEqual({ elements: [] });
    await client.run('q');
    expect(calls).toEqual(['a', 'b', 'b']);
  });

  it('runs one request at a time', async () => {
    let running = 0;
    let maxRunning = 0;
    const fetchFn = (async () => {
      maxRunning = Math.max(maxRunning, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return new Response(JSON.stringify({ elements: [] }));
    }) as typeof fetch;
    const client = new OverpassClient(fetchFn, ['a'], 0);
    await Promise.all([client.run('1'), client.run('2'), client.run('3')]);
    expect(maxRunning).toBe(1);
  });

  it('names every server in the error, and flags load refusals', async () => {
    const fetchFn = (async (url: string) =>
      url.includes('one') ? new Response('', { status: 504 }) : Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
    const err = await new OverpassClient(fetchFn, ['https://one.example/api', 'https://maps.two.example/api'], 0).run('q').catch((e) => e);
    expect(err.message).toBe('one.example 504, two.example 연결 실패');
    expect(err.busy).toBe(true);
  });

  it('spaces requests out', async () => {
    const starts: number[] = [];
    const fetchFn = (async () => {
      starts.push(Date.now());
      return new Response(JSON.stringify({ elements: [] }));
    }) as typeof fetch;
    const client = new OverpassClient(fetchFn, ['a'], 50);
    await Promise.all([client.run('1'), client.run('2'), client.run('3')]);
    expect(starts[2] - starts[0]).toBeGreaterThanOrEqual(95);
  });

  it('treats a timed-out query reported as 200 with a remark as a failure', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ elements: [], remark: 'runtime error: Query timed out' }))) as typeof fetch;
    await expect(new OverpassClient(fetchFn, ['a'], 0).run('q')).rejects.toThrow('서버 처리 시간 초과');
  });
});

describe('cameras on the road ahead', () => {
  const M = 1 / 111195;
  const road = [
    { lat: 37.5, lon: 126.99 },
    { lat: 37.5, lon: 127.01 },
  ];
  const onRoad = { lat: 37.5, lon: 127.004, maxspeed: 50 };
  const parallel = { lat: 37.5 + 40 * M, lon: 127.003, maxspeed: 60 }; // 40 m north, a parallel street
  const roadside = { lat: 37.5 + 12 * M, lon: 127.005, maxspeed: 70 }; // official data: by the road
  const car = fix(37.5, 127.001, 90);
  const ref = () => matchToPaths(car, [road], 20)!;
  const cams = (...cameras: RoadData['cameras']): RoadData => ({ ...emptyRoadData(), cameras });

  it('announces a camera on the matched road, measured along it', () => {
    const a = cameraAhead(cams(onRoad), car, ref());
    expect(a?.limit).toBe(50);
    expect(a!.dist).toBeCloseTo(265, -1);
    expect(cameraAhead(cams(roadside), car, ref())?.limit).toBe(70);
  });

  it('ignores cameras on parallel roads that the old straight-ahead check caught', () => {
    expect(cameraAhead(cams(parallel), car)?.limit).toBe(60); // fallback, no road match
    expect(cameraAhead(cams(parallel), car, ref())).toBeNull();
  });

  it('carries straight on past the end of the matched way', () => {
    const shortWay = [
      { lat: 37.5, lon: 126.99 },
      { lat: 37.5, lon: 127.002 },
    ];
    expect(cameraAhead(cams(onRoad), car, matchToPaths(car, [shortWay], 20))?.limit).toBe(50);
  });

  it('drops a held warning once the car has turned onto another road', () => {
    const t = new CameraTracker();
    expect(t.next(cams(onRoad), car, ref())?.limit).toBe(50);
    // Turned north onto a side street at 127.002: matched there now.
    const side = [
      { lat: 37.5, lon: 127.002 },
      { lat: 37.51, lon: 127.002 },
    ];
    const turned = fix(37.5 + 30 * M, 127.002, 0);
    expect(t.next(cams(onRoad), turned, matchToPaths(turned, [side], 20))).toBeNull();
  });
});
