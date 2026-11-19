import './ui/style.css';
import { StatusEngine } from './core/engine';
import { togglePomodoro } from './core/pomodoro';
import { activeTodos, setTodosFromText } from './core/state';
import { LINES, MODE_LABEL } from './core/types';
import { createEvenHost, isEvenApp } from './platform/evenHost';
import type { Host } from './platform/host';
import { createPreviewHost } from './platform/previewHost';
import { fillForm, readForm } from './ui/settingsForm';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

async function main(): Promise<void> {
  let host: Host;
  if (isEvenApp()) {
    host = await createEvenHost();
  } else {
    const preview = $('#preview');
    preview.hidden = false;
    host = createPreviewHost(preview);
  }
  $('#host-kind').textContent = host.kind === 'glasses' ? 'G2 연결됨' : '브라우저 미리보기';

  const engine = new StatusEngine(host);
  await engine.start();

  // Live mirror of the HUD lines on the phone.
  const live = $('#live');
  const modeLabel = $('#mode-label');
  engine.subscribe(() => {
    const l = engine.lastLines;
    if (!l) return;
    live.innerHTML = '';
    for (const line of LINES) {
      const div = document.createElement('div');
      div.textContent = l[line].text;
      div.style.opacity = String(0.35 + l[line].brightness * 0.16);
      live.appendChild(div);
    }
    const auto = engine.state.modeOverride ? '고정' : '자동';
    modeLabel.textContent = `${MODE_LABEL[engine.mode]} · ${auto}${engine.state.hidden ? ' · 숨김' : ''}`;
  });

  // Todos
  const todos = $<HTMLTextAreaElement>('#todos');
  todos.value = activeTodos(engine.state).map((t) => t.text).join('\n');
  $('#save-todos').addEventListener('click', () => {
    void engine.mutate((s) => setTodosFromText(s, todos.value));
  });
  $('#pomodoro').addEventListener('click', () => {
    void engine.mutate((s) => togglePomodoro(s, engine.settings, Date.now()));
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
