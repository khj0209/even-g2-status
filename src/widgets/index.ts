import type { WidgetId } from '../core/types';
import { batteryWidget, calendarWidget, clockWidget, createAirWidget, createWeatherWidget, modeWidget, tomorrowWidget } from './basic';
import { createDevWidget } from './dev';
import { focusWidget, todayWidget, workoutWidget } from './personal';
import { createTrackerWidget } from './tracker';
import { createTransitWidget } from './transit';
import type { Widget } from './widget';

export function createWidgets(): Map<WidgetId, Widget> {
  const list: Widget[] = [
    modeWidget,
    clockWidget,
    createWeatherWidget(),
    createAirWidget(),
    batteryWidget,
    calendarWidget,
    tomorrowWidget,
    focusWidget,
    createDevWidget(),
    createTransitWidget(),
    createTrackerWidget(),
    workoutWidget,
    todayWidget,
  ];
  return new Map(list.map((w) => [w.id, w]));
}

export const WIDGET_LABEL: Record<WidgetId, string> = {
  mode: '모드 표시 (HUD)',
  clock: '시계',
  weather: '날씨',
  air: '미세먼지',
  battery: '글래스 배터리',
  calendar: '다음 일정',
  tomorrow: '내일 첫 일정',
  focus: '할 일 + 뽀모도로',
  dev: '개발 상태',
  transit: '지하철 도착',
  tracker: '숫자 트래커',
  workout: '운동 타이머',
  today: '오늘 요약',
};
