import { SCREEN, type Host, type ImageBox, type MenuItem, type Page, type TextBox } from './host';

const pct = (v: number, of: number) => `${(v / of) * 100}%`;

/**
 * DOM rendering of the 576x288 glasses display: text panels (with borders) and
 * image containers, tinted green like the micro-LED. Used by the browser
 * preview and as the phone-side mirror while connected to real glasses.
 */
export interface Screen {
  createPage(page: Page, menu: MenuItem[]): void;
  updateText(id: number, content: string, brightness?: number): void;
  updateImage(id: number, png: Uint8Array): void;
  menu: MenuItem[];
}

const TEXT_OPACITY = [0.18, 0.4, 0.6, 0.8, 1];

export function createScreen(mount: HTMLElement): Screen {
  mount.classList.add('g2-screen');
  mount.style.aspectRatio = `${SCREEN.width}/${SCREEN.height}`;
  const texts = new Map<number, HTMLDivElement>();
  const images = new Map<number, HTMLImageElement>();
  const urls = new Map<number, string>();

  const place = (el: HTMLElement, b: TextBox | ImageBox) =>
    Object.assign(el.style, {
      left: pct(b.x, SCREEN.width),
      top: pct(b.y, SCREEN.height),
      width: pct(b.width, SCREEN.width),
      height: pct(b.height, SCREEN.height),
    });

  const screen: Screen = {
    menu: [],
    createPage(page, menu) {
      mount.innerHTML = '';
      texts.clear();
      images.clear();
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls.clear();
      for (const b of page.images) {
        const img = document.createElement('img');
        img.className = 'g2-image';
        img.alt = '';
        place(img, b);
        mount.appendChild(img);
        images.set(b.id, img);
      }
      for (const b of page.texts) {
        const el = document.createElement('div');
        el.className = 'g2-text';
        place(el, b);
        if (b.border?.width) {
          el.style.border = `${b.border.width}px solid rgba(110, 255, 110, ${0.15 + (b.border.color / 16) * 0.85})`;
          el.style.borderRadius = `${b.border.radius}px`;
        }
        el.style.padding = `0 ${((b.padding ?? 4) / SCREEN.width) * 100}%`;
        el.style.opacity = String(TEXT_OPACITY[b.brightness] ?? 1);
        el.textContent = b.content;
        mount.appendChild(el);
        texts.set(b.id, el);
      }
      screen.menu = menu;
    },
    updateText(id, content, brightness) {
      const el = texts.get(id);
      if (!el) return;
      el.textContent = content;
      if (brightness !== undefined) el.style.opacity = String(TEXT_OPACITY[brightness] ?? 1);
    },
    updateImage(id, png) {
      const img = images.get(id);
      if (!img) return;
      const old = urls.get(id);
      if (old) URL.revokeObjectURL(old);
      const url = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }));
      urls.set(id, url);
      img.src = url;
    },
  };
  return screen;
}

/** Wrap a real host so everything sent to the glasses is mirrored on the phone screen. */
export function mirrorHost(host: Host, screen: Screen): Host {
  return {
    ...host,
    kind: host.kind,
    async createPage(page, menu) {
      screen.createPage(page, menu);
      return host.createPage(page, menu);
    },
    async updateText(box, content, brightness) {
      screen.updateText(box.id, content, brightness);
      return host.updateText(box, content, brightness);
    },
    async updateImage(box, png) {
      screen.updateImage(box.id, png);
      return host.updateImage(box, png);
    },
  };
}
