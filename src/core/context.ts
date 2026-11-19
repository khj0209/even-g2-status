import { inWindow, type Settings } from './settings';
import type { AppState } from './state';
import type { CalendarEvent, GeoPoint, Mode } from './types';

export interface ContextInput {
  now: Date;
  settings: Settings;
  state: AppState;
  events: CalendarEvent[];
  location: GeoPoint | null;
}

const NEAR_METERS = 250;

export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function near(loc: GeoPoint | null, place: GeoPoint | null): boolean {
  return !!loc && !!place && distanceMeters(loc, place) <= NEAR_METERS;
}

function isWorkoutEvent(ev: CalendarEvent, keywords: string[], now: Date): boolean {
  if (ev.allDay || now < ev.start || now >= ev.end) return false;
  const title = ev.title.toLowerCase();
  return keywords.some((k) => k && title.includes(k.toLowerCase()));
}

/**
 * Decide which mode to show automatically.
 *
 * Priority: manual override > active workout (timer or calendar) > location >
 * time-of-day windows > default.
 */
export function resolveMode(input: ContextInput): Mode {
  const { now, settings, state, events, location } = input;
  if (state.modeOverride) return state.modeOverride;
  if (state.workout.startedAt) return 'workout';
  if (events.some((e) => isWorkoutEvent(e, settings.workoutKeywords, now))) return 'workout';

  const day = now.getDay();
  const weekday = day >= 1 && day <= 5;
  const hour = now.getHours();
  const late = hour >= 19 || hour < 5;

  if (weekday && near(location, settings.office)) return 'work';
  if (near(location, settings.home)) return late ? 'evening' : 'default';

  if (weekday && settings.commuteWindows.some((w) => inWindow(w, now))) return 'commute';
  if (weekday && inWindow(settings.workHours, now)) return 'work';
  if (late) return 'evening';
  return 'default';
}

/** Next manual mode when cycling with a tap: auto -> each mode -> auto. */
export function nextOverride(current: Mode | null, order: Mode[]): Mode | null {
  if (current === null) return order[0];
  const i = order.indexOf(current);
  return i < 0 || i === order.length - 1 ? null : order[i + 1];
}
