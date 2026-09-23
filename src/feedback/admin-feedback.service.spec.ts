import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FeedbackStatus, FeedbackType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CONCURRENT_MODIFICATION } from '../system-users/system-users.errors';
import {
  AdminFeedbackService,
  feedbackSearchWhere,
  toFeedbackCounts,
  toFeedbackListItem,
} from './admin-feedback.service';
import type { ListFeedbackQueryDto } from './dto/admin-feedback-query.dto';
import type { UpdateFeedbackDto } from './dto/admin-feedback-write.dto';
import {
  FEEDBACK_NO_CHANGE,
  FEEDBACK_NOT_FOUND,
  FEEDBACK_UPDATE_EMPTY,
} from './feedback.constants';

const FEEDBACK_ID = 'clx_feedback_cuid';
const ACTOR = { id: 'clx_staff_cuid' };

/** PII the log line must never carry (AC-22). Thai on purpose — it is what reporters type. */
const SUBJECT = 'แอร์ห้องประชุม 1 ไม่เย็น';
const DESCRIPTION = 'แอร์ตัวที่อยู่ฝั่งหน้าต่างไม่ทำงานมา 3 วันแล้ว';
const NOTE = 'โทรหาคุณสมชาย 081-234-5678 แล้ว นัดช่างพรุ่งนี้';
const PHONE = '081-234-5678';

/** The first argument of a mock's Nth call, typed — keeps the casts in ONE place (lint-safe). */
const callArg = <T>(fn: jest.Mock, call = 0): T =>
  (fn.mock.calls as unknown as unknown[][])[call][0] as T;

const query = (
  over: Partial<ListFeedbackQueryDto> = {},
): ListFeedbackQueryDto => ({ page: 1, limit: 10, ...over });

/** A row shaped exactly like `FEEDBACK_DETAIL_SELECT`'s payload. */
const detailRow = (over: Record<string, unknown> = {}) => ({
  id: FEEDBACK_ID,
  code: 'ISS-25690920-001',
  type: FeedbackType.ISSUE,
  status: FeedbackStatus.PENDING,
  subject: SUBJECT,
  description: DESCRIPTION,
  photos: ['https://cdn.example.org/feedback/a.jpg'],
  createdAt: new Date('2026-09-20T13:05:00.000Z'),
  venue: { id: 'clx_venue', name: 'ห้องประชุม 1' },
  lineUser: {
    displayName: 'Somchai',
    pictureUrl: 'https://profile.line-scdn.net/somchai',
    registration: {
      firstName: 'สมชาย',
      lastName: 'ใจดี',
      phone: PHONE,
      department: { name: 'กลุ่มบริหารงานวิชาการ' },
      personnelRole: { name: 'ครู' },
    },
  },
  logs: [] as unknown[],
  ...over,
});

