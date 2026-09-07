// The LINE Login channel id the guard verifies id_token `aud` against. MUST be set before the app
// boots (ConfigModule reads process.env at forRoot). Digits only, per env.validation.
process.env.LINE_LOGIN_CHANNEL_ID =
  process.env.LINE_LOGIN_CHANNEL_ID ?? '1234567890';

import type { INestApplication } from '@nestjs/common';
import { AppAccess, BookingStatus } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { API_BASE_PATH } from '../src/common/api.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, ensureE2eOptions, prismaOf } from './e2e-app';

jest.setTimeout(120_000);

const CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;
const PREFIX = 'e2esch-';
const url = (path: string) => `${API_BASE_PATH}${path}`;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const BANGKOK_OFFSET = 420 * 60_000;

interface ScheduleRow {
  id: string;
  startAt: string;
  endAt: string;
  venueId: string;
  venueName: string;
  venueTypeId: number | null;
  venueTypeName: string | null;
  purpose: string;
  requesterName: string | null;
  isMine: boolean;
}

/** Exactly `LineScheduleSlotDto`'s keys — the wire contract, asserted on the response. */
const ROW_KEYS = [
  'endAt',
  'id',
  'isMine',
  'purpose',
  'requesterName',
  'startAt',
  'venueId',
  'venueName',
  'venueTypeId',
  'venueTypeName',
].sort();

/** The verify-endpoint mock's current answer. Mirrors `line-settings.e2e-spec.ts`. */
let currentSub = '';
const futureExp = () => Math.floor(Date.now() / 1000) + 3600;

/**
 * The first instant of the CURRENT Bangkok calendar month, and of the next one — the window the
 * endpoint defaults to. Recomputed rather than hard-coded so the suite does not expire.
 */
const bangkokMonth = () => {
  const local = new Date(Date.now() + BANGKOK_OFFSET);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1) - BANGKOK_OFFSET),
    next: new Date(Date.UTC(y, m + 1, 1) - BANGKOK_OFFSET),
  };
};

/**
 * `GET /line-users/schedule` (Phase 7b) against the real HTTP pipeline `configureApp` assembles.
 *
 * 🔴 THREE OF THE PROPERTIES BELOW CANNOT BE PROVEN BY A UNIT SPEC, and each fails silently:
 *
 * 1. **Route resolution.** `GET /line-users/schedule` is a 2-segment GET sharing its base path with
 *    three other controllers, one of which (`LineUsersController`) is registered FIRST because
 *    `LineModule` precedes `BookingsModule` in `app.module.ts`. Reading the registration order is how
 *    a shadowed route survives review; a 200 carrying schedule rows is how it does not. The unit spec
 *    calls the service directly and would pass even if the route answered from another handler.
 * 2. **The guard is actually applied.** `LineIdTokenGuard` is a decorator — an omitted `@UseGuards`
 *    still compiles, still passes every unit test, and publishes the whole school's calendar.
 * 3. **The filters run in Postgres, not in a mock.** `bookingRequest: { status: APPROVED }` and
 *    `venue: { deletedAt: null }` are relation filters; a mocked `findMany` echoes back whatever it
 *    was told to, so only real rows prove a pending request is genuinely absent.
 */
