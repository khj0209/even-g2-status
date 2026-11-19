import { SCREEN, type Box } from './layout';
import type { HudSink } from './renderer';

const GREEN = '#35f06a';

/** Draws the HUD onto a canvas in the phone page, approximating the glasses' green display. */
export class PreviewSink implements HudSink {
  private boxes: Box[] = [];
  private texts = new Map<number, { content: string; level: number }>();
  private images = new Map<number, HTMLCanvasElement>();
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = SCREEN.w;
    canvas.height = SCREEN.h;
    this.ctx = canvas.getContext('2d')!;
  }

  setLayout(boxes: Box[]): void {
    this.boxes = boxes;
    this.texts.clear();
    this.images.clear();
    this.paint();
  }

  setText(box: Box, content: string, level: number): void {
    this.texts.set(box.id, { content, level });
    this.paint();
  }

  setImage(box: Box, image: HTMLCanvasElement): void {
    this.images.set(box.id, image);
    this.paint();
  }

  private paint(): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SCREEN.w, SCREEN.h);
    for (const box of this.boxes) {
      const image = this.images.get(box.id);
      if (image) ctx.drawImage(image, box.x, box.y);
      const t = this.texts.get(box.id);
      if (!t) continue;
      const text = t.content;
      const g = Math.round(80 + (175 * t.level) / 4);
      ctx.fillStyle = `rgb(${g},${g},${g})`;
      ctx.font = '22px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      text.split('\n').forEach((line, i) => ctx.fillText(line, box.x + 4, box.y + 6 + i * 30, box.w - 8));
    }
    // Tint the white-on-black drawing green.
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = GREEN;
    ctx.fillRect(0, 0, SCREEN.w, SCREEN.h);
  }
}
