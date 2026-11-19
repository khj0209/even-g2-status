import type { DeviceState, InputAction } from '../core/types';
import type { Host } from './host';
import type { Screen } from './screen';

/**
 * Browser stand-in for the glasses: renders into a Screen and offers buttons
 * for tap / double tap / long press / menu items and a fake device state.
 */
export function createPreviewHost(screen: Screen, controls: HTMLElement): Host {
  const inputListeners = new Set<(a: InputAction) => void>();
  const deviceListeners = new Set<(s: DeviceState) => void>();
  let device: DeviceState = { connected: true, wearing: true, battery: 78, charging: false };

  controls.innerHTML = `
    <button data-act="click">TAP</button>
    <button data-act="doubleClick">DOUBLE</button>
    <button data-act="longPress">HOLD</button>
    <select class="g2-menu"><option value="">MENU</option></select>
    <label>BAT <input class="g2-batt" type="number" min="0" max="100" value="${device.battery}"></label>
    <label><input class="g2-wear" type="checkbox" checked> WORN</label>`;
  const menuSelect = controls.querySelector<HTMLSelectElement>('.g2-menu')!;
  const emit = (a: InputAction) => inputListeners.forEach((cb) => cb(a));
  const emitDevice = () => deviceListeners.forEach((cb) => cb({ ...device }));

  controls.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((btn) =>
    btn.addEventListener('click', () => emit({ type: btn.dataset.act as 'click' | 'doubleClick' | 'longPress' })),
  );
  menuSelect.addEventListener('change', () => {
    if (menuSelect.value) emit({ type: 'menu', itemId: +menuSelect.value });
    menuSelect.value = '';
  });
  controls.querySelector<HTMLInputElement>('.g2-batt')!.addEventListener('change', (e) => {
    device = { ...device, battery: +(e.target as HTMLInputElement).value };
    emitDevice();
  });
  controls.querySelector<HTMLInputElement>('.g2-wear')!.addEventListener('change', (e) => {
    device = { ...device, wearing: (e.target as HTMLInputElement).checked };
    emitDevice();
  });

  return {
    kind: 'preview',
    async createPage(page, menu) {
      screen.createPage(page, menu);
      menuSelect.innerHTML =
        '<option value="">MENU</option>' + menu.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
      return true;
    },
    async updateText(box, content, brightness) {
      screen.updateText(box.id, content, brightness);
      return true;
    },
    async updateImage(box, png) {
      screen.updateImage(box.id, png);
      return true;
    },
    onInput(cb) {
      inputListeners.add(cb);
      return () => inputListeners.delete(cb);
    },
    onDevice(cb) {
      deviceListeners.add(cb);
      setTimeout(() => cb({ ...device }), 0);
      return () => deviceListeners.delete(cb);
    },
    getLocation: () =>
      new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
          () => resolve(null),
          { timeout: 5000 },
        );
      }),
    async load(key) {
      return localStorage.getItem(key);
    },
    async save(key, value) {
      localStorage.setItem(key, value);
    },
  };
}
