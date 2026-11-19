import type { CalendarEvent } from './types';

/**
 * Minimal iCalendar (RFC 5545) parser for a status HUD.
 *
 * Supported: DTSTART/DTEND/DURATION, all-day events, UTC ("Z") times,
 * RRULE with FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (weekly),
 * EXDATE, RECURRENCE-ID overrides, STATUS:CANCELLED.
 *
 * Simplification: times with a TZID are interpreted in the device's local time zone,
 * which is correct whenever the calendar and the phone share a zone (the common case).
 */

interface RawEvent {
  uid: string;
  summary: string;
  start: Date;
  end: Date;
  allDay: boolean;
  rrule: Record<string, string> | null;
  exdates: number[];
  recurrenceId: number | null;
  cancelled: boolean;
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function unescape(v: string): string {
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

export function parseIcsDate(value: string): { date: Date; allDay: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { date: new Date(+y, +mo - 1, +d), allDay: true };
  const date = z
    ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0)))
    : new Date(+y, +mo - 1, +d, +h, +mi, +(s ?? 0));
  return { date, allDay: false };
}

function parseDuration(v: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+(w ?? 0) * 7 + +(d ?? 0)) * 86400 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

function parseRaw(text: string): RawEvent[] {
  const out: RawEvent[] = [];
  let cur: Partial<RawEvent> & { duration?: number } | null = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') {
      cur = { uid: '', summary: '', exdates: [], rrule: null, recurrenceId: null, cancelled: false };
      continue;
    }
    if (!cur) continue;
    if (line === 'END:VEVENT') {
      if (cur.start) {
        let end = cur.end;
        if (!end) {
          end = cur.duration !== undefined
            ? new Date(cur.start.getTime() + cur.duration)
            : new Date(cur.start.getTime() + (cur.allDay ? 86_400_000 : 0));
        }
        out.push({ ...(cur as RawEvent), end });
      }
      cur = null;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [name] = line.slice(0, colon).toUpperCase().split(';');
    const value = line.slice(colon + 1);
    switch (name) {
      case 'UID': cur.uid = value.trim(); break;
      case 'SUMMARY': cur.summary = unescape(value); break;
      case 'STATUS': cur.cancelled = value.trim().toUpperCase() === 'CANCELLED'; break;
      case 'DTSTART': {
        const p = parseIcsDate(value);
        if (p) { cur.start = p.date; cur.allDay = p.allDay; }
        break;
      }
      case 'DTEND': { const p = parseIcsDate(value); if (p) cur.end = p.date; break; }
      case 'DURATION': cur.duration = parseDuration(value); break;
      case 'RRULE':
        cur.rrule = Object.fromEntries(value.split(';').map((kv) => {
          const [k, v = ''] = kv.split('=');
          return [k.toUpperCase(), v.toUpperCase()];
        }));
        break;
      case 'EXDATE':
        for (const v of value.split(',')) {
          const p = parseIcsDate(v);
          if (p) cur.exdates!.push(p.date.getTime());
        }
        break;
      case 'RECURRENCE-ID': { const p = parseIcsDate(value); if (p) cur.recurrenceId = p.date.getTime(); break; }
    }
  }
  return out;
}

