import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { defaultState } from '../src/core/state';
import type { CalendarEvent } from '../src/core/types';
import { batteryWidget, calendarWidget, pmGrade, weatherLabel } from '../src/widgets/basic';
import { ciStateFrom, createDevWidget } from '../src/widgets/dev';
import { focusWidget, progressBar } from '../src/widgets/personal';
import { compactNumber, createTrackerWidget, getPath, parseTrackerItems, streakDays } from '../src/widgets/tracker';
import { createTransitWidget, parseArrivals } from '../src/widgets/transit';
import { clip, type WidgetEnv } from '../src/widgets/widget';

const now = new Date(2026, 10, 19, 14, 32);

function env(patch: Partial<WidgetEnv> = {}): WidgetEnv {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    state: defaultState(now),
    device: { connected: true, wearing: true, battery: 80, charging: false },
    location: null,
    events: [],
    mode: 'default',
    fetch: (() => { throw new Error('no network in tests'); }) as any,
    ...patch,
  };
}

const ev = (title: string, h: number, m: number, dur = 60): CalendarEvent => {
  const start = new Date(2026, 10, 19, h, m);
  return { title, start, end: new Date(start.getTime() + dur * 60_000), allDay: false };
};

describe('calendar widget', () => {
  it('shows the next event with relative time and flags it urgent when close', () => {
    expect(calendarWidget.render(env({ events: [ev('디자인 리뷰', 15, 0)] }), now))
      .toEqual({ text: '15:00 디자인 리뷰 (28분 후)', urgent: false });
    expect(calendarWidget.render(env({ events: [ev('회의', 14, 40)] }), now))
      .toEqual({ text: '14:40 회의 (8분 후)', urgent: true });
  });

  it('shows the ongoing event unless the next one is imminent', () => {
    const events = [ev('집중 블록', 14, 0, 120), ev('1:1', 16, 0)];
    expect(calendarWidget.render(env({ events }), now)!.text).toBe('진행중 집중 블록 ~16:00');
  });

  it('says nothing is left only in default mode', () => {
    expect(calendarWidget.render(env(), now)!.text).toBe('남은 일정 없음');
    expect(calendarWidget.render(env({ mode: 'work' }), now)).toBeNull();
  });
});

describe('focus widget', () => {
  it('shows the first todo and how many remain', () => {
    const e = env();
    e.state.todos = [
      { id: 'a', text: '보고서 초안', done: false },
      { id: 'b', text: 'PR 리뷰', done: false },
    ];
    expect(focusWidget.render(e, now)!.text).toBe('할 일: 보고서 초안 (+1)');
  });

  it('shows pomodoro progress and an urgent prompt when finished', () => {
    const e = env();
    e.state.pomodoro = { phase: 'focus', endsAt: now.getTime() + 10 * 60_000, finished: null, finishedAt: 0 };
    expect(focusWidget.render(e, now)!.text).toBe('> 집중 [#####---] 10분');
    e.state.pomodoro = { phase: 'idle', endsAt: 0, finished: 'focus', finishedAt: 0 };
    expect(focusWidget.render(e, now)).toMatchObject({ urgent: true });
  });

  it('draws progress bars', () => {
    expect(progressBar(0)).toBe('[--------]');
    expect(progressBar(1)).toBe('[########]');
    expect(progressBar(2)).toBe('[########]');
  });
});

describe('battery widget', () => {
  it('flags low battery unless charging', () => {
    expect(batteryWidget.render(env({ device: { connected: true, wearing: true, battery: 12, charging: false } }), now))
      .toEqual({ text: '12%', urgent: true });
    expect(batteryWidget.render(env({ device: { connected: true, wearing: true, battery: 12, charging: true } }), now))
      .toEqual({ text: '+12%', urgent: false });
    expect(batteryWidget.render(env({ device: { connected: false, wearing: null, battery: null, charging: false } }), now))
      .toBeNull();
  });
});

describe('labels', () => {
  it('maps weather codes and PM grades', () => {
    expect(weatherLabel(0)).toBe('맑음');
    expect(weatherLabel(63)).toBe('비');
    expect(weatherLabel(73)).toBe('눈');
    expect(pmGrade(10)).toBe('좋음');
    expect(pmGrade(40)).toBe('나쁨');
    expect(pmGrade(80)).toBe('매우나쁨');
  });

  it('clips by visual width counting Korean as double', () => {
    expect(clip('abcdef', 4)).toBe('abcd…');
    expect(clip('가나다라', 5)).toBe('가나…');
    expect(clip('짧음', 10)).toBe('짧음');
  });
});

