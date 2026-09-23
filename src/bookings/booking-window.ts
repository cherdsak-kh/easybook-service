import { BadRequestException } from '@nestjs/common';
import {
  AVAILABILITY_MAX_DAYS,
  AVAILABILITY_RANGE_INVALID,
  AVAILABILITY_RANGE_TOO_WIDE,
  BANGKOK_UTC_OFFSET_MINUTES,
} from './bookings.constants';

/**
 * 🔴 THE SINGLE OWNER OF THE CALENDAR WINDOW, shared by every read that paints a month of slots.
 *
 * ── WHY IT IS ITS OWN FILE ──
 * It was module-private in `BookingsService`, which was right while the LIFF venue calendar and
 * `#/home`'s master schedule were its only callers. The admin booking calendar
 * (`GET /booking-requests/calendar`) is a third, and it lives in `AdminBookingsService`. The three
 * must agree on the default month and on both refusals — a copy would be a second chance to default
 * one of them to "today" or to a UTC month. Same move `booking-code.ts`, `booking-overlap.ts` and
 * `booking-list-view.ts` already made: extracted, never duplicated, never reached for across a
 * service boundary. Behaviour-preserving: the body is unchanged on the way out.
 */

/**
 * The window: what the caller asked for, or the current Bangkok calendar month.
 *
 * ⚠️ BANGKOK, NOT THE SERVER'S CLOCK. "This month" has to mean the month the user is looking at on
 * a phone in Thailand; a UTC container would default the first seven hours of every 1st of the month
 * to the previous one and open the calendar on the wrong page.
 *
 * ⚠️ THE PARAMETER IS STRUCTURAL, NOT A DTO, because three endpoints share this window: the venue
 * calendar (`VenueAvailabilityQueryDto`), `#/home`'s master schedule (`ScheduleQueryDto`) and the
 * admin calendar (`CalendarBookingQueryDto`).
 *
 * ⚠️ `to == from` IS ACCEPTED HERE AND RETURNED AS-IS. An empty half-open window contains no
 * instant, but a slot straddling it still satisfies `startAt < to AND endAt > from` — a caller that
 * promises `[]` for it must short-circuit itself (`AdminBookingsService.getCalendar` does). The
 * LIFF callers never relied on that, and this helper is not where their behaviour changes.
 */
export function resolveWindow(query: { from?: string; to?: string }): {
  from: Date;
  to: Date;
} {
  const offset = BANGKOK_UTC_OFFSET_MINUTES * 60_000;
  const nowLocal = new Date(Date.now() + offset);
  const monthStart = new Date(
    Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), 1) - offset,
  );
  const monthEnd = new Date(
    Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth() + 1, 1) - offset,
  );

  const from = query.from ? new Date(query.from) : monthStart;
  const to = query.to ? new Date(query.to) : monthEnd;

  if (to.getTime() < from.getTime()) {
    throw new BadRequestException(AVAILABILITY_RANGE_INVALID);
  }
  if (to.getTime() - from.getTime() > AVAILABILITY_MAX_DAYS * 86_400_000) {
    throw new BadRequestException(AVAILABILITY_RANGE_TOO_WIDE);
  }
  return { from, to };
}
