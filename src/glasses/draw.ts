import type { GaugeModel, TimelineModel } from './visuals';

/**
 * Draws the HUD images with Canvas 2D and encodes them as PNG.
 *
 * Everything is drawn in shades of grey on black: the glasses render black as
 * "off" (transparent) and map grey levels to 16 shades of green.
 */
export interface HudRenderer {
  gauge(m: GaugeModel, width: number, height: number): Promise<Uint8Array>;
  timeline(m: TimelineModel, width: number, height: number): Promise<Uint8Array>;
  blank(width: number, height: number): Promise<Uint8Array>;
}

type Ctx = CanvasRenderingContext2D;

const grey = (v: number) => `rgb(${v},${v},${v})`;
const DEG = Math.PI / 180;
const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

function canvas(width: number, height: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  return [c, ctx];
}

async function toPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

function arc(ctx: Ctx, cx: number, cy: number, r: number, from: number, to: number, width: number, level: number) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, from, to);
  ctx.strokeStyle = grey(level);
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  ctx.stroke();
}

/** Spaced-out uppercase text, centred: the "HUD label" look. */
function label(ctx: Ctx, text: string, x: number, y: number, size: number, level: number, spacing = 1.5) {
  ctx.font = `600 ${size}px ${FONT}`;
  ctx.fillStyle = grey(level);
  ctx.textBaseline = 'middle';
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (widths.length - 1);
  let cursor = x - total / 2;
  [...text].forEach((ch, i) => {
    ctx.fillText(ch, cursor, y);
    cursor += widths[i] + spacing;
  });
}

function corners(ctx: Ctx, w: number, h: number, len: number, level: number) {
  ctx.strokeStyle = grey(level);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const [x, y, dx, dy] of [[0.5, 0.5, 1, 1], [w - 0.5, 0.5, -1, 1], [0.5, h - 0.5, 1, -1], [w - 0.5, h - 0.5, -1, -1]]) {
    ctx.moveTo(x + dx * len, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * len);
  }
  ctx.stroke();
}

export function drawGauge(ctx: Ctx, m: GaugeModel, w: number, h: number): void {
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 3;
  const top = -90 * DEG;

  corners(ctx, w, h, 10, 90);

  // Outer hairline and alert brackets.
  arc(ctx, cx, cy, R, 0, Math.PI * 2, 1, 60);
  if (m.alert) {
    for (const a of [45, 135, 225, 315]) arc(ctx, cx, cy, R, (a - 14) * DEG, (a + 14) * DEG, 3, 255);
  }

  // Progress arc: pomodoro / break / minutes past the hour.
  const rArc = R - 6;
  arc(ctx, cx, cy, rArc, 0, Math.PI * 2, 5, 32);
  if (m.outer > 0) {
    if (m.outerKind === 'break') ctx.setLineDash([3, 3]);
    arc(ctx, cx, cy, rArc, top, top + m.outer * Math.PI * 2, 5, m.outerKind === 'hour' ? 170 : 240);
    ctx.setLineDash([]);
    // Bright "head" at the leading edge.
    const a = top + m.outer * Math.PI * 2;
    arc(ctx, cx, cy, rArc, a - 3 * DEG, a, 7, 255);
  }

  // Tick ring: 60 ticks, every fifth longer and brighter.
  const rTick = rArc - 6;
  for (let i = 0; i < 60; i++) {
    const a = top + (i / 60) * Math.PI * 2;
    const major = i % 5 === 0;
    const r0 = rTick - (major ? 5 : 2);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * rTick, cy + Math.sin(a) * rTick);
    ctx.strokeStyle = grey(major ? 150 : 60);
    ctx.lineWidth = major ? 1.5 : 1;
    ctx.stroke();
  }

  // Battery: 20 segments over a 270° arc open at the bottom.
  const rBat = rTick - 11;
  const segs = 20;
  const start = 135 * DEG;
  const sweep = 270 * DEG;
  const lit = m.battery === null ? 0 : Math.round(m.battery * segs);
  for (let i = 0; i < segs; i++) {
    const a0 = start + (i / segs) * sweep + 1.5 * DEG;
    const a1 = start + ((i + 1) / segs) * sweep - 1.5 * DEG;
    const low = m.battery !== null && m.battery <= 0.15;
    arc(ctx, cx, cy, rBat, a0, a1, 4, i < lit ? (low ? 255 : 150) : 28);
  }

  // Centre readout, kept inside the battery ring (radius rBat).
  label(ctx, `${m.day} ${m.date}`, cx, cy - 16, 8, 160, 0.5);
  ctx.font = `700 23px ${FONT}`;
  ctx.fillStyle = grey(255);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(m.time, cx, cy + 2);
  ctx.textAlign = 'start';
  const bottom = m.alert ? '! ALERT' : m.battery === null ? m.label : `${m.label} ${Math.round(m.battery * 100)}${m.charging ? '+' : '%'}`;
  label(ctx, bottom, cx, cy + 19, 7, m.alert ? 255 : 140, 0.5);
}

export function drawTimeline(ctx: Ctx, m: TimelineModel, w: number, h: number): void {
  const span = (m.endHour - m.startHour) * 60;
  const x = (min: number) => Math.round((min / span) * (w - 2)) + 1;
  const base = h - 4;

  // Baseline + hour ticks (every 6h taller).
  ctx.fillStyle = grey(55);
  ctx.fillRect(0, base, w, 1);
  for (let hr = m.startHour; hr <= m.endHour; hr++) {
    const major = hr % 6 === 0;
    ctx.fillStyle = grey(major ? 130 : 70);
    const tall = major ? 5 : 2;
    ctx.fillRect(x((hr - m.startHour) * 60), base - tall, 1, tall);
  }

  // Events.
  for (const e of m.events) {
    const x0 = x(e.from);
    const x1 = Math.max(x0 + 2, x(e.to));
    ctx.fillStyle = grey(e.current ? 210 : e.next ? 170 : 95);
    ctx.fillRect(x0, base - 9, x1 - x0, 6);
    if (e.next) {
      ctx.fillStyle = grey(255);
      ctx.fillRect(x0, base - 11, x1 - x0, 1);
    }
  }

  // Now marker with a small notch on top.
  const nx = x(m.now);
  ctx.fillStyle = grey(255);
  ctx.fillRect(nx - 1, 3, 2, h - 3);
  ctx.beginPath();
  ctx.moveTo(nx - 4, 0);
  ctx.lineTo(nx + 4, 0);
  ctx.lineTo(nx, 4);
  ctx.closePath();
  ctx.fill();
}

export function createCanvasRenderer(): HudRenderer {
  return {
    async gauge(m, w, h) {
      const [c, ctx] = canvas(w, h);
      drawGauge(ctx, m, w, h);
      return toPng(c);
    },
    async timeline(m, w, h) {
      const [c, ctx] = canvas(w, h);
      drawTimeline(ctx, m, w, h);
      return toPng(c);
    },
    async blank(w, h) {
      return toPng(canvas(w, h)[0]);
    },
  };
}
