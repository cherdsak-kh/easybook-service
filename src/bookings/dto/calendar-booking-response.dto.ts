import { ApiProperty } from '@nestjs/swagger';
import {
  CALENDAR_STATUSES,
  type CalendarStatus,
} from './calendar-booking-query.dto';

/**
 * One slot on the admin ปฏิทินการจอง — `GET /booking-requests/calendar` returns an array of these.
 *
 * ⚠️ ONE FLAT ROW PER SLOT, NOT PER REQUEST. The screen places each span on its own day and lists it
 * as its own card, so a three-day request is three rows sharing `bookingRequestId` and `code`, told
 * apart by `slotIndex`/`slotCount`. Nesting slots under a request would make the client flatten them
 * again, and the queue's row shape (`AdminBookingRequestListItemDto`) already covers "per request".
 *
 * ⚠️ `date` / `start` / `end` ARE BANGKOK WALL-CLOCK STRINGS COMPUTED BY THE SERVER, next to the real
 * instants. The grid buckets by `date` and prints `start – end น.`; computing them client-side would
 * depend on the browser's time zone, which the prototype's `todayIso()` got wrong.
 *
 * Staff are the permitted viewer (`admin-booking-response.dto.ts`'s header): `purpose` and the
 * requester's name are carried in every status, PENDING included.
 */
export class CalendarBookingSlotDto {
  @ApiProperty({ description: 'The `BookingSlot` cuid — one span.' })
  id!: string;

  @ApiProperty({
    description:
      'The parent `BookingRequest` cuid — what `GET /booking-requests/:id` and the detail dialog open.',
  })
  bookingRequestId!: string;

  @ApiProperty({ example: 'BR-25690903-001' })
  code!: string;

  @ApiProperty({
    enum: CALENDAR_STATUSES,
    description:
      'The parent request’s status. Only the two occupying statuses ever appear on the calendar.',
  })
  status!: CalendarStatus;

  @ApiProperty({ example: 'ประชุมผู้ปกครองระดับชั้น ม.3' })
  purpose!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'สมชาย ใจดี',
    description:
      'From the LINE registration when there is one, otherwise the staff requester override. Null is legitimate — a staff booking that named nobody.',
  })
  requesterName!: string | null;

  @ApiProperty({ description: 'The venue cuid (a string, never a number).' })
  venueId!: string;

  @ApiProperty({ example: 'หอประชุมวารณ' })
  venueName!: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'Inclusive start instant. Spans are half-open `[startAt, endAt)`.',
  })
  startAt!: Date;

  @ApiProperty({ format: 'date-time', description: 'Exclusive end instant.' })
  endAt!: Date;

  @ApiProperty({
    example: '2026-09-18',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description:
      'The Bangkok (UTC+7) calendar date of `startAt`, `YYYY-MM-DD` (Gregorian). A slot is listed on this date ONLY — never duplicated onto the next day, even if it ends there.',
  })
  date!: string;

  @ApiProperty({
    example: '09:00',
    pattern: '^\\d{2}:\\d{2}$',
    description: 'Bangkok wall-clock start, `HH:mm`.',
  })
  start!: string;

  @ApiProperty({
    example: '12:00',
    pattern: '^\\d{2}:\\d{2}$',
    description:
      'Bangkok wall-clock end, `HH:mm`. `24:00` when `endAt` is the Bangkok midnight right after `date`, so an end-of-day slot never reads as ending at `00:00`.',
  })
  end!: string;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    example: 2,
    description:
      '1-based position of this slot among its request’s NON-cancelled slots, by `startAt`. Counted over the whole request, not the window.',
  })
  slotIndex!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    example: 3,
    description:
      'How many non-cancelled slots the request has in total (the `m` of `ช่วงที่ n จาก m`). Counted over the whole request, not the window.',
  })
  slotCount!: number;
}
