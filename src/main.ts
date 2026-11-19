import './ui/style.css';
import { StatusEngine } from './core/engine';
import { activeTodos, setTodosFromText } from './core/state';
import { MODE_CODE, MODES, type Mode } from './core/types';
import { createCanvasRenderer } from './glasses/draw';
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { App as DriveApp } from './drive/app';
import { DriveController } from './drive/controller';
import { PreviewSink } from './drive/hud/preview';
import { initDriveUi } from './drive/ui';
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

  // Driving mode: the Drive HUD app, embedded. It owns the glasses only while driving.
  // `?demo` in the URL starts its built-in demo drive (handy in the browser).
  const forceDemo = new URLSearchParams(location.search).has('demo');
  const driveApp = new DriveApp(new PreviewSink($<HTMLCanvasElement>('#preview')), forceDemo);
  initDriveUi(driveApp);
  driveApp.start();

  let drive: DriveController | null = null;
  const engine = new StatusEngine(host, {
    renderer: createCanvasRenderer(),
    onDriveRequest: () => void drive?.enter('manual'),
  });
  await engine.start();
  if (isEvenApp()) await driveApp.attachBridge(await waitForEvenAppBridge());

  drive = new DriveController(engine, driveApp, {
    getSpeed: () => host.getSpeed(),
    settings: () => engine.settings.drive,
  });
  drive.startPolling();
  const driveCtl = drive;
  const toggle = $<HTMLButtonElement>('#drive-toggle');
  toggle.addEventListener('click', () => void driveCtl.toggle());
  const syncDrive = () => {
    const on = driveCtl.state !== 'off';
    toggle.setAttribute('aria-pressed', String(on));
    $('#drive-state').textContent = on
      ? `운전 모드 켜짐 (${driveCtl.state === 'auto' ? '자동' : '수동'})`
      : engine.settings.drive.auto ? `운전 모드 꺼짐 · ${engine.settings.drive.autoKmh} km/h 이상이면 자동 시작` : '운전 모드 꺼짐';
    $('#screen').hidden = on;
    $('#preview').hidden = !on;
    $('#map-status').hidden = !on;
    if (on) $('#mode-label').textContent = 'DRIVE';
  };
  driveCtl.subscribe(syncDrive);

  const auto = $<HTMLInputElement>('#drive-auto');
  const autoKmh = $<HTMLInputElement>('#drive-auto-kmh');
  auto.checked = engine.settings.drive.auto;
  autoKmh.value = String(engine.settings.drive.autoKmh);
  const saveDrive = () => {
    const kmh = Math.min(80, Math.max(5, Math.round(Number(autoKmh.value) || engine.settings.drive.autoKmh)));
    autoKmh.value = String(kmh);
    void engine.applySettings({ ...engine.settings, drive: { auto: auto.checked, autoKmh: kmh } }).then(syncDrive);
  };
  auto.addEventListener('change', saveDrive);
  autoKmh.addEventListener('change', saveDrive);
  syncDrive();

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
    modeLabel.textContent = engine.isSuspended
      ? 'DRIVE'
      : `${MODE_CODE[engine.mode]} · ${pinned ? 'LOCK' : 'AUTO'}${engine.state.hidden ? ' · HIDDEN' : ''}`;
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
