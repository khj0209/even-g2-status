import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  ImuReportPace,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { pngBytes } from './draw';
import { LAYOUT, type Box } from './layout';
import type { HudSink } from './renderer';

const IMAGE_ORDER = ['speed', 'turn', 'minimap', 'overview'];
const SPEED_ID = LAYOUT.find((b) => b.name === 'speed')!.id;
const imagePriority = (box: Box) => {
  const i = IMAGE_ORDER.indexOf(box.name);
  return i < 0 ? IMAGE_ORDER.length : i;
};

export interface GlassesEvents {
  onDoubleClick(): void;
  /** The glasses page came (back) to the foreground and needs repainting. */
  onResume(): void;
  /** An item of the glasses' menu was chosen (its id from `menu`). */
  onMenu?(itemID: number): void;
  /** One motion-sensor sample, while enabled with setImu(true). */
  onImu?(v: [number, number, number]): void;
}

export interface GlassesMenuItem {
  id: number;
  /** At most 32 bytes of UTF-8. */
  name: string;
}

/**
 * Drives the G2 display through the Even App bridge.
 *
 * The link is slow (an image takes a noticeable fraction of a second) and must not be used
 * concurrently, so updates are queued latest-wins per container and sent one at a time,
 * text before images, and images in order of importance.
 */
export class GlassesSink implements HudSink {
  private layout: Box[] | null = null;
  private texts = new Map<number, { box: Box; content: string; level: number }>();
  private images = new Map<number, { box: Box; image: HTMLCanvasElement }>();
  private created: boolean;
  private pumping = false;
  private disposed = false;
  private unsubscribe: () => void;
  /** Updates sent, for the background diagnostics. */
  sent = { images: 0, texts: 0, failed: 0 };

  constructor(
    private bridge: EvenAppBridge,
    events: GlassesEvents,
    private menu: GlassesMenuItem[] = [],
    /** G2 Status: the status HUD already created the startup page, so rebuild it instead. */
    options: { pageExists?: boolean } = {},
  ) {
    this.created = !!options.pageExists;
    this.unsubscribe = bridge.onEvenHubEvent((e) => {
      if (this.disposed) return;
      if (e.menuItemClickEvent?.itemID != null) {
        events.onMenu?.(e.menuItemClickEvent.itemID);
        return;
      }
      const imu = e.sysEvent?.eventType === OsEventTypeList.IMU_DATA_REPORT ? e.sysEvent.imuData : null;
      if (imu) {
        events.onImu?.([imu.x ?? 0, imu.y ?? 0, imu.z ?? 0]);
        return;
      }
      const ev = e.textEvent ?? e.sysEvent ?? e.listEvent;
      if (!ev) return;
      // The host omits zero-valued fields, so a missing eventType means CLICK_EVENT (0).
      const type = ev.eventType ?? OsEventTypeList.CLICK_EVENT;
      if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) events.onDoubleClick();
      else if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) events.onResume();
    });
  }

  /** Stop listening and sending; the page goes back to its next owner (the status HUD). */
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.texts.clear();
    this.images.clear();
    this.layout = null;
  }

  setLayout(boxes: Box[]): void {
    this.layout = boxes;
    this.texts.clear();
    this.images.clear();
    void this.pump();
  }

  setText(box: Box, content: string, level: number): void {
    this.texts.set(box.id, { box, content, level });
    void this.pump();
  }

  setImage(box: Box, image: HTMLCanvasElement): void {
    this.images.set(box.id, { box, image });
    void this.pump();
  }

  /** Turn the glasses' motion sensor reports on or off. */
  setImu(on: boolean): Promise<boolean> {
    return this.bridge.imuControl(on, ImuReportPace.P100).catch(() => false);
  }

  /** Close the HUD on the glasses, letting the system confirm with the wearer. */
  exit(): void {
    void this.bridge.shutDownPageContainer(1);
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.disposed) break;
        if (this.layout) {
          const boxes = this.layout;
          this.layout = null;
          await this.applyLayout(boxes);
        } else if (this.images.has(SPEED_ID)) {
          // The speed goes ahead of everything else: it changes every second and is what the
          // driver looks for first, so it should never wait behind a text update.
          await this.sendImage(SPEED_ID);
        } else if (this.texts.size) {
          const [id, { box, content, level }] = this.texts.entries().next().value!;
          this.texts.delete(id);
          this.sent.texts++;
          await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({ containerID: box.id, containerName: box.name, content, textColor: level }),
          );
        } else if (this.images.size) {
          // Most important image first, so the speed never waits behind the minimap.
          const [id] = [...this.images].sort(([, a], [, b]) => imagePriority(a.box) - imagePriority(b.box))[0];
          await this.sendImage(id);
        } else break;
      }
    } catch (e) {
      console.error('[glasses]', e);
    } finally {
      this.pumping = false;
    }
  }

  private async sendImage(id: number): Promise<void> {
    const { box, image } = this.images.get(id)!;
    this.images.delete(id);
    const result = await this.bridge.updateImageRawData(
      new ImageRawDataUpdate({ containerID: box.id, containerName: box.name, imageData: await pngBytes(image) }),
    );
    this.sent.images++;
    if (result !== ImageRawDataUpdateResult.success) {
      this.sent.failed++;
      console.warn('[glasses] image', box.name, result);
    }
  }

  private async applyLayout(boxes: Box[]): Promise<void> {
    const base = (b: Box, z: number) => ({
      xPosition: b.x,
      yPosition: b.y,
      width: b.w,
      height: b.h,
      containerID: b.id,
      containerName: b.name,
      zOrderIndex: z,
    });
    const page = {
      containerTotalNum: boxes.length,
      menuObject: this.menu.length
        ? new MenuContainerProperty({
            menuItems: this.menu.map((m) => new MenuItemProperty({ itemID: m.id, itemName: m.name })),
          })
        : undefined,
      textObject: boxes.flatMap((b, z) =>
        b.kind === 'text'
          ? [new TextContainerProperty({ ...base(b, z), content: ' ', isEventCapture: b.capture ? 1 : 0 })]
          : [],
      ),
      imageObject: boxes.flatMap((b, z) => (b.kind === 'image' ? [new ImageContainerProperty(base(b, z))] : [])),
    };
    if (this.created) {
      if (!(await this.bridge.rebuildPageContainer(new RebuildPageContainer(page)))) console.warn('[glasses] rebuild failed');
    } else {
      const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page));
      if (result === StartUpPageCreateResult.success) this.created = true;
      else console.warn('[glasses] create page', result);
    }
  }
}
