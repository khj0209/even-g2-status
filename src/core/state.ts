import type { Mode } from './types';

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  doneAt?: number;
}

export interface Pomodoro {
  phase: 'idle' | 'focus' | 'break';
  endsAt: number;
  /** Set when a phase ended and the user hasn't acknowledged it yet. */
  finished: 'focus' | 'break' | null;
  finishedAt: number;
}

/** Persistent, user-driven state (as opposed to fetched data, which lives in widgets). */
export interface AppState {
  todos: Todo[];
  pomodoro: Pomodoro;
  workout: { startedAt: number | null };
  /** null = automatic mode selection. */
  modeOverride: Mode | null;
  hidden: boolean;
  /** Per-day counters, reset when `date` changes. */
  daily: { date: string; water: number; pomodoros: number; todosDone: number };
}

export function todayKey(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function defaultState(now = new Date()): AppState {
  return {
    todos: [],
    pomodoro: { phase: 'idle', endsAt: 0, finished: null, finishedAt: 0 },
    workout: { startedAt: null },
    modeOverride: null,
    hidden: false,
    daily: { date: todayKey(now), water: 0, pomodoros: 0, todosDone: 0 },
  };
}

export function mergeState(stored: unknown, now = new Date()): AppState {
  const base = defaultState(now);
  if (!stored || typeof stored !== 'object') return base;
  const s = stored as Partial<AppState>;
  const merged: AppState = {
    ...base,
    ...s,
    pomodoro: { ...base.pomodoro, ...s.pomodoro },
    workout: { ...base.workout, ...s.workout },
    daily: { ...base.daily, ...s.daily },
    todos: Array.isArray(s.todos) ? s.todos : [],
  };
  rollDaily(merged, now);
  return merged;
}

/** Reset per-day counters on date change. Returns true if anything changed. */
export function rollDaily(state: AppState, now: Date): boolean {
  const key = todayKey(now);
  if (state.daily.date === key) return false;
  state.daily = { date: key, water: 0, pomodoros: 0, todosDone: 0 };
  // Completed todos from previous days are cleared out.
  state.todos = state.todos.filter((t) => !t.done);
  return true;
}

export function activeTodos(state: AppState): Todo[] {
  return state.todos.filter((t) => !t.done);
}

/** Replace the todo list from settings-page text (one per line), keeping done-state of existing items. */
export function setTodosFromText(state: AppState, text: string): void {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const existing = new Map(state.todos.filter((t) => !t.done).map((t) => [t.text, t]));
  const kept = state.todos.filter((t) => t.done);
  state.todos = [
    ...lines.map((line) => existing.get(line) ?? { id: Math.random().toString(36).slice(2, 10), text: line, done: false }),
    ...kept,
  ];
}

export function completeCurrentTodo(state: AppState, now: number): Todo | null {
  const todo = activeTodos(state)[0];
  if (!todo) return null;
  todo.done = true;
  todo.doneAt = now;
  state.daily.todosDone += 1;
  return todo;
}
