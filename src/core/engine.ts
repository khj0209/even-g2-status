import { BOX_ID, buildBoxes, LINE_WIDTH, MENU, MenuId } from '../glasses/layout';
import type { Host } from '../platform/host';
import { createWidgets } from '../widgets';
import { clip, type Widget, type WidgetEnv } from '../widgets/widget';
import { nextOverride, resolveMode } from './context';
import { parseIcs, parseManualEvents } from './ics';
import { acknowledgePomodoro, tickPomodoro, togglePomodoro } from './pomodoro';
import { layoutFor, mergeSettings, type Settings } from './settings';
import { completeCurrentTodo, mergeState, rollDaily, type AppState } from './state';
import {
  LINES, MODE_LABEL, MODES,
  type CalendarEvent, type DeviceState, type GeoPoint, type InputAction, type LineName, type Mode, type WidgetId,
} from './types';

export const SETTINGS_KEY = 'g2status.settings';
export const STATE_KEY = 'g2status.state';

const TICK_MS = 1000;
const CALENDAR_REFRESH_MS = 10 * 60_000;
const LOCATION_REFRESH_MS = 10 * 60_000;
const RETRY_AFTER_ERROR_MS = 60_000;
const TOAST_MS = 3000;

export interface RenderedLine {
  text: string;
  brightness: number;
  urgent: boolean;
}

export interface EngineOptions {
  now?: () => Date;
  fetch?: typeof fetch;
  /** Disable timers (tests drive tick() manually). */
  manualTicks?: boolean;
}

/**
 * The status HUD engine: decides the mode, renders widgets into three lines,
 * and pushes only lines that changed to the glasses.
 */
export class StatusEngine {
  settings: Settings;
  state: AppState;
  device: DeviceState = { connected: false, wearing: null, battery: null, charging: false };
  location: GeoPoint | null = null;
  events: CalendarEvent[] = [];
  mode: Mode = 'default';
  lastLines: Record<LineName, RenderedLine> | null = null;

  private widgets: Map<WidgetId, Widget>;
  private sent = new Map<number, { text: string; brightness: number }>();
  private nextRefresh = new Map<string, number>();
  private refreshing = new Set<string>();
  private seenUrgent = new Set<string>();
  private toast: { text: string; until: number } | null = null;
  private foreground = true;
  private blinking = false;
  private pushing: Promise<void> | null = null;
  private pendingLines: Record<LineName, RenderedLine> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubs: (() => void)[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => Date;
  private readonly fetchFn: typeof fetch;
  private listeners = new Set<() => void>();

  constructor(private host: Host, private opts: EngineOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
    this.settings = mergeSettings(null);
    this.state = mergeState(null, this.now());
    this.widgets = createWidgets();
  }

  async start(): Promise<void> {
    const [s, st] = await Promise.all([this.host.load(SETTINGS_KEY), this.host.load(STATE_KEY)]);
    this.settings = mergeSettings(safeJson(s));
    this.state = mergeState(safeJson(st), this.now());

    this.unsubs.push(
      this.host.onInput((a) => void this.handleInput(a)),
      this.host.onDevice((d) => {
        const wasActive = this.isActive();
        this.device = d;
        if (!wasActive && this.isActive()) this.sent.clear(); // force full redraw
        void this.tick();
      }),
    );
    await this.host.createPage(buildBoxes(this.settings), MENU);
    await this.tick();
    if (!this.opts.manualTicks) this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }

  /** Subscribe to state changes (used by the phone settings UI). */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Glasses are worn and our page is in the foreground. Unknown wear state counts as worn. */
  isActive(): boolean {
    return this.foreground && this.device.wearing !== false;
  }

  async applySettings(settings: Settings): Promise<void> {
    const relayout = settings.position !== this.settings.position;
    this.settings = settings;
    await this.host.save(SETTINGS_KEY, JSON.stringify(settings));
    this.nextRefresh.clear(); // refetch with new config
    if (relayout) {
      await this.host.createPage(buildBoxes(settings), MENU);
    }
    this.sent.clear();
    await this.tick();
  }

  /** Mutate state, persist (debounced), and re-render. */
  async mutate(fn: (s: AppState) => void): Promise<void> {
    fn(this.state);
    this.persistState();
    await this.tick();
  }

  private persistState(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.host.save(STATE_KEY, JSON.stringify(this.state)), 500);
  }

