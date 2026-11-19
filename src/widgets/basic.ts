import { MODE_CODE } from '../core/types';
import { fetchJson, hhmm, clip, relMinutes, type Widget } from './widget';

const KO_WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

/** HUD status code: "» WORK", plus "LOCK" when the mode is pinned by hand. */
export const modeWidget: Widget = {
  id: 'mode',
  render: (env) => ({ text: `» ${MODE_CODE[env.mode]}${env.state.modeOverride ? ' LOCK' : ''}` }),
};

export const clockWidget: Widget = {
  id: 'clock',
  render: (_env, now) => ({ text: `${hhmm(now)} ${KO_WEEKDAY[now.getDay()]}` }),
};

/** WMO weather codes -> short Korean label. */
export function weatherLabel(code: number): string {
  if (code === 0) return '맑음';
  if (code <= 2) return '구름조금';
  if (code === 3) return '흐림';
  if (code === 45 || code === 48) return '안개';
  if (code >= 51 && code <= 57) return '이슬비';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return '비';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '눈';
  if (code >= 95) return '뇌우';
  return '';
}

export function createWeatherWidget(): Widget {
  let data: { temp: number; code: number; pop: number } | null = null;
  return {
    id: 'weather',
    refreshMs: 30 * 60_000,
    async refresh(env) {
      const loc = env.location ?? env.settings.fallbackLocation;
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat.toFixed(3)}&longitude=${loc.lon.toFixed(3)}` +
        `&current=temperature_2m,weather_code&hourly=precipitation_probability&forecast_hours=3&timezone=auto`;
      const j = await fetchJson(env.fetch, url);
      const pops: number[] = j.hourly?.precipitation_probability ?? [];
      data = { temp: j.current.temperature_2m, code: j.current.weather_code, pop: Math.max(0, ...pops) };
    },
    render() {
      if (!data) return null;
      const rain = data.pop >= 60 && weatherLabel(data.code) !== '비' ? ` 우산${data.pop}%` : '';
      return { text: `${Math.round(data.temp)}° ${weatherLabel(data.code)}${rain}`.trim() };
    },
  };
}

/** Korean (환경부) PM grade thresholds. */
export function pmGrade(pm25: number): '좋음' | '보통' | '나쁨' | '매우나쁨' {
  if (pm25 <= 15) return '좋음';
  if (pm25 <= 35) return '보통';
  if (pm25 <= 75) return '나쁨';
  return '매우나쁨';
}

export function createAirWidget(): Widget {
  let data: { pm10: number; pm25: number } | null = null;
  return {
    id: 'air',
    refreshMs: 60 * 60_000,
    async refresh(env) {
      const loc = env.location ?? env.settings.fallbackLocation;
      const url =
        `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${loc.lat.toFixed(3)}` +
        `&longitude=${loc.lon.toFixed(3)}&current=pm10,pm2_5`;
      const j = await fetchJson(env.fetch, url);
      data = { pm10: j.current.pm10, pm25: j.current.pm2_5 };
    },
    render() {
      if (!data) return null;
      const grade = pmGrade(data.pm25);
      return { text: `초미세 ${Math.round(data.pm25)} ${grade}`, urgent: grade === '매우나쁨' };
    },
  };
}

export const batteryWidget: Widget = {
  id: 'battery',
  render(env) {
    const { battery, charging, connected } = env.device;
    if (!connected || battery === null) return null;
    const low = battery <= 15 && !charging;
    return { text: `${charging ? '+' : ''}${battery}%`, urgent: low };
  },
};

/** Next/ongoing timed event today. */
export const calendarWidget: Widget = {
  id: 'calendar',
  render(env, now) {
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timed = env.events.filter((e) => !e.allDay && e.end > now && e.start < endOfDay);
    const current = timed.find((e) => e.start <= now);
    const next = timed.find((e) => e.start > now);
    const alertMin = env.settings.calendar.alertMinutes;

    if (next) {
      const min = Math.round((next.start.getTime() - now.getTime()) / 60_000);
      // Upcoming soon beats "currently in" — that's the thing you need to act on.
      if (!current || min <= alertMin) {
        return { text: `${hhmm(next.start)} ${clip(next.title, 18)} (${relMinutes(min)})`, urgent: min <= alertMin };
      }
    }
    if (current) return { text: `진행중 ${clip(current.title, 18)} ~${hhmm(current.end)}` };
    const allDay = env.events.find((e) => e.allDay && e.start <= now && e.end > now);
    if (allDay) return { text: `오늘: ${clip(allDay.title, 22)}` };
    return env.mode === 'default' ? { text: '남은 일정 없음' } : null;
  },
};

/** First event tomorrow (used in the evening). */
export const tomorrowWidget: Widget = {
  id: 'tomorrow',
  render(env, now) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
    const ev = env.events.find((e) => !e.allDay && e.start >= start && e.start < end);
    return ev ? { text: `내일 ${hhmm(ev.start)} ${clip(ev.title, 20)}` } : { text: '내일 일정 없음' };
  },
};
