import { describe, expect, it } from 'vitest';
import { OsEventTypeList } from '@evenrealities/even_hub_sdk';
import { GlassesSink } from '../../src/drive/hud/glasses';
import { LAYOUT } from '../../src/drive/hud/layout';

function fakeBridge() {
  const calls: string[] = [];
  let listener: ((e: any) => void) | null = null;
  const bridge = {
    onEvenHubEvent(fn: (e: any) => void) {
      listener = fn;
      return () => {
        listener = null;
        calls.push('unsubscribed');
      };
    },
    async createStartUpPageContainer() { calls.push('create'); return 0; },
    async rebuildPageContainer() { calls.push('rebuild'); return true; },
    async textContainerUpgrade() { calls.push('text'); return true; },
    async imuControl() { return true; },
  };
  return { bridge: bridge as any, calls, emit: (e: any) => listener?.(e), hasListener: () => !!listener };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Drive HUD glasses handoff', () => {
  it('rebuilds the status HUD page instead of creating a second startup page', async () => {
    const b = fakeBridge();
    const sink = new GlassesSink(b.bridge, { onDoubleClick() {}, onResume() {} }, [], { pageExists: true });
    sink.setLayout(LAYOUT);
    await tick();
    expect(b.calls).toContain('rebuild');
    expect(b.calls).not.toContain('create');
  });

  it('after dispose it stops listening and sending', async () => {
    const b = fakeBridge();
    let doubleClicks = 0;
    const sink = new GlassesSink(b.bridge, { onDoubleClick: () => doubleClicks++, onResume() {} }, [], { pageExists: true });
    b.emit({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } });
    expect(doubleClicks).toBe(1);
    sink.dispose();
    expect(b.calls).toContain('unsubscribed');
    expect(b.hasListener()).toBe(false);
    const before = b.calls.length;
    sink.setText(LAYOUT.find((x) => x.kind === 'text')!, 'x', 4);
    await tick();
    expect(b.calls.length).toBe(before);
  });
});
