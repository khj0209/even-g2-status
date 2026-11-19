import type { Settings } from '../core/settings';
import { LINES, type LineName } from '../core/types';
import { SCREEN, type ImageBox, type MenuItem, type Page, type TextBox } from '../platform/host';

export const BOX_ID: Record<LineName, number> = { top: 1, main: 2, sub: 3 };
export const BOX_NAME: Record<LineName, string> = { top: 'hud-top', main: 'hud-main', sub: 'hud-sub' };

export const IMAGE = {
  gauge: { id: 10, name: 'hud-gauge' },
  timeline: { id: 11, name: 'hud-timeline' },
} as const;
export type ImageName = keyof typeof IMAGE;

/** Approximate characters per line (CJK = 2). Longer text is clipped with "..". */
export function lineWidth(settings: Settings): number {
  return settings.theme === 'hud' ? 34 : 46;
}

// ---------------------------------------------------------------- classic

const CLASSIC_LINE_HEIGHT = 42;

function classicPage(settings: Settings): Page {
  const total = CLASSIC_LINE_HEIGHT * LINES.length;
  const y0 = settings.position === 'top' ? 4 : SCREEN.height - total - 4;
  return {
    texts: LINES.map((line, i) => ({
      id: BOX_ID[line],
      name: BOX_NAME[line],
      x: 0,
      y: y0 + i * CLASSIC_LINE_HEIGHT,
      width: SCREEN.width,
      height: CLASSIC_LINE_HEIGHT,
      content: ' ',
      brightness: settings.brightness,
      captureEvents: i === 0, // exactly one container must capture input
    })),
    images: [],
  };
}

// -------------------------------------------------------------------- hud

/**
 * HUD theme, laid out in a 158px band so the centre of the view stays clear:
 *
 *   ┌gauge─┐  » WORK · 12° 맑음            (status line, no border)
 *   │ 14:32│ ╭──────────────────────────╮
 *   │ THU  │ │ main panel               │
 *   └──────┘ ╰──────────────────────────╯
 *            ╭──────────────────────────╮
 *            │ sub panel                │
 *            ╰──────────────────────────╯
 *            ▁▁▁█▁▁▁▁|▁▁▁██▁▁▁▁  timeline
 */
export const HUD = {
  band: 158,
  gauge: { x: 0, y: 6, width: 132, height: 132 },
  panelX: 142,
  status: { y: 0, height: 36 },
  main: { y: 38, height: 46 },
  sub: { y: 88, height: 44 },
  timeline: { y: 136, height: 20, width: 288 },
} as const;

function hudPage(settings: Settings): Page {
  const y0 = settings.position === 'top' ? 0 : SCREEN.height - HUD.band;
  const panelWidth = SCREEN.width - HUD.panelX;
  const text = (line: LineName, box: { y: number; height: number }, extra: Partial<TextBox>): TextBox => ({
    id: BOX_ID[line],
    name: BOX_NAME[line],
    x: HUD.panelX,
    y: y0 + box.y,
    width: panelWidth,
    height: box.height,
    content: ' ',
    brightness: settings.brightness,
    captureEvents: false,
    padding: 6,
    ...extra,
  });
  const texts = [
    text('top', HUD.status, { captureEvents: true, padding: 4 }),
    text('main', HUD.main, { border: { width: 1, color: 8, radius: 6 } }),
    text('sub', HUD.sub, { border: { width: 1, color: 5, radius: 6 } }),
  ];
  const images: ImageBox[] = [
    { ...IMAGE.gauge, x: HUD.gauge.x, y: y0 + HUD.gauge.y, width: HUD.gauge.width, height: HUD.gauge.height },
    { ...IMAGE.timeline, x: HUD.panelX + 4, y: y0 + HUD.timeline.y, width: HUD.timeline.width, height: HUD.timeline.height },
  ];
  return { texts, images };
}

export function buildPage(settings: Settings): Page {
  return settings.theme === 'hud' ? hudPage(settings) : classicPage(settings);
}

export enum MenuId {
  ToggleHidden = 1,
  CompleteTodo = 2,
  TogglePomodoro = 3,
  ToggleWorkout = 4,
  Water = 5,
  CycleMode = 6,
  Refresh = 7,
}

/** Menu labels must be <= 32 UTF-8 bytes (Korean = 3 bytes/char). */
export const MENU: MenuItem[] = [
  { id: MenuId.TogglePomodoro, label: '뽀모도로 시작/정지' },
  { id: MenuId.CompleteTodo, label: '할 일 완료' },
  { id: MenuId.Water, label: '물 한 잔 +1' },
  { id: MenuId.ToggleWorkout, label: '운동 시작/종료' },
  { id: MenuId.CycleMode, label: '화면 모드 전환' },
  { id: MenuId.ToggleHidden, label: '화면 숨기기/보이기' },
  { id: MenuId.Refresh, label: '지금 새로고침' },
];
