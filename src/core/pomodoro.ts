import type { AppState } from './state';
import type { Settings } from './settings';

const MIN = 60_000;

export function startFocus(state: AppState, settings: Settings, now: number): void {
  state.pomodoro = { phase: 'focus', endsAt: now + settings.pomodoro.focusMin * MIN, finished: null, finishedAt: 0 };
}

export function startBreak(state: AppState, settings: Settings, now: number): void {
  state.pomodoro = { phase: 'break', endsAt: now + settings.pomodoro.breakMin * MIN, finished: null, finishedAt: 0 };
}

export function stopPomodoro(state: AppState): void {
  state.pomodoro = { phase: 'idle', endsAt: 0, finished: null, finishedAt: 0 };
}

/** Start/stop toggle used by the menu. */
export function togglePomodoro(state: AppState, settings: Settings, now: number): void {
  if (state.pomodoro.phase === 'idle' && !state.pomodoro.finished) startFocus(state, settings, now);
  else stopPomodoro(state);
}

/**
 * Advance the timer. Returns 'focus' / 'break' when that phase just finished
 * (so the caller can alert), otherwise null.
 */
export function tickPomodoro(state: AppState, now: number): 'focus' | 'break' | null {
  const p = state.pomodoro;
  if (p.phase === 'idle' || now < p.endsAt) return null;
  const finished = p.phase;
  if (finished === 'focus') state.daily.pomodoros += 1;
  state.pomodoro = { phase: 'idle', endsAt: 0, finished, finishedAt: now };
  return finished;
}

/**
 * Acknowledge a finished phase: after focus -> start break, after break -> start next focus.
 * Returns false if there was nothing to acknowledge.
 */
export function acknowledgePomodoro(state: AppState, settings: Settings, now: number): boolean {
  const f = state.pomodoro.finished;
  if (!f) return false;
  if (f === 'focus') startBreak(state, settings, now);
  else startFocus(state, settings, now);
  return true;
}

export function remainingMs(state: AppState, now: number): number {
  return Math.max(0, state.pomodoro.endsAt - now);
}
