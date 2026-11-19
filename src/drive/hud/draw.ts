import type { ManeuverIcon, MinimapPoint, MinimapView, OverviewView } from '../core/types';
import { MINIMAP, OVERVIEW } from './layout';

/** Bitmaps for the glasses: white on black, which the G2 shows as green on transparent. */

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  ctx.lineCap = ctx.lineJoin = 'round';
  return [c, ctx];
}

const FONT = 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

/**
 * Rounded-rect path via `arcTo`, not `ctx.roundRect` — the G2's WebView canvas engine is an
 * unknown/older build and `roundRect` is recent enough (2021+) that it can't be assumed present.
 */
function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * Speed, with the limit sign beside it when there is one (one image, since the glasses allow only
 * four). Boxed when over the limit.
 */
export function drawSpeed(speed: string, unit: string, over: boolean, limit: number | null): HTMLCanvasElement {
  const [c, ctx] = canvas(200, 100);
  const cx = limit == null ? 100 : 72;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `bold 76px ${FONT}`;
  ctx.fillText(speed, cx, 68, limit == null ? 180 : 128);
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText(unit, cx, 91);
  if (limit != null) {
    // Round limit sign, heavier when over.
    ctx.lineWidth = over ? 8 : 5;
    ctx.beginPath();
    ctx.arc(160, 48, 31 - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.stroke();
    const text = String(limit);
    ctx.font = `bold ${text.length > 2 ? 21 : 28}px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 160, 50);
  }
  if (over) {
    ctx.lineWidth = 4;
    roundedRectPath(ctx, 3, 3, 194, 94, 14);
    ctx.stroke();
  }
  return c;
}

/** Caption under an icon in a 120×100 side block. */
function caption(ctx: CanvasRenderingContext2D, text: string): void {
  ctx.fillStyle = '#fff';
  ctx.font = `bold 22px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, 60, 95, 116);
}

/** Left-hand block: turn arrow with the distance to the turn under it. Null draws nothing. */
export function drawTurn(nav: { icon: ManeuverIcon; dist: string } | null): HTMLCanvasElement {
  const [c, ctx] = canvas(120, 100);
  if (!nav) return c;
  ctx.save();
  ctx.translate(60 - 35, 0);
  ctx.scale(70 / 96, 70 / 96);
  arrow(ctx, nav.icon);
  ctx.restore();
  caption(ctx, nav.dist);
  return c;
}

type Pt = [number, number];

/** Arrow shafts for right-hand manoeuvres in a 96×96 box; left-hand ones are mirrored. */
const SHAFTS: Record<string, Pt[]> = {
  straight: [[48, 88], [48, 26]],
  'slight-right': [[38, 88], [38, 56], [64, 30]],
  right: [[32, 88], [32, 44], [68, 44]],
  'sharp-right': [[34, 88], [34, 30], [64, 60]],
};

function arrowHead(ctx: CanvasRenderingContext2D, from: Pt, tip: Pt, size = 20): void {
  const a = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  // Push the head past the end of the shaft so the tip is sharp.
  const tx = tip[0] + Math.cos(a) * size * 0.6;
  const ty = tip[1] + Math.sin(a) * size * 0.6;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - Math.cos(a - 0.6) * size * 1.4, ty - Math.sin(a - 0.6) * size * 1.4);
  ctx.lineTo(tx - Math.cos(a + 0.6) * size * 1.4, ty - Math.sin(a + 0.6) * size * 1.4);
  ctx.closePath();
  ctx.fill();
}

