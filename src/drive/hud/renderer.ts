import { dimCanvas, drawMinimap, drawOverview, drawSpeed, drawTurn } from './draw';
import { LAYOUT, type Box } from './layout';
import type { HudView } from './view';

/** Somewhere the HUD can be shown: the glasses, or the on-phone preview. */
export interface HudSink {
  setLayout(boxes: Box[]): void;
  /** `level`: text brightness 0..4 (4 = full). */
  setText(box: Box, content: string, level: number): void;
  setImage(box: Box, image: HTMLCanvasElement): void;
}

/** Text brightness level at night (of 0..4), and how much images are dimmed. */
const NIGHT_TEXT_LEVEL = 2;

/** Turns a HudView into per-container updates, sending only what changed. */
export class HudRenderer {
  private sinks: HudSink[] = [];
  private boxes: Box[] = [];
  private started = false;
  /** Last content key sent per container id. */
  private sent = new Map<number, string>();
  private lastView: HudView | null = null;
  /** When each container was last sent, for `minInterval`. */
  private sentAt = new Map<number, number>();

  addSink(sink: HudSink): void {
    this.sinks.push(sink);
    if (this.started) {
      sink.setLayout(this.boxes);
      this.redraw();
    }
  }

  /** Stop drawing to a sink (the glasses, when driving mode ends). */
  removeSink(sink: HudSink): void {
    this.sinks = this.sinks.filter((s) => s !== sink);
  }

  /** Lay out the HUD on every sink. Called once; there is a single fixed layout. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.boxes = LAYOUT;
    for (const s of this.sinks) s.setLayout(this.boxes);
    this.redraw();
  }

  /** Forget what was sent and push everything again (e.g. after the glasses page was rebuilt). */
  redraw(): void {
    this.sent.clear();
    this.sentAt.clear();
    if (this.lastView) this.render(this.lastView);
  }

  render(view: HudView): void {
    this.lastView = view;
    for (const box of this.boxes) {
      const [content, make] = this.content(box, view);
      // Night dimming changes every container, so it's part of every key.
      const key = `${view.dim ? 'D' : 'B'}${content}`;
      if (this.sent.get(box.id) === key) continue;
      // Throttled boxes catch up on a later render, since `sent` still holds the old key.
      const now = Date.now();
      if (box.minInterval && this.sent.has(box.id) && now - (this.sentAt.get(box.id) ?? 0) < box.minInterval) continue;
      this.sent.set(box.id, key);
      this.sentAt.set(box.id, now);
      if (box.kind === 'text') for (const s of this.sinks) s.setText(box, content, view.dim ? NIGHT_TEXT_LEVEL : 4);
      else {
        const image = (make as () => HTMLCanvasElement)();
        if (view.dim) dimCanvas(image);
        for (const s of this.sinks) s.setImage(box, image);
      }
    }
  }

  /** Content key for a container, plus a painter for image containers. */
  private content(box: Box, v: HudView): [string, (() => HTMLCanvasElement)?] {
    switch (box.name) {
      case 'speed':
        return [`${v.speed}|${v.unit}|${v.over}|${v.limit}`, () => drawSpeed(v.speed, v.unit, v.over, v.limit)];
      case 'alert':
        return [v.alert || ' '];
      case 'overview':
        return [v.overview?.key ?? '', () => drawOverview(v.overview)];
      case 'turn':
        return [v.nav ? `${v.nav.icon}|${v.nav.dist}` : '', () => drawTurn(v.nav)];
      case 'minimap': {
        const key = v.minimap?.key ?? '';
        return [key, () => drawMinimap(v.minimap)];
      }
      case 'info':
        return [v.info];
      default:
        return [' '];
    }
  }
}

