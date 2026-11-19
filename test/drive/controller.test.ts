import { beforeEach, describe, expect, it } from 'vitest';
import { AUTO_SNOOZE_MS, DriveController } from '../../src/drive/controller';

function setup() {
  const log: string[] = [];
  let speed: number | null = null;
  let worn = true;
  let now = 0;
  let tripEnd: (() => void) | null = null;
  let exitFromWearer: (() => void) | null = null;
  const settings = { auto: true, autoKmh: 20 };
  const ctl = new DriveController(
    {
      suspend: () => log.push('suspend'),
      resume: async () => void log.push('resume'),
      isWorn: () => worn,
    },
    {
      startDriving: (onExit) => {
        exitFromWearer = onExit;
        log.push('start');
      },
      stopDriving: () => log.push('stop'),
      onTripEnd: (fn) => (tripEnd = fn),
    },
    { getSpeed: async () => speed, settings: () => settings, now: () => now },
  );
  return {
    ctl, log, settings,
    setSpeed: (kmh: number | null) => (speed = kmh === null ? null : kmh / 3.6),
    setWorn: (w: boolean) => (worn = w),
    advance: (ms: number) => (now += ms),
    tripEnd: () => tripEnd!(),
    wearerExit: () => exitFromWearer!(),
  };
}

describe('DriveController', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));

  it('enters and exits manually, handing the glasses over and back', async () => {
    await t.ctl.toggle();
    expect(t.ctl.state).toBe('manual');
    await t.ctl.toggle();
    expect(t.ctl.state).toBe('off');
    expect(t.log).toEqual(['suspend', 'start', 'stop', 'resume']);
  });

  it('starts automatically after two fast samples in a row', async () => {
    t.setSpeed(35);
    await t.ctl.poll();
    expect(t.ctl.state).toBe('off');
    await t.ctl.poll();
    expect(t.ctl.state).toBe('auto');
  });

  it('needs consecutive samples: a slow or missing one resets the count', async () => {
    t.setSpeed(35);
    await t.ctl.poll();
    t.setSpeed(5);
    await t.ctl.poll();
    t.setSpeed(35);
    await t.ctl.poll();
    expect(t.ctl.state).toBe('off');
    t.setSpeed(null);
    await t.ctl.poll();
    t.setSpeed(35);
    await t.ctl.poll();
    expect(t.ctl.state).toBe('off');
  });

  it('does not start automatically when disabled or the glasses are off', async () => {
    t.setSpeed(50);
    t.settings.auto = false;
    await t.ctl.poll();
    await t.ctl.poll();
    expect(t.ctl.state).toBe('off');
    t.settings.auto = true;
    t.setWorn(false);
    await t.ctl.poll();
    await t.ctl.poll();
    expect(t.ctl.state).toBe('off');
  });

  it('an automatic driving mode ends when the trip ends; a manual one does not', async () => {
    t.setSpeed(40);
    await t.ctl.poll();
    await t.ctl.poll();
    t.tripEnd();
    await Promise.resolve();
    expect(t.ctl.state).toBe('off');

    await t.ctl.enter('manual');
    t.tripEnd();
    await Promise.resolve();
    expect(t.ctl.state).toBe('manual');
  });

  it('after a manual exit while moving, waits before starting automatically again', async () => {
    t.setSpeed(40);
    await t.ctl.poll();
    await t.ctl.poll();
    t.wearerExit(); // double tap / "운전 모드 끝내기"
    await Promise.resolve();
    expect(t.ctl.state).toBe('off');
    await t.ctl.poll();
    await t.ctl.poll();
    expect(t.ctl.state).toBe('off');
    t.advance(AUTO_SNOOZE_MS + 1);
    await t.ctl.poll();
    await t.ctl.poll();
    expect(t.ctl.state).toBe('auto');
  });

  it('a trip-end exit does not snooze the next automatic start', async () => {
    t.setSpeed(40);
    await t.ctl.poll();
    await t.ctl.poll();
    t.tripEnd();
    await Promise.resolve();
    await t.ctl.poll();
    await t.ctl.poll();
    expect(t.ctl.state).toBe('auto');
  });
});
