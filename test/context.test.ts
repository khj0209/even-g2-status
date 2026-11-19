import { describe, expect, it } from 'vitest';
import { nextOverride, resolveMode } from '../src/core/context';
import { DEFAULT_SETTINGS, inWindow, mergeSettings, type Settings } from '../src/core/settings';
import { defaultState } from '../src/core/state';
import { MODES, type CalendarEvent } from '../src/core/types';

const thu = (h: number, m = 0) => new Date(2026, 10, 19, h, m);
const sat = (h: number) => new Date(2026, 10, 21, h, 0);

function mode(now: Date, opts: { settings?: Partial<Settings>; events?: CalendarEvent[]; location?: any; state?: any } = {}) {
  return resolveMode({
    now,
    settings: { ...DEFAULT_SETTINGS, ...opts.settings },
    state: { ...defaultState(now), ...opts.state },
    events: opts.events ?? [],
    location: opts.location ?? null,
  });
}

describe('resolveMode', () => {
  it('follows the weekday time windows', () => {
    expect(mode(thu(6))).toBe('default');
    expect(mode(thu(8))).toBe('commute');
    expect(mode(thu(11))).toBe('work');
    expect(mode(thu(18, 30))).toBe('commute');
    expect(mode(thu(21))).toBe('evening');
  });

  it('does not use commute/work windows on weekends', () => {
    expect(mode(sat(8))).toBe('default');
    expect(mode(sat(11))).toBe('default');
    expect(mode(sat(22))).toBe('evening');
  });

  it('switches to workout from the timer or a calendar event', () => {
    expect(mode(thu(11), { state: { workout: { startedAt: 1 } } })).toBe('workout');
    const gym: CalendarEvent = { title: '저녁 헬스', start: thu(10, 30), end: thu(11, 30), allDay: false };
    expect(mode(thu(11), { events: [gym] })).toBe('workout');
    expect(mode(thu(12), { events: [gym] })).toBe('work');
  });

  it('uses location when home/office are configured', () => {
    const office = { lat: 37.5, lon: 127.0 };
    const home = { lat: 37.6, lon: 127.1 };
    expect(mode(thu(8), { settings: { office, home }, location: { lat: 37.5005, lon: 127.0005 } })).toBe('work');
    expect(mode(thu(8), { settings: { office, home }, location: home })).toBe('default');
    expect(mode(thu(20), { settings: { office, home }, location: home })).toBe('evening');
  });

  it('manual override wins', () => {
    expect(mode(thu(8), { state: { modeOverride: 'evening' } })).toBe('evening');
  });
});

describe('helpers', () => {
  it('cycles overrides auto -> modes -> auto', () => {
    const seen: (string | null)[] = [];
    let cur = null as any;
    for (let i = 0; i <= MODES.length; i++) seen.push((cur = nextOverride(cur, MODES)));
    expect(seen).toEqual([...MODES, null]);
  });

  it('handles windows crossing midnight', () => {
    expect(inWindow('22:00-02:00', thu(23))).toBe(true);
    expect(inWindow('22:00-02:00', thu(1))).toBe(true);
    expect(inWindow('22:00-02:00', thu(12))).toBe(false);
  });

  it('merges partial stored settings over defaults', () => {
    const s = mergeSettings({ brightness: 3, calendar: { manual: 'x' } });
    expect(s.brightness).toBe(3);
    expect(s.calendar.manual).toBe('x');
    expect(s.calendar.alertMinutes).toBe(DEFAULT_SETTINGS.calendar.alertMinutes);
  });
});