/** Candidate occurrence starts of a recurring event, in order, up to `until`. */
function* occurrences(ev: RawEvent, until: Date): Generator<Date> {
  const r = ev.rrule!;
  const freq = r.FREQ;
  const interval = Math.max(1, parseInt(r.INTERVAL ?? '1', 10) || 1);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  const ruleUntil = r.UNTIL ? parseIcsDate(r.UNTIL)?.date : undefined;
  const limit = ruleUntil && ruleUntil < until ? ruleUntil : until;
  const byDay = (r.BYDAY ?? '').split(',').map((d) => DAY_CODES.indexOf(d.slice(-2))).filter((d) => d >= 0);
  const start = ev.start;
  let emitted = 0;

  const at = (base: Date) =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate(), start.getHours(), start.getMinutes(), start.getSeconds());

  if (freq === 'WEEKLY' && byDay.length) {
    // Walk week by week from the week containing DTSTART.
    const weekStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() - start.getDay());
    for (let w = 0; emitted < count && w < 2000; w += interval) {
      for (let d = 0; d < 7; d++) {
        if (!byDay.includes(d)) continue;
        const day = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + w * 7 + d);
        const occ = at(day);
        if (occ < start) continue;
        if (occ > limit) return;
        emitted++;
        yield occ;
        if (emitted >= count) return;
      }
    }
    return;
  }

  for (let i = 0; emitted < count && i < 5000; i++) {
    const n = i * interval;
    let occ: Date;
    if (freq === 'DAILY') occ = at(new Date(start.getFullYear(), start.getMonth(), start.getDate() + n));
    else if (freq === 'WEEKLY') occ = at(new Date(start.getFullYear(), start.getMonth(), start.getDate() + n * 7));
    else if (freq === 'MONTHLY') {
      occ = at(new Date(start.getFullYear(), start.getMonth() + n, start.getDate()));
      if (occ.getDate() !== start.getDate()) continue; // e.g. the 31st in a 30-day month
    } else if (freq === 'YEARLY') occ = at(new Date(start.getFullYear() + n, start.getMonth(), start.getDate()));
    else { yield start; return; }
    if (occ > limit) return;
    emitted++;
    yield occ;
  }
}

/** Expand an ICS document into concrete events overlapping [from, to). */
export function parseIcs(text: string, from: Date, to: Date): CalendarEvent[] {
  const raws = parseRaw(text);
  const overrides = new Set(
    raws.filter((r) => r.recurrenceId !== null).map((r) => `${r.uid}@${r.recurrenceId}`),
  );
  const out: CalendarEvent[] = [];
  const push = (r: RawEvent, start: Date) => {
    const end = new Date(start.getTime() + (r.end.getTime() - r.start.getTime()));
    if (end > from && start < to) out.push({ title: r.summary || '(제목 없음)', start, end, allDay: r.allDay });
  };
  for (const r of raws) {
    if (r.cancelled) continue;
    if (!r.rrule || r.recurrenceId !== null) {
      push(r, r.start);
      continue;
    }
    for (const occ of occurrences(r, to)) {
      const t = occ.getTime();
      if (r.exdates.includes(t) || overrides.has(`${r.uid}@${t}`)) continue;
      push(r, occ);
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

const KO_DAYS: Record<string, number> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };

/**
 * Manual events typed on the phone settings page, one per line:
 *
 *   2026-11-20 15:00 디자인 리뷰
 *   2026-11-20 15:00-16:30 디자인 리뷰
 *   매일 12:00 점심
 *   평일 09:30-09:45 스탠드업
 *   주말 10:00 러닝
 *   월,수,금 19:00-20:00 헬스
 *
 * Events without an end time last 30 minutes.
 */
export function parseManualEvents(text: string, from: Date, to: Date): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s+(\d{1,2}):(\d{2})(?:\s*-\s*(\d{1,2}):(\d{2}))?\s+(.+)$/.exec(line);
    if (!m) continue;
    const [, when, sh, sm, eh, em, title] = m;
    const make = (day: Date) => {
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), +sh, +sm);
      let end = eh !== undefined
        ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), +eh, +em)
        : new Date(start.getTime() + 30 * 60_000);
      if (end <= start) end = new Date(end.getTime() + 86_400_000);
      if (end > from && start < to) out.push({ title, start, end, allDay: false });
    };
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(when);
    if (date) {
      make(new Date(+date[1], +date[2] - 1, +date[3]));
      continue;
    }
    let days: number[];
    if (when === '매일') days = [0, 1, 2, 3, 4, 5, 6];
    else if (when === '평일') days = [1, 2, 3, 4, 5];
    else if (when === '주말') days = [0, 6];
    else days = when.split(',').map((d) => KO_DAYS[d.trim()]).filter((d) => d !== undefined);
    if (!days.length) continue;
    // Start one day early so events that began yesterday and are still running are included.
    for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1); d < to; d.setDate(d.getDate() + 1)) {
      if (days.includes(d.getDay())) make(new Date(d));
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
