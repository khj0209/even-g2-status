import { describe, expect, it } from 'vitest';
import { LAYOUT, SCREEN } from '../../src/drive/hud/layout';

describe('LAYOUT', () => {
  it('stays within what the glasses accept', () => {
    const images = LAYOUT.filter((b) => b.kind === 'image');
    expect(images.length).toBeLessThanOrEqual(4); // firmware max for image containers
    expect(LAYOUT.filter((b) => b.kind === 'text').length).toBeLessThanOrEqual(8);
    expect(LAYOUT.length).toBeLessThanOrEqual(12);
    expect(LAYOUT.filter((b) => b.capture)).toHaveLength(1);
    for (const b of images) {
      expect(b.w).toBeLessThanOrEqual(200);
      expect(b.h).toBeLessThanOrEqual(100);
    }
    for (const b of LAYOUT) {
      expect(b.x + b.w).toBeLessThanOrEqual(SCREEN.w);
      expect(b.y + b.h).toBeLessThanOrEqual(SCREEN.h);
    }
  });

  it('uses contiguous ids from 1', () => {
    expect(LAYOUT.map((b) => b.id).sort((a, b) => a - b)).toEqual(LAYOUT.map((_, i) => i + 1));
  });

  it('keeps the overview and minimap apart', () => {
    const o = LAYOUT.find((b) => b.name === 'overview')!;
    const m = LAYOUT.find((b) => b.name === 'minimap')!;
    expect(o.x + o.w).toBeLessThan(m.x);
  });
});
