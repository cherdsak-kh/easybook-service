import { ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { CalendarBookingQueryDto } from './calendar-booking-query.dto';

/** The global pipe's exact options (`app.setup.ts`). */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const META: ArgumentMetadata = {
  type: 'query',
  metatype: CalendarBookingQueryDto,
};

const validate = (query: unknown): Promise<CalendarBookingQueryDto> =>
  pipe.transform(query, META) as Promise<CalendarBookingQueryDto>;

describe('CalendarBookingQueryDto (plan B6, B7)', () => {
  it('accepts an empty query — the service defaults the window', async () => {
    await expect(validate({})).resolves.toBeInstanceOf(CalendarBookingQueryDto);
  });

  it('accepts a full query in the shape the admin page sends', async () => {
    await expect(
      validate({
        from: '2026-08-29T17:00:00.000Z',
        to: '2026-10-10T17:00:00.000Z',
        venueId: 'clx_venue_cuid',
        status: 'PENDING',
      }),
    ).resolves.toMatchObject({ venueId: 'clx_venue_cuid', status: 'PENDING' });
  });

  it.each([
    ['2026-09-01'],
    ['2026-09-01T00:00:00+07:00'],
    ['2026-09-01T00:00Z'],
    ['2026-08-31T17:00:00.000Z'],
  ])('accepts the instant %s', async (from) => {
    await expect(validate({ from })).resolves.toMatchObject({ from });
  });

  it.each([
    ['status=REJECTED', { status: 'REJECTED' }],
    ['status=CANCELLED', { status: 'CANCELLED' }],
    ['status=EXPIRED', { status: 'EXPIRED' }],
    ['a lower-case status', { status: 'approved' }],
    ['an empty venueId', { venueId: '' }],
    ['a non-date `from`', { from: 'yesterday' }],
    // Each of these passes `@IsISO8601()` alone and becomes an Invalid Date in `new Date()` — which
    // would reach Prisma as NaN and answer 500 rather than 400.
    ['an ISO week date', { from: '2026-W37' }],
    ['an ISO ordinal date', { to: '2026-257' }],
    ['the ISO basic format', { from: '20260901' }],
    // …and this one would be silently rolled over to 2 March.
    ['an impossible calendar date', { to: '2026-02-30' }],
    ['an unknown query parameter', { page: '1' }],
  ])('rejects %s with a 400', async (_label, query) => {
    await expect(validate(query)).rejects.toMatchObject({ status: 400 });
  });
});
