import type { GeoPoint, Layout, Mode, Theme } from './types';

export interface Settings {
  /** 'hud': gauge + timeline images with bordered panels. 'classic': three plain text lines. */
  theme: Theme;
  /** Where the HUD sits in the field of view. */
  position: 'top' | 'bottom';
  /** Base brightness (0-4) of normal lines. Urgent lines are always 4. */
  brightness: number;
  /** Fallback location when the phone can't provide one (default: Seoul City Hall). */
  fallbackLocation: GeoPoint;
  home: GeoPoint | null;
  office: GeoPoint | null;
  /** "HH:MM-HH:MM" windows, weekdays only. */
  workHours: string;
  commuteWindows: string[];
  pomodoro: { focusMin: number; breakMin: number };
  calendar: {
    icsUrls: string[];
    /** Optional prefix for ICS feeds without CORS headers, e.g. "https://my-proxy.example/?url=". */
    corsProxy: string;
    /** Manual events, one per line. See calendar widget docs. */
    manual: string;
    alertMinutes: number;
  };
  dev: {
    githubToken: string;
    repo: string; // owner/name
    branch: string;
    healthUrls: string[];
  };
  transit: {
    seoulApiKey: string;
    station: string;
    /** Only show trains whose direction text contains this (e.g. "성수행" or "외선"). */
    directionFilter: string;
  };
  /** Tracker items, one per line. See tracker widget docs. */
  tracker: string;
  workoutKeywords: string[];
  /** Advanced: per-mode layout override. Missing modes use the defaults. */
  layouts: Partial<Record<Mode, Layout>>;
}

export const DEFAULT_LAYOUTS: Record<Mode, Layout> = {
  default: { top: ['clock', 'weather', 'battery'], main: ['calendar'], sub: ['focus'] },
  commute: { top: ['clock', 'weather', 'battery'], main: ['transit'], sub: ['calendar'] },
  work: { top: ['clock', 'battery', 'dev'], main: ['focus'], sub: ['calendar'] },
  workout: { top: ['clock', 'battery'], main: ['workout'], sub: ['weather', 'air'] },
  evening: { top: ['clock', 'weather', 'battery'], main: ['today', 'tracker'], sub: ['tomorrow'] },
};

/**
 * HUD theme: time, date and battery live in the gauge image, so the text lines
 * carry a mode code plus the most relevant context instead.
 */
export const HUD_LAYOUTS: Record<Mode, Layout> = {
  default: { top: ['mode', 'weather', 'air'], main: ['calendar'], sub: ['focus'] },
  commute: { top: ['mode', 'weather'], main: ['transit'], sub: ['calendar'] },
  work: { top: ['mode', 'dev'], main: ['focus'], sub: ['calendar'] },
  workout: { top: ['mode', 'air'], main: ['workout'], sub: ['weather'] },
  evening: { top: ['mode', 'weather'], main: ['today', 'tracker'], sub: ['tomorrow'] },
};

export const DEFAULT_SETTINGS: Settings = {
  theme: 'hud',
  position: 'top',
  brightness: 2,
  fallbackLocation: { lat: 37.5663, lon: 126.9779 },
  home: null,
  office: null,
  workHours: '09:30-18:00',
  commuteWindows: ['07:30-09:30', '18:00-19:30'],
  pomodoro: { focusMin: 25, breakMin: 5 },
  calendar: { icsUrls: [], corsProxy: '', manual: '', alertMinutes: 10 },
  dev: { githubToken: '', repo: '', branch: 'main', healthUrls: [] },
  transit: { seoulApiKey: '', station: '', directionFilter: '' },
  tracker: 'water\nfx USD KRW',
  workoutKeywords: ['운동', '헬스', 'PT', '러닝', 'workout', 'gym'],
  layouts: {},
};

export function layoutFor(settings: Settings, mode: Mode): Layout {
  return settings.layouts[mode] ?? (settings.theme === 'hud' ? HUD_LAYOUTS : DEFAULT_LAYOUTS)[mode];
}

/** Deep-merge stored (possibly older/partial) settings over the defaults. */
export function mergeSettings(stored: unknown): Settings {
  if (!stored || typeof stored !== 'object') return structuredClone(DEFAULT_SETTINGS);
  return deepMerge(structuredClone(DEFAULT_SETTINGS), stored as Record<string, unknown>) as Settings;
}

function deepMerge(base: any, patch: Record<string, unknown>): any {
  for (const [key, value] of Object.entries(patch)) {
    const current = base[key];
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      current && typeof current === 'object' && !Array.isArray(current)
    ) {
      base[key] = deepMerge(current, value as Record<string, unknown>);
    } else if (value !== undefined) {
      base[key] = value;
    }
  }
  return base;
}

/** Parse "HH:MM-HH:MM" into minutes since midnight. Supports windows crossing midnight. */
export function parseWindow(win: string): { from: number; to: number } | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(win);
  if (!m) return null;
  return { from: +m[1] * 60 + +m[2], to: +m[3] * 60 + +m[4] };
}

export function inWindow(win: string, now: Date): boolean {
  const w = parseWindow(win);
  if (!w) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return w.from <= w.to ? t >= w.from && t < w.to : t >= w.from || t < w.to;
}
