import { fetchJson, type Widget, type WidgetEnv } from './widget';

/**
 * Tracker items, one per line in settings:
 *
 *   water                              오늘 마신 물 (메뉴 "물 +1")
 *   streak 금연 2026-01-01              시작일부터 며칠째
 *   crypto KRW-BTC                     업비트 시세
 *   fx USD KRW                         환율
 *   json 라벨 https://url path.to.value [접미사]   임의 JSON API 값
 */
export type TrackerItem =
  | { kind: 'water' }
  | { kind: 'streak'; label: string; since: string }
  | { kind: 'crypto'; market: string }
  | { kind: 'fx'; base: string; quote: string }
  | { kind: 'json'; label: string; url: string; path: string; suffix: string };

export function parseTrackerItems(text: string): TrackerItem[] {
  const items: TrackerItem[] = [];
  for (const raw of text.split('\n')) {
    const parts = raw.trim().split(/\s+/);
    switch (parts[0]) {
      case 'water': items.push({ kind: 'water' }); break;
      case 'streak':
        if (parts.length >= 3) items.push({ kind: 'streak', label: parts[1], since: parts[2] });
        break;
      case 'crypto':
        if (parts[1]) items.push({ kind: 'crypto', market: parts[1].toUpperCase() });
        break;
      case 'fx':
        if (parts[1] && parts[2]) items.push({ kind: 'fx', base: parts[1].toUpperCase(), quote: parts[2].toUpperCase() });
        break;
      case 'json':
        if (parts.length >= 4) items.push({ kind: 'json', label: parts[1], url: parts[2], path: parts[3], suffix: parts[4] ?? '' });
        break;
    }
  }
  return items;
}

export function getPath(obj: any, path: string): unknown {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[/^\d+$/.test(k) ? +k : k]), obj);
}

export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${+(n / 1e8).toFixed(2)}억`;
  if (abs >= 1e4) return `${+(n / 1e4).toFixed(abs >= 1e6 ? 0 : 1)}만`;
  if (abs >= 100) return Math.round(n).toLocaleString('en-US');
  return String(+n.toFixed(2));
}

export function streakDays(since: string, now: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(since);
  if (!m) return null;
  const start = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today.getTime() - start.getTime()) / 86_400_000) + 1;
}

export function createTrackerWidget(): Widget {
  const values = new Map<string, string>();
  const key = (i: TrackerItem) => JSON.stringify(i);

  async function load(env: WidgetEnv, item: TrackerItem): Promise<void> {
    if (item.kind === 'crypto') {
      const [t] = await fetchJson(env.fetch, `https://api.upbit.com/v1/ticker?markets=${item.market}`);
      const sign = t.change === 'RISE' ? '+' : t.change === 'FALL' ? '-' : '';
      const coin = item.market.split('-')[1] ?? item.market;
      values.set(key(item), `${coin} ${compactNumber(t.trade_price)} ${sign}${(t.change_rate * 100).toFixed(1)}%`);
    } else if (item.kind === 'fx') {
      const j = await fetchJson(env.fetch, `https://open.er-api.com/v6/latest/${item.base}`);
      const rate = j.rates?.[item.quote];
      if (typeof rate === 'number') values.set(key(item), `${item.base} ${compactNumber(rate)}`);
    } else if (item.kind === 'json') {
      const v = getPath(await fetchJson(env.fetch, item.url), item.path);
      if (v !== undefined && v !== null) {
        const text = typeof v === 'number' ? compactNumber(v) : String(v);
        values.set(key(item), `${item.label} ${text}${item.suffix}`);
      }
    }
  }

  return {
    id: 'tracker',
    refreshMs: 5 * 60_000,
    async refresh(env) {
      const results = await Promise.allSettled(parseTrackerItems(env.settings.tracker).map((i) => load(env, i)));
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) throw (failed as PromiseRejectedResult).reason;
    },
    render(env, now) {
      const parts: string[] = [];
      for (const item of parseTrackerItems(env.settings.tracker)) {
        if (item.kind === 'water') parts.push(`물 ${env.state.daily.water}잔`);
        else if (item.kind === 'streak') {
          const d = streakDays(item.since, now);
          if (d !== null) parts.push(`${item.label} ${d}일째`);
        } else {
          const v = values.get(key(item));
          if (v) parts.push(v);
        }
      }
      return parts.length ? { text: parts.join(' · ') } : null;
    },
  };
}
