import type { HudRenderer } from '../glasses/draw';
import { BOX_ID, BOX_NAME, buildPage, IMAGE, lineWidth, MENU, MenuId } from '../glasses/layout';
import { gaugeModel, modelKey, timelineModel } from '../glasses/visuals';
import type { Host, ImageBox, Page } from '../platform/host';
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
  /** Draws HUD-theme images. Without it the HUD theme shows its text panels only. */
  renderer?: HudRenderer;
  /** The wearer chose "운전 모드" in the glasses menu. */
  onDriveRequest?: () => void;
}

const IMAGE_RETRY_MS = 60_000;

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
  /** Last model key sent per image container (images are expensive: ~100ms each over BLE). */
  private sentImages = new Map<number, string>();
  private imageRetryAt = 0;
  private page: Page = { texts: [], images: [] };
  private nextRefresh = new Map<string, number>();
  private refreshing = new Set<string>();
  private seenUrgent = new Set<string>();
  private toast: { text: string; until: number } | null = null;
  private foreground = true;
  /** Another screen (driving mode) owns the glasses; keep state ticking but send nothing. */
  private suspended = false;
  private blinking = false;
  private pushing: Promise<void> | null = null;
  private pendingLines: Record<LineName, RenderedLine> | null = null;
  private pendingNow = new Date(0);
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
        if (!wasActive && this.isActive()) this.forceRedraw();
        void this.tick();
      }),
    );
    await this.createPage();
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
    return !this.suspended && this.foreground && this.device.wearing !== false;
  }

  /** Glasses are worn (or unknown) and the app is in the foreground, regardless of who draws. */
  isWorn(): boolean {
    return this.foreground && this.device.wearing !== false;
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  /** Hand the glasses to another screen (driving mode). Pomodoro etc. keep running. */
  suspend(): void {
    this.suspended = true;
  }

  /** Take the glasses back: rebuild our page and redraw everything. */
  async resume(): Promise<void> {
    if (!this.suspended) return;
    this.suspended = false;
    await this.createPage();
    await this.tick();
  }

  async applySettings(settings: Settings): Promise<void> {
    const relayout = settings.position !== this.settings.position || settings.theme !== this.settings.theme;
    this.settings = settings;
    await this.host.save(SETTINGS_KEY, JSON.stringify(settings));
    this.nextRefresh.clear(); // refetch with new config
    if (relayout) await this.createPage();
    this.forceRedraw();
    await this.tick();
  }

  private async createPage(): Promise<void> {
    this.page = buildPage(this.settings);
    await this.host.createPage(this.page, MENU);
    this.forceRedraw();
  }

  /** Resend everything on the next push (after a relayout or coming back to the foreground). */
  private forceRedraw(): void {
    this.sent.clear();
    this.sentImages.clear();
    this.imageRetryAt = 0;
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
    if (this.isActive() && !this.blinking) await this.enqueuePush(lines, now);
  }

  /** Serialise pushes: BLE writes must not interleave; only the newest pending frame is sent. */
  private async enqueuePush(lines: Record<LineName, RenderedLine>, now: Date): Promise<void> {
    this.pendingLines = lines;
    this.pendingNow = now;
    if (this.pushing) return this.pushing;
    this.pushing = (async () => {
      try {
        while (this.pendingLines) {
          const next = this.pendingLines;
          this.pendingLines = null;
          await this.push(next, this.pendingNow);
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
    const width = lineWidth(this.settings);

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
      out[line] = { text: clip(parts.join(this.settings.theme === 'hud' ? ' · ' : '  '), width) || ' ', brightness: urgent ? 4 : normal, urgent };
    }

    if (this.toast && this.toast.until > now.getTime()) {
      out.main = { text: clip(this.toast.text, width), brightness: 4, urgent: false };
    } else {
      this.toast = null;
    }
    return out;
  }

  private async push(lines: Record<LineName, RenderedLine>, now: Date): Promise<void> {
    const toBlink: LineName[] = [];
    for (const line of LINES) {
      const l = lines[line];
      const id = BOX_ID[line];
      const prev = this.sent.get(id);
      if (prev && prev.text === l.text && prev.brightness === l.brightness) continue;
      const ok = await this.host.updateText({ id, name: BOX_NAME[line] }, l.text, l.brightness);
      if (ok) this.sent.set(id, { text: l.text, brightness: l.brightness });
      if (l.urgent && !this.seenUrgent.has(l.text)) toBlink.push(line);
    }
    // Remember which urgent texts were already announced; forget ones no longer shown.
    const urgentNow = new Set(LINES.filter((l) => lines[l].urgent).map((l) => lines[l].text));
    for (const t of this.seenUrgent) if (!urgentNow.has(t)) this.seenUrgent.delete(t);
    urgentNow.forEach((t) => this.seenUrgent.add(t));
    if (toBlink.length && !this.opts.manualTicks) void this.blink(toBlink, lines);
    await this.pushImages(lines, now);
  }

  /** Redraw and send HUD images whose content changed. Never concurrent (called inside push). */
  private async pushImages(lines: Record<LineName, RenderedLine>, now: Date): Promise<void> {
    const r = this.opts.renderer;
    if (!r || !this.page.images.length || now.getTime() < this.imageRetryAt) return;
    const alert = LINES.some((l) => lines[l].urgent);
    for (const img of this.page.images) {
      let key: string;
      let draw: () => Promise<Uint8Array>;
      if (this.state.hidden) {
        key = 'blank';
        draw = () => r.blank(img.width, img.height);
      } else if (img.id === IMAGE.gauge.id) {
        const m = gaugeModel({ now, state: this.state, settings: this.settings, device: this.device, mode: this.mode, alert });
        key = modelKey(m);
        draw = () => r.gauge(m, img.width, img.height);
      } else {
        const m = timelineModel(now, this.events);
        key = modelKey(m);
        draw = () => r.timeline(m, img.width, img.height);
      }
      if (this.sentImages.get(img.id) === key) continue;
      if (!(await this.sendImage(img, draw))) {
        // Don't hammer the BLE link with a broken image; try again in a minute.
        this.imageRetryAt = now.getTime() + IMAGE_RETRY_MS;
        return;
      }
      this.sentImages.set(img.id, key);
    }
  }

  private async sendImage(img: ImageBox, draw: () => Promise<Uint8Array>): Promise<boolean> {
    try {
      return await this.host.updateImage(img, await draw());
    } catch (e) {
      console.warn(`image ${img.name} failed`, e);
      return false;
    }
  }

  /** Pulse brightness a few times to catch the eye, then restore. */
  private async blink(lines: LineName[], rendered: Record<LineName, RenderedLine>): Promise<void> {
    this.blinking = true;
    try {
      for (const level of [1, 4, 1, 4]) {
        await sleep(350);
        for (const l of lines) await this.host.updateText({ id: BOX_ID[l], name: BOX_NAME[l] }, rendered[l].text, level);
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
    // While driving mode owns the glasses, its own handler gets the input.
    if (this.suspended && action.type !== 'foreground') return;
    const now = this.now().getTime();
    switch (action.type) {
      case 'foreground':
        this.foreground = action.active;
        if (action.active) this.forceRedraw();
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
      case MenuId.Drive:
        this.opts.onDriveRequest?.();
        break;
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