  private env(): WidgetEnv {
    return {
      settings: this.settings,
      state: this.state,
      device: this.device,
      location: this.location,
      events: this.events,
      mode: this.mode,
      fetch: this.fetchFn,
    };
  }

  // ---------------------------------------------------------------- tick

  async tick(): Promise<void> {
    const now = this.now();
    let dirty = rollDaily(this.state, now);
    const finished = tickPomodoro(this.state, now.getTime());
    if (finished) dirty = true;
    if (dirty) this.persistState();

    this.mode = resolveMode({
      now, settings: this.settings, state: this.state, events: this.events, location: this.location,
    });
    if (this.isActive()) this.scheduleRefreshes(now);

    const lines = this.renderLines(now);
    this.lastLines = lines;
    this.listeners.forEach((cb) => cb());
    if (this.isActive() && !this.blinking) await this.enqueuePush(lines);
  }

  /** Serialise pushes: BLE writes must not interleave; only the newest pending frame is sent. */
  private async enqueuePush(lines: Record<LineName, RenderedLine>): Promise<void> {
    this.pendingLines = lines;
    if (this.pushing) return this.pushing;
    this.pushing = (async () => {
      try {
        while (this.pendingLines) {
          const next = this.pendingLines;
          this.pendingLines = null;
          await this.push(next);
        }
      } finally {
        this.pushing = null;
      }
    })();
    return this.pushing;
  }

  renderLines(now: Date): Record<LineName, RenderedLine> {
    const env = this.env();
    const layout = layoutFor(this.settings, this.mode);
    const base = this.settings.brightness;
    const out = {} as Record<LineName, RenderedLine>;

    for (const line of LINES) {
      if (this.state.hidden) {
        out[line] = { text: ' ', brightness: 0, urgent: false };
        continue;
      }
      const parts: string[] = [];
      let urgent = false;
      for (const id of layout[line]) {
        const w = this.widgets.get(id);
        if (!w) continue;
        try {
          const o = w.render(env, now);
          if (o?.text) {
            parts.push(o.text);
            urgent ||= !!o.urgent;
          }
        } catch (e) {
          console.warn(`render ${id} failed`, e);
        }
      }
      const normal = line === 'main' ? Math.min(4, base + 1) : base;
      out[line] = { text: clip(parts.join('  '), LINE_WIDTH) || ' ', brightness: urgent ? 4 : normal, urgent };
    }

    if (this.toast && this.toast.until > now.getTime()) {
      out.main = { text: clip(this.toast.text, LINE_WIDTH), brightness: 4, urgent: false };
    } else {
      this.toast = null;
    }
    return out;
  }

  private async push(lines: Record<LineName, RenderedLine>): Promise<void> {
    const toBlink: LineName[] = [];
    for (const line of LINES) {
      const l = lines[line];
      const id = BOX_ID[line];
      const prev = this.sent.get(id);
      if (prev && prev.text === l.text && prev.brightness === l.brightness) continue;
      const ok = await this.host.updateText({ id, name: `hud-${line}` }, l.text, l.brightness);
      if (ok) this.sent.set(id, { text: l.text, brightness: l.brightness });
      if (l.urgent && !this.seenUrgent.has(l.text)) toBlink.push(line);
    }
    // Remember which urgent texts were already announced; forget ones no longer shown.
    const urgentNow = new Set(LINES.filter((l) => lines[l].urgent).map((l) => lines[l].text));
    for (const t of this.seenUrgent) if (!urgentNow.has(t)) this.seenUrgent.delete(t);
    urgentNow.forEach((t) => this.seenUrgent.add(t));
    if (toBlink.length && !this.opts.manualTicks) void this.blink(toBlink, lines);
  }

  /** Pulse brightness a few times to catch the eye, then restore. */
  private async blink(lines: LineName[], rendered: Record<LineName, RenderedLine>): Promise<void> {
    this.blinking = true;
    try {
      for (const level of [1, 4, 1, 4]) {
        await sleep(350);
        for (const l of lines) await this.host.updateText({ id: BOX_ID[l], name: `hud-${l}` }, rendered[l].text, level);
      }
    } finally {
      this.blinking = false;
    }
  }

  // ------------------------------------------------------------ refresh