describe('tracker', () => {
  it('parses item lines and ignores junk', () => {
    expect(parseTrackerItems('water\nstreak 금연 2026-01-01\ncrypto krw-btc\nfx usd krw\njson 방문자 https://x.io/a data.0.n 명\nbogus')).toEqual([
      { kind: 'water' },
      { kind: 'streak', label: '금연', since: '2026-01-01' },
      { kind: 'crypto', market: 'KRW-BTC' },
      { kind: 'fx', base: 'USD', quote: 'KRW' },
      { kind: 'json', label: '방문자', url: 'https://x.io/a', path: 'data.0.n', suffix: '명' },
    ]);
  });

  it('formats numbers compactly', () => {
    expect(compactNumber(143_250_000)).toBe('1.43억');
    expect(compactNumber(1_380.55)).toBe('1,381');
    expect(compactNumber(25_300)).toBe('2.5만');
    expect(compactNumber(3.14159)).toBe('3.14');
  });

  it('counts streak days inclusively and reads JSON paths', () => {
    expect(streakDays('2026-11-17', now)).toBe(3);
    expect(getPath({ a: [{ b: 5 }] }, 'a.0.b')).toBe(5);
  });

  it('fetches and renders crypto, fx and water', async () => {
    const fakeFetch = async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes('upbit')
          ? [{ trade_price: 143_250_000, change: 'RISE', change_rate: 0.0123 }]
          : { rates: { KRW: 1380.5 } },
    });
    const w = createTrackerWidget();
    const e = env({ fetch: fakeFetch as any });
    e.settings.tracker = 'water\ncrypto KRW-BTC\nfx USD KRW';
    e.state.daily.water = 4;
    await w.refresh!(e, now);
    expect(w.render(e, now)!.text).toBe('물 4잔 · BTC 1.43억 +1.2% · USD 1,381');
  });
});

describe('transit', () => {
  const sample = {
    realtimeArrivalList: [
      { subwayId: '1002', trainLineNm: '성수행 - 역삼방면', barvlDt: '300', arvlMsg2: '5분 후' },
      { subwayId: '1002', trainLineNm: '신도림행 - 교대방면', barvlDt: '60', arvlMsg2: '1분 후' },
      { subwayId: '1002', trainLineNm: '성수행 - 역삼방면', barvlDt: '0', arvlMsg2: '전역 도착' },
    ],
  };

  it('parses, filters by direction and sorts by arrival', () => {
    const list = parseArrivals(sample, '성수', 0);
    expect(list.map((a) => [a.line, a.direction, a.seconds])).toEqual([
      ['2호선', '성수행', 0],
      ['2호선', '성수행', 300],
    ]);
  });

  it('asks for configuration when missing and renders countdowns', async () => {
    const w = createTransitWidget();
    expect(w.render(env(), now)!.text).toContain('폰 설정');
    const e = env({ fetch: (async () => ({ ok: true, json: async () => sample })) as any });
    e.settings.transit = { seoulApiKey: 'k', station: '강남역', directionFilter: '' };
    await w.refresh!(e, now);
    expect(w.render(e, new Date())!.text).toBe('2호선 성수행 전역 도착 / 1분');
  });
});

describe('dev widget', () => {
  it('derives CI state', () => {
    expect(ciStateFrom({ status: 'in_progress' })).toBe('run');
    expect(ciStateFrom({ status: 'completed', conclusion: 'success' })).toBe('ok');
    expect(ciStateFrom({ status: 'completed', conclusion: 'failure' })).toBe('fail');
    expect(ciStateFrom(undefined)).toBeNull();
  });

  it('goes urgent on CI failure or a down server', async () => {
    const fakeFetch = async (url: string) => {
      if (url.includes('actions/runs')) return { ok: true, json: async () => ({ workflow_runs: [{ status: 'completed', conclusion: 'failure' }] }) };
      if (url.includes('search/issues')) return { ok: true, json: async () => ({ total_count: 2 }) };
      if (url.includes('api.example')) return { ok: false, status: 503 };
      return { ok: true };
    };
    const w = createDevWidget();
    const e = env({ fetch: fakeFetch as any });
    e.settings.dev = { githubToken: 't', repo: 'me/app', branch: 'main', healthUrls: ['https://api.example.com/health', 'https://web.ok.com'] };
    await w.refresh!(e, now);
    expect(w.render(e, now)).toEqual({ text: 'CI 실패 리뷰 2 다운 api', urgent: true });
  });
});
