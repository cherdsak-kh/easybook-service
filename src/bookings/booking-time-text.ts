import {
  BANGKOK_UTC_OFFSET_MINUTES,
  BUDDHIST_ERA_OFFSET,
} from './bookings.constants';

/**
 * `thaiShortDate` / `bangkokClock` / `describeSlots` — moved here from `booking-notifier.ts`
 * (design §2.2, D-2).
 *
 * 🔴 WHY THEY LIVE HERE AND NOT THERE ANY MORE: the Phase 3 triggers need them too (B1/B2/B3's
 * `when(slots)`), and `notifications/triggers/*` may not import a VALUE from `bookings/*.service.ts`
 * or `bookings/booking-notifier.ts` (design §2.1's file-level import rule) — importing
 * `booking-notifier.ts` from a trigger builder would close the cycle
 * `line.service → admin-notification-triggers.service → builders → booking-notifier → line.service`,
 * and `emitDecoratorMetadata` would then read an `undefined` constructor type and Nest would fail to
 * boot. This file imports only `bookings.constants`, so it is a safe leaf both sides can reach.
 *
 * `booking-notifier.ts` re-exports all three names, so its own spec and every existing caller
 * (`announcements.service.ts`, `admin-bookings.service.ts`) need no edit.
 */

const THAI_MONTHS_SHORT = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
] as const;

/** Shifted into Bangkok's frame to READ calendar fields — never stored (see `booking-code.ts`). */
const bangkok = (at: Date): Date =>
  new Date(at.getTime() + BANGKOK_UTC_OFFSET_MINUTES * 60_000);

/** `2026-09-18T02:00:00Z` → `"18 ก.ย. 2569"` (Bangkok calendar, Buddhist era). */
export function thaiShortDate(at: Date): string {
  const local = bangkok(at);
  return `${local.getUTCDate()} ${THAI_MONTHS_SHORT[local.getUTCMonth()]} ${
    local.getUTCFullYear() + BUDDHIST_ERA_OFFSET
  }`;
}

/** `2026-09-18T02:00:00Z` → `"09:00"` (Bangkok wall clock). */
export function bangkokClock(at: Date): string {
  const local = bangkok(at);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export interface SlotTimes {
  startAt: Date;
  endAt: Date;
}

/**
 * The card's `วันที่ใช้งาน` / `ช่วงเวลา` pair for a set of slots, plus the one-line `dateSummary`
 * the chat-list preview uses.
 *
 * `dateText` (THE BUBBLE) lists the DISTINCT Bangkok dates the slots start on, chronologically:
 * - one date (however many slots) → `"18 ก.ย. 2569"`
 * - several dates → one bulleted line each, `"• 18 ก.ย. 2569\n• 20 ก.ย. 2569"`
 *
 * 🔴 NEVER A RANGE. `"18 ก.ย. - 25 ก.ย."` reads as every day in between, when a multi-day booking
 * is any set of days. The newlines render because every Flex text node is `wrap: true`
 * (`notification-cards.ts` `text()`).
 *
 * `dateSummary` (THE `altText`) is that same list compressed onto ONE line, because a preview has
 * neither bullets nor newlines and LINE caps `altText` at 400 characters — a 60-slot booking's
 * bulleted list alone is ~1,000 and the push would be rejected with HTTP 400 (nothing delivered):
 * - one date → identical to `dateText`
 * - several dates → `"18 ก.ย. 2569 - 25 ก.ย. 2569 (รวม 5 วัน)"`, bounded whatever the slot count is
 *
 * The bounds ARE a range here, and that is safe only because `(รวม N วัน)` states how many days are
 * actually booked. Never put this string in the bubble, where the exact days must be readable.
 *
 * `periodText` is one period when every slot shares it, else `"หลายช่วงเวลา"`. LINE rejects an empty
 * text node, hence the `-` fallback.
 */
export function describeSlots(slots: readonly SlotTimes[]): {
  dateText: string;
  dateSummary: string;
  periodText: string;
} {
  if (slots.length === 0)
    return { dateText: '-', dateSummary: '-', periodText: '-' };
  // Keyed by the start's BANGKOK date (`thaiShortDate`), so a slot just after local midnight counts
  // on its own day, and a slot ending exactly at midnight stays on the day it started.
  const dates = [
    ...new Set(
      [...slots]
        .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
        .map((s) => thaiShortDate(s.startAt)),
    ),
  ];
  const dateText =
    dates.length === 1 ? dates[0] : dates.map((d) => `• ${d}`).join('\n');
  const dateSummary =
    dates.length === 1
      ? dates[0]
      : `${dates[0]} - ${dates[dates.length - 1]} (รวม ${dates.length} วัน)`;

  const periods = new Set(
    slots.map((s) => `${bangkokClock(s.startAt)} - ${bangkokClock(s.endAt)}`),
  );
  const periodText =
    periods.size === 1 ? `${[...periods][0]} น.` : 'หลายช่วงเวลา';
  return { dateText, dateSummary, periodText };
}