  private scheduleRefreshes(now: Date): void {
    const t = now.getTime();
    const layout = layoutFor(this.settings, this.mode);
    const visible = new Set<WidgetId>([...layout.top, ...layout.main, ...layout.sub]);

    const run = (key: string, interval: number, job: () => Promise<void>) => {
      if (this.refreshing.has(key) || (this.nextRefresh.get(key) ?? 0) > t) return;
      this.refreshing.add(key);
      job()
        .then(() => this.nextRefresh.set(key, this.now().getTime() + interval))
        .catch((e) => {
          console.warn(`refresh ${key} failed`, e);
          this.nextRefresh.set(key, this.now().getTime() + Math.min(interval, RETRY_AFTER_ERROR_MS));
        })
        .finally(() => {
          this.refreshing.delete(key);
          void this.tick();
        });
    };

    run('location', LOCATION_REFRESH_MS, async () => {
      const loc = await this.host.getLocation();
      if (loc) this.location = loc;
    });
    // The calendar is always loaded: mode selection depends on it.
    run('calendar', CALENDAR_REFRESH_MS, () => this.loadCalendar());
    for (const id of visible) {
      const w = this.widgets.get(id);
      if (w?.refresh && w.refreshMs) run(id, w.refreshMs, () => w.refresh!(this.env(), this.now()));
    }
  }

  async loadCalendar(): Promise<void> {
    const now = this.now();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 2);
    const { icsUrls, corsProxy, manual } = this.settings.calendar;
    const results = await Promise.allSettled(
      icsUrls.filter(Boolean).map(async (url) => {
        const res = await this.fetchFn(corsProxy ? corsProxy + encodeURIComponent(url) : url);
        if (!res.ok) throw new Error(`ICS HTTP ${res.status}`);
        return parseIcs(await res.text(), from, to);
      }),
    );
    const events = parseManualEvents(manual, from, to);
    for (const r of results) if (r.status === 'fulfilled') events.push(...r.value);
    this.events = events.sort((a, b) => a.start.getTime() - b.start.getTime());
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }

  // -------------------------------------------------------------- input

  showToast(text: string): void {
    this.toast = { text, until: this.now().getTime() + TOAST_MS };
  }

  async handleInput(action: InputAction): Promise<void> {
    const now = this.now().getTime();
    switch (action.type) {
      case 'foreground':
        this.foreground = action.active;
        if (action.active) this.sent.clear();
        break;
      case 'click':
        // Context-sensitive primary action.
        if (this.state.hidden) this.state.hidden = false;
        else if (acknowledgePomodoro(this.state, this.settings, now)) this.showToast(
          this.state.pomodoro.phase === 'break' ? '휴식 시작' : '집중 시작',
        );
        else this.cycleMode();
        break;
      case 'doubleClick':
        this.state.hidden = !this.state.hidden;
        break;
      case 'longPress':
        this.completeTodo(now);
        break;
      case 'menu':
        this.handleMenu(action.itemId, now);
        break;
    }
    this.persistState();
    await this.tick();
  }

  private cycleMode(): void {
    this.state.modeOverride = nextOverride(this.state.modeOverride, MODES);
    const m = this.state.modeOverride;
    this.showToast(m ? `화면: ${MODE_LABEL[m]} (고정)` : '화면: 자동');
  }

  private completeTodo(now: number): void {
    const done = completeCurrentTodo(this.state, now);
    this.showToast(done ? `완료: ${done.text}` : '남은 할 일 없음');
  }

  private handleMenu(id: number, now: number): void {
    switch (id) {
      case MenuId.ToggleHidden: this.state.hidden = !this.state.hidden; break;
      case MenuId.CompleteTodo: this.completeTodo(now); break;
      case MenuId.TogglePomodoro:
        togglePomodoro(this.state, this.settings, now);
        this.showToast(this.state.pomodoro.phase === 'focus' ? '집중 시작' : '뽀모도로 정지');
        break;
      case MenuId.ToggleWorkout:
        this.state.workout.startedAt = this.state.workout.startedAt ? null : now;
        this.showToast(this.state.workout.startedAt ? '운동 시작' : '운동 종료');
        break;
      case MenuId.Water:
        this.state.daily.water += 1;
        this.showToast(`물 ${this.state.daily.water}잔`);
        break;
      case MenuId.CycleMode: this.cycleMode(); break;
      case MenuId.Refresh:
        this.nextRefresh.clear();
        this.showToast('새로고침');
        break;
    }
  }
}

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
