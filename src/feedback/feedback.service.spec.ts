import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AppAccess, FeedbackType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { R2StorageService } from '../storage/r2-storage.service';
import type { CreateFeedbackDto } from './dto/feedback.dto';
import { FeedbackService } from './feedback.service';
import {
  FEEDBACK_CODE_MAX_ATTEMPTS,
  FEEDBACK_NOT_ALLOWED,
  FEEDBACK_PHOTO_URL_INVALID,
  FEEDBACK_VENUE_INVALID,
} from './feedback.constants';

const SUB = 'U0123456789abcdef0123456789abcdef';
const LINE_USER_ID = 'clx_lineuser_cuid';
const VENUE_ID = 'clx_venue_cuid';
const BASE = 'https://pub-abc123.r2.dev';
const OUR_PHOTO = `${BASE}/feedback/0123456789abcdef0123456789abcdef.jpg`;

const dto = (over: Partial<CreateFeedbackDto> = {}): CreateFeedbackDto => ({
  type: FeedbackType.ISSUE,
  subject: 'แอร์ห้องประชุม 1 ไม่เย็น',
  description: 'แอร์ตัวที่อยู่ฝั่งหน้าต่างไม่ทำงานมา 3 วันแล้วครับ',
  ...over,
});

const p2002 = (target: string[]) =>
  new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { target },
  });

/**
 * ⚠️ THESE ARE NOT PRISMA'S REAL ARGUMENT TYPES and must not be mistaken for them — they describe
 * only the keys these tests read, the same compromise `bookings.service.spec.ts` documents. The
 * compiler still checks the SERVICE against the real ones, because that is where the real client is
 * injected.
 */
type CreateArgs = {
  data: {
    code: string;
    type: FeedbackType;
    lineUserId: string;
    venueId: string | null;
    subject: string;
    description: string;
    photos: string[];
    status?: unknown;
  };
};

type CountArgs = {
  where: { type: FeedbackType; createdAt: { gte: Date; lt: Date } };
};

type LineUserFindArgs = {
  where: { lineUserId: string; deletedAt: null };
  select: Record<string, boolean>;
};

type VenueFindArgs = {
  where: { id: string; deletedAt: null; isOpen?: boolean };
  select: Record<string, boolean>;
};

