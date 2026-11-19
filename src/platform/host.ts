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
  createPage(boxes: TextBox[], menu: MenuItem[]): Promise<boolean>;
  updateText(box: Pick<TextBox, 'id' | 'name'>, content: string, brightness?: number): Promise<boolean>;
  onInput(cb: (action: InputAction) => void): () => void;
  onDevice(cb: (state: DeviceState) => void): () => void;
  getLocation(): Promise<GeoPoint | null>;
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
}

/** G2 display resolution. */
export const SCREEN = { width: 576, height: 288 } as const;
