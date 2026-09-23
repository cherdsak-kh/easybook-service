// The LINE Login channel id the guard verifies id_token `aud` against. MUST be set before the app
// boots (ConfigModule reads process.env at forRoot). Digits only, per env.validation.
process.env.LINE_LOGIN_CHANNEL_ID =
  process.env.LINE_LOGIN_CHANNEL_ID ?? '1234567890';

import type { INestApplication } from '@nestjs/common';
import { AppAccess, BookingStatus } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { API_BASE_PATH } from '../src/common/api.constants';
import { LineService } from '../src/line/line.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, prismaOf } from './e2e-app';

jest.setTimeout(120_000);

const CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;
const PREFIX = 'e2epag-';
const url = (path: string) => `${API_BASE_PATH}${path}`;

const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Meta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
interface Facets {
  venueTypes: { id: number; name: string }[];
}
interface Envelope<T> {
  data: T[];
  meta: Meta;
  facets: Facets;
}
interface VenueRow {
  id: string;
  name: string;
  isOpen: boolean;
  venueType: { id: number; name: string };
}
interface BookingRow {
  id: string;
  code: string;
  venue: { id: string; venueType: { id: number } };
}

/** The verify-endpoint mock's current answer. Mirrors `line-schedule.e2e-spec.ts`. */
let currentSub = '';
const futureExp = () => Math.floor(Date.now() / 1000) + 3600;

/**
 * `CLIENT-PAGINATION-1` — `GET /line-users/venues` and `GET /line-users/bookings` as `{ data, meta,
 * facets }`, against real Postgres.
 *
 * 🔴 WHY THIS IS AN E2E SPEC AND NOT A UNIT SPEC. The booking buckets are relation filters
 * (`slots: { some }`, a `NOT` over an `OR` of `AND`s) and the facets are a two-hop `some`. A mocked
 * `findMany` echoes back whatever it is told, so only real rows prove that a booking whose LAST slot
 * was cancelled is still `approved`, that the three buckets partition the set, and that a facet never
 * reveals another user's venue categories.
 *
 * ⚠️ THE VENUE READS ARE SCOPED BY `q=e2epag-`. The catalogue is global and shares a database with
 * every other suite and any dev data, so an unscoped count proves nothing. The booking reads need no
 * such scope — ownership already limits them to this suite's users.
 */
