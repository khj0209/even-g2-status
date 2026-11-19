import type { Settings } from '../core/settings';
import { LINES, type LineName } from '../core/types';
import { SCREEN, type MenuItem, type TextBox } from '../platform/host';

export const LINE_HEIGHT = 42;
/** Approximate characters per line (CJK = 2). Longer text is clipped with "…". */
export const LINE_WIDTH = 46;

export const BOX_ID: Record<LineName, number> = { top: 1, main: 2, sub: 3 };

export function buildBoxes(settings: Settings): TextBox[] {
  const total = LINE_HEIGHT * LINES.length;
  const y0 = settings.position === 'top' ? 4 : SCREEN.height - total - 4;
  return LINES.map((line, i) => ({
    id: BOX_ID[line],
    name: `hud-${line}`,
    x: 0,
    y: y0 + i * LINE_HEIGHT,
    width: SCREEN.width,
    height: LINE_HEIGHT,
    content: ' ',
    brightness: settings.brightness,
    // Exactly one container must capture input; the top line does.
    captureEvents: i === 0,
  }));
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
