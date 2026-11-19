import { describe, expect, it } from 'vitest';
import { CAM_SECTION_END, CAM_SECTION_START, CAM_SIGNAL, CAM_SPEED, classify, decodeTile, encodeTile, parseOfficialCamera, splitByTile, tileOf } from '../../src/drive/services/tileformat';

describe('classify', () => {
  it('keeps drivable roads and anything with a limit', () => {
    expect(classify({ highway: 'primary', maxspeed: '60' })).toEqual({ drivable: true, major: true, maxspeed: 60 });
    expect(classify({ highway: 'residential' })).toEqual({ drivable: true, major: false, maxspeed: 0 });
    expect(classify({ highway: 'service', maxspeed: '20' })).toEqual({ drivable: false, major: false, maxspeed: 20 });
    expect(classify({ highway: 'footway' })).toBeNull();
    expect(classify({ building: 'yes' })).toBeNull();
  });
});

describe('splitByTile', () => {
  it('cuts a polyline into per-tile pieces that overlap by the border-crossing segment', () => {
    // Three points in one tile row, the last one in the next column.
    const pts = [
      { lat: 37.535, lon: 126.64 },
      { lat: 37.535, lon: 126.645 },
      { lat: 37.535, lon: 126.652 },
    ];
    const a = tileOf(pts[0]);
    const b = tileOf(pts[2]);
    const out = splitByTile(pts);
    expect([...out.keys()].sort()).toEqual([`${a.x}:${a.y}`, `${b.x}:${b.y}`].sort());
    expect(out.get(`${a.x}:${a.y}`)).toEqual([pts]);
    expect(out.get(`${b.x}:${b.y}`)).toEqual([pts.slice(1)]);
  });

  it('does not skip a tile a long segment passes through', () => {
    const out = splitByTile([
      { lat: 37.535, lon: 126.6 },
      { lat: 37.535, lon: 126.7 },
    ]);
    expect(out.size).toBe(tileOf({ lat: 37.535, lon: 126.7 }).y - tileOf({ lat: 37.535, lon: 126.6 }).y + 1);
  });

  it('starts a new piece when a way leaves a tile and comes back', () => {
    const pts = [
      { lat: 37.535, lon: 126.645 },
      { lat: 37.535, lon: 126.655 }, // next tile
      { lat: 37.536, lon: 126.655 },
      { lat: 37.536, lon: 126.645 }, // back
    ];
    const home = tileOf(pts[0]);
    expect(splitByTile(pts).get(`${home.x}:${home.y}`)).toHaveLength(2);
  });
});

describe('encode/decode', () => {
  it('round-trips to about a metre', () => {
    const ways = [{ drivable: true, major: false, maxspeed: 50, points: [{ lat: 37.123456, lon: 126.987654 }, { lat: 37.12401, lon: 126.98801 }] }];
    const back = decodeTile(JSON.parse(encodeTile(ways, [{ lat: 37.5, lon: 127, maxspeed: null }])));
    expect(back.ways[0]).toMatchObject({ drivable: true, major: false, maxspeed: 50 });
    expect(back.ways[0].points[0].lat).toBeCloseTo(37.12346, 5);
    expect(back.ways[0].points[1].lon).toBeCloseTo(126.98801, 5);
    expect(back.cameras).toEqual([{ lat: 37.5, lon: 127, maxspeed: null, kind: 0, section: 0 }]);
  });
});

describe('parseOfficialCamera', () => {
  const row = (r: Record<string, string>) => parseOfficialCamera({ latitude: '37.5', longitude: '127.0', lmttVe: '0', regltSctnLcSe: '', ovrspdRegltSctnLt: '', ...r });

  it('tells speed, signal and section cameras apart', () => {
    expect(row({ lmttVe: '60' })).toMatchObject({ kind: CAM_SPEED, maxspeed: 60 });
    expect(row({ lmttVe: '0', regltSe: '02' })).toMatchObject({ kind: CAM_SIGNAL, maxspeed: null });
    expect(row({ lmttVe: '0', regltSe: '4' })).toMatchObject({ kind: CAM_SPEED, maxspeed: null }); // plain 단속
    expect(row({ lmttVe: '60', regltSe: '01+02' })).toMatchObject({ kind: CAM_SPEED, maxspeed: 60 });
    expect(row({ lmttVe: '100', regltSe: '99', regltSctnLcSe: '01' })).toMatchObject({ kind: CAM_SECTION_START });
    expect(row({ lmttVe: '100', regltSe: '99', regltSctnLcSe: '02' })).toMatchObject({ kind: CAM_SECTION_END });
    expect(row({ lmttVe: '100', regltSctnLcSe: '1', ovrspdRegltSctnLt: '7.6' })).toMatchObject({
      kind: CAM_SECTION_START,
      maxspeed: 100,
      section: 7600,
    });
    expect(row({ lmttVe: '100', regltSctnLcSe: '종점' })).toMatchObject({ kind: CAM_SECTION_END, section: 0 });
  });

  it('drops rows without a usable position', () => {
    expect(row({ latitude: '', longitude: '' })).toBeNull();
    expect(row({ latitude: '0', longitude: '0' })).toBeNull();
  });

  it('round-trips kind and section length through the tile format', () => {
    const cam = row({ lmttVe: '100', regltSctnLcSe: '1', ovrspdRegltSctnLt: '7.6' })!;
    expect(decodeTile(JSON.parse(encodeTile([], [cam]))).cameras[0]).toMatchObject({ kind: CAM_SECTION_START, section: 7600, maxspeed: 100 });
  });
});
