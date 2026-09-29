import { periodFloor } from './notifications.period';

/**
 * AC-8 — `period` is cut on Asia/Bangkok calendar days (UTC+7, no DST), with an injected clock.
 *
 * "Today" throughout is 26 Sep 2026 in Bangkok. Bangkok midnight that day is 2026-09-25T17:00:00Z.
 */
const NOW = new Date('2026-09-26T03:00:00.000Z'); // 10:00 Bangkok, 26 Sep
const BANGKOK_MIDNIGHT_TODAY = new Date('2026-09-25T17:00:00.000Z');

/** `createdAt >= floor` — exactly the clause the service builds. */
const includes = (floor: Date | null, createdAt: Date): boolean =>
  floor === null || createdAt.getTime() >= floor.getTime();

describe('periodFloor (Bangkok calendar days, AC-8)', () => {
  it('absent period → null (all time, no clause)', () => {
    expect(periodFloor(undefined, NOW)).toBeNull();
  });

  it('today → Bangkok midnight today, NOT UTC midnight', () => {
    const floor = periodFloor('today', NOW);
    expect(floor).toEqual(BANGKOK_MIDNIGHT_TODAY);
    // The naive UTC cut would be 07:00 Bangkok — the bug this helper exists to prevent.
    expect(floor).not.toEqual(new Date('2026-09-26T00:00:00.000Z'));
  });

  it('7d / 30d → Bangkok midnight 7 / 30 days before today', () => {
    expect(periodFloor('7d', NOW)).toEqual(
      new Date('2026-09-18T17:00:00.000Z'),
    );
    expect(periodFloor('30d', NOW)).toEqual(
      new Date('2026-08-26T17:00:00.000Z'),
    );
  });

  it('23:30 Bangkok YESTERDAY (16:30Z) is excluded from today and included in 7d', () => {
    const lateYesterday = new Date('2026-09-25T16:30:00.000Z');
    expect(includes(periodFloor('today', NOW), lateYesterday)).toBe(false);
    expect(includes(periodFloor('7d', NOW), lateYesterday)).toBe(true);
  });

  it('00:05 Bangkok TODAY (17:05Z the previous UTC day) is included in today', () => {
    const justAfterMidnight = new Date('2026-09-25T17:05:00.000Z');
    expect(includes(periodFloor('today', NOW), justAfterMidnight)).toBe(true);
  });

  it('the floor itself is inclusive (createdAt exactly at Bangkok midnight is today)', () => {
    expect(includes(periodFloor('today', NOW), BANGKOK_MIDNIGHT_TODAY)).toBe(
      true,
    );
  });

  it('7d includes today plus exactly the seven days before it (prototype `days <= 7`)', () => {
    const floor = periodFloor('7d', NOW);
    // 7 days ago, 00:00 Bangkok — in; one millisecond earlier (8 days ago) — out.
    const sevenDaysAgo = new Date('2026-09-18T17:00:00.000Z');
    expect(includes(floor, sevenDaysAgo)).toBe(true);
    expect(includes(floor, new Date(sevenDaysAgo.getTime() - 1))).toBe(false);
  });

  it.each([
    // [clock, expected Bangkok midnight "today"]
    ['2026-09-25T16:59:59.999Z', '2026-09-24T17:00:00.000Z'], // 23:59:59.999 on the 25th, Bangkok
    ['2026-09-25T17:00:00.000Z', '2026-09-25T17:00:00.000Z'], // 00:00 on the 26th, Bangkok
    ['2026-09-26T16:59:59.999Z', '2026-09-25T17:00:00.000Z'], // 23:59:59.999 on the 26th, Bangkok
  ])('the day flips at 17:00Z, not 00:00Z — clock %s', (clock, expected) => {
    expect(periodFloor('today', new Date(clock))).toEqual(new Date(expected));
  });
});
