import type { DeviceState, InputAction } from '../core/types';
import { SCREEN, type Host, type MenuItem, type TextBox } from './host';

const BRIGHTNESS_OPACITY = [0.15, 0.35, 0.55, 0.78, 1];

/**
 * Browser stand-in for the glasses: draws the 576x288 display as a green-on-black
 * panel and offers buttons for tap / double tap / long press / menu items.
 */
export function createPreviewHost(mount: HTMLElement): Host {
  const inputListeners = new Set<(a: InputAction) => void>();
  const deviceListeners = new Set<(s: DeviceState) => void>();
  const elements = new Map<number, HTMLDivElement>();
  let device: DeviceState = { connected: true, wearing: true, battery: 78, charging: false };

  mount.innerHTML = `
    <div class="g2-screen" style="aspect-ratio:${SCREEN.width}/${SCREEN.height}"></div>
    <div class="g2-controls">
      <button data-act="click">탭</button>
      <button data-act="doubleClick">더블탭</button>
      <button data-act="longPress">길게 누르기</button>
      <select class="g2-menu"><option value="">메뉴…</option></select>
      <label>배터리 <input class="g2-batt" type="number" min="0" max="100" value="${device.battery}"></label>
      <label><input class="g2-wear" type="checkbox" checked> 착용중</label>
    </div>`;
  const screen = mount.querySelector<HTMLDivElement>('.g2-screen')!;
  const menuSelect = mount.querySelector<HTMLSelectElement>('.g2-menu')!;
  const emit = (a: InputAction) => inputListeners.forEach((cb) => cb(a));
  const emitDevice = () => deviceListeners.forEach((cb) => cb({ ...device }));

  mount.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((btn) =>
    btn.addEventListener('click', () => emit({ type: btn.dataset.act as 'click' | 'doubleClick' | 'longPress' })),
  );
  menuSelect.addEventListener('change', () => {
    if (menuSelect.value) emit({ type: 'menu', itemId: +menuSelect.value });
    menuSelect.value = '';
  });
  mount.querySelector<HTMLInputElement>('.g2-batt')!.addEventListener('change', (e) => {
    device = { ...device, battery: +(e.target as HTMLInputElement).value };
    emitDevice();
  });
  mount.querySelector<HTMLInputElement>('.g2-wear')!.addEventListener('change', (e) => {
    device = { ...device, wearing: (e.target as HTMLInputElement).checked };
    emitDevice();
  });

  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  return {
    kind: 'preview',
    async createPage(boxes: TextBox[], menu: MenuItem[]) {
      screen.innerHTML = '';
      elements.clear();
      for (const b of boxes) {
        const el = document.createElement('div');
        el.className = 'g2-text';
        Object.assign(el.style, {
          left: pct(b.x, SCREEN.width),
          top: pct(b.y, SCREEN.height),
          width: pct(b.width, SCREEN.width),
          height: pct(b.height, SCREEN.height),
          opacity: String(BRIGHTNESS_OPACITY[b.brightness] ?? 1),
        });
        el.textContent = b.content;
        screen.appendChild(el);
        elements.set(b.id, el);
      }
      menuSelect.innerHTML =
        '<option value="">메뉴…</option>' + menu.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
      return true;
    },
    async updateText(box, content, brightness) {
      const el = elements.get(box.id);
      if (!el) return false;
      el.textContent = content;
      if (brightness !== undefined) el.style.opacity = String(BRIGHTNESS_OPACITY[brightness] ?? 1);
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
