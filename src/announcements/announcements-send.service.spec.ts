import {
  BadGatewayException,
  ConflictException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { messagingApi } from '@line/bot-sdk';
import {
  AnnouncementAudience,
  AnnouncementFormat,
  AnnouncementStatus,
  AppAccess,
  Prisma,
} from '@prisma/client';
import { bangkokClock, thaiShortDate } from '../bookings/booking-notifier';
import { LineCallError, type LineErrorKind } from '../line/line-call-error';
import { LineService, type MulticastOutcome } from '../line/line.service';
import { PrismaService } from '../prisma/prisma.service';
import { CONCURRENT_MODIFICATION } from '../system-users/system-users.errors';
import {
  ANNOUNCEMENT_ALREADY_SENT,
  ANNOUNCEMENT_BODY_REQUIRED,
  ANNOUNCEMENT_DEPARTMENT_INVALID,
  ANNOUNCEMENT_LINE_BOT_INFO_UNAVAILABLE,
  ANNOUNCEMENT_LINE_NOT_CONFIGURED,
  ANNOUNCEMENT_LINE_RATE_LIMITED,
  ANNOUNCEMENT_LINE_SEND_FAILED,
  ANNOUNCEMENT_NO_RECIPIENTS_FOUND,
  ANNOUNCEMENT_NOT_FOUND,
  ANNOUNCEMENT_PARTIALLY_SENT,
  ANNOUNCEMENT_SEND_DEADLINE_MS,
  ANNOUNCEMENT_SEND_IN_PROGRESS,
  ANNOUNCEMENT_SEND_TX_TIMEOUT_MS,
} from './announcements.constants';
import { AnnouncementsService } from './announcements.service';

/**
 * `ANNOUNCE-API-2` — `AnnouncementsService.send` / `getLineBotInfo` (design §5.1). Prisma and
 * `LineService` are mocked: nothing here can reach a database or LINE.
 */

const ID = 'clx_announcement_cuid';
const ACTOR = 'clx_admin';
const UPDATED_AT = new Date('2026-09-22T08:05:00.000Z');

/** Staff-authored free text that must never reach a log line (PDPA). */
const TITLE = 'ประชุมผู้ปกครอง คุณสมชาย ใจดี';
const BODY = 'โทร 081-234-5678 เพื่อยืนยัน';

const uid = (n: number) => `U${n.toString(16).padStart(32, '0')}`;

type Settings = { notifications: Prisma.JsonValue } | null;
const user = (lineUserId: string, settings: Settings = null) => ({
  lineUserId,
  settings,
});

const content = (
  over: Partial<{
    title: string;
    body: string;
    format: AnnouncementFormat;
    audience: AnnouncementAudience;
    departmentId: number | null;
    updatedAt: Date;
  }> = {},
) => ({
  title: TITLE,
  body: BODY,
  format: AnnouncementFormat.TEXT,
  audience: AnnouncementAudience.ALL,
  departmentId: null as number | null,
  updatedAt: UPDATED_AT,
  ...over,
});

/** A saved row shaped like `ANNOUNCEMENT_SELECT`'s payload. */
const savedRow = (data: { sentAt: Date; sentCount: number }) => ({
  id: ID,
  title: TITLE,
  body: BODY,
  format: AnnouncementFormat.TEXT,
  status: AnnouncementStatus.SENT,
  audience: AnnouncementAudience.ALL,
  sentAt: data.sentAt,
  sentCount: data.sentCount,
  createdAt: new Date('2026-09-22T08:00:00.000Z'),
  updatedAt: new Date('2026-09-22T08:10:00.000Z'),
  department: null,
  createdBy: { id: ACTOR, firstName: 'วีระ', lastName: 'ทองดี' },
});

const accepted = (n: number): MulticastOutcome => ({
  targetedCount: n,
  acceptedCount: n,
  requestCount: Math.ceil(n / 500),
  failure: null,
});

const failed = (
  kind: Exclude<LineErrorKind, 'ALREADY_ACCEPTED'>,
  status: number | null,
  targeted = 2,
): MulticastOutcome => ({
  targetedCount: targeted,
  acceptedCount: 0,
  requestCount: 2,
  failure: { chunkIndex: 0, kind, status },
});

/** Resolves to the thrown error; fails the test if the promise resolved. */
const caught = async (p: Promise<unknown>): Promise<HttpException> => {
  try {
    await p;
  } catch (e) {
    return e as HttpException;
  }
  throw new Error('expected a rejection');
};
const bodyOf = (e: HttpException) => e.getResponse() as Record<string, unknown>;

type FindManyArgs = {
  where: Prisma.LineUserWhereInput;
  select: unknown;
  orderBy: unknown;
};
type MulticastArgs = [
  string[],
  messagingApi.Message[],
  { retryKeySeed: string; deadlineAt?: number },
];
type UpdateArgs = {
  where: { id: string };
  data: { status: AnnouncementStatus; sentAt: Date; sentCount: number };
};

describe('AnnouncementsService — send / getLineBotInfo (ANNOUNCE-API-2)', () => {
  let service: AnnouncementsService;

  const tx = {
    $queryRaw: jest.fn(),
    announcement: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
    department: { findFirst: jest.fn() },
    lineUser: { findMany: jest.fn() },
  };
  /** Records whether the callback RETURNED (the tx would commit) before any error left `send`. */
  const events: string[] = [];
  const $transaction = jest.fn(
    async (cb: (t: typeof tx) => Promise<unknown>) => {
      const result = await cb(tx);
      events.push('commit');
      return result;
    },
  );
  const line = { multicast: jest.fn(), getBotInfo: jest.fn() };

  let logSpies: jest.SpyInstance[];
  const logged = () =>
    logSpies
      .flatMap((s) =>
        (s.mock.calls as unknown[][]).map((c) => c.map(String).join(' ')),
      )
      .join('\n');

  const lockReturns = (status: AnnouncementStatus | null) =>
    tx.$queryRaw.mockResolvedValue(status === null ? [] : [{ status }]);

  const multicastArgs = (call = 0) =>
    line.multicast.mock.calls[call] as MulticastArgs;
  const updateArgs = () =>
    (tx.announcement.update.mock.calls as unknown[][])[0][0] as UpdateArgs;
  const findManyArgs = () =>
    (tx.lineUser.findMany.mock.calls as unknown[][])[0][0] as FindManyArgs;

  beforeEach(async () => {
    jest.clearAllMocks();
    events.length = 0;
    lockReturns(AnnouncementStatus.DRAFT);
    tx.announcement.findUniqueOrThrow.mockResolvedValue(content());
    tx.department.findFirst.mockResolvedValue({ id: 7 });
    tx.lineUser.findMany.mockResolvedValue([user(uid(1)), user(uid(2))]);
    tx.announcement.update.mockImplementation(
      ({ data }: { data: { sentAt: Date; sentCount: number } }) =>
        Promise.resolve(savedRow(data)),
    );
    line.multicast.mockResolvedValue(accepted(2));
    logSpies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        AnnouncementsService,
        { provide: PrismaService, useValue: { $transaction } },
        { provide: LineService, useValue: line },
      ],
    }).compile();
    service = moduleRef.get(AnnouncementsService);
  });

  afterEach(() => logSpies.forEach((s) => s.mockRestore()));

  const send = () => service.send(ID, ACTOR);

  // ── The lock (D-A) ────────────────────────────────────────────────────────────────────────────
  describe('D-A — the row lock', () => {
    it('takes SELECT … FOR UPDATE NOWAIT first, binding the id as a parameter', async () => {
      await send();
      const [strings, ...values] = tx.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[],
      ];
      expect(strings.join('?').replace(/\s+/g, ' ').trim()).toBe(
        'SELECT "status" FROM "announcements" WHERE "id" = ? FOR UPDATE NOWAIT',
      );
      expect(values).toEqual([ID]);
    });

    it('runs in ONE interactive transaction with the explicit 120 s timeout', async () => {
      await send();
      expect($transaction).toHaveBeenCalledTimes(1);
      expect(($transaction.mock.calls as unknown[][])[0][1]).toEqual({
        timeout: ANNOUNCEMENT_SEND_TX_TIMEOUT_MS,
      });
      expect(ANNOUNCEMENT_SEND_TX_TIMEOUT_MS).toBe(120_000);
    });

    it('55P03 (Prisma P2010) → 409 ANNOUNCEMENT_SEND_IN_PROGRESS, nothing read or sent', async () => {
      tx.$queryRaw.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(
          'Raw query failed. Code: `55P03`. Message: `could not obtain lock on row in relation "announcements"`',
          {
            code: 'P2010',
            clientVersion: '7.8.0',
            meta: {
              driverAdapterError: { cause: { originalCode: '55P03' } },
            },
          },
        ),
      );
      const e = await caught(send());
      expect(e).toBeInstanceOf(ConflictException);
      expect(bodyOf(e)).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message: ANNOUNCEMENT_SEND_IN_PROGRESS,
        code: 'ANNOUNCEMENT_SEND_IN_PROGRESS',
      });
      expect(tx.announcement.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(line.multicast).not.toHaveBeenCalled();
    });

    it('any other lock-query failure is rethrown unchanged (not a 409)', async () => {
      const boom = new Error('connection reset');
      tx.$queryRaw.mockRejectedValue(boom);
      await expect(send()).rejects.toBe(boom);
      expect(line.multicast).not.toHaveBeenCalled();
    });

    it('a write conflict before LINE is the house 409 (mapTransactionError)', async () => {
      tx.announcement.findUniqueOrThrow.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('write conflict', {
          code: 'P2034',
          clientVersion: '7.8.0',
        }),
      );
      await expect(send()).rejects.toThrow(
        new ConflictException(CONCURRENT_MODIFICATION),
      );
      expect(line.multicast).not.toHaveBeenCalled();
    });
  });

  // ── Validation order (D-D, AC-8) ──────────────────────────────────────────────────────────────
  describe('D-D — validation order; none of these calls LINE (AC-8)', () => {
    afterEach(() => {
      expect(line.multicast).not.toHaveBeenCalled();
      expect(tx.announcement.update).not.toHaveBeenCalled();
    });

    it('unknown id (lock finds no row) → 404 ANNOUNCEMENT_NOT_FOUND', async () => {
      lockReturns(null);
      const e = await caught(send());
      expect(e.getStatus()).toBe(404);
      expect(bodyOf(e)).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: ANNOUNCEMENT_NOT_FOUND,
        code: 'ANNOUNCEMENT_NOT_FOUND',
      });
      expect(tx.announcement.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('already SENT → 409 ANNOUNCEMENT_ALREADY_SENT, before the content is even read', async () => {
      lockReturns(AnnouncementStatus.SENT);
      const e = await caught(send());
      expect(bodyOf(e)).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message: ANNOUNCEMENT_ALREADY_SENT,
        code: 'ANNOUNCEMENT_ALREADY_SENT',
      });
      expect(tx.announcement.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it.each(['', '   ', ' \n\t '])(
      'blank body %j → 400 ANNOUNCEMENT_BODY_REQUIRED, before department and recipients',
      async (body) => {
        tx.announcement.findUniqueOrThrow.mockResolvedValue(
          content({
            body,
            audience: AnnouncementAudience.DEPARTMENT,
            departmentId: null,
          }),
        );
        const e = await caught(send());
        expect(bodyOf(e)).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: ANNOUNCEMENT_BODY_REQUIRED,
          code: 'ANNOUNCEMENT_BODY_REQUIRED',
        });
        expect(tx.department.findFirst).not.toHaveBeenCalled();
        expect(tx.lineUser.findMany).not.toHaveBeenCalled();
      },
    );

    it('DEPARTMENT with a null departmentId → 400 ANNOUNCEMENT_DEPARTMENT_INVALID, no lookup', async () => {
      tx.announcement.findUniqueOrThrow.mockResolvedValue(
        content({ audience: AnnouncementAudience.DEPARTMENT }),
      );
      const e = await caught(send());
      expect(bodyOf(e)).toMatchObject({
        statusCode: 400,
        message: ANNOUNCEMENT_DEPARTMENT_INVALID,
        code: 'ANNOUNCEMENT_DEPARTMENT_INVALID',
      });
      expect(tx.department.findFirst).not.toHaveBeenCalled();
      expect(tx.lineUser.findMany).not.toHaveBeenCalled();
    });

    it('DEPARTMENT missing or soft-deleted → 400 ANNOUNCEMENT_DEPARTMENT_INVALID; the reserved flag is NOT checked', async () => {
      tx.announcement.findUniqueOrThrow.mockResolvedValue(
        content({ audience: AnnouncementAudience.DEPARTMENT, departmentId: 7 }),
      );
      tx.department.findFirst.mockResolvedValue(null);
      const e = await caught(send());
      expect(bodyOf(e)).toMatchObject({
        code: 'ANNOUNCEMENT_DEPARTMENT_INVALID',
      });
      expect(tx.department.findFirst).toHaveBeenCalledWith({
        where: { id: 7, deletedAt: null },
        select: { id: true },
      });
      expect(tx.lineUser.findMany).not.toHaveBeenCalled();
    });

    it('zero recipients → 400 NO_RECIPIENTS_FOUND', async () => {
      tx.lineUser.findMany.mockResolvedValue([]);
      const e = await caught(send());
      expect(bodyOf(e)).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ANNOUNCEMENT_NO_RECIPIENTS_FOUND,
        code: 'NO_RECIPIENTS_FOUND',
      });
    });

    it('recipients who ALL opted out or are malformed → 400 NO_RECIPIENTS_FOUND', async () => {
      tx.lineUser.findMany.mockResolvedValue([
        user(uid(1), { notifications: { announcements: false } }),
        user('e2e-junk-allowed'),
      ]);
      const e = await caught(send());
      expect(bodyOf(e)).toMatchObject({ code: 'NO_RECIPIENTS_FOUND' });
    });
  });

  // ── Recipients (AC-6, D-J, S-5) ───────────────────────────────────────────────────────────────
  describe('recipients', () => {
    it('ALL: ALLOWED, not deleted, non-empty id, ordered by LineUser.id — and no registration clause', async () => {
      await send();
      const args = findManyArgs();
      expect(args.where).toEqual({
        access: AppAccess.ALLOWED,
        deletedAt: null,
        lineUserId: { not: '' },
      });
      expect(args.orderBy).toEqual({ id: 'asc' });
      expect(args.select).toEqual({
        lineUserId: true,
        settings: { select: { notifications: true } },
      });
    });

    it('DEPARTMENT: adds a LIVE registration in exactly that department', async () => {
      tx.announcement.findUniqueOrThrow.mockResolvedValue(
        content({ audience: AnnouncementAudience.DEPARTMENT, departmentId: 7 }),
      );
      await send();
      expect(findManyArgs().where).toEqual({
        access: AppAccess.ALLOWED,
        deletedAt: null,
        lineUserId: { not: '' },
        registration: { is: { deletedAt: null, departmentId: 7 } },
      });
    });

    it('D-J: announcements:false is excluded; no row, {}, a non-boolean and a null JSON all fall back to ON', async () => {
      tx.lineUser.findMany.mockResolvedValue([
        user(uid(1), { notifications: { announcements: false } }),
        user(uid(2)),
        user(uid(3), { notifications: {} }),
        user(uid(4), { notifications: { announcements: 'no' } }),
        user(uid(5), { notifications: null }),
        user(uid(6), {
          notifications: { announcements: true, decisions: false },
        }),
      ]);
      line.multicast.mockResolvedValue(accepted(5));
      await send();
      expect(multicastArgs()[0]).toEqual([
        uid(2),
        uid(3),
        uid(4),
        uid(5),
        uid(6),
      ]);
    });

    it('S-5: a malformed lineUserId is skipped; order is the query’s (LineUser.id), never re-sorted', async () => {
      tx.lineUser.findMany.mockResolvedValue([
        user(uid(9)),
        user('e2e-junk-allowed'),
        user(`U${'A'.repeat(32)}`), // upper-case hex is not a LINE id
        user('U123'),
        user(uid(1)),
      ]);
      await send();
      expect(multicastArgs()[0]).toEqual([uid(9), uid(1)]);
    });
  });

  // ── Messages and the SENT write (AC-5, S-8) ───────────────────────────────────────────────────
  describe('AC-5 — the message and the SENT write', () => {
    it('TEXT: one text message "title\\n\\nbody", seed = id|updatedAt, deadline 90 s from the start', async () => {
      const before = Date.now();
      await send();
      const after = Date.now();

      const [to, messages, options] = multicastArgs();
      expect(to).toEqual([uid(1), uid(2)]);
      expect(messages).toEqual([{ type: 'text', text: `${TITLE}\n\n${BODY}` }]);
      expect(options.retryKeySeed).toBe(`${ID}|${UPDATED_AT.toISOString()}`);
      expect(options.deadlineAt).toBeGreaterThanOrEqual(
        before + ANNOUNCEMENT_SEND_DEADLINE_MS,
      );
      expect(options.deadlineAt).toBeLessThanOrEqual(
        after + ANNOUNCEMENT_SEND_DEADLINE_MS,
      );
    });

    it('FLEX: one flex bubble whose footer time is the SAME instant written to sentAt', async () => {
      tx.announcement.findUniqueOrThrow.mockResolvedValue(
        content({ format: AnnouncementFormat.FLEX }),
      );
      await send();

      const [, messages] = multicastArgs();
      expect(messages).toHaveLength(1);
      const flex = messages[0] as messagingApi.FlexMessage;
      expect(flex.type).toBe('flex');
      const bubble = flex.contents as messagingApi.FlexBubble;
      const footer = (bubble.footer?.contents ?? []) as messagingApi.FlexText[];

      const { sentAt } = updateArgs().data;
      expect(footer[0].text).toBe(
        `${thaiShortDate(sentAt)} ${bangkokClock(sentAt)} น.`,
      );
    });

    it('success → update SENT / sentAt / sentCount = accepted, answered as the DTO', async () => {
      const dto = await send();

      expect(tx.announcement.update).toHaveBeenCalledTimes(1);
      const args = updateArgs();
      expect(args.where).toEqual({ id: ID });
      expect(args.data.status).toBe(AnnouncementStatus.SENT);
      expect(args.data.sentAt).toBeInstanceOf(Date);
      expect(args.data.sentCount).toBe(2);

      expect(dto.status).toBe(AnnouncementStatus.SENT);
      expect(dto.sentCount).toBe(2);
      expect(dto.sentAt).toBe(args.data.sentAt.toISOString());
    });
  });

  // ── Nothing accepted (D-C, AC-10) ─────────────────────────────────────────────────────────────
  describe('AC-10 — nothing accepted: throw inside the tx (rollback), row untouched', () => {
    it.each<
      [
        Exclude<LineErrorKind, 'ALREADY_ACCEPTED'>,
        number | null,
        number,
        string,
        string,
      ]
    >([
      [
        'NOT_CONFIGURED',
        401,
        503,
        'LINE_NOT_CONFIGURED',
        ANNOUNCEMENT_LINE_NOT_CONFIGURED,
      ],
      [
        'NOT_CONFIGURED',
        null,
        503,
        'LINE_NOT_CONFIGURED',
        ANNOUNCEMENT_LINE_NOT_CONFIGURED,
      ],
      [
        'RATE_LIMITED',
        429,
        503,
        'LINE_RATE_LIMITED',
        ANNOUNCEMENT_LINE_RATE_LIMITED,
      ],
      [
        'TRANSIENT',
        500,
        502,
        'LINE_SEND_FAILED',
        ANNOUNCEMENT_LINE_SEND_FAILED,
      ],
      [
        'TRANSIENT',
        null,
        502,
        'LINE_SEND_FAILED',
        ANNOUNCEMENT_LINE_SEND_FAILED,
      ],
      ['REJECTED', 400, 502, 'LINE_SEND_FAILED', ANNOUNCEMENT_LINE_SEND_FAILED],
    ])('%s (%s) → %i %s', async (kind, status, httpStatus, code, message) => {
      line.multicast.mockResolvedValue(failed(kind, status));
      const e = await caught(send());

      expect(e.getStatus()).toBe(httpStatus);
      expect(bodyOf(e)).toEqual({
        statusCode: httpStatus,
        error: httpStatus === 503 ? 'Service Unavailable' : 'Bad Gateway',
        message,
        code,
      });
      expect(tx.announcement.update).not.toHaveBeenCalled();
      expect(events).not.toContain('commit'); // the callback threw → rollback
    });
  });

  // ── Partial failure (D-B, AC-11) ──────────────────────────────────────────────────────────────
  describe('AC-11 — partial send: commit SENT, THEN 502', () => {
    const partial: MulticastOutcome = {
      targetedCount: 501,
      acceptedCount: 500,
      requestCount: 3,
      failure: { chunkIndex: 1, kind: 'TRANSIENT', status: 500 },
    };

    it('writes SENT with sentCount 500, commits, and only then throws 502 ANNOUNCEMENT_PARTIALLY_SENT', async () => {
      tx.lineUser.findMany.mockResolvedValue(
        Array.from({ length: 501 }, (_v, i) => user(uid(i + 1))),
      );
      line.multicast.mockResolvedValue(partial);

      const e = await caught(send());

      expect(tx.announcement.update).toHaveBeenCalledTimes(1);
      expect(updateArgs().data).toMatchObject({
        status: AnnouncementStatus.SENT,
        sentCount: 500,
      });
      expect(events).toEqual(['commit']); // the callback RETURNED — the SENT write commits
      expect(e).toBeInstanceOf(BadGatewayException);
      expect(bodyOf(e)).toEqual({
        statusCode: 502,
        error: 'Bad Gateway',
        message: ANNOUNCEMENT_PARTIALLY_SENT,
        code: 'ANNOUNCEMENT_PARTIALLY_SENT',
        acceptedCount: 500,
        targetedCount: 501,
      });
      expect(logged()).toContain(
        `Announcement partially sent id=${ID} accepted=500 targeted=501 failedChunk=1 kind=TRANSIENT`,
      );
    });

    it('a resend of the now-SENT row → 409 ANNOUNCEMENT_ALREADY_SENT, no LINE call', async () => {
      line.multicast.mockResolvedValue(partial);
      await caught(send());
      line.multicast.mockClear();

      lockReturns(AnnouncementStatus.SENT);
      const e = await caught(send());
      expect(bodyOf(e)).toMatchObject({ code: 'ANNOUNCEMENT_ALREADY_SENT' });
      expect(line.multicast).not.toHaveBeenCalled();
    });
  });

  // ── D-A residual ──────────────────────────────────────────────────────────────────────────────
  it('LINE accepted but the SENT write failed (e.g. P2028) → logged as the residual, rethrown (500)', async () => {
    const timeout = new Prisma.PrismaClientKnownRequestError(
      'Transaction already closed',
      { code: 'P2028', clientVersion: '7.8.0' },
    );
    tx.announcement.update.mockRejectedValue(timeout);

    await expect(send()).rejects.toBe(timeout);
    expect(logged()).toContain(
      `LINE accepted recipients but the SENT write did not commit; row left DRAFT. id=${ID} accepted=2`,
    );
  });

  // ── AC-14 ─────────────────────────────────────────────────────────────────────────────────────
  it('AC-14 — no log line carries the title, the body or a LINE user id', async () => {
    await send(); // success
    line.multicast.mockResolvedValue({
      targetedCount: 2,
      acceptedCount: 1,
      requestCount: 2,
      failure: { chunkIndex: 1, kind: 'REJECTED', status: 400 },
    });
    await caught(send()); // partial
    line.multicast.mockResolvedValue(failed('TRANSIENT', 500));
    await caught(send()); // total failure

    const text = logged();
    expect(text).toContain(`id=${ID}`); // the spy does see the lines
    expect(text).not.toContain(TITLE);
    expect(text).not.toContain(BODY);
    expect(text).not.toMatch(/U[0-9a-f]{32}/);
  });

  // ── getLineBotInfo (D-G, AC-4) ────────────────────────────────────────────────────────────────
  describe('getLineBotInfo', () => {
    it('maps to exactly basicId, displayName, pictureUrl, chatMode', async () => {
      line.getBotInfo.mockResolvedValue({
        basicId: '@e2e',
        displayName: 'EB',
        pictureUrl: null,
        chatMode: 'chat',
        markAsReadMode: 'auto',
      });
      await expect(service.getLineBotInfo()).resolves.toEqual({
        basicId: '@e2e',
        displayName: 'EB',
        pictureUrl: null,
        chatMode: 'chat',
      });
    });

    it('NOT_CONFIGURED → 503 LINE_NOT_CONFIGURED', async () => {
      line.getBotInfo.mockRejectedValue(
        new LineCallError('NOT_CONFIGURED', 401),
      );
      const e = await caught(service.getLineBotInfo());
      expect(bodyOf(e)).toEqual({
        statusCode: 503,
        error: 'Service Unavailable',
        message: ANNOUNCEMENT_LINE_NOT_CONFIGURED,
        code: 'LINE_NOT_CONFIGURED',
      });
    });

    it.each<LineErrorKind>(['TRANSIENT', 'RATE_LIMITED', 'REJECTED'])(
      '%s → 503 LINE_BOT_INFO_UNAVAILABLE',
      async (kind) => {
        line.getBotInfo.mockRejectedValue(new LineCallError(kind, 500));
        const e = await caught(service.getLineBotInfo());
        expect(bodyOf(e)).toEqual({
          statusCode: 503,
          error: 'Service Unavailable',
          message: ANNOUNCEMENT_LINE_BOT_INFO_UNAVAILABLE,
          code: 'LINE_BOT_INFO_UNAVAILABLE',
        });
      },
    );

    it('an unclassified error is still a 503, never a 500', async () => {
      line.getBotInfo.mockRejectedValue(new Error('surprise'));
      const e = await caught(service.getLineBotInfo());
      expect(e.getStatus()).toBe(503);
      expect(bodyOf(e)).toMatchObject({ code: 'LINE_BOT_INFO_UNAVAILABLE' });
    });
  });
});
