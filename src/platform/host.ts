import type { DeviceState, GeoPoint, InputAction } from '../core/types';

export interface TextBox {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
  brightness: number;
  captureEvents: boolean;
  /** Optional panel border: width 0-5, brightness 0-16, corner radius 0-10. */
  border?: { width: number; color: number; radius: number };
  /** Inner padding in px (0-32). */
  padding?: number;
}

/** Image container: up to 288x144, greyscale (host converts to 16 levels). */
export interface ImageBox {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Page {
  texts: TextBox[];
  images: ImageBox[];
}

export interface MenuItem {
  id: number;
  label: string;
}

/**
 * Everything the app needs from its environment. Implemented by the real
 * Even Hub bridge (glasses) and by an in-browser preview for development.
 */
export interface Host {
  readonly kind: 'glasses' | 'preview';
  createPage(page: Page, menu: MenuItem[]): Promise<boolean>;
  updateText(box: Pick<TextBox, 'id' | 'name'>, content: string, brightness?: number): Promise<boolean>;
  /** PNG bytes sized to the container. Never call concurrently. */
  updateImage(box: Pick<ImageBox, 'id' | 'name'>, png: Uint8Array): Promise<boolean>;
  onInput(cb: (action: InputAction) => void): () => void;
  onDevice(cb: (state: DeviceState) => void): () => void;
  getLocation(): Promise<GeoPoint | null>;
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
}

/** G2 display resolution. */
export const SCREEN = { width: 576, height: 288 } as const;