describe('LINE master schedule (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const server = () => app.getHttpServer();

  const MINE = `${PREFIX}U-mine`;
  const OTHER = `${PREFIX}U-other`;
  const STAFFISH = `${PREFIX}U-staffish`;
  const NOT_ALLOWED = `${PREFIX}U-pending`;

  const ids: Record<string, string> = {};
  let liveVenueId = '';
  let deletedVenueId = '';
  let codeSeq = 0;
  let month = bangkokMonth();

  // ───────────────────────────── fixtures ─────────────────────────────

  /**
   * Raw SQL, and the ORDER IS LOAD-BEARING. `BookingRequest.lineUserId` is `onDelete: SetNull`, so
   * deleting a LINE user first would null the only owner column on its requests and trip
   * `booking_requests_owner_check`. Bookings go first, always.
   */
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
    // `line_user_registrations` is ON DELETE CASCADE.
    await prisma.$executeRawUnsafe(
      `DELETE FROM line_users WHERE "lineUserId" LIKE '${PREFIX}%'`,
    );
  };

  const seedBooking = async (opts: {
    venueId: string;
    ownerSub: string;
    status: BookingStatus;
    startAt: Date;
    endAt: Date;
    purpose: string;
    cancelled?: boolean;
    requesterName?: string;
  }) =>
    prisma.bookingRequest.create({
      data: {
        code: `${PREFIX}${String(++codeSeq).padStart(4, '0')}`,
        venueId: opts.venueId,
        lineUserId: ids[opts.ownerSub],
        requesterName: opts.requesterName,
        purpose: opts.purpose,
        attendees: 20,
        status: opts.status,
        firstStartAt: opts.startAt,
        lastEndAt: opts.endAt,
        slots: {
          create: [
            {
              venueId: opts.venueId,
              startAt: opts.startAt,
              endAt: opts.endAt,
              ...(opts.cancelled
                ? { isCancelled: true, cancelledAt: new Date() }
                : {}),
            },
          ],
        },
      },
      select: { id: true, code: true },
    });

  const seed = async () => {
    await purgeRows();
    codeSeq = 0;
    month = bangkokMonth();
    const options = await ensureE2eOptions(prisma);

    const typeId = (
      await prisma.venueType.create({
        data: { name: `${PREFIX}หอประชุม` },
        select: { id: true },
      })
    ).id;
    liveVenueId = (
      await prisma.venue.create({
        data: { name: `${PREFIX}main`, venueTypeId: typeId, capacity: 100 },
        select: { id: true },
      })
    ).id;
    // Soft-deleted at birth: the row still exists and still owns its bookings, which is exactly the
    // state that must not reach the calendar.
    deletedVenueId = (
      await prisma.venue.create({
        data: {
          name: `${PREFIX}retired`,
          venueTypeId: typeId,
          capacity: 50,
          deletedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;

    for (const [sub, access, first] of [
      [MINE, AppAccess.ALLOWED, 'สมชาย'],
      [OTHER, AppAccess.ALLOWED, 'มานี'],
      [NOT_ALLOWED, AppAccess.PENDING, 'ปิติ'],
    ] as Array<[string, AppAccess, string]>) {
      const row = await prisma.lineUser.create({
        data: {
          lineUserId: sub,
          access,
          registration: {
            create: {
              firstName: first,
              lastName: 'ใจดี',
              phone: '081-234-5678',
              phoneDigits: '0812345678',
              ...options,
            },
          },
        },
        select: { id: true },
      });
      ids[sub] = row.id;
    }
    // 🔴 NO REGISTRATION ON PURPOSE. It stands in for the ADMIN origin (`D-C18`): the name has to
    // fall back to the `requesterName` override, and a suite whose every row resolves through a
    // registration never exercises that branch.
    ids[STAFFISH] = (
      await prisma.lineUser.create({
        data: { lineUserId: STAFFISH, access: AppAccess.ALLOWED },
        select: { id: true },
      })
    ).id;

    // ── the rows, all inside the current Bangkok month unless said otherwise ──
    // ⚠️ THE APPROVED SPANS ON `liveVenueId` MUST NOT OVERLAP EACH OTHER: `booking_slots_no_overlap`
    // is a real GiST exclusion constraint and would reject the fixture, not the test.
    const at = (days: number) => new Date(month.start.getTime() + days * DAY);

    await seedBooking({
      venueId: liveVenueId,
      ownerSub: MINE,
      status: BookingStatus.APPROVED,
      startAt: at(2),
      endAt: new Date(at(2).getTime() + 2 * HOUR),
      purpose: 'ประชุมผู้ปกครองระดับชั้น ม.3',
    });
    await seedBooking({
      venueId: liveVenueId,
      ownerSub: OTHER,
      status: BookingStatus.APPROVED,
      startAt: at(3),
      endAt: new Date(at(3).getTime() + 2 * HOUR),
      purpose: 'อบรมครูผู้ช่วย',
    });
    await seedBooking({
      venueId: liveVenueId,
      ownerSub: STAFFISH,
      status: BookingStatus.APPROVED,
      startAt: at(4),
      endAt: new Date(at(4).getTime() + 2 * HOUR),
      purpose: 'กิจกรรมฝ่ายกิจการนักเรียน',
      requesterName: 'ฝ่ายกิจการนักเรียน',
    });
    // 🔴 Same hour as the first row, and legal: a PENDING request holds nothing (`D-C13` rule 4).
    await seedBooking({
      venueId: liveVenueId,
      ownerSub: OTHER,
      status: BookingStatus.PENDING,
      startAt: at(2),
      endAt: new Date(at(2).getTime() + 2 * HOUR),
      purpose: 'PENDING-MUST-NOT-APPEAR',
    });
    await seedBooking({
      venueId: liveVenueId,
      ownerSub: OTHER,
      status: BookingStatus.APPROVED,
      startAt: at(5),
      endAt: new Date(at(5).getTime() + 2 * HOUR),
      purpose: 'CANCELLED-MUST-NOT-APPEAR',
      cancelled: true,
    });
    await seedBooking({
      venueId: deletedVenueId,
      ownerSub: OTHER,
      status: BookingStatus.APPROVED,
      startAt: at(6),
      endAt: new Date(at(6).getTime() + 2 * HOUR),
      purpose: 'DELETED-VENUE-MUST-NOT-APPEAR',
    });
    // Next month: outside the default window, reachable with an explicit `from`/`to`.
    await seedBooking({
      venueId: liveVenueId,
      ownerSub: OTHER,
      status: BookingStatus.APPROVED,
      startAt: new Date(month.next.getTime() + DAY),
      endAt: new Date(month.next.getTime() + DAY + 2 * HOUR),
      purpose: 'NEXT-MONTH',
    });
    // Straddles the window's opening edge: begins before `from`, ends after it. Must be RETURNED —
    // overlap, not containment.
    await seedBooking({
      venueId: liveVenueId,
      ownerSub: OTHER,
      status: BookingStatus.APPROVED,
      startAt: new Date(month.start.getTime() - 6 * HOUR),
      endAt: new Date(month.start.getTime() + 6 * HOUR),
      purpose: 'ค่ายพักแรมข้ามเดือน',
    });
  };

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
    prisma = prismaOf(app);
    await seed();
  }, 90_000);

  afterAll(async () => {
    await purgeRows();
    jest.restoreAllMocks();
    await app.close();
  });

  const read = (sub: string, query = '', token = 'good-token') => {
    currentSub = sub;
    return request(server())
      .get(url(`/line-users/schedule${query}`))
      .set('Authorization', `Bearer ${token}`);
  };

  const rowsOf = (res: request.Response) =>
    (res.body as ScheduleRow[]).filter((r) => r.venueName.startsWith(PREFIX));

  // ───────────────────────────── the guard ─────────────────────────────

  it('401s with no Authorization header', async () => {
    await request(server()).get(url('/line-users/schedule')).expect(401);
  });

  it('401s when LINE rejects the token', async () => {
    await read(MINE, '', 'invalid').expect(401);
  });

  it('403s a registered user whose access is not ALLOWED', async () => {
    // 🔴 The schedule is not public. PENDING/REJECTED/BLOCKED all get the same answer as an
    // unregistered caller — no oracle, and no peek at the school's calendar before approval.
    await read(NOT_ALLOWED).expect(403);
  });

  it('403s a LINE user this service has never seen', async () => {
    await read(`${PREFIX}U-ghost`).expect(403);
  });

  // ───────────────────────────── route resolution ─────────────────────────────

  it('🔴 reaches THIS handler — the 2-segment GET is not shadowed by the admin controller', async () => {
    // A 200 carrying schedule-shaped rows is the whole assertion. `LineUsersController` registers
    // first (`LineModule` precedes `BookingsModule`); the day it grows a `GET :id`, this fails.
    const res = await read(MINE).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(rowsOf(res).length).toBeGreaterThan(0);
    expect(Object.keys(rowsOf(res)[0]).sort()).toEqual(ROW_KEYS);
  });

  // ───────────────────────────── the filters ─────────────────────────────

  it('returns approved activity across ALL venues, and excludes pending, cancelled and deleted-venue rows', async () => {
    const rows = rowsOf(await read(MINE).expect(200));
    const purposes = rows.map((r) => r.purpose);

    expect(purposes).toContain('ประชุมผู้ปกครองระดับชั้น ม.3');
    expect(purposes).toContain('อบรมครูผู้ช่วย');
    expect(purposes).toContain('กิจกรรมฝ่ายกิจการนักเรียน');
    // Overlap, not containment — the cross-month camp occupies day one of the window.
    expect(purposes).toContain('ค่ายพักแรมข้ามเดือน');

    // 🔴 The three exclusions this endpoint exists to make. A PENDING request is not a fact about
    // the school; a cancelled slot is a freed hour; a retired room is not on the calendar.
    expect(purposes).not.toContain('PENDING-MUST-NOT-APPEAR');
    expect(purposes).not.toContain('CANCELLED-MUST-NOT-APPEAR');
    expect(purposes).not.toContain('DELETED-VENUE-MUST-NOT-APPEAR');
    // And the default window is a month, so next month is out.
    expect(purposes).not.toContain('NEXT-MONTH');

    expect(rows.every((r) => r.venueId === liveVenueId)).toBe(true);
    expect(rows.some((r) => r.venueId === deletedVenueId)).toBe(false);
  });

  it('orders by startAt ascending', async () => {
    const starts = rowsOf(await read(MINE).expect(200)).map((r) =>
      Date.parse(r.startAt),
    );
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('honours an explicit half-open window — `to` is EXCLUSIVE', async () => {
    const from = month.next.toISOString();
    const to = new Date(month.next.getTime() + 10 * DAY).toISOString();
    const rows = rowsOf(await read(MINE, `?from=${from}&to=${to}`).expect(200));

    expect(rows.map((r) => r.purpose)).toEqual(['NEXT-MONTH']);
  });

  it('400s a malformed date, a reversed range and an unknown query key', async () => {
    await read(MINE, '?from=not-a-date').expect(400);
    await read(
      MINE,
      `?from=${month.next.toISOString()}&to=${month.start.toISOString()}`,
    ).expect(400);
    // `forbidNonWhitelisted` — the DTO is the contract, and `venueId` is deliberately not on it.
    await read(MINE, `?venueId=${liveVenueId}`).expect(400);
  });

  // ───────────────────────────── the payload ─────────────────────────────

  it('flattens the venue and resolves the requester from both origins', async () => {
    const rows = rowsOf(await read(MINE).expect(200));
    const mine = rows.find((r) => r.purpose === 'ประชุมผู้ปกครองระดับชั้น ม.3');
    const staffish = rows.find(
      (r) => r.purpose === 'กิจกรรมฝ่ายกิจการนักเรียน',
    );

    expect(mine?.venueName).toBe(`${PREFIX}main`);
    expect(mine?.venueTypeName).toBe(`${PREFIX}หอประชุม`);
    expect(typeof mine?.venueTypeId).toBe('number');
    // LIFF origin: through the LINE registration.
    expect(mine?.requesterName).toBe('สมชาย ใจดี');
    // Admin origin (`D-C18`): through the `requesterName` override.
    expect(staffish?.requesterName).toBe('ฝ่ายกิจการนักเรียน');
  });

  it('🔴 isMine is true only for the CALLER’s own activity, and flips with the caller', async () => {
    const asMine = rowsOf(await read(MINE).expect(200));
    expect(
      asMine.find((r) => r.purpose === 'ประชุมผู้ปกครองระดับชั้น ม.3')?.isMine,
    ).toBe(true);
    expect(asMine.find((r) => r.purpose === 'อบรมครูผู้ช่วย')?.isMine).toBe(
      false,
    );

    // The same rows read by the other user: exactly the inverse. A mapper wired to a constant, or
    // one comparing the `U…` sub against the cuid FK, passes one direction and fails this.
    const asOther = rowsOf(await read(OTHER).expect(200));
    expect(
      asOther.find((r) => r.purpose === 'ประชุมผู้ปกครองระดับชั้น ม.3')?.isMine,
    ).toBe(false);
    expect(asOther.find((r) => r.purpose === 'อบรมครูผู้ช่วย')?.isMine).toBe(
      true,
    );
  });
});
