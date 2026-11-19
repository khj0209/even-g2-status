export type Mode = 'default' | 'commute' | 'work' | 'workout' | 'evening';

export const MODES: Mode[] = ['default', 'commute', 'work', 'workout', 'evening'];

export const MODE_LABEL: Record<Mode, string> = {
  default: '기본',
  commute: '출퇴근',
  work: '업무',
  workout: '운동',
  evening: '저녁',
};

export type WidgetId =
  | 'mode'
  | 'clock'
  | 'weather'
  | 'air'
  | 'battery'
  | 'calendar'
  | 'tomorrow'
  | 'focus'
  | 'dev'
  | 'transit'
  | 'tracker'
  | 'workout'
  | 'today';

/** What a widget wants to show. `null` from render() means "nothing to show". */
export interface WidgetOutput {
  text: string;
  /** Urgent output makes its line full brightness and triggers a short blink. */
  urgent?: boolean;
}

/** Short English status codes used by the HUD theme ("» WORK"). */
export const MODE_CODE: Record<Mode, string> = {
  default: 'STANDBY',
  commute: 'TRANSIT',
  work: 'WORK',
  workout: 'TRAINING',
  evening: 'EVENING',
};

export type Theme = 'hud' | 'classic';

export type LineName = 'top' | 'main' | 'sub';
export const LINES: LineName[] = ['top', 'main', 'sub'];

export type Layout = Record<LineName, WidgetId[]>;

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface CalendarEvent {
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
}

/** Normalised input coming from the glasses (or the browser preview). */
export type InputAction =
  | { type: 'click' }
  | { type: 'doubleClick' }
  | { type: 'longPress' }
  | { type: 'menu'; itemId: number }
  | { type: 'foreground'; active: boolean };

export interface DeviceState {
  connected: boolean;
  wearing: boolean | null;
  battery: number | null;
  charging: boolean;
}
