import { remainingMs } from '../core/pomodoro';
import type { AppState } from '../core/state';
import type { Settings } from '../core/settings';
import { MODE_CODE, type CalendarEvent, type DeviceState, type Mode } from '../core/types';

/**
 * Plain data describing what the HUD images should show. Kept free of canvas
 * code so it can be unit-tested; the same model always draws the same pixels,
 * which lets the engine skip sending unchanged images.
 */
export interface GaugeModel {
  time: string; // "14:32"
  day: string; // "THU"
  date: string; // "11.19"
  /** Outer arc 0..1: pomodoro progress, or minutes past the hour. */
  outer: number;
  outerKind: 'pomodoro' | 'break' | 'hour';
  /** Inner segmented arc 0..1: glasses battery, or null when unknown. */
  battery: number | null;
  charging: boolean;
  label: string; // "WORK"
  alert: boolean;
}

export interface TimelineModel {
  startHour: number;
  endHour: number;
  /** Minutes since startHour, quantised to 5 minutes. Clamped to the range. */
  now: number;
  events: { from: number; to: number; next: boolean; current: boolean }[];
}

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const pad = (n: number) => String(n).padStart(2, '0');

export function gaugeModel(input: {
  now: Date;
  state: AppState;
  settings: Settings;
  device: DeviceState;
  mode: Mode;
  alert: boolean;
}): GaugeModel {
  const { now, state, settings, device, mode, alert } = input;
  const p = state.pomodoro;
  let outer: number;
  let outerKind: GaugeModel['outerKind'];
  if (p.phase === 'focus' || p.phase === 'break') {
    const total = (p.phase === 'focus' ? settings.pomodoro.focusMin : settings.pomodoro.breakMin) * 60_000;
    // Quantise to 1/60 so the image changes at most once a minute-ish.
    outer = Math.round((1 - remainingMs(state, now.getTime()) / total) * 60) / 60;
    outerKind = p.phase === 'focus' ? 'pomodoro' : 'break';
  } else {
    outer = now.getMinutes() / 60;
    outerKind = 'hour';
  }
  const battery = device.connected && device.battery !== null ? Math.round(device.battery / 5) * 5 / 100 : null;
  return {
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    day: DAYS[now.getDay()],
    date: `${pad(now.getMonth() + 1)}.${pad(now.getDate())}`,
    outer: Math.min(1, Math.max(0, outer)),
    outerKind,
    battery,
    charging: device.charging,
    label: MODE_CODE[mode],
    alert,
  };
}

export function timelineModel(now: Date, events: CalendarEvent[], startHour = 6, endHour = 24): TimelineModel {
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), startHour).getTime();
  const span = (endHour - startHour) * 60;
  const toMin = (d: Date) => Math.min(span, Math.max(0, Math.round((d.getTime() - day0) / 60_000)));
  const nowMin = Math.floor(toMin(now) / 5) * 5; // changes exactly every 5 minutes
  const today = events
    .filter((e) => !e.allDay)
    .map((e) => ({ from: toMin(e.start), to: toMin(e.end), start: e.start, end: e.end }))
    .filter((e) => e.to > e.from); // drops events outside today's window
  const next = today.find((e) => e.start > now);
  return {
    startHour,
    endHour,
    now: nowMin,
    events: today.map((e) => ({
      from: e.from,
      to: e.to,
      next: e === next,
      current: e.start <= now && e.end > now,
    })),
  };
}

/** Stable identity for change detection. */
export const modelKey = (m: unknown) => JSON.stringify(m);
