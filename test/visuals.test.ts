import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { defaultState } from '../src/core/state';
import type { CalendarEvent, DeviceState } from '../src/core/types';
import { gaugeModel, timelineModel } from '../src/glasses/visuals';

const now = new Date(2026, 10, 19, 14, 15);
const device: DeviceState = { connected: true, wearing: true, battery: 83, charging: false };
const base = { now, settings: DEFAULT_SETTINGS, device, mode: 'work' as const, alert: false };

describe('gaugeModel', () => {
  it('shows minutes past the hour when no pomodoro runs', () => {
    expect(gaugeModel({ ...base, state: defaultState(now) })).toEqual({
      time: '14:15', day: 'THU', date: '11.19', outer: 0.25, outerKind: 'hour',
      battery: 0.85, charging: false, label: 'WORK', alert: false,
    });
  });

  it('tracks pomodoro and break progress', () => {
    const state = defaultState(now);
    state.pomodoro = { phase: 'focus', endsAt: now.getTime() + 10 * 60_000, finished: null, finishedAt: 0 };
    expect(gaugeModel({ ...base, state })).toMatchObject({ outerKind: 'pomodoro', outer: 0.6 });
    state.pomodoro = { phase: 'break', endsAt: now.getTime() + 60_000, finished: null, finishedAt: 0 };
    expect(gaugeModel({ ...base, state })).toMatchObject({ outerKind: 'break', outer: 0.8 });
  });

  it('hides the battery when the glasses are disconnected', () => {
    const m = gaugeModel({ ...base, state: defaultState(now), device: { ...device, connected: false } });
    expect(m.battery).toBeNull();
  });
});

describe('timelineModel', () => {
  const ev = (d: number, h: number, dur: number): CalendarEvent => {
    const start = new Date(2026, 10, d, h);
    return { title: 'x', start, end: new Date(start.getTime() + dur * 3_600_000), allDay: false };
  };

  it('maps today’s events into the 06–24 window and marks current/next', () => {
    const m = timelineModel(now, [ev(19, 13, 2), ev(19, 16, 1), ev(20, 9, 1)]);
    expect(m.now).toBe((14 - 6) * 60 + 15);
    expect(m.events).toEqual([
      { from: 7 * 60, to: 9 * 60, next: false, current: true },
      { from: 10 * 60, to: 11 * 60, next: true, current: false },
    ]); // tomorrow's event is dropped
  });

  it('clamps events that start before the window', () => {
    const m = timelineModel(now, [ev(19, 4, 3)]);
    expect(m.events).toEqual([{ from: 0, to: 60, next: false, current: false }]);
  });
});
