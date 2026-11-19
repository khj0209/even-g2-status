import { beforeEach, describe, expect, it } from 'vitest';
import {
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  TextContainerProperty,
  isMenuNameWithinLimit,
  validateEvenHubPageContainer,
} from '@evenrealities/even_hub_sdk';
import { SETTINGS_KEY, STATE_KEY, StatusEngine } from '../src/core/engine';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import type { DeviceState, InputAction } from '../src/core/types';
import { BOX_ID, buildBoxes, MENU, MenuId } from '../src/glasses/layout';
import type { Host, MenuItem, TextBox } from '../src/platform/host';

class FakeHost implements Host {
  kind = 'preview' as const;
  boxes: TextBox[] = [];
  menu: MenuItem[] = [];
  updates: { id: number; content: string; brightness?: number }[] = [];
  storage = new Map<string, string>();
  input?: (a: InputAction) => void;
  device?: (s: DeviceState) => void;

  async createPage(boxes: TextBox[], menu: MenuItem[]) { this.boxes = boxes; this.menu = menu; return true; }
  async updateText(box: { id: number }, content: string, brightness?: number) {
    this.updates.push({ id: box.id, content, brightness });
    return true;
  }
  onInput(cb: (a: InputAction) => void) { this.input = cb; return () => {}; }
  onDevice(cb: (s: DeviceState) => void) { this.device = cb; return () => {}; }
  async getLocation() { return null; }
  async load(k: string) { return this.storage.get(k) ?? null; }
  async save(k: string, v: string) { this.storage.set(k, v); }

  text(id: number) {
    return [...this.updates].reverse().find((u) => u.id === id)?.content;
  }
}

const offline = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;

describe('StatusEngine', () => {
  let host: FakeHost;
  let clock: Date;
  let engine: StatusEngine;

  beforeEach(async () => {
    host = new FakeHost();
    clock = new Date(2026, 10, 19, 14, 32); // Thursday, work hours
    host.storage.set(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, calendar: { ...DEFAULT_SETTINGS.calendar, manual: '2026-11-19 15:00 디자인 리뷰' } }));
    host.storage.set(STATE_KEY, JSON.stringify({ todos: [{ id: '1', text: '보고서 초안', done: false }] }));
    engine = new StatusEngine(host, { now: () => clock, fetch: offline, manualTicks: true });
    await engine.start();
    await engine.loadCalendar();
    await engine.tick();
  });

  it('creates three lines with exactly one event-capturing container', () => {
    expect(host.boxes).toHaveLength(3);
    expect(host.boxes.filter((b) => b.captureEvents)).toHaveLength(1);
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

describe('glasses page definition', () => {
  it('passes the SDK validator and menu limits', () => {
    for (const position of ['top', 'bottom'] as const) {
      const boxes = buildBoxes({ ...DEFAULT_SETTINGS, position });
      for (const b of boxes) {
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.y + b.height).toBeLessThanOrEqual(288);
      }
      const page = new CreateStartUpPageContainer({
        containerTotalNum: boxes.length,
        textObject: boxes.map((b, i) => new TextContainerProperty({
          xPosition: b.x, yPosition: b.y, width: b.width, height: b.height,
          containerID: b.id, containerName: b.name, zOrderIndex: i + 1, content: b.content,
          textColor: b.brightness, isEventCapture: b.captureEvents ? 1 : 0,
        })),
        menuObject: new MenuContainerProperty({ menuItems: MENU.map((m) => new MenuItemProperty({ itemID: m.id, itemName: m.label })) }),
      });
      expect(validateEvenHubPageContainer(page)).toEqual({ valid: true });
      // Sanity check that the validator is not vacuous: duplicate z-order must fail.
      page.textObject!.forEach((t) => (t.zOrderIndex = 1));
      expect(validateEvenHubPageContainer(page)).toMatchObject({ valid: false });
    }
    expect(MENU.length).toBeLessThanOrEqual(10);
    expect(MENU.every((m) => isMenuNameWithinLimit(m.label))).toBe(true);
    expect(new Set(MENU.map((m) => m.id)).size).toBe(MENU.length);
  });
});
