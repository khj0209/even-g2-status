import { remainingMs } from '../core/pomodoro';
import { activeTodos } from '../core/state';
import { clip, type Widget } from './widget';

/** Minutes left, rounded up, so the display changes at most once a minute. */
export function minutesLeft(ms: number): string {
  return `${Math.max(0, Math.ceil(ms / 60_000))}분`;
}

export function progressBar(fraction: number, cells = 8): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * cells);
  return '[' + '#'.repeat(filled) + '-'.repeat(cells - filled) + ']';
}

/** "Only the next thing to do" + pomodoro timer. */
export const focusWidget: Widget = {
  id: 'focus',
  render(env, now) {
    const { state, settings } = env;
    const p = state.pomodoro;
    const todos = activeTodos(state);
    const task = todos[0]?.text;

    if (p.finished === 'focus') return { text: '집중 끝! 탭하면 휴식 시작', urgent: true };
    if (p.finished === 'break') return { text: '휴식 끝! 탭하면 다시 집중', urgent: true };

    const left = remainingMs(state, now.getTime());
    if (p.phase === 'focus') {
      const total = settings.pomodoro.focusMin * 60_000;
      const label = task ? clip(task, 14) : '집중';
      return { text: `> ${label} ${progressBar(1 - left / total)} ${minutesLeft(left)}` };
    }
    if (p.phase === 'break') return { text: `휴식중 ${minutesLeft(left)} 남음` };

    if (!task) return env.mode === 'work' ? { text: '할 일 없음 - 폰에서 추가' } : null;
    const rest = todos.length - 1;
    return { text: `할 일: ${clip(task, 22)}${rest ? ` (+${rest})` : ''}` };
  },
};

export const workoutWidget: Widget = {
  id: 'workout',
  render(env, now) {
    const started = env.state.workout.startedAt;
    if (!started) {
      const ev = env.events.find((e) => e.start <= now && e.end > now);
      return { text: ev ? `${clip(ev.title, 12)} 시간 - 메뉴에서 운동 시작` : '메뉴에서 운동 시작' };
    }
    const min = Math.floor((now.getTime() - started) / 60_000);
    const h = Math.floor(min / 60);
    return { text: `운동 ${h ? `${h}시간 ` : ''}${min % 60}분째` };
  },
};

/** End-of-day summary. */
export const todayWidget: Widget = {
  id: 'today',
  render(env) {
    const d = env.state.daily;
    const parts = [`완료 ${d.todosDone}`];
    if (d.pomodoros) parts.push(`뽀모 ${d.pomodoros}`);
    return { text: parts.join(' · ') };
  },
};
