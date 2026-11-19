import type { Settings } from '../core/settings';
import type { AppState } from '../core/state';
import type { CalendarEvent, DeviceState, GeoPoint, Mode, WidgetId, WidgetOutput } from '../core/types';

/** Everything a widget may read. Widgets never talk to the glasses directly. */
export interface WidgetEnv {
  settings: Settings;
  state: AppState;
  device: DeviceState;
  location: GeoPoint | null;
  events: CalendarEvent[];
  mode: Mode;
  fetch: typeof fetch;
}

export interface Widget {
  id: WidgetId;
  /** How often refresh() should run while the widget is on screen. */
  refreshMs?: number;
  /** Fetch remote data. Errors are caught by the engine; keep the last good value. */
  refresh?(env: WidgetEnv, now: Date): Promise<void>;
  render(env: WidgetEnv, now: Date): WidgetOutput | null;
}

export async function fetchJson<T = any>(
  fetchFn: typeof fetch,
  url: string,
  init?: RequestInit,
  timeoutMs = 10_000,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export const pad2 = (n: number) => String(n).padStart(2, '0');

export function hhmm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Truncate by visual width (CJK counts as 2) so lines don't wrap on the narrow display. */
export function clip(text: string, maxWidth: number): string {
  let width = 0;
  let out = '';
  for (const ch of text) {
    const w = /[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(ch) ? 2 : 1;
    if (width + w > maxWidth) return out.trimEnd() + '…';
    width += w;
    out += ch;
  }
  return out;
}

export function relMinutes(min: number): string {
  if (min < 1) return '곧';
  if (min < 60) return `${min}분 후`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}시간 ${m}분 후` : `${h}시간 후`;
}
