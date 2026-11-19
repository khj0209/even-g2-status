import { beforeEach, describe, expect, it } from 'vitest';
import {
  CreateStartUpPageContainer,
  isMenuNameWithinLimit,
  validateEvenHubPageContainer,
} from '@evenrealities/even_hub_sdk';
import { SETTINGS_KEY, STATE_KEY, StatusEngine } from '../src/core/engine';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import type { DeviceState, InputAction } from '../src/core/types';
import type { HudRenderer } from '../src/glasses/draw';
import { BOX_ID, buildPage, IMAGE, MENU, MenuId } from '../src/glasses/layout';
import { sdkPageFields } from '../src/platform/evenHost';
import type { Host, MenuItem, Page } from '../src/platform/host';

class FakeHost implements Host {
  kind = 'preview' as const;
  page: Page = { texts: [], images: [] };
  menu: MenuItem[] = [];
  updates: { id: number; content: string; brightness?: number }[] = [];
  images: { id: number; png: string }[] = [];
  imageOk = true;
  storage = new Map<string, string>();
  input?: (a: InputAction) => void;
  device?: (s: DeviceState) => void;

  async createPage(page: Page, menu: MenuItem[]) { this.page = page; this.menu = menu; return true; }
  async updateImage(box: { id: number }, png: Uint8Array) {
    this.images.push({ id: box.id, png: new TextDecoder().decode(png) });
    return this.imageOk;
  }
  async updateText(box: { id: number }, content: string, brightness?: number) {
    this.updates.push({ id: box.id, content, brightness });
    return true;
  }
  onInput(cb: (a: InputAction) => void) { this.input = cb; return () => {}; }
  onDevice(cb: (s: DeviceState) => void) { this.device = cb; return () => {}; }
  async getLocation() { return null; }
  async getSpeed() { return null; }
  async load(k: string) { return this.storage.get(k) ?? null; }
  async save(k: string, v: string) { this.storage.set(k, v); }

  text(id: number) {
    return [...this.updates].reverse().find((u) => u.id === id)?.content;
  }
}

const offline = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;

/** Fake renderer: the "PNG" is the model as JSON, so tests can read what was drawn. */
const fakeRenderer: HudRenderer = {
  gauge: async (m) => new TextEncoder().encode(JSON.stringify({ kind: 'gauge', ...m })),
  timeline: async (m) => new TextEncoder().encode(JSON.stringify({ kind: 'timeline', ...m })),
  blank: async () => new TextEncoder().encode('{"kind":"blank"}'),
};