/** Paints a manoeuvre arrow into a 96×96 box at the origin. */
function arrow(ctx: CanvasRenderingContext2D, icon: ManeuverIcon): void {
  ctx.lineWidth = 12;

  if (icon === 'arrive') {
    // Map pin.
    ctx.beginPath();
    ctx.arc(48, 36, 24, Math.PI * 0.85, Math.PI * 0.15);
    ctx.lineTo(48, 90);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(48, 36, 9, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (icon === 'uturn') {
    ctx.beginPath();
    ctx.moveTo(66, 88);
    ctx.lineTo(66, 44);
    ctx.arc(48, 44, 18, 0, Math.PI, true);
    ctx.lineTo(30, 58);
    ctx.stroke();
    arrowHead(ctx, [30, 44], [30, 58]);
    return;
  }
  if (icon === 'roundabout') {
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(48, 40, 18, 0, Math.PI * 2);
    ctx.moveTo(48, 58);
    ctx.lineTo(48, 90);
    ctx.stroke();
    arrowHead(ctx, [56, 22], [66, 22], 12);
    return;
  }

  const left = icon.endsWith('left');
  if (left) {
    ctx.translate(96, 0);
    ctx.scale(-1, 1);
  }
  const pts = SHAFTS[icon.replace('left', 'right')];
  ctx.beginPath();
  ctx.moveTo(...pts[0]);
  for (const p of pts.slice(1)) ctx.lineTo(...p);
  ctx.stroke();
  arrowHead(ctx, pts[pts.length - 2], pts[pts.length - 1]);
}

// Grey levels: the G2 shows brightness in 16 steps, and the lowest few are hard to see on the real
// glasses (the simulator shows them brighter). Buildings are the dimmest layer but still well above
// that floor, then roads, then the route at full brightness with a dark casing so it separates from
// the roads it runs along. Outlines are whole pixels wide so they don't anti-alias into dim greys.
const BUILDING_FILL = '#303030';
const BUILDING_EDGE = '#7a7a7a';
const MINOR_ROAD = '#9c9c9c';
const MAJOR_ROAD = '#c8c8c8';

function polyline(ctx: CanvasRenderingContext2D, points: MinimapPoint[]): void {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.stroke();
}

/** Top-right minimap: roads, the route, next turn, destination and cameras around the car. */
export function drawMinimap(mm: MinimapView | null): HTMLCanvasElement {
  const { w, h } = MINIMAP;
  const [c, ctx] = canvas(w, h);
  ctx.save();
  roundedRectPath(ctx, 1, 1, w - 2, h - 2, 12);
  ctx.clip();

  if (mm) {
    ctx.save();
    ctx.translate(w / 2, 68);
    ctx.lineWidth = 2;
    for (const b of mm.buildings) {
      ctx.beginPath();
      ctx.moveTo(b[0].x, b[0].y);
      for (const p of b.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fillStyle = BUILDING_FILL;
      ctx.fill();
      ctx.strokeStyle = BUILDING_EDGE;
      ctx.stroke();
    }
    for (const road of mm.roads) {
      ctx.strokeStyle = road.major ? MAJOR_ROAD : MINOR_ROAD;
      ctx.lineWidth = road.major ? 6 : 3;
      polyline(ctx, road.points);
    }
    ctx.strokeStyle = ctx.fillStyle = '#fff';
    if (mm.route.length >= 2) {
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 11;
      polyline(ctx, mm.route);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 6;
      polyline(ctx, mm.route);
    }
    if (mm.turn) {
      // Ring around the turn point, cut out of the route so it reads as a target.
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(mm.turn.x, mm.turn.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = '#fff';
    }
    if (mm.dest) {
      ctx.fillRect(mm.dest.x - 5, mm.dest.y - 5, 10, 10);
    }
    for (const cam of mm.cameras) {
      // Camera: small diamond.
      ctx.beginPath();
      ctx.moveTo(cam.x, cam.y - 6);
      ctx.lineTo(cam.x + 6, cam.y);
      ctx.lineTo(cam.x, cam.y + 6);
      ctx.lineTo(cam.x - 6, cam.y);
      ctx.closePath();
      ctx.fill();
    }
    // Car: an arrow pointing up (heading-up) with a black outline so it stands out on the route.
    ctx.beginPath();
    if (mm.headingKnown) {
      ctx.moveTo(0, -10);
      ctx.lineTo(8, 8);
      ctx.lineTo(0, 4);
      ctx.lineTo(-8, 8);
      ctx.closePath();
    } else {
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  roundedRectPath(ctx, 1, 1, w - 2, h - 2, 12);
  ctx.stroke();
  return c;
}

/** Top-left overview of the whole route: dim where already driven, bright ahead. Blank when not guiding. */
export function drawOverview(ov: OverviewView | null): HTMLCanvasElement {
  const { w, h } = OVERVIEW;
  const [c, ctx] = canvas(w, h);
  if (!ov) return c;
  ctx.lineWidth = 2;
  roundedRectPath(ctx, 1, 1, w - 2, h - 2, 12);
  ctx.stroke();

  ctx.lineWidth = 3;
  if (ov.done.length >= 2) {
    ctx.strokeStyle = '#6a6a6a';
    polyline(ctx, ov.done);
  }
  if (ov.ahead.length >= 2) {
    ctx.strokeStyle = '#fff';
    polyline(ctx, ov.ahead);
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect(ov.dest.x - 4, ov.dest.y - 4, 8, 8);

  if (ov.car) {
    // The car: an arrow along the heading (north-up map), or a dot without one.
    ctx.save();
    ctx.translate(ov.car.x, ov.car.y);
    ctx.beginPath();
    if (ov.heading != null) {
      ctx.rotate((ov.heading * Math.PI) / 180);
      ctx.moveTo(0, -8);
      ctx.lineTo(6, 6);
      ctx.lineTo(0, 3);
      ctx.lineTo(-6, 6);
      ctx.closePath();
    } else ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }
  return c;
}

/** Night: scale every grey level down to about half brightness. */
export function dimCanvas(c: HTMLCanvasElement): void {
  const ctx = c.getContext('2d')!;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = '#8a8a8a';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.restore();
}

/** Encode a canvas as PNG bytes for `updateImageRawData`. */
export async function pngBytes(c: HTMLCanvasElement): Promise<number[]> {
  // Synchronous toDataURL, not toBlob: browsers run toBlob's encoding in idle time, which a
  // backgrounded WebView (phone screen off) may defer indefinitely, freezing every image on the
  // glasses while the text kept updating.
  const url = c.toDataURL('image/png');
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Array<number>(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