describe('FeedbackService', () => {
  let service: FeedbackService;

  const lineUser = { findFirst: jest.fn<any, [LineUserFindArgs]>() };
  const venue = { findFirst: jest.fn<any, [VenueFindArgs]>() };
  const feedback = {
    count: jest.fn<any, [CountArgs]>(),
    create: jest.fn<any, [CreateArgs]>(),
  };
  // The interactive form runs the callback against the same mocks, so the assertions below see the
  // statements the transaction would actually issue.
  const $transaction = jest.fn((run: (tx: unknown) => unknown) =>
    run({ feedback }),
  );
  const publicBaseUrl = jest.fn();

  const prisma = {
    lineUser,
    venue,
    feedback,
    $transaction,
  } as unknown as PrismaService;
  const storage = { publicBaseUrl } as unknown as R2StorageService;

  /** The row Prisma would hand back, echoing whatever the create was asked to write. */
  const createdRow = (args: CreateArgs) => ({
    id: 'clx_feedback_cuid',
    ...args.data,
    createdAt: new Date('2026-09-20T13:05:00.000Z'),
    updatedAt: new Date('2026-09-20T13:05:00.000Z'),
    status: 'PENDING',
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks clears CALLS, not implementations.
    lineUser.findFirst.mockResolvedValue({
      id: LINE_USER_ID,
      access: AppAccess.ALLOWED,
    });
    venue.findFirst.mockResolvedValue({ id: VENUE_ID, name: 'ห้องประชุม 1' });
    feedback.count.mockResolvedValue(0);
    feedback.create.mockImplementation((args: CreateArgs) =>
      Promise.resolve(createdRow(args)),
    );
    publicBaseUrl.mockReturnValue(BASE);
    service = new FeedbackService(prisma, storage);
  });

  // ───────────────────────── who: the 403 ladder (AC-34, AC-35) ─────────────────────────

  it('🔴 resolves the U… sub to the CUID and never lets the sub reach a FK column', async () => {
    await service.create(SUB, dto());

    // The lookup is BY the LINE-side string…
    expect(lineUser.findFirst.mock.calls[0][0].where.lineUserId).toBe(SUB);
    // …and what is WRITTEN is the cuid. This is the whole of AC-34: the two values are both
    // strings, so the wrong one type-checks perfectly and fails only at runtime, forever.
    expect(feedback.create.mock.calls[0][0].data.lineUserId).toBe(LINE_USER_ID);
    expect(feedback.create.mock.calls[0][0].data.lineUserId).not.toBe(SUB);
  });

  it('treats a soft-deleted (unfollowed) user as absent — it is part of the `where`', async () => {
    expect.assertions(2);
    lineUser.findFirst.mockResolvedValue(null);

    await expect(service.create(SUB, dto())).rejects.toThrow(
      new ForbiddenException(FEEDBACK_NOT_ALLOWED),
    );
    // Filtered in the query rather than after it: a query that cannot return a deleted row cannot
    // leak one by accident.
    expect(lineUser.findFirst.mock.calls[0][0].where.deletedAt).toBeNull();
  });

  it.each([
    AppAccess.UNREGISTERED,
    AppAccess.PENDING,
    AppAccess.REJECTED,
    AppAccess.BLOCKED,
  ])('refuses %s with ONE message and never writes', async (access) => {
    lineUser.findFirst.mockResolvedValue({ id: LINE_USER_ID, access });

    await expect(service.create(SUB, dto())).rejects.toThrow(
      new ForbiddenException(FEEDBACK_NOT_ALLOWED),
    );
    expect(feedback.create).not.toHaveBeenCalled();
  });

  // ───────────────────────── where: the venue (E-5, AC-10) ─────────────────────────

  it('persists NULL for a general report, and does not look a venue up', async () => {
    const result = await service.create(SUB, dto());

    expect(venue.findFirst).not.toHaveBeenCalled();
    expect(feedback.create.mock.calls[0][0].data.venueId).toBeNull();
    expect(result.venueId).toBeNull();
    expect(result.venueName).toBeNull();
  });

  it('treats an explicit null venueId exactly like an absent one', async () => {
    // Absent and `null` are the SAME input: both mean ปัญหาทั่วไป / ไม่ระบุสถานที่.
    await service.create(SUB, dto({ venueId: null }));

    expect(venue.findFirst).not.toHaveBeenCalled();
    expect(feedback.create.mock.calls[0][0].data.venueId).toBeNull();
  });

  it('🔴 answers 400, NOT 404, for a venue that is unknown or soft-deleted (E-5)', async () => {
    expect.assertions(3);
    venue.findFirst.mockResolvedValue(null);

    await expect(
      service.create(SUB, dto({ venueId: VENUE_ID })),
    ).rejects.toThrow(new BadRequestException(FEEDBACK_VENUE_INVALID));
    // The venue is an INPUT to this write, not the resource being addressed — so one message for
    // "never existed" and "deleted", and no enumeration oracle over `venues`.
    expect(venue.findFirst.mock.calls[0][0].where.deletedAt).toBeNull();
    expect(feedback.create).not.toHaveBeenCalled();
  });

  it('⚠️ accepts a CLOSED venue — isOpen is deliberately not part of the lookup', async () => {
    // A closed venue is exactly the venue somebody needs to report a problem about; `VENUE_CLOSED`
    // belongs to booking, not to reporting.
    const result = await service.create(SUB, dto({ venueId: VENUE_ID }));

    expect(venue.findFirst.mock.calls[0][0].where.isOpen).toBeUndefined();
    expect(feedback.create.mock.calls[0][0].data.venueId).toBe(VENUE_ID);
    // Resolved from the lookup the service already did, not from a second read after the insert.
    expect(result.venueName).toBe('ห้องประชุม 1');
  });

  // ───────────────────────── what: the photo URLs ─────────────────────────

  it('stores our own photo URLs, in the order they were attached', async () => {
    const second = `${BASE}/feedback/ffffffffffffffffffffffffffffffff.png`;
    await service.create(SUB, dto({ photos: [OUR_PHOTO, second] }));

    expect(feedback.create.mock.calls[0][0].data.photos).toEqual([
      OUR_PHOTO,
      second,
    ]);
  });

  it.each([
    ['a foreign host', 'https://evil.example.com/feedback/x.jpg'],
    ['our host but another prefix', `${BASE}/avatars/u-1/x.jpg`],
    ['our host but no prefix at all', `${BASE}/x.jpg`],
    ['a prefix-lookalike host', `${BASE}.evil.com/feedback/x.jpg`],
  ])('🔴 refuses a photo URL we did not mint — %s', async (_label, url) => {
    await expect(service.create(SUB, dto({ photos: [url] }))).rejects.toThrow(
      new BadRequestException(FEEDBACK_PHOTO_URL_INVALID),
    );
    expect(feedback.create).not.toHaveBeenCalled();
  });

  it('refuses the whole submission when ONE of several URLs is foreign', async () => {
    await expect(
      service.create(
        SUB,
        dto({ photos: [OUR_PHOTO, 'https://evil.example.com/feedback/x.jpg'] }),
      ),
    ).rejects.toThrow(new BadRequestException(FEEDBACK_PHOTO_URL_INVALID));
  });

  it('refuses every URL when the bucket is not configured — a missing base never widens the allowlist', async () => {
    publicBaseUrl.mockReturnValue(undefined);

    await expect(
      service.create(SUB, dto({ photos: [OUR_PHOTO] })),
    ).rejects.toThrow(new BadRequestException(FEEDBACK_PHOTO_URL_INVALID));
  });

  it('writes an empty array when no photos were sent, without asking the bucket anything', async () => {
    await service.create(SUB, dto());

    expect(publicBaseUrl).not.toHaveBeenCalled();
    expect(feedback.create.mock.calls[0][0].data.photos).toEqual([]);
  });

  // ───────────────────────── write: the code, and the retry (AC-37, AC-38) ─────────────────────

  it('mints the code inside the transaction and returns it verbatim', async () => {
    feedback.count.mockResolvedValue(2);

    const result = await service.create(SUB, dto());

    // The value the dialog prints is the value the row carries — the client never computes one.
    expect(result.code).toMatch(/^ISS-\d{8}-003$/);
    expect(result.code).toBe(feedback.create.mock.calls[0][0].data.code);
    // Counted and inserted in ONE transaction, so the count and the write see one snapshot.
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it('uses the FDB prefix for a suggestion — one table, never a branch', async () => {
    const result = await service.create(
      SUB,
      dto({ type: FeedbackType.FEEDBACK }),
    );

    expect(result.code).toMatch(/^FDB-\d{8}-001$/);
    expect(feedback.count.mock.calls[0][0].where.type).toBe(
      FeedbackType.FEEDBACK,
    );
  });

  it('🔴 retries the WHOLE transaction on a `code` collision, so the retry re-counts', async () => {
    feedback.create
      .mockRejectedValueOnce(p2002(['code']))
      .mockImplementation((args: CreateArgs) =>
        Promise.resolve(createdRow(args)),
      );

    const result = await service.create(SUB, dto());

    expect(result.code).toMatch(/^ISS-\d{8}-001$/);
    // Two transactions, two counts: a P2002 aborts the transaction, so only a NEW one can see the
    // row that beat it. A retry inside the transaction would recount to the same taken number.
    expect($transaction).toHaveBeenCalledTimes(2);
    expect(feedback.count).toHaveBeenCalledTimes(2);
  });

  it('rethrows a P2002 that is NOT about `code`, without retrying', async () => {
    feedback.create.mockRejectedValue(p2002(['lineUserId']));

    await expect(service.create(SUB, dto())).rejects.toMatchObject({
      code: 'P2002',
    });
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it('gives up after the last attempt rather than looping forever', async () => {
    feedback.create.mockRejectedValue(p2002(['code']));

    await expect(service.create(SUB, dto())).rejects.toMatchObject({
      code: 'P2002',
    });
    expect($transaction).toHaveBeenCalledTimes(FEEDBACK_CODE_MAX_ATTEMPTS);
  });

  // ───────────────────────── the response body ─────────────────────────

  it('answers with the persisted row and nothing about the reporter', async () => {
    const result = await service.create(
      SUB,
      dto({ venueId: VENUE_ID, photos: [OUR_PHOTO] }),
    );

    expect(result.code).toMatch(/^ISS-\d{8}-001$/);
    expect(result).toEqual({
      id: 'clx_feedback_cuid',
      code: result.code,
      type: FeedbackType.ISSUE,
      venueId: VENUE_ID,
      venueName: 'ห้องประชุม 1',
      subject: dto().subject,
      description: dto().description,
      photos: [OUR_PHOTO],
      createdAt: '2026-09-20T13:05:00.000Z',
    });
    // 🔴 Neither the `U…` sub nor the cuid appears in a response body (plan §8).
    expect(JSON.stringify(result)).not.toContain(SUB);
    expect(JSON.stringify(result)).not.toContain(LINE_USER_ID);
  });

  it('never writes `status` — the column default is its only writer this cycle', async () => {
    await service.create(SUB, dto());

    expect(feedback.create.mock.calls[0][0].data.status).toBeUndefined();
  });
});