describe('StatusEngine (classic theme)', () => {
  let host: FakeHost;
  let clock: Date;
  let engine: StatusEngine;

  beforeEach(async () => {
    host = new FakeHost();
    clock = new Date(2026, 10, 19, 14, 32); // Thursday, work hours
    host.storage.set(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, theme: 'classic', calendar: { ...DEFAULT_SETTINGS.calendar, manual: '2026-11-19 15:00 디자인 리뷰' } }));
    host.storage.set(STATE_KEY, JSON.stringify({ todos: [{ id: '1', text: '보고서 초안', done: false }] }));
    engine = new StatusEngine(host, { now: () => clock, fetch: offline, manualTicks: true });
    await engine.start();
    await engine.loadCalendar();
    await engine.tick();
  });

  it('creates three lines with exactly one event-capturing container', () => {
    expect(host.page.texts).toHaveLength(3);
    expect(host.page.images).toHaveLength(0);
    expect(host.page.texts.filter((b) => b.captureEvents)).toHaveLength(1);
    expect(engine.mode).toBe('work');
  });

  it('renders the work layout', () => {
    expect(host.text(BOX_ID.top)).toBe('14:32 목');
    expect(host.text(BOX_ID.main)).toBe('할 일: 보고서 초안');
    expect(host.text(BOX_ID.sub)).toBe('15:00 디자인 리뷰 (28분 후)');
  });

  it('only pushes lines that changed', async () => {
    const before = host.updates.length;
    await engine.tick();
    expect(host.updates.length).toBe(before);
    clock = new Date(2026, 10, 19, 14, 33);
    await engine.tick();
    // clock line + the "27분 후" line changed; the todo line did not.
    expect(host.updates.slice(before).map((u) => u.id).sort()).toEqual([BOX_ID.top, BOX_ID.sub]);
  });

  it('marks an imminent meeting urgent at full brightness', async () => {
    clock = new Date(2026, 10, 19, 14, 52);
    await engine.tick();
    const last = [...host.updates].reverse().find((u) => u.id === BOX_ID.sub)!;
    expect(last).toMatchObject({ content: '15:00 디자인 리뷰 (8분 후)', brightness: 4 });
  });

  it('long press completes the current todo and shows a toast', async () => {
    host.input!({ type: 'longPress' });
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.state.todos[0].done).toBe(true);
    expect(engine.state.daily.todosDone).toBe(1);
    expect(host.text(BOX_ID.main)).toBe('완료: 보고서 초안');
  });

  it('tap cycles the display mode and double tap hides everything', async () => {
    await engine.handleInput({ type: 'click' });
    expect(engine.state.modeOverride).toBe('default');
    expect(engine.mode).toBe('default');
    await engine.handleInput({ type: 'doubleClick' });
    expect(host.text(BOX_ID.top)).toBe(' ');
    await engine.handleInput({ type: 'click' }); // tap while hidden just unhides
    expect(engine.state.hidden).toBe(false);
    expect(engine.state.modeOverride).toBe('default');
  });

  it('pomodoro: menu start, finish alert, tap starts break', async () => {
    await engine.handleInput({ type: 'menu', itemId: MenuId.TogglePomodoro });
    expect(engine.state.pomodoro.phase).toBe('focus');
    clock = new Date(clock.getTime() + 25 * 60_000 + 1000);
    await engine.tick();
    expect(engine.state.daily.pomodoros).toBe(1);
    expect(engine.lastLines!.main).toMatchObject({ text: '집중 끝! 탭하면 휴식 시작', urgent: true, brightness: 4 });
    await engine.handleInput({ type: 'click' });
    expect(engine.state.pomodoro.phase).toBe('break');
  });

  it('stops pushing while the glasses are not worn and redraws on return', async () => {
    host.device!({ connected: true, wearing: false, battery: 50, charging: false });
    await new Promise((r) => setTimeout(r, 0));
    const before = host.updates.length;
    clock = new Date(2026, 10, 19, 14, 40);
    await engine.tick();
    expect(host.updates.length).toBe(before);
    host.device!({ connected: true, wearing: true, battery: 50, charging: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(host.updates.length).toBeGreaterThanOrEqual(before + 3);
  });

  it('persists state across restarts', async () => {
    await engine.handleInput({ type: 'menu', itemId: MenuId.Water });
    await new Promise((r) => setTimeout(r, 600));
    const again = new StatusEngine(host, { now: () => clock, fetch: offline, manualTicks: true });
    await again.start();
    expect(again.state.daily.water).toBe(1);
  });
});

describe('StatusEngine suspend/resume (driving mode)', () => {
  it('stops sending and ignores input while suspended, then rebuilds the page on resume', async () => {
    const host = new FakeHost();
    let clock = new Date(2026, 10, 19, 14, 32);
    let driveRequests = 0;
    const engine = new StatusEngine(host, {
      now: () => clock, fetch: offline, manualTicks: true, renderer: fakeRenderer,
      onDriveRequest: () => driveRequests++,
    });
    await engine.start();
    await engine.handleInput({ type: 'menu', itemId: MenuId.Drive });
    expect(driveRequests).toBe(1);

    engine.suspend();
    const texts = host.updates.length;
    const images = host.images.length;
    const pageBefore = host.page;
    clock = new Date(2026, 10, 19, 14, 40);
    await engine.tick();
    await engine.handleInput({ type: 'menu', itemId: MenuId.Water }); // belongs to the Drive HUD now
    expect(host.updates.length).toBe(texts);
    expect(host.images.length).toBe(images);
    expect(engine.state.daily.water).toBe(0);

    await engine.resume();
    expect(host.page).not.toBe(pageBefore); // page rebuilt
    expect(host.text(BOX_ID.top)).toBe('» WORK');
    expect(host.images.length).toBeGreaterThan(images); // full redraw
  });
});

