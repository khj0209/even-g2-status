import { describe, expect, it } from 'vitest';
import { DrowsinessDetector, DrowsyCalibrator } from '../../src/drive/services/drowsiness';

/** Samples every 100 ms: head level is (0, 9.8, 0); dropping the head lowers y by `drop`. */
function run(det: DrowsinessDetector, from: number, ms: number, drop: number, kmh = 60, yaw = 0) {
  let warned = false;
  for (let t = from; t < from + ms; t += 100) warned = det.sample([yaw, 9.8 - drop, 0], t, kmh) || warned;
  return warned;
}

describe('DrowsyCalibrator', () => {
  it('finds the axis and direction of a nod', () => {
    const c = new DrowsyCalibrator();
    for (let i = 0; i < 30; i++) c.add([0.1 * Math.sin(i), 9.8 - (i % 10 > 6 ? 3 : 0), 0]);
    expect(c.finish()).toEqual({ axis: 1, sign: -1, amp: 3 });
  });

  it('needs enough samples', () => {
    const c = new DrowsyCalibrator();
    c.add([0, 0, 0]);
    expect(c.finish()).toBeNull();
  });
});

describe('DrowsinessDetector', () => {
  const cal = { axis: 1 as const, sign: -1 as const, amp: 3 };

  it('warns after two nods while driving', () => {
    const d = new DrowsinessDetector(cal);
    expect(run(d, 0, 5000, 0)).toBe(false);
    expect(run(d, 5000, 800, 2.5)).toBe(false); // first nod
    expect(run(d, 5800, 3000, 0)).toBe(false);
    expect(run(d, 8800, 800, 2.5)).toBe(false); // second nod, still down
    expect(run(d, 9600, 1000, 0)).toBe(true); // and back up
  });

  it('warns when the head stays down', () => {
    const d = new DrowsinessDetector(cal);
    run(d, 0, 5000, 0);
    expect(run(d, 5000, 3000, 2.5)).toBe(true);
  });

  it('ignores mirror checks, brief dips and being parked', () => {
    const d = new DrowsinessDetector(cal);
    run(d, 0, 5000, 0);
    expect(run(d, 5000, 2000, 0, 60, 5)).toBe(false); // head turn: another axis
    expect(run(d, 7000, 200, 2.5)).toBe(false); // 0.2 s dip
    expect(run(d, 7200, 1000, 0)).toBe(false);
    expect(run(d, 8200, 5000, 2.5, 0)).toBe(false); // head down while stopped
  });

  it('does not repeat the warning straight away', () => {
    const d = new DrowsinessDetector(cal);
    run(d, 0, 5000, 0);
    expect(run(d, 5000, 3000, 2.5)).toBe(true);
    expect(run(d, 8000, 1000, 0)).toBe(false);
    expect(run(d, 9000, 3000, 2.5)).toBe(false);
  });
});