describe('LINE list pagination (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const server = () => app.getHttpServer();

  const MINE = `${PREFIX}U-mine`;
  const OTHER = `${PREFIX}U-other`;
  const NOT_ALLOWED = `${PREFIX}U-pending`;
  const ids: Record<string, string> = {};

  /** Venue-type ids by fixture label. */
  const T: Record<'hall' | 'gym' | 'otherOnly' | 'deletedOnly', number> = {
    hall: 0,
    gym: 0,
    otherOnly: 0,
    deletedOnly: 0,
  };
  /** Venue ids by fixture label. */
  const V: Record<string, string> = {};
  /** Booking codes by fixture label. */
  const B: Record<string, string> = {};
  let codeSeq = 0;

  // ───────────────────────────── fixtures ─────────────────────────────

  /** Raw SQL, bookings first — see `line-schedule.e2e-spec.ts` on `booking_requests_owner_check`. */
  const purgeRows = async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM booking_slots WHERE "bookingRequestId" IN (SELECT id FROM booking_requests WHERE code LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM booking_requests WHERE code LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM booking_slots WHERE "venueId" IN (SELECT id FROM venues WHERE name LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM booking_requests WHERE "venueId" IN (SELECT id FROM venues WHERE name LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venues WHERE name LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venue_types WHERE name LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM line_users WHERE "lineUserId" LIKE '${PREFIX}%'`,
    );
  };

  const at = (offset: number) => new Date(Date.now() + offset);

  /**
   * One booking. `lastEndAt` defaults to the latest slot end, and may be overridden to reproduce the
   * value the cancel path RECOMPUTES over surviving slots — which is exactly the column the bucket
   * query must not read.
   */
  const seedBooking = async (
    label: string,
    opts: {
      owner: string;
      venue: string;
      status: BookingStatus;
      slots: { start: number; hours: number; cancelled?: boolean }[];
      lastEndAt?: Date;
    },
  ) => {
    const spans = opts.slots.map((s) => ({
      startAt: at(s.start),
      endAt: at(s.start + s.hours * HOUR),
      cancelled: s.cancelled ?? false,
    }));
    const row = await prisma.bookingRequest.create({
      data: {
        code: `${PREFIX}${String(++codeSeq).padStart(4, '0')}`,
        venueId: V[opts.venue],
        lineUserId: ids[opts.owner],
        purpose: label,
        attendees: 10,
        status: opts.status,
        firstStartAt: new Date(Math.min(...spans.map((s) => +s.startAt))),
        lastEndAt:
          opts.lastEndAt ?? new Date(Math.max(...spans.map((s) => +s.endAt))),
        slots: {
          create: spans.map((s) => ({
            venueId: V[opts.venue],
            startAt: s.startAt,
            endAt: s.endAt,
            ...(s.cancelled
              ? { isCancelled: true, cancelledAt: new Date() }
              : {}),
          })),
        },
      },
      select: { code: true },
    });
    B[label] = row.code;
  };

  const seed = async () => {
    await purgeRows();
    codeSeq = 0;

    const type = async (name: string) =>
      (
        await prisma.venueType.create({
          data: { name: `${PREFIX}${name}` },
          select: { id: true },
        })
      ).id;
    T.hall = await type('hall');
    T.gym = await type('gym');
    T.otherOnly = await type('other-only');
    T.deletedOnly = await type('deleted-only');

    const venue = async (
      label: string,
      venueTypeId: number,
      extra: { isOpen?: boolean; closedReason?: string; deletedAt?: Date } = {},
    ) => {
      V[label] = (
        await prisma.venue.create({
          data: {
            name: `${PREFIX}${label}`,
            venueTypeId,
            capacity: 50,
            ...extra,
          },
          select: { id: true },
        })
      ).id;
    };
    // Catalogue order must come out as a, c, d, x (open, by name) then b (closed); e is deleted.
    await venue('a', T.hall);
    await venue('b', T.hall, { isOpen: false, closedReason: 'ปิดปรับปรุง' });
    await venue('c', T.gym);
    await venue('d', T.gym);
    await venue('x', T.otherOnly);
    await venue('e', T.deletedOnly, { deletedAt: new Date() });

    for (const [sub, access] of [
      [MINE, AppAccess.ALLOWED],
      [OTHER, AppAccess.ALLOWED],
      [NOT_ALLOWED, AppAccess.PENDING],
    ] as Array<[string, AppAccess]>) {
      ids[sub] = (
        await prisma.lineUser.create({
          data: { lineUserId: sub, access },
          select: { id: true },
        })
      ).id;
    }

    // ── MINE: eleven bookings, one per rule of `bookingState()` plus the edges ──
    // ⚠️ APPROVED LIVE SLOTS ON ONE VENUE MUST NOT OVERLAP: `booking_slots_no_overlap` is a real
    // exclusion constraint and would reject the fixture, not the test.
    await seedBooking('pending', {
      owner: MINE,
      venue: 'a',
      status: BookingStatus.PENDING,
      slots: [{ start: 2 * DAY, hours: 2 }],
    });
    // PENDING, every slot cancelled → `cancelled` → history.
    await seedBooking('pendingAllCancelled', {
      owner: MINE,
      venue: 'a',
      status: BookingStatus.PENDING,
      slots: [{ start: 3 * DAY, hours: 2, cancelled: true }],
    });
    await seedBooking('approvedFuture', {
      owner: MINE,
      venue: 'a',
      status: BookingStatus.APPROVED,
      slots: [{ start: 4 * DAY, hours: 2 }],
    });
    // 🔴 THE `lastEndAt` TRAP. Day one is over, the LAST day was cancelled but is still ahead. The
    // cancel path would have recomputed `lastEndAt` over the surviving slot — set here to that past
    // value. `bookingState()` reads every slot, so this is `approved`, and the server must agree.
    await seedBooking('approvedLastSlotCancelled', {
      owner: MINE,
      venue: 'a',
      status: BookingStatus.APPROVED,
      slots: [
        { start: -2 * DAY, hours: 1 },
        { start: 5 * DAY, hours: 1, cancelled: true },
      ],
      lastEndAt: at(-2 * DAY + HOUR),
    });
    // In progress right now: its end is still ahead → `approved`, not `done`.
    await seedBooking('approvedInProgress', {
      owner: MINE,
      venue: 'c',
      status: BookingStatus.APPROVED,
      slots: [{ start: -HOUR, hours: 2 }],
    });
    await seedBooking('done', {
      owner: MINE,
      venue: 'c',
      status: BookingStatus.APPROVED,
      slots: [{ start: -3 * DAY, hours: 2 }],
    });
    await seedBooking('rejected', {
      owner: MINE,
      venue: 'c',
      status: BookingStatus.REJECTED,
      slots: [{ start: 6 * DAY, hours: 2 }],
    });
    // Stored EXPIRED, with a slot still in the future — the bucket reads the status, never the clock.
    await seedBooking('expired', {
      owner: MINE,
      venue: 'a',
      status: BookingStatus.EXPIRED,
      slots: [{ start: 9 * DAY, hours: 2 }],
    });
    // Stored CANCELLED with a slot row that was never flagged — the status alone decides.
    await seedBooking('cancelled', {
      owner: MINE,
      venue: 'c',
      status: BookingStatus.CANCELLED,
      slots: [{ start: 7 * DAY, hours: 2 }],
    });
    // APPROVED, every slot cancelled, still ahead → `cancelled` → history.
    await seedBooking('approvedAllCancelled', {
      owner: MINE,
      venue: 'c',
      status: BookingStatus.APPROVED,
      slots: [{ start: 8 * DAY, hours: 2, cancelled: true }],
    });
    // At a since-deleted venue: still listed, and its category must stay a facet.
    await seedBooking('atDeletedVenue', {
      owner: MINE,
      venue: 'e',
      status: BookingStatus.REJECTED,
      slots: [{ start: 10 * DAY, hours: 2 }],
    });

    // ── OTHER: must never reach MINE's rows, count or facets ──
    await seedBooking('otherApproved', {
      owner: OTHER,
      venue: 'x',
      status: BookingStatus.APPROVED,
      slots: [{ start: 4 * DAY, hours: 2 }],
    });
    await seedBooking('otherPending', {
      owner: OTHER,
      venue: 'a',
      status: BookingStatus.PENDING,
      slots: [{ start: 2 * DAY, hours: 2 }],
    });
  };

  const PENDING = ['pending'];
  const APPROVED = [
    'approvedFuture',
    'approvedLastSlotCancelled',
    'approvedInProgress',
  ];
  const HISTORY = [
    'pendingAllCancelled',
    'done',
    'rejected',
    'expired',
    'cancelled',
    'approvedAllCancelled',
    'atDeletedVenue',
  ];
  const ALL_MINE = [...PENDING, ...APPROVED, ...HISTORY];
  const codes = (labels: string[]) => labels.map((l) => B[l]).sort();

  // ───────────────────────────── lifecycle ─────────────────────────────

  beforeAll(async () => {
    jest.spyOn(global, 'fetch').mockImplementation((_input, init) => {
      const body = init?.body as URLSearchParams | undefined;
      if (body?.get('id_token') === 'invalid') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: 'invalid_request' }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            iss: 'https://access.line.me',
            sub: currentSub,
            aud: CHANNEL_ID,
            exp: futureExp(),
          }),
      } as Response);
    });

    app = await createE2eApp();
    // Booking writes push LINE cards since CLIENT-NOTIFY-1; never reach the real Messaging API.
    jest.spyOn(app.get(LineService), 'push').mockResolvedValue(undefined);
    prisma = prismaOf(app);
    await seed();
  }, 90_000);

  afterAll(async () => {
    await purgeRows();
    jest.restoreAllMocks();
    await app.close();
  });

  const get = (path: string, sub: string, token = 'good-token') => {
    currentSub = sub;
    return request(server())
      .get(url(path))
      .set('Authorization', `Bearer ${token}`);
  };

  const venues = async (query: string, sub = MINE) =>
    (await get(`/line-users/venues?q=${PREFIX}${query}`, sub).expect(200))
      .body as Envelope<VenueRow>;

  const bookings = async (query = '', sub = MINE) =>
    (await get(`/line-users/bookings?${query}`, sub).expect(200))
      .body as Envelope<BookingRow>;

  const facetIds = (f: Facets) => f.venueTypes.map((t) => t.id).sort();

  // ═════════════════════════ GET /line-users/venues ═════════════════════════

  describe('GET /line-users/venues', () => {
    it('401s with no Authorization header', async () => {
      await request(server()).get(url('/line-users/venues')).expect(401);
    });

    it('returns { data, meta, facets }, bookable venues first, deleted venues never', async () => {
      const body = await venues('&limit=100');

      expect(Object.keys(body).sort()).toEqual(['data', 'facets', 'meta']);
      // 🔴 The order the page used to compute in the browser: open by name, THEN closed.
      expect(body.data.map((v) => v.name)).toEqual(
        ['a', 'c', 'd', 'x', 'b'].map((n) => `${PREFIX}${n}`),
      );
      expect(body.meta).toEqual({
        page: 1,
        limit: 100,
        total: 5,
        totalPages: 1,
      });
    });

    it('defaults to 12 per page', async () => {
      expect((await venues('')).meta.limit).toBe(12);
    });

    it('pages without gaps or repeats, and a page past the end is an empty 200', async () => {
      const full = (await venues('&limit=100')).data.map((v) => v.id);
      const paged: string[] = [];
      for (let page = 1; page <= 3; page++) {
        const body = await venues(`&limit=2&page=${page}`);
        expect(body.meta).toEqual({ page, limit: 2, total: 5, totalPages: 3 });
        paged.push(...body.data.map((v) => v.id));
      }
      expect(paged).toEqual(full);

      const beyond = await venues('&limit=2&page=4');
      expect(beyond.data).toEqual([]);
      expect(beyond.meta.total).toBe(5);
    });

    it('filters by status and venueTypeId in the database, so meta.total is the filtered count', async () => {
      const open = await venues('&status=open');
      expect(open.meta.total).toBe(4);
      expect(open.data.every((v) => v.isOpen)).toBe(true);

      const closed = await venues('&status=closed');
      expect(closed.data.map((v) => v.name)).toEqual([`${PREFIX}b`]);

      const gym = await venues(`&venueTypeId=${T.gym}`);
      expect(gym.data.map((v) => v.name)).toEqual([`${PREFIX}c`, `${PREFIX}d`]);
      expect(gym.meta.total).toBe(2);
    });

    it('🔴 facets list the searched set’s categories and ignore the type, status and page', async () => {
      const expected = [T.hall, T.gym, T.otherOnly].sort();

      for (const query of [
        '',
        `&venueTypeId=${T.gym}`,
        '&status=closed',
        '&limit=1&page=5',
      ]) {
        // A category whose only venue is soft-deleted is a dead end, so `deletedOnly` is absent.
        expect(facetIds((await venues(query)).facets)).toEqual(expected);
      }
    });

    it('facets follow q', async () => {
      expect(facetIds((await venues('c')).facets)).toEqual([T.gym]);
    });

    it('400s out-of-bounds paging and unknown keys', async () => {
      for (const query of [
        'page=0',
        'page=abc',
        'page=1.5',
        'limit=0',
        'limit=101',
        'sort=name',
      ]) {
        await get(`/line-users/venues?${query}`, MINE).expect(400);
      }
    });
  });

  // ═════════════════════════ GET /line-users/bookings ═════════════════════════

  describe('GET /line-users/bookings', () => {
    it('401s with no token and 403s a caller who is not ALLOWED', async () => {
      await request(server()).get(url('/line-users/bookings')).expect(401);
      await get('/line-users/bookings', NOT_ALLOWED).expect(403);
    });

    it('returns { data, meta, facets }, owner-scoped, 10 per page by default', async () => {
      const body = await bookings();

      expect(Object.keys(body).sort()).toEqual(['data', 'facets', 'meta']);
      expect(body.meta).toEqual({
        page: 1,
        limit: 10,
        total: 11,
        totalPages: 2,
      });
      expect(body.data).toHaveLength(10);

      const all = await bookings('limit=100');
      // 🔴 Nothing of OTHER's, ever.
      expect(all.data.map((b) => b.code).sort()).toEqual(codes(ALL_MINE));
    });

    it('🔴 each state returns exactly its bucket', async () => {
      const read = async (state: string) =>
        (await bookings(`state=${state}&limit=100`)).data
          .map((b) => b.code)
          .sort();

      expect(await read('pending')).toEqual(codes(PENDING));
      expect(await read('approved')).toEqual(codes(APPROVED));
      expect(await read('history')).toEqual(codes(HISTORY));
    });

    it('🔴 the three buckets partition the set: disjoint, and their totals sum to the full total', async () => {
      const full = await bookings('limit=100');
      const parts = await Promise.all(
        ['pending', 'approved', 'history'].map((s) =>
          bookings(`state=${s}&limit=100`),
        ),
      );

      const totals = parts.map((p) => p.meta.total);
      expect(totals.reduce((a, b) => a + b, 0)).toBe(full.meta.total);

      const union = parts.flatMap((p) => p.data.map((b) => b.id));
      expect(new Set(union).size).toBe(union.length);
      expect(union.sort()).toEqual(full.data.map((b) => b.id).sort());
    });

    it('🔴 an APPROVED booking whose last slot is cancelled but still ahead is approved, not history', async () => {
      // `lastEndAt` in the row is in the PAST. Reading it would misfile this booking.
      const history = await bookings('state=history&limit=100');
      expect(history.data.map((b) => b.code)).not.toContain(
        B.approvedLastSlotCancelled,
      );
      const approved = await bookings('state=approved&limit=100');
      expect(approved.data.map((b) => b.code)).toContain(
        B.approvedLastSlotCancelled,
      );
    });

    it('buckets bookings with no live slot as history whatever their status, and reads EXPIRED from the status', async () => {
      const history = (await bookings('state=history&limit=100')).data.map(
        (b) => b.code,
      );
      expect(history).toEqual(
        expect.arrayContaining([
          B.pendingAllCancelled,
          B.approvedAllCancelled,
          B.expired,
          B.done,
        ]),
      );
      expect(history).not.toContain(B.approvedInProgress);
    });

    it('pages without gaps or repeats, in the requested sort, and a page past the end is an empty 200', async () => {
      const full = (await bookings('limit=100&sort=event-asc')).data.map(
        (b) => b.code,
      );
      const paged: string[] = [];
      for (let page = 1; page <= 4; page++) {
        const body = await bookings(`limit=3&page=${page}&sort=event-asc`);
        expect(body.meta).toEqual({ page, limit: 3, total: 11, totalPages: 4 });
        paged.push(...body.data.map((b) => b.code));
      }
      expect(paged).toEqual(full);

      const beyond = await bookings('limit=3&page=5');
      expect(beyond.data).toEqual([]);
      expect(beyond.meta.total).toBe(11);
    });

    it('combines venueTypeId with state', async () => {
      const gym = await bookings(`venueTypeId=${T.gym}&limit=100`);
      expect(gym.data.every((b) => b.venue.venueType.id === T.gym)).toBe(true);
      expect(gym.meta.total).toBe(5);

      const gymHistory = await bookings(
        `venueTypeId=${T.gym}&state=history&limit=100`,
      );
      expect(gymHistory.data.map((b) => b.code).sort()).toEqual(
        codes(['done', 'rejected', 'cancelled', 'approvedAllCancelled']),
      );
    });

    it('🔴 facets never leak another user’s venue categories', async () => {
      // MINE booked hall, gym and the deleted-venue category — never `otherOnly`, which only OTHER
      // booked. A facet query without the ownership clause would include it.
      const mine = await bookings();
      expect(facetIds(mine.facets)).toEqual(
        [T.hall, T.gym, T.deletedOnly].sort(),
      );
      expect(facetIds(mine.facets)).not.toContain(T.otherOnly);

      // And the same query answered for OTHER is OTHER's own set.
      const other = await bookings('', OTHER);
      expect(facetIds(other.facets)).toEqual([T.hall, T.otherOnly].sort());

      // Naming the other user's category as a filter widens nothing either.
      const probe = await bookings(`venueTypeId=${T.otherOnly}`);
      expect(probe.data).toEqual([]);
      expect(probe.meta.total).toBe(0);
    });

    it('facets ignore state, venueTypeId and page, and follow q', async () => {
      const expected = [T.hall, T.gym, T.deletedOnly].sort();
      for (const query of [
        'state=pending',
        `venueTypeId=${T.gym}`,
        'limit=1&page=20',
      ]) {
        expect(facetIds((await bookings(query)).facets)).toEqual(expected);
      }

      const searched = await bookings(`q=${encodeURIComponent(B.done)}`);
      expect(searched.data.map((b) => b.code)).toEqual([B.done]);
      expect(facetIds(searched.facets)).toEqual([T.gym]);
    });

    it('🔴 400s the retired `status` parameter, an invalid state and out-of-bounds paging', async () => {
      for (const query of [
        'status=APPROVED',
        'state=done',
        'state=APPROVED',
        'venueTypeId=abc',
        'page=0',
        'limit=101',
      ]) {
        await get(`/line-users/bookings?${query}`, MINE).expect(400);
      }
    });
  });
});