describe('StatusEngine (HUD theme)', () => {
  let host: FakeHost;
  let clock: Date;
  let engine: StatusEngine;
  const lastImage = (id: number) => {
    const i = [...host.images].reverse().find((x) => x.id === id);
    return i ? JSON.parse(i.png) : undefined;
  };

  beforeEach(async () => {
    host = new FakeHost();
    clock = new Date(2026, 10, 19, 14, 32);
    host.storage.set(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, calendar: { ...DEFAULT_SETTINGS.calendar, manual: '2026-11-19 15:00-16:00 디자인 리뷰' } }));
    host.storage.set(STATE_KEY, JSON.stringify({ todos: [{ id: '1', text: '보고서 초안', done: false }] }));
    engine = new StatusEngine(host, { now: () => clock, fetch: offline, manualTicks: true, renderer: fakeRenderer });
    await engine.start();
    host.device!({ connected: true, wearing: true, battery: 78, charging: false });
    await engine.loadCalendar();
    await engine.tick();
  });

  it('lays out a gauge, a timeline and three panels', () => {
    expect(host.page.images.map((i) => i.id)).toEqual([IMAGE.gauge.id, IMAGE.timeline.id]);
    expect(host.page.texts.filter((t) => t.border)).toHaveLength(2);
    expect(host.text(BOX_ID.top)).toBe('» WORK');
    expect(host.text(BOX_ID.main)).toBe('할 일: 보고서 초안');
  });

  it('draws the gauge and timeline from engine state', () => {
    expect(lastImage(IMAGE.gauge.id)).toMatchObject({ kind: 'gauge', time: '14:32', day: 'THU', label: 'WORK', battery: 0.8, alert: false });
    const tl = lastImage(IMAGE.timeline.id);
    expect(tl).toMatchObject({ kind: 'timeline', startHour: 6, now: (14 - 6) * 60 + 30 });
    expect(tl.events).toEqual([{ from: 9 * 60, to: 10 * 60, next: true, current: false }]);
  });

  it('only resends images whose content changed', async () => {
    const before = host.images.length;
    await engine.tick();
    expect(host.images.length).toBe(before);
    clock = new Date(2026, 10, 19, 14, 33); // gauge changes; timeline is quantised to 5 min
    await engine.tick();
    expect(host.images.slice(before).map((i) => i.id)).toEqual([IMAGE.gauge.id]);
  });

  it('flags an alert on the gauge when a meeting is imminent', async () => {
    clock = new Date(2026, 10, 19, 14, 52);
    await engine.tick();
    expect(lastImage(IMAGE.gauge.id)).toMatchObject({ alert: true });
  });

  it('blanks the images when hidden and restores them after', async () => {
    await engine.handleInput({ type: 'doubleClick' });
    expect(lastImage(IMAGE.gauge.id)).toEqual({ kind: 'blank' });
    expect(lastImage(IMAGE.timeline.id)).toEqual({ kind: 'blank' });
    await engine.handleInput({ type: 'doubleClick' });
    expect(lastImage(IMAGE.gauge.id)).toMatchObject({ kind: 'gauge' });
  });

  it('backs off for a minute after an image fails instead of retrying every tick', async () => {
    host.imageOk = false;
    clock = new Date(2026, 10, 19, 14, 33);
    await engine.tick();
    const afterFail = host.images.length;
    clock = new Date(2026, 10, 19, 14, 33, 30);
    await engine.tick();
    expect(host.images.length).toBe(afterFail);
    host.imageOk = true;
    clock = new Date(2026, 10, 19, 14, 34, 1);
    await engine.tick();
    expect(host.images.length).toBeGreaterThan(afterFail);
  });

  it('switches to the classic theme without images', async () => {
    await engine.applySettings({ ...engine.settings, theme: 'classic' });
    expect(host.page.images).toHaveLength(0);
    expect(host.text(BOX_ID.top)).toBe('14:32 목  78%');
  });
});

describe('glasses page definition', () => {
  it('passes the SDK validator for every theme and position', () => {
    for (const theme of ['hud', 'classic'] as const) {
      for (const position of ['top', 'bottom'] as const) {
        const page = buildPage({ ...DEFAULT_SETTINGS, theme, position });
        for (const b of [...page.texts, ...page.images]) {
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.y).toBeGreaterThanOrEqual(0);
          expect(b.x + b.width).toBeLessThanOrEqual(576);
          expect(b.y + b.height).toBeLessThanOrEqual(288);
        }
        for (const img of page.images) {
          expect(img.width).toBeGreaterThanOrEqual(20);
          expect(img.width).toBeLessThanOrEqual(288);
          expect(img.height).toBeGreaterThanOrEqual(20);
          expect(img.height).toBeLessThanOrEqual(144);
        }
        expect(page.images.length).toBeLessThanOrEqual(4);
        expect(page.texts.length).toBeLessThanOrEqual(8);
        expect([...page.texts].filter((t) => t.captureEvents)).toHaveLength(1);
        for (const t of page.texts) {
          if (t.border) {
            expect(t.border.width).toBeLessThanOrEqual(5);
            expect(t.border.color).toBeLessThanOrEqual(16);
            expect(t.border.radius).toBeLessThanOrEqual(10);
          }
        }
        const sdk = new CreateStartUpPageContainer(sdkPageFields(page, MENU));
        expect(validateEvenHubPageContainer(sdk)).toEqual({ valid: true });
        // Sanity check that the validator is not vacuous: duplicate z-order must fail.
        sdk.textObject!.forEach((t) => (t.zOrderIndex = 1));
        expect(validateEvenHubPageContainer(sdk)).toMatchObject({ valid: false });
      }
    }
    expect(MENU.length).toBeLessThanOrEqual(10);
    expect(MENU.every((m) => isMenuNameWithinLimit(m.label))).toBe(true);
    expect(new Set(MENU.map((m) => m.id)).size).toBe(MENU.length);
  });
});