describe('AdminFeedbackService', () => {
  let service: AdminFeedbackService;

  const feedback = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
    update: jest.fn(),
  };
  const feedbackLog = { create: jest.fn() };
  const $queryRaw = jest.fn();

  const tx = { feedback, feedbackLog, $queryRaw };

  /** The interactive form: the callback runs against the same mocks the assertions read. */
  const $transaction = jest.fn((cb: (client: unknown) => unknown) => cb(tx));

  /** What the row lock returns: the current status, or `[]` for an unknown id. */
  const lockReturns = (status: FeedbackStatus | null) =>
    $queryRaw.mockResolvedValue(status ? [{ status }] : []);

  beforeEach(async () => {
    jest.clearAllMocks();
    $transaction.mockImplementation((cb: (client: unknown) => unknown) =>
      cb(tx),
    );
    feedback.findMany.mockResolvedValue([]);
    feedback.count.mockResolvedValue(0);
    feedback.groupBy.mockResolvedValue([]);
    feedback.findUnique.mockResolvedValue(detailRow());
    feedback.update.mockResolvedValue({});
    feedbackLog.create.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminFeedbackService,
        {
          provide: PrismaService,
          useValue: { feedback, feedbackLog, $queryRaw, $transaction },
        },
      ],
    }).compile();
    service = module.get(AdminFeedbackService);
  });

  // ── LIST ─────────────────────────────────────────────────────────────────────────────────────

  describe('list', () => {
    type FindManyArgs = {
      where: Prisma.FeedbackWhereInput;
      orderBy: unknown;
      skip: number;
      take: number;
    };

    it('U-1 no filters → empty where, total order, skip/take from page/limit', async () => {
      await service.list(query({ page: 3, limit: 20 }));

      const args = callArg<FindManyArgs>(feedback.findMany);
      expect(args.where).toEqual({});
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { code: 'desc' }]);
      expect(args.skip).toBe(40);
      expect(args.take).toBe(20);
      expect(callArg<{ where: unknown }>(feedback.count).where).toEqual({});
    });

    it('U-2 type + status + venueId are ANDed into one where, and count uses the same where', async () => {
      await service.list(
        query({
          type: FeedbackType.FEEDBACK,
          status: FeedbackStatus.IN_PROGRESS,
          venueId: 'clx_venue',
        }),
      );

      const expected = {
        type: FeedbackType.FEEDBACK,
        status: FeedbackStatus.IN_PROGRESS,
        venueId: 'clx_venue',
      };
      expect(callArg<FindManyArgs>(feedback.findMany).where).toEqual(expected);
      expect(callArg<{ where: unknown }>(feedback.count).where).toEqual(
        expected,
      );
    });

    it('U-3 venueId=general → venueId IS NULL', async () => {
      await service.list(query({ venueId: 'general' }));

      const where = callArg<FindManyArgs>(feedback.findMany).where;
      expect(where).toEqual({ venueId: null });
      expect(where.venueId).toBeNull();
    });

    it('U-4 q="#ISS-1" → OR over code/subject/displayName/firstName/lastName, insensitive, no description', async () => {
      await service.list(query({ q: '#ISS-1' }));

      const where = callArg<FindManyArgs>(feedback.findMany).where;
      const like = { contains: 'ISS-1', mode: 'insensitive' };
      expect(where.OR).toEqual([
        { code: like },
        { subject: like },
        { lineUser: { displayName: like } },
        { lineUser: { registration: { firstName: like } } },
        { lineUser: { registration: { lastName: like } } },
      ]);
      expect(JSON.stringify(where)).not.toContain('description');
    });

    it.each([['#'], ['   '], ['  #  '], ['']])(
      'U-5 q=%j → no OR clause at all (E-10)',
      async (q) => {
        await service.list(query({ q }));

        expect(callArg<FindManyArgs>(feedback.findMany).where).toEqual({});
        expect(feedbackSearchWhere(q)).toEqual({});
      },
    );

    it('U-6 counts: groupBy has NO where whatever the filters, sums per type/status, missing → 0', async () => {
      feedback.groupBy.mockResolvedValue([
        {
          type: FeedbackType.ISSUE,
          status: FeedbackStatus.PENDING,
          _count: { _all: 4 },
        },
        {
          type: FeedbackType.ISSUE,
          status: FeedbackStatus.RESOLVED,
          _count: { _all: 2 },
        },
        {
          type: FeedbackType.FEEDBACK,
          status: FeedbackStatus.PENDING,
          _count: { _all: 3 },
        },
        {
          type: FeedbackType.FEEDBACK,
          status: FeedbackStatus.IN_PROGRESS,
          _count: { _all: 1 },
        },
      ]);

      const res = await service.list(
        query({
          page: 99,
          type: FeedbackType.ISSUE,
          status: FeedbackStatus.RESOLVED,
          venueId: 'general',
          q: 'แอร์',
        }),
      );

      const args = callArg<Record<string, unknown>>(feedback.groupBy);
      expect(args).toEqual({ by: ['type', 'status'], _count: { _all: true } });
      expect(args).not.toHaveProperty('where');
      expect(res.counts).toEqual({
        pendingCount: 7,
        issueCount: 6,
        feedbackCount: 4,
      });
      expect(toFeedbackCounts([])).toEqual({
        pendingCount: 0,
        issueCount: 0,
        feedbackCount: 0,
      });
    });

    it('U-7 meta: totalPages = ceil(total/limit), 0 when total is 0', async () => {
      feedback.count.mockResolvedValue(21);
      const res = await service.list(query({ page: 2, limit: 10 }));
      expect(res.meta).toEqual({
        page: 2,
        limit: 10,
        total: 21,
        totalPages: 3,
      });

      feedback.count.mockResolvedValue(0);
      const empty = await service.list(query({ page: 5, limit: 50 }));
      expect(empty.meta).toEqual({
        page: 5,
        limit: 50,
        total: 0,
        totalPages: 0,
      });
      expect(empty.data).toEqual([]);
    });

    it('maps rows to list items: photoCount, venue, reporter, ISO createdAt, no photo URLs', async () => {
      feedback.findMany.mockResolvedValue([detailRow({ venue: null })]);

      const [item] = (await service.list(query())).data;

      expect(item).toEqual({
        id: FEEDBACK_ID,
        code: 'ISS-25690920-001',
        type: FeedbackType.ISSUE,
        status: FeedbackStatus.PENDING,
        subject: SUBJECT,
        description: DESCRIPTION,
        photoCount: 1,
        venue: null,
        reporter: {
          firstName: 'สมชาย',
          lastName: 'ใจดี',
          personnelRoleName: 'ครู',
          departmentName: 'กลุ่มบริหารงานวิชาการ',
          phone: PHONE,
          lineDisplayName: 'Somchai',
          pictureUrl: 'https://profile.line-scdn.net/somchai',
        },
        createdAt: '2026-09-20T13:05:00.000Z',
      });
      expect(item).not.toHaveProperty('photos');
    });

    it('U-8 mapper with a missing registration → null reporter fields, displayName kept, no throw', () => {
      const item = toFeedbackListItem(
        detailRow({
          lineUser: {
            displayName: 'Somchai',
            pictureUrl: null,
            registration: null,
          },
        }),
      );
      expect(item.reporter).toEqual({
        firstName: null,
        lastName: null,
        personnelRoleName: null,
        departmentName: null,
        phone: null,
        lineDisplayName: 'Somchai',
        pictureUrl: null,
      });

      const bare = toFeedbackListItem(
        detailRow({
          lineUser: { displayName: null, pictureUrl: null, registration: null },
        }),
      );
      expect(bare.reporter.lineDisplayName).toBeNull();
      expect(bare.reporter.pictureUrl).toBeNull();
    });
  });

  // ── DETAIL ───────────────────────────────────────────────────────────────────────────────────

  describe('getDetail', () => {
    it('selects the logs ASC with an id tie-breaker and never the LINE subject', async () => {
      await service.getDetail(FEEDBACK_ID);

      const args = callArg<{
        where: unknown;
        select: Record<string, unknown> & {
          logs: { orderBy: unknown };
          lineUser: { select: Record<string, unknown> };
        };
      }>(feedback.findUnique);
      expect(args.where).toEqual({ id: FEEDBACK_ID });
      expect(args.select.logs.orderBy).toEqual([
        { createdAt: 'asc' },
        { id: 'asc' },
      ]);
      expect(args.select.lineUser.select).not.toHaveProperty('lineUserId');
    });

    it('returns photos in stored order and logs mapped to ISO strings', async () => {
      feedback.findUnique.mockResolvedValue(
        detailRow({
          photos: ['https://x/feedback/2.jpg', 'https://x/feedback/1.jpg'],
          logs: [
            {
              id: 'log-1',
              status: FeedbackStatus.IN_PROGRESS,
              note: null,
              createdAt: new Date('2026-09-21T01:00:00.000Z'),
              author: { id: ACTOR.id, firstName: 'วีระ', lastName: 'ทองดี' },
            },
            {
              id: 'log-2',
              status: FeedbackStatus.IN_PROGRESS,
              note: 'ok',
              createdAt: new Date('2026-09-21T02:00:00.000Z'),
              author: null,
            },
          ],
        }),
      );

      const detail = await service.getDetail(FEEDBACK_ID);

      expect(detail.photos).toEqual([
        'https://x/feedback/2.jpg',
        'https://x/feedback/1.jpg',
      ]);
      expect(detail.photoCount).toBe(2);
      expect(detail.logs).toEqual([
        {
          id: 'log-1',
          status: FeedbackStatus.IN_PROGRESS,
          note: null,
          createdAt: '2026-09-21T01:00:00.000Z',
          author: { id: ACTOR.id, firstName: 'วีระ', lastName: 'ทองดี' },
        },
        {
          id: 'log-2',
          status: FeedbackStatus.IN_PROGRESS,
          note: 'ok',
          createdAt: '2026-09-21T02:00:00.000Z',
          author: null,
        },
      ]);
    });

    it('U-9 unknown id → 404 FEEDBACK_NOT_FOUND', async () => {
      feedback.findUnique.mockResolvedValue(null);

      await expect(service.getDetail('nope')).rejects.toThrow(
        new NotFoundException(FEEDBACK_NOT_FOUND),
      );
    });
  });

  // ── PATCH ────────────────────────────────────────────────────────────────────────────────────

  describe('update', () => {
    type LogData = {
      data: {
        feedbackId: string;
        status: FeedbackStatus;
        note: string | null;
        authorId: string;
      };
    };

    const update = (dto: UpdateFeedbackDto) =>
      service.update(FEEDBACK_ID, dto, ACTOR);

    it('U-10 {} → 400 FEEDBACK_UPDATE_EMPTY before any DB work', async () => {
      await expect(update({})).rejects.toThrow(
        new BadRequestException(FEEDBACK_UPDATE_EMPTY),
      );
      expect($transaction).not.toHaveBeenCalled();
      expect($queryRaw).not.toHaveBeenCalled();
    });

    it('takes the row lock with SELECT … FOR UPDATE, binding the id as a parameter', async () => {
      lockReturns(FeedbackStatus.PENDING);

      await update({ status: FeedbackStatus.IN_PROGRESS });

      const [strings, ...values] = $queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[],
      ];
      expect(strings.join('?')).toMatch(
        /SELECT "status" FROM "feedbacks" WHERE "id" = \? FOR UPDATE/,
      );
      expect(values).toEqual([FEEDBACK_ID]);
    });

    it('U-11 same status + no note → 400 FEEDBACK_NO_CHANGE, nothing written', async () => {
      lockReturns(FeedbackStatus.IN_PROGRESS);

      await expect(
        update({ status: FeedbackStatus.IN_PROGRESS }),
      ).rejects.toThrow(new BadRequestException(FEEDBACK_NO_CHANGE));
      expect(feedback.update).not.toHaveBeenCalled();
      expect(feedbackLog.create).not.toHaveBeenCalled();
    });

    it('U-12 status-only change → feedback.update + one log {status: next, note: null, authorId: actor}', async () => {
      lockReturns(FeedbackStatus.PENDING);

      await update({ status: FeedbackStatus.IN_PROGRESS });

      expect(feedback.update).toHaveBeenCalledTimes(1);
      expect(feedback.update).toHaveBeenCalledWith({
        where: { id: FEEDBACK_ID },
        data: { status: FeedbackStatus.IN_PROGRESS },
      });
      expect(feedbackLog.create).toHaveBeenCalledTimes(1);
      expect(callArg<LogData>(feedbackLog.create).data).toEqual({
        feedbackId: FEEDBACK_ID,
        status: FeedbackStatus.IN_PROGRESS,
        note: null,
        authorId: ACTOR.id,
      });
    });

    it('U-13 note-only (status absent) → no feedback.update, log carries the CURRENT status', async () => {
      lockReturns(FeedbackStatus.IN_PROGRESS);

      await update({ note: NOTE });

      expect(feedback.update).not.toHaveBeenCalled();
      expect(feedbackLog.create).toHaveBeenCalledTimes(1);
      expect(callArg<LogData>(feedbackLog.create).data).toEqual({
        feedbackId: FEEDBACK_ID,
        status: FeedbackStatus.IN_PROGRESS,
        note: NOTE,
        authorId: ACTOR.id,
      });
    });

    it('U-14 note + the SAME status → same as note-only', async () => {
      lockReturns(FeedbackStatus.RESOLVED);

      await update({ status: FeedbackStatus.RESOLVED, note: NOTE });

      expect(feedback.update).not.toHaveBeenCalled();
      expect(callArg<LogData>(feedbackLog.create).data).toMatchObject({
        status: FeedbackStatus.RESOLVED,
        note: NOTE,
      });
    });

    it('status change + note → both written, log carries the note', async () => {
      lockReturns(FeedbackStatus.PENDING);

      await update({ status: FeedbackStatus.RESOLVED, note: NOTE });

      expect(feedback.update).toHaveBeenCalledTimes(1);
      expect(callArg<LogData>(feedbackLog.create).data).toMatchObject({
        status: FeedbackStatus.RESOLVED,
        note: NOTE,
      });
    });

    it('U-15 unknown id (lock returns []) → 404, no writes', async () => {
      lockReturns(null);

      await expect(update({ status: FeedbackStatus.RESOLVED })).rejects.toThrow(
        new NotFoundException(FEEDBACK_NOT_FOUND),
      );
      expect(feedback.update).not.toHaveBeenCalled();
      expect(feedbackLog.create).not.toHaveBeenCalled();
    });

    it('U-16 RESOLVED → PENDING is allowed — there is no transition policy (AC-21)', async () => {
      lockReturns(FeedbackStatus.RESOLVED);

      await update({ status: FeedbackStatus.PENDING });

      expect(feedback.update).toHaveBeenCalledWith({
        where: { id: FEEDBACK_ID },
        data: { status: FeedbackStatus.PENDING },
      });
      expect(callArg<LogData>(feedbackLog.create).data.status).toBe(
        FeedbackStatus.PENDING,
      );
    });

    it('runs every write and the echo read on the TRANSACTION client, and returns the detail', async () => {
      lockReturns(FeedbackStatus.PENDING);
      feedback.findUnique.mockResolvedValue(
        detailRow({ status: FeedbackStatus.IN_PROGRESS }),
      );

      const detail = await update({ status: FeedbackStatus.IN_PROGRESS });

      expect($transaction).toHaveBeenCalledTimes(1);
      // Lock → write → log → read, all inside the one callback.
      const order = [
        $queryRaw.mock.invocationCallOrder[0],
        feedback.update.mock.invocationCallOrder[0],
        feedbackLog.create.mock.invocationCallOrder[0],
        feedback.findUnique.mock.invocationCallOrder[0],
      ];
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(detail.status).toBe(FeedbackStatus.IN_PROGRESS);
    });

    it('U-17 a P2034 inside the transaction → 409 CONCURRENT_MODIFICATION', async () => {
      // `mockImplementation`, not `mockRejectedValue`: the mock's return type is inferred as
      // `unknown` from its callback form, which makes `mockRejectedValue` demand `never`.
      $transaction.mockImplementation(() =>
        Promise.reject(
          new Prisma.PrismaClientKnownRequestError('write conflict', {
            code: 'P2034',
            clientVersion: '7.8.0',
          }),
        ),
      );

      const err = (await update({ status: FeedbackStatus.RESOLVED }).catch(
        (e: unknown) => e,
      )) as HttpException;
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe(CONCURRENT_MODIFICATION);
    });

    it('U-17 a deliberate 400 thrown inside the transaction passes through unchanged', async () => {
      lockReturns(FeedbackStatus.PENDING);

      const err = (await update({ status: FeedbackStatus.PENDING }).catch(
        (e: unknown) => e,
      )) as HttpException;
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getStatus()).toBe(400);
      expect(err.message).toBe(FEEDBACK_NO_CHANGE);
    });

    it('U-18 the log line carries ids and status only — never note, subject, description or phone (AC-22)', async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      lockReturns(FeedbackStatus.PENDING);

      await update({ status: FeedbackStatus.IN_PROGRESS, note: NOTE });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = String(logSpy.mock.calls[0][0]);
      expect(line).toContain(`id=${FEEDBACK_ID}`);
      expect(line).toContain(`by=${ACTOR.id}`);
      expect(line).toContain('status=IN_PROGRESS');
      for (const pii of [NOTE, SUBJECT, DESCRIPTION, PHONE]) {
        expect(line).not.toContain(pii);
      }
      logSpy.mockRestore();
    });
  });
});
