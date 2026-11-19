import { bearing, interpolate } from '../core/geo';
import type { Fix, LatLon } from '../core/types';
import type { RoadData } from './roads';
import { routeFromPolyline, type Route } from './routing';

/**
 * Self-contained demo drive: a made-up loop with its own speed limits, camera and route, so the
 * whole HUD can be exercised at a desk with no GPS and no network.
 */
const PATH: LatLon[] = [
  { lat: 37.498, lon: 127.0276 },
  { lat: 37.5043, lon: 127.0276 }, // 700 m north
  { lat: 37.5043, lon: 127.0389 }, // right, 1 km east
  { lat: 37.4989, lon: 127.0389 }, // right, 600 m south
  { lat: 37.4975, lon: 127.0371 }, // slight right
  { lat: 37.4975, lon: 127.0299 }, // 640 m west
];
const NAMES = ['테헤란로', '언주로', '도곡로', '역삼로'];
/** Limit (km/h) and how fast the demo car drives (km/h) on each leg — it speeds on leg 2 and 4. */
const LEGS = [
  { limit: 50, speed: 46 },
  { limit: 60, speed: 71 },
  { limit: 30, speed: 28 },
  { limit: 50, speed: 44 },
  { limit: 50, speed: 58 },
];

/** A stretch of the first leg where the demo "loses GPS", to show dead reckoning through a tunnel. */
const TUNNEL = { from: 37.5003, to: 37.5025, lon: 127.0276 };
export const inDemoTunnel = (p: LatLon) => Math.abs(p.lon - TUNNEL.lon) < 1e-6 && p.lat > TUNNEL.from && p.lat < TUNNEL.to;

export const demoRoute = (): Route => routeFromPolyline(PATH, NAMES, 13);

/** A made-up street grid around the drive so the minimap has something to show. */
function demoStreets(): RoadData['map'] {
  const streets: RoadData['map'] = [];
  // Side streets roughly every 130 m, like a dense city block grid.
  for (let lat = 37.4955; lat < 37.507; lat += 0.0012)
    streets.push({ major: false, points: [{ lat, lon: 127.022 }, { lat, lon: 127.044 }] });
  for (let lon = 127.0235; lon < 127.044; lon += 0.0015)
    streets.push({ major: false, points: [{ lat: 37.494, lon }, { lat: 37.508, lon }] });
  for (let i = 0; i + 1 < PATH.length; i++) streets.push({ major: true, points: [PATH[i], PATH[i + 1]] });
  return streets;
}

/** Two or three made-up buildings in every block of the demo grid. */
function demoBuildings(): LatLon[][] {
  const out: LatLon[][] = [];
  const rect = (lat: number, lon: number, dLat: number, dLon: number): LatLon[] => [
    { lat, lon },
    { lat, lon: lon + dLon },
    { lat: lat + dLat, lon: lon + dLon },
    { lat: lat + dLat, lon },
    { lat, lon },
  ];
  for (let lat = 37.4955; lat + 0.0012 < 37.507; lat += 0.0012)
    for (let lon = 127.0235; lon + 0.0015 < 127.044; lon += 0.0015) {
      out.push(rect(lat + 0.00015, lon + 0.0002, 0.0004, 0.0005));
      out.push(rect(lat + 0.00065, lon + 0.0002, 0.0004, 0.00035));
      out.push(rect(lat + 0.00015, lon + 0.0008, 0.0009, 0.0005));
    }
  return out;
}

export const demoRoadData = (): RoadData => ({
  ways: LEGS.map((leg, i) => ({ maxspeed: leg.limit, points: [PATH[i], PATH[i + 1]] })),
  cameras: [{ ...interpolate(PATH[1], PATH[2], 0.7), maxspeed: 60 }],
  map: demoStreets(),
  buildings: demoBuildings(),
});

/** Position on the demo drive `elapsed` seconds in. Stops at the end. */
export function demoFix(elapsed: number, ts: number): Fix {
  const route = demoRoute();
  let t = elapsed;
  for (let i = 0; i < LEGS.length; i++) {
    const len = route.cum[i + 1] - route.cum[i];
    const mps = LEGS[i].speed / 3.6;
    const legTime = len / mps;
    if (t < legTime) {
      // Ease in/out of each corner so the speed readout moves like a real car.
      const edge = Math.min(t, legTime - t);
      const speed = mps * Math.min(1, 0.45 + edge / 6);
      return { ...interpolate(PATH[i], PATH[i + 1], t / legTime), speed, heading: bearing(PATH[i], PATH[i + 1]), ts };
    }
    t -= legTime;
  }
  return { ...PATH[PATH.length - 1], speed: 0, heading: null, ts };
}
