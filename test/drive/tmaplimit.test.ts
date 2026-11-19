import { describe, expect, it } from 'vitest';
import type { Fix } from '../../src/drive/core/types';
import { parseNearToRoad, TmapLimitService } from '../../src/drive/services/tmaplimit';

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const fix = (lat = 37.5355, lon = 126.6431): Fix => ({ lat, lon, speed: 15, heading: 0, ts: Date.now() });

function fakeTmap(speed: number | null = 60, status = 200) {
  const calls: { url: string; key: string | null }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, key: new Headers(init.headers).get('appKey') });
    if (status !== 200) return new Response(status === 204 ? null : '', { status });
    return new Response(JSON.stringify({ resultData: { header: { speed, roadName: '에코로', linkId: '123' } } }));
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('parseNearToRoad', () => {
  it('reads the link limit, treating 0 as unknown', () => {
    expect(parseNearToRoad({ resultData: { header: { speed: 50, roadName: '에코로', linkId: 7 } } })).toEqual({
      limit: 50,
      roadName: '에코로',
      linkId: '7',
    });
    expect(parseNearToRoad({ resultData: { header: { speed: 0 } } })?.limit).toBeNull();
    expect(parseNearToRoad({})).toBeNull();
  });
});

describe('TmapLimitService', () => {
  it('asks only with a key, sends the key as a header, and serves the answer nearby', async () => {
    const { fetchFn, calls } = fakeTmap(60);
    const svc = new TmapLimitService(fetchFn);
    svc.update(fix(), '', null);
    expect(calls).toHaveLength(0);
    svc.update(fix(), 'KEY', null);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe('KEY');
    expect(calls[0].url).not.toContain('KEY');
    expect(svc.limitAt(fix())).toBe(60);
    expect(svc.limitAt(fix(37.55))).toBeNull(); // ~1.6 km away
  });

  it('asks again on a new road or after 400 m, but no more than every 5 s', async () => {
    const { fetchFn, calls } = fakeTmap();
    const svc = new TmapLimitService(fetchFn);
    const roadA = {};
    svc.update(fix(), 'K', roadA);
    await settle();
    svc.update(fix(37.5356), 'K', roadA); // same road, 10 m on
    svc.update(fix(37.5356), 'K', {}); // new road, but too soon
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('skips estimated positions', () => {
    const { fetchFn, calls } = fakeTmap();
    new TmapLimitService(fetchFn).update({ ...fix(), estimated: true }, 'K', null);
    expect(calls).toHaveLength(0);
  });

  it('reports errors (e.g. a bad key) and backs off', async () => {
    const { fetchFn, calls } = fakeTmap(60, 401);
    const svc = new TmapLimitService(fetchFn);
    svc.update(fix(), 'BAD', null);
    await settle();
    expect(svc.statusText()).toBe('Tmap 제한속도 오류: HTTP 401');
    expect(svc.limitAt(fix())).toBeNull();
    svc.update(fix(37.6), 'BAD', null);
    expect(calls).toHaveLength(1);
  });

  it('treats 204 as "no road here"', async () => {
    const { fetchFn } = fakeTmap(60, 204);
    const svc = new TmapLimitService(fetchFn);
    svc.update(fix(), 'K', null);
    await settle();
    expect(svc.limitAt(fix())).toBeNull();
    expect(svc.statusText()).toBe('Tmap 제한속도 사용 (1회 조회)');
  });
});
