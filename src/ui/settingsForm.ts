import { mergeSettings, type Settings } from '../core/settings';
import type { GeoPoint, Layout, LineName, Mode, WidgetId } from '../core/types';
import { LINES, MODES } from '../core/types';
import { WIDGET_LABEL } from '../widgets';

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const list = (s: string) => s.split(',').map((l) => l.trim()).filter(Boolean);

export function formatPoint(p: GeoPoint | null): string {
  return p ? `${p.lat},${p.lon}` : '';
}

export function parsePoint(s: string): GeoPoint | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return null;
  const lat = +m[1];
  const lon = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/** Validate the advanced layouts JSON. Throws a readable Korean error. */
export function parseLayouts(text: string): Partial<Record<Mode, Layout>> {
  if (!text.trim()) return {};
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('레이아웃 JSON 형식이 올바르지 않습니다.');
  }
  const out: Partial<Record<Mode, Layout>> = {};
  for (const [mode, layout] of Object.entries(raw ?? {})) {
    if (!MODES.includes(mode as Mode)) throw new Error(`알 수 없는 모드: ${mode}`);
    const l = {} as Layout;
    for (const line of LINES) {
      const ids = (layout as any)?.[line] ?? [];
      if (!Array.isArray(ids)) throw new Error(`${mode}.${line} 는 배열이어야 합니다.`);
      for (const id of ids) if (!(id in WIDGET_LABEL)) throw new Error(`알 수 없는 위젯: ${id}`);
      l[line as LineName] = ids as WidgetId[];
    }
    out[mode as Mode] = l;
  }
  return out;
}

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export function fillForm(form: HTMLFormElement, s: Settings): void {
  const set = (name: string, value: string | number) => {
    const el = form.elements.namedItem(name) as Field | null;
    if (el) el.value = String(value);
  };
  set('position', s.position);
  set('brightness', s.brightness);
  set('workHours', s.workHours);
  set('commuteWindows', s.commuteWindows.join(', '));
  set('home', formatPoint(s.home));
  set('office', formatPoint(s.office));
  set('fallbackLocation', formatPoint(s.fallbackLocation));
  set('workoutKeywords', s.workoutKeywords.join(', '));
  set('icsUrls', s.calendar.icsUrls.join('\n'));
  set('corsProxy', s.calendar.corsProxy);
  set('manual', s.calendar.manual);
  set('alertMinutes', s.calendar.alertMinutes);
  set('focusMin', s.pomodoro.focusMin);
  set('breakMin', s.pomodoro.breakMin);
  set('seoulApiKey', s.transit.seoulApiKey);
  set('station', s.transit.station);
  set('directionFilter', s.transit.directionFilter);
  set('repo', s.dev.repo);
  set('branch', s.dev.branch);
  set('githubToken', s.dev.githubToken);
  set('healthUrls', s.dev.healthUrls.join('\n'));
  set('tracker', s.tracker);
  set('layouts', Object.keys(s.layouts).length ? JSON.stringify(s.layouts, null, 2) : '');
}

export function readForm(form: HTMLFormElement, current: Settings): Settings {
  const get = (name: string) => ((form.elements.namedItem(name) as Field | null)?.value ?? '').trim();
  const num = (name: string, min: number, max: number, fallback: number) => {
    const n = Number(get(name));
    return Number.isFinite(n) && get(name) !== '' ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  return mergeSettings({
    ...current,
    position: get('position') === 'bottom' ? 'bottom' : 'top',
    brightness: num('brightness', 0, 4, current.brightness),
    workHours: get('workHours') || current.workHours,
    commuteWindows: list(get('commuteWindows')),
    home: parsePoint(get('home')),
    office: parsePoint(get('office')),
    fallbackLocation: parsePoint(get('fallbackLocation')) ?? current.fallbackLocation,
    workoutKeywords: list(get('workoutKeywords')),
    calendar: {
      icsUrls: lines(get('icsUrls')),
      corsProxy: get('corsProxy'),
      manual: get('manual'),
      alertMinutes: num('alertMinutes', 1, 60, current.calendar.alertMinutes),
    },
    pomodoro: {
      focusMin: num('focusMin', 1, 120, current.pomodoro.focusMin),
      breakMin: num('breakMin', 1, 60, current.pomodoro.breakMin),
    },
    transit: { seoulApiKey: get('seoulApiKey'), station: get('station'), directionFilter: get('directionFilter') },
    dev: {
      repo: get('repo'),
      branch: get('branch') || 'main',
      githubToken: get('githubToken'),
      healthUrls: lines(get('healthUrls')),
    },
    tracker: get('tracker'),
    layouts: parseLayouts(get('layouts')),
  });
}
