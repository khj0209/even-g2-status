import { describe, expect, it } from 'vitest';
import { parseIcs, parseManualEvents } from '../src/core/ics';

const wrap = (...events: string[]) =>
  ['BEGIN:VCALENDAR', ...events.flatMap((e) => ['BEGIN:VEVENT', ...e.trim().split('\n').map((l) => l.trim()), 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');

const from = new Date(2026, 10, 19); // Thu 19 Nov 2026
const to = new Date(2026, 10, 21);

describe('parseIcs', () => {
  it('parses a single timed event with local time and folded summary', () => {
    const ics = wrap(`
      UID:1
      DTSTART;TZID=Asia/Seoul:20261119T150000
      DTEND;TZID=Asia/Seoul:20261119T160000
      SUMMARY:디자인\\, 리뷰`).replace('SUMMARY:디자인\\, 리뷰', 'SUMMARY:디자인\\,\r\n  리뷰');
    const [ev] = parseIcs(ics, from, to);
    expect(ev.title).toBe('디자인, 리뷰');
    expect(ev.start).toEqual(new Date(2026, 10, 19, 15, 0));
    expect(ev.end).toEqual(new Date(2026, 10, 19, 16, 0));
    expect(ev.allDay).toBe(false);
  });

  it('parses UTC times and DURATION', () => {
    const [ev] = parseIcs(wrap(`UID:2\nDTSTART:20261119T060000Z\nDURATION:PT45M\nSUMMARY:x`), from, to);
    expect(ev.start.getTime()).toBe(Date.UTC(2026, 10, 19, 6, 0));
    expect(ev.end.getTime() - ev.start.getTime()).toBe(45 * 60_000);
  });

  it('parses all-day events', () => {
    const [ev] = parseIcs(wrap(`UID:3\nDTSTART;VALUE=DATE:20261120\nDTEND;VALUE=DATE:20261121\nSUMMARY:휴가`), from, to);
    expect(ev.allDay).toBe(true);
    expect(ev.start).toEqual(new Date(2026, 10, 20));
  });

  it('skips cancelled and out-of-range events', () => {
    const ics = wrap(
      `UID:4\nDTSTART:20261119T100000\nDTEND:20261119T110000\nSTATUS:CANCELLED\nSUMMARY:취소됨`,
      `UID:5\nDTSTART:20261201T100000\nDTEND:20261201T110000\nSUMMARY:나중`,
    );
    expect(parseIcs(ics, from, to)).toEqual([]);
  });

  it('expands weekly BYDAY recurrence with EXDATE and an override', () => {
    const ics = wrap(
      `UID:w\nDTSTART:20261102T093000\nDTEND:20261102T094500\nRRULE:FREQ=WEEKLY;BYDAY=MO,TH,FR\nEXDATE:20261120T093000\nSUMMARY:스탠드업`,
      `UID:w\nRECURRENCE-ID:20261119T093000\nDTSTART:20261119T100000\nDTEND:20261119T101500\nSUMMARY:스탠드업(변경)`,
    );
    const evs = parseIcs(ics, from, new Date(2026, 10, 24));
    expect(evs.map((e) => [e.title, e.start.getDate(), e.start.getHours()])).toEqual([
      ['스탠드업(변경)', 19, 10], // overridden Thursday
      // Friday 20th excluded by EXDATE
      ['스탠드업', 23, 9], // Monday
    ]);
  });

  it('honours COUNT, UNTIL and INTERVAL for daily rules', () => {
    const count = wrap(`UID:c\nDTSTART:20261117T080000\nDTEND:20261117T083000\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:c`);
    expect(parseIcs(count, from, to).map((e) => e.start.getDate())).toEqual([19]);
    const until = wrap(`UID:u\nDTSTART:20261118T080000\nDTEND:20261118T083000\nRRULE:FREQ=DAILY;UNTIL=20261119T235959\nSUMMARY:u`);
    expect(parseIcs(until, from, to).map((e) => e.start.getDate())).toEqual([19]);
    const interval = wrap(`UID:i\nDTSTART:20261117T080000\nDTEND:20261117T083000\nRRULE:FREQ=DAILY;INTERVAL=2\nSUMMARY:i`);
    expect(parseIcs(interval, from, new Date(2026, 10, 23)).map((e) => e.start.getDate())).toEqual([19, 21]);
  });

  it('expands monthly rules on the same day of month', () => {
    const ics = wrap(`UID:m\nDTSTART:20260920T190000\nDTEND:20260920T200000\nRRULE:FREQ=MONTHLY\nSUMMARY:월례`);
    expect(parseIcs(ics, from, to).map((e) => e.start.getDate())).toEqual([20]);
  });
});

describe('parseManualEvents', () => {
  it('supports dates, weekday groups and day lists', () => {
    const text = [
      '2026-11-19 15:00 디자인 리뷰',
      '평일 09:30-09:45 스탠드업',
      '주말 10:00 러닝',
      '월,수,금 19:00-20:00 헬스',
      '# 주석',
      '잘못된 줄',
    ].join('\n');
    const evs = parseManualEvents(text, from, to);
    const summary = evs.map((e) => `${e.start.getDate()} ${e.start.getHours()}:${e.start.getMinutes()} ${e.title}`);
    expect(summary).toEqual([
      '19 9:30 스탠드업',
      '19 15:0 디자인 리뷰',
      '20 9:30 스탠드업',
      '20 19:0 헬스',
    ]);
    const review = evs.find((e) => e.title === '디자인 리뷰')!;
    expect(review.end.getTime() - review.start.getTime()).toBe(30 * 60_000);
  });

  it('includes an event from yesterday that is still running past midnight', () => {
    const evs = parseManualEvents('매일 23:00-01:00 야간', from, to);
    expect(evs[0].start).toEqual(new Date(2026, 10, 18, 23, 0));
    expect(evs[0].end).toEqual(new Date(2026, 10, 19, 1, 0));
  });
});
