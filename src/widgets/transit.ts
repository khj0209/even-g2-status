import { fetchJson, clip, type Widget } from './widget';

interface Arrival {
  line: string;
  direction: string;
  /** Seconds until arrival at the time of the fetch. */
  seconds: number;
  message: string;
  fetchedAt: number;
}

const SUBWAY_LINES: Record<string, string> = {
  '1001': '1호선', '1002': '2호선', '1003': '3호선', '1004': '4호선', '1005': '5호선',
  '1006': '6호선', '1007': '7호선', '1008': '8호선', '1009': '9호선',
  '1063': '경의중앙', '1065': '공항철도', '1067': '경춘', '1075': '수인분당', '1077': '신분당',
  '1092': '우이신설', '1032': 'GTX-A',
};

export function parseArrivals(json: any, filter: string, fetchedAt: number): Arrival[] {
  const list: any[] = json?.realtimeArrivalList ?? [];
  return list
    .map((a) => ({
      line: SUBWAY_LINES[a.subwayId] ?? '',
      direction: String(a.trainLineNm ?? '').split(' - ')[0],
      seconds: parseInt(a.barvlDt, 10) || 0,
      message: String(a.arvlMsg2 ?? ''),
      fetchedAt,
    }))
    .filter((a) => !filter || a.direction.includes(filter) || a.line.includes(filter))
    .sort((a, b) => a.seconds - b.seconds);
}

/**
 * Seoul real-time subway arrivals (서울 열린데이터광장 실시간 도착정보).
 * Needs a free API key from data.seoul.go.kr. The endpoint is HTTP-only.
 */
export function createTransitWidget(): Widget {
  let arrivals: Arrival[] = [];
  let error = false;
  return {
    id: 'transit',
    refreshMs: 30_000,
    async refresh(env) {
      const { seoulApiKey, station, directionFilter } = env.settings.transit;
      if (!seoulApiKey || !station) return;
      try {
        const url =
          `http://swopenapi.seoul.go.kr/api/subway/${encodeURIComponent(seoulApiKey)}/json/realtimeStationArrival/0/8/` +
          encodeURIComponent(station.replace(/역$/, ''));
        arrivals = parseArrivals(await fetchJson(env.fetch, url), directionFilter, Date.now());
        error = false;
      } catch (e) {
        error = true;
        throw e;
      }
    },
    render(env, now) {
      const { seoulApiKey, station } = env.settings.transit;
      if (!seoulApiKey || !station) return { text: '교통: 폰 설정에서 역/API키 입력' };
      if (!arrivals.length) return error ? { text: `${station} 도착정보 없음` } : null;
      const items = arrivals.slice(0, 2).map((a) => {
        // barvlDt is a countdown from fetch time; when it's 0 fall back to the message ("전역 도착").
        const left = a.seconds ? Math.round((a.seconds * 1000 - (now.getTime() - a.fetchedAt)) / 60_000) : null;
        return left !== null && left >= 0 ? `${left}분` : clip(a.message, 10);
      });
      const first = arrivals[0];
      const head = `${first.line} ${clip(first.direction, 10)}`.trim();
      return { text: `${head} ${items.join(' / ')}` };
    },
  };
}
