import {
  bangkokDayRange,
  bookingCodeDatePart,
  formatBookingCode,
} from './booking-code';

/**
 * The booking number is the one string in this domain a human reads aloud, and every bug it can have
 * is a time-zone bug. These run on pure functions with fixed instants, so they say the same thing on
 * a laptop in Bangkok and in a CI container in UTC — which is the property being tested.
 */
describe('booking-code', () => {
  describe('bookingCodeDatePart', () => {
    it('writes the Buddhist-era Bangkok date', () => {
      // 11:00 Bangkok on 2 Sep 2026 → 2569-09-02. The example on `BookingRequest.code`.
      expect(bookingCodeDatePart(new Date('2026-09-02T04:00:00.000Z'))).toBe(
        '25690902',
      );
    });

    it('🔴 uses BANGKOK’s day, not the server’s — an instant late in UTC is already tomorrow', () => {
      // 17:00Z on the 2nd is 00:00 on the 3rd in Bangkok. A server reading its own clock would mint
      // a code stamped with yesterday's date onto a booking the user submitted today.
      expect(bookingCodeDatePart(new Date('2026-09-02T17:00:00.000Z'))).toBe(
        '25690903',
      );
      // And one minute earlier is still the 2nd — the boundary is exact, not approximate.
      expect(bookingCodeDatePart(new Date('2026-09-02T16:59:59.999Z'))).toBe(
        '25690902',
      );
    });

    it('pads month and day, and rolls the year', () => {
      expect(bookingCodeDatePart(new Date('2026-01-05T03:00:00.000Z'))).toBe(
        '25690105',
      );
      // 18:00Z on 31 Dec is 01:00 on 1 Jan in Bangkok — a new Gregorian AND Buddhist year.
      expect(bookingCodeDatePart(new Date('2026-12-31T18:00:00.000Z'))).toBe(
        '25700101',
      );
    });
  });

  describe('bangkokDayRange', () => {
    it('spans exactly 24 hours from Bangkok midnight', () => {
      const { start, end } = bangkokDayRange(
        new Date('2026-09-02T04:00:00.000Z'),
      );
      // Bangkok midnight on the 2nd is 17:00Z on the 1st.
      expect(start.toISOString()).toBe('2026-09-01T17:00:00.000Z');
      expect(end.toISOString()).toBe('2026-09-02T17:00:00.000Z');
    });

    it('🔴 agrees with the label — the count window and the printed date are the same day', () => {
      // If these two disagreed, the sequence would restart part-way through a day and mint a
      // duplicate `code`, which the @unique column would then reject at random hours.
      for (const iso of [
        '2026-09-02T16:59:59.999Z',
        '2026-09-02T17:00:00.000Z',
        '2026-09-03T09:30:00.000Z',
      ]) {
        const at = new Date(iso);
        const { start } = bangkokDayRange(at);
        expect(bookingCodeDatePart(start)).toBe(bookingCodeDatePart(at));
      }
    });
  });

  describe('formatBookingCode', () => {
    it('numbers from 001', () => {
      const at = new Date('2026-09-02T04:00:00.000Z');
      expect(formatBookingCode(at, 0)).toBe('BR-25690902-001');
      expect(formatBookingCode(at, 41)).toBe('BR-25690902-042');
    });

    it('widens rather than wraps past 999', () => {
      // An ugly code beats a collision: the 1000th booking of one day must still be unique.
      expect(formatBookingCode(new Date('2026-09-02T04:00:00.000Z'), 999)).toBe(
        'BR-25690902-1000',
      );
    });
  });
});
