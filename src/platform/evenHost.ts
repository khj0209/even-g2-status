import {
  AppLocationAccuracy,
  CreateStartUpPageContainer,
  DeviceConnectType,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import type { DeviceState, InputAction } from '../core/types';
import type { Host, MenuItem, TextBox } from './host';

/** True when running inside the Even App WebView. */
export function isEvenApp(): boolean {
  return typeof window !== 'undefined' && !!(window as any).flutter_inappwebview;
}

export function toInputAction(event: EvenHubEvent): InputAction | null {
  if (event.menuItemClickEvent?.itemID) return { type: 'menu', itemId: event.menuItemClickEvent.itemID };
  const type = event.textEvent?.eventType ?? event.listEvent?.eventType ?? event.sysEvent?.eventType;
  switch (type) {
    case OsEventTypeList.CLICK_EVENT: return { type: 'click' };
    case OsEventTypeList.DOUBLE_CLICK_EVENT: return { type: 'doubleClick' };
    case OsEventTypeList.LONG_PRESS_EVENT: return { type: 'longPress' };
    case OsEventTypeList.FOREGROUND_ENTER_EVENT: return { type: 'foreground', active: true };
    case OsEventTypeList.FOREGROUND_EXIT_EVENT: return { type: 'foreground', active: false };
    default: return null;
  }
}

// The host may deliver the click on the capturing text container *and* as a
// sysEvent. Collapse identical actions arriving within a short window.
const DEDUPE_MS = 150;

export async function createEvenHost(): Promise<Host> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();
  let pageCreated = false;

  return {
    kind: 'glasses',

    async createPage(boxes: TextBox[], menu: MenuItem[]) {
      const fields = {
        containerTotalNum: boxes.length,
        textObject: boxes.map((b, i) => new TextContainerProperty({
          xPosition: b.x,
          yPosition: b.y,
          width: b.width,
          height: b.height,
          borderWidth: 0,
          paddingLength: 4,
          containerID: b.id,
          containerName: b.name,
          zOrderIndex: i + 1,
          content: b.content,
          textColor: b.brightness,
          isEventCapture: b.captureEvents ? 1 : 0,
        })),
        menuObject: menu.length
          ? new MenuContainerProperty({
            menuItems: menu.map((m) => new MenuItemProperty({ itemID: m.id, itemName: m.label })),
          })
          : undefined,
      };
      if (!pageCreated) {
        const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(fields));
        pageCreated = result === StartUpPageCreateResult.success;
        if (!pageCreated) console.error('createStartUpPageContainer failed:', result);
        return pageCreated;
      }
      return bridge.rebuildPageContainer(new RebuildPageContainer(fields));
    },

    updateText(box, content, brightness) {
      return bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: box.id,
        containerName: box.name,
        content,
        ...(brightness !== undefined ? { textColor: brightness } : {}),
      }));
    },

    onInput(cb) {
      let last = { key: '', at: 0 };
      return bridge.onEvenHubEvent((event) => {
        const action = toInputAction(event);
        if (!action) return;
        const key = JSON.stringify(action);
        const now = Date.now();
        if (key === last.key && now - last.at < DEDUPE_MS) return;
        last = { key, at: now };
        cb(action);
      });
    },

    onDevice(cb) {
      return bridge.onDeviceStatusChanged((s) => {
        const state: DeviceState = {
          connected: s.connectType === DeviceConnectType.Connected,
          wearing: s.isWearing ?? null,
          battery: s.batteryLevel ?? null,
          charging: !!s.isCharging,
        };
        cb(state);
      });
    },

    async getLocation() {
      try {
        const loc = await bridge.getAppLocation({ accuracy: AppLocationAccuracy.Medium, timeoutMs: 8000 });
        return loc ? { lat: loc.latitude, lon: loc.longitude } : null;
      } catch {
        return null;
      }
    },

    async load(key) {
      const v = await bridge.getLocalStorage(key);
      return v ? v : null;
    },

    async save(key, value) {
      await bridge.setLocalStorage(key, value);
    },
  };
}
