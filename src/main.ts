import './ui/style.css';
import { StatusEngine } from './core/engine';
import { activeTodos, setTodosFromText } from './core/state';
import { MODE_CODE, MODES, type Mode } from './core/types';
import { createCanvasRenderer } from './glasses/draw';
import { createEvenHost, isEvenApp } from './platform/evenHost';
import type { Host } from './platform/host';
import { createPreviewHost } from './platform/previewHost';
import { createScreen, mirrorHost } from './platform/screen';
import { fillForm, readForm } from './ui/settingsForm';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

async function main(): Promise<void> {
  // The phone shows the same 576x288 page the glasses get (mirror), or a simulator.
  const screen = createScreen($('#screen'));
  let host: Host;
  const link = $('#host-kind');
  if (isEvenApp()) {
    host = mirrorHost(await createEvenHost(), screen);
    link.querySelector('b')!.textContent = 'G2 LINK ONLINE';
  } else {
    const controls = $('#preview-controls');
    controls.hidden = false;
    host = createPreviewHost(screen, controls);
    link.classList.add('sim');
    link.querySelector('b')!.textContent = 'SIMULATION';
  }

  const engine = new StatusEngine(host, { renderer: createCanvasRenderer() });
  await engine.start();

  // Mode chips: AUTO + each mode; selecting one pins it (same as tapping the glasses).
  const modes = $('#modes');
  const chip = (label: string, value: Mode | null) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.textContent = label;
    b.addEventListener('click', () => void engine.mutate((s) => (s.modeOverride = value)));
    modes.appendChild(b);
    return [b, value] as const;
  };
  const chips = [chip('AUTO', null), ...MODES.map((m) => chip(MODE_CODE[m], m))];

  document.querySelectorAll<HTMLButtonElement>('[data-menu]').forEach((b) =>
    b.addEventListener('click', () => void engine.handleInput({ type: 'menu', itemId: +b.dataset.menu! })),
  );

  const modeLabel = $('#mode-label');
  engine.subscribe(() => {
    const pinned = engine.state.modeOverride;
    modeLabel.textContent = `${MODE_CODE[engine.mode]} · ${pinned ? 'LOCK' : 'AUTO'}${engine.state.hidden ? ' · HIDDEN' : ''}`;
    for (const [b, value] of chips) b.setAttribute('aria-checked', String(value === pinned));
  });

  // Todos
  const todos = $<HTMLTextAreaElement>('#todos');
  todos.value = activeTodos(engine.state).map((t) => t.text).join('\n');
  $('#save-todos').addEventListener('click', () => {
    void engine.mutate((s) => setTodosFromText(s, todos.value));
  });
  // Keep the textarea in sync when todos are completed from the glasses (unless the user is editing).
  engine.subscribe(() => {
    if (document.activeElement === todos) return;
    const text = activeTodos(engine.state).map((t) => t.text).join('\n');
    if (todos.value !== text) todos.value = text;
  });

  // Settings
  const form = $<HTMLFormElement>('#settings');
  const status = $('#save-status');
  fillForm(form, engine.settings);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const next = readForm(form, engine.settings);
      await engine.applySettings(next);
      fillForm(form, next);
      status.textContent = '저장됨';
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
    }
    setTimeout(() => (status.textContent = ''), 3000);
  });
}

main().catch((e) => {
  console.error(e);
  const pre = document.createElement('pre');
  pre.className = 'card';
  pre.textContent = `시작 실패: ${String(e)}`;
  document.body.prepend(pre);
});
