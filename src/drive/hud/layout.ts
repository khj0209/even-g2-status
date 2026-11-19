export const SCREEN = { w: 576, h: 288 };

export interface Box {
  id: number;
  name: string;
  kind: 'text' | 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  /** Receives touchpad events. Exactly one per layout. */
  capture?: boolean;
  /** Don't resend more often than this (ms). For images that change constantly but matter little. */
  minInterval?: number;
}

// The G2 display floats slightly above the wearer's line of sight, so everything is packed into
// one cluster in the lower middle of the canvas: closest to the road, nothing out at the edges,
// and readable in a single glance. Speed sits dead centre, with the turn on its left and the
// limit on its right, like a car HUD.
//
// Image containers stay within 200×100, the limit documented for the G2.
// The full-screen text box sits behind everything purely to capture touch events.
const EVENTS: Box = { id: 1, name: 'evt', kind: 'text', x: 0, y: 0, w: SCREEN.w, h: SCREEN.h, capture: true };

const BAND_Y = 160;

export const MINIMAP = { w: 160, h: 100 };
export const OVERVIEW = { w: 160, h: 100 };

export const LAYOUT: Box[] = [
  EVENTS,
  { id: 2, name: 'info', kind: 'text', x: 68, y: 120, w: 440, h: 40 },
  { id: 3, name: 'turn', kind: 'image', x: 68, y: BAND_Y, w: 120, h: 100 },
  // Speed with the limit sign beside it, in one image: the glasses allow only 4 image containers.
  { id: 4, name: 'speed', kind: 'image', x: 188, y: BAND_Y, w: 200, h: 100 },
  { id: 5, name: 'alert', kind: 'text', x: 392, y: BAND_Y + 18, w: 150, h: 70 },
  // Top corners: the minimap (right) and the whole-route overview (left), clear of the main cluster.
  // Ids are kept contiguous: a non-contiguous id once failed to render on real hardware.
  {
    id: 6,
    name: 'minimap',
    kind: 'image',
    x: SCREEN.w - MINIMAP.w - 12,
    y: 12,
    w: MINIMAP.w,
    h: MINIMAP.h,
    minInterval: 3000,
  },
  { id: 7, name: 'overview', kind: 'image', x: 12, y: 12, w: OVERVIEW.w, h: OVERVIEW.h, minInterval: 5000 },
];
