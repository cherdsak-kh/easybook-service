import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CONCURRENT_MODIFICATION } from '../system-users/system-users.errors';
import {
  CANNED_REPLIES_LIMIT_EXCEEDED,
  CANNED_REPLIES_LOCK_NS,
  CANNED_REPLIES_MAX,
  CANNED_REPLY_NOT_FOUND,
  CANNED_REPLY_UPDATE_EMPTY,
} from './canned-replies.constants';
import {
  CANNED_REPLY_ORDER,
  CANNED_REPLY_SELECT,
  CannedRepliesService,
  toCannedReplyDto,
} from './canned-replies.service';

/**
 * `ANNOUNCE-API-5` — `CannedRepliesService` (design §5.2 U-C). Prisma is mocked: nothing here reaches
 * a database.
 */

const ID = 'canned_reply_default_1';
const ACTOR = 'clx_admin';

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  title: 'แจ้งวิธีจองสถานที่',
  text: 'สวัสดีค่ะ',
  sortOrder: 0,
  createdAt: new Date('2026-09-22T08:00:00.000Z'),
  updatedAt: new Date('2026-09-22T08:05:00.000Z'),
  ...over,
});

/** The first argument of a mock's Nth call, typed — keeps the casts in ONE place (lint-safe). */
const callArg = <T>(fn: jest.Mock, call = 0): T =>
  (fn.mock.calls as unknown as unknown[][])[call][0] as T;

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

describe('CannedRepliesService', () => {
  let service: CannedRepliesService;

  /** Shared call log: proves the advisory lock is the FIRST statement of the transaction. */
  const events: string[] = [];
  const record =
    <T>(name: string, value: () => T) =>
    () => {
      events.push(name);
      return value();
    };

  const tx = {
    $executeRaw: jest.fn(),
    cannedReply: {
      count: jest.fn(),
      aggregate: jest.fn(),
      create: jest.fn(),
    },
  };
  const cannedReply = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
  };
  const $executeRaw = jest.fn();
  const $transaction = jest.fn(
    async (cb: (t: typeof tx) => Promise<unknown>) => {
      events.push('begin');
      const result = await cb(tx);
      events.push('commit');
      return result;
    },
  );

  let logSpy: jest.SpyInstance;
  const logged = () =>
    (logSpy.mock.calls as unknown[][]).map((c) => String(c[0])).join('\n');

  const setCount = (n: number) =>
    tx.cannedReply.count.mockImplementation(
      record('count', () => Promise.resolve(n)),
    );
  const setMax = (max: number | null) =>
    tx.cannedReply.aggregate.mockImplementation(
      record('aggregate', () => Promise.resolve({ _max: { sortOrder: max } })),
    );

  beforeEach(async () => {
    jest.clearAllMocks();
    events.length = 0;
    tx.$executeRaw.mockImplementation(record('lock', () => Promise.resolve(1)));
    setCount(2);
    setMax(1);
    tx.cannedReply.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => {
        events.push('create');
        return Promise.resolve(row({ id: 'clx_new', ...data }));
      },
    );
    cannedReply.findMany.mockResolvedValue([]);
    cannedReply.findUnique.mockResolvedValue(row());
    cannedReply.updateMany.mockResolvedValue({ count: 1 });
    cannedReply.deleteMany.mockResolvedValue({ count: 1 });
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    const moduleRef = await Test.createTestingModule({
      providers: [
        CannedRepliesService,
        {
          provide: PrismaService,
          useValue: { cannedReply, $transaction, $executeRaw },
        },
      ],
    }).compile();
    service = moduleRef.get(CannedRepliesService);
  });

  afterEach(() => logSpy.mockRestore());

  // ── LIST ─────────────────────────────────────────────────────────────────────────────────────
  describe('list', () => {
    it('orders sortOrder → createdAt → id, all ASC, and maps dates to ISO strings', async () => {
      cannedReply.findMany.mockResolvedValue([row(), row({ id: 'b' })]);
      const result = await service.list();

      expect(callArg<unknown>(cannedReply.findMany)).toEqual({
        select: CANNED_REPLY_SELECT,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(CANNED_REPLY_ORDER).toEqual([
        { sortOrder: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' },
      ]);
      expect(result).toEqual([
        {
          id: ID,
          title: 'แจ้งวิธีจองสถานที่',
          text: 'สวัสดีค่ะ',
          sortOrder: 0,
          createdAt: '2026-09-22T08:00:00.000Z',
          updatedAt: '2026-09-22T08:05:00.000Z',
        },
        toCannedReplyDto(row({ id: 'b' })),
      ]);
    });

    it('an empty table → []', async () => {
      await expect(service.list()).resolves.toEqual([]);
    });
  });

  // ── CREATE (D-3) ─────────────────────────────────────────────────────────────────────────────
  describe('create', () => {
    const create = (dto: {
      title?: string;
      text?: string;
      sortOrder?: number;
    }) => service.create({ title: 't', text: 'x', ...dto }, ACTOR);

    it('takes pg_advisory_xact_lock(4220::int4, 0::int4) as the FIRST statement, then counts, then writes', async () => {
      await create({});
      expect(events).toEqual([
        'begin',
        'lock',
        'count',
        'aggregate',
        'create',
        'commit',
      ]);
      const [strings, ...values] = tx.$executeRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[],
      ];
      expect(strings.join('?').replace(/\s+/g, ' ').trim()).toBe(
        'SELECT pg_advisory_xact_lock(?::int4, ?::int4)',
      );
      expect(values).toEqual([CANNED_REPLIES_LOCK_NS, 0]);
      expect(CANNED_REPLIES_LOCK_NS).toBe(4220);
      expect(CANNED_REPLIES_LOCK_NS).not.toBe(4210); // BOOKING_VENUE_LOCK_NS
      expect($executeRaw).not.toHaveBeenCalled(); // the lock is on the TRANSACTION client
    });

    it(`at ${CANNED_REPLIES_MAX} rows → 400 CANNED_REPLIES_LIMIT_EXCEEDED with the exact Thai message, nothing created`, async () => {
      setCount(5);
      const e = await caught(create({}));
      expect(e).toBeInstanceOf(BadRequestException);
      expect(bodyOf(e)).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'ข้อความตอบกลับด่วนสามารถมีได้สูงสุดไม่เกิน 5 ข้อความ',
        code: 'CANNED_REPLIES_LIMIT_EXCEEDED',
      });
      expect(CANNED_REPLIES_LIMIT_EXCEEDED).toBe(bodyOf(e).message);
      expect(tx.cannedReply.create).not.toHaveBeenCalled();
      expect(tx.cannedReply.aggregate).not.toHaveBeenCalled();
      expect(events).not.toContain('commit'); // the callback threw → rollback, lock released
    });

    it('above the cap (a stray 6th row) is refused the same way', async () => {
      setCount(6);
      const e = await caught(create({}));
      expect(bodyOf(e)).toMatchObject({
        code: 'CANNED_REPLIES_LIMIT_EXCEEDED',
      });
    });

    it('at 4 rows → creates, answering the DTO', async () => {
      setCount(4);
      const dto = await create({ title: 'หัวข้อ', text: 'ข้อความ' });
      expect(callArg<unknown>(tx.cannedReply.create)).toEqual({
        data: { title: 'หัวข้อ', text: 'ข้อความ', sortOrder: 2 },
        select: CANNED_REPLY_SELECT,
      });
      expect(dto).toMatchObject({
        id: 'clx_new',
        title: 'หัวข้อ',
        text: 'ข้อความ',
        sortOrder: 2,
      });
      expect(typeof dto.createdAt).toBe('string');
    });

    it.each([
      [7, 8],
      [null, 0],
      [9998, 9999],
      [9999, 9999],
    ])(
      'omitted sortOrder with max %p → %p (bottom of the list, capped at 9999)',
      async (max, expected) => {
        setMax(max);
        await create({});
        expect(
          callArg<{ data: { sortOrder: number } }>(tx.cannedReply.create).data
            .sortOrder,
        ).toBe(expected);
      },
    );

    it.each([0, 3, 9999])(
      'a given sortOrder %p is used as is, with no aggregate',
      async (sortOrder) => {
        await create({ sortOrder });
        expect(tx.cannedReply.aggregate).not.toHaveBeenCalled();
        expect(
          callArg<{ data: { sortOrder: number } }>(tx.cannedReply.create).data
            .sortOrder,
        ).toBe(sortOrder);
      },
    );

    it('a write conflict inside the transaction is the house 409 (mapTransactionError)', async () => {
      tx.cannedReply.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('write conflict', {
          code: 'P2034',
          clientVersion: '7.8.0',
        }),
      );
      await expect(create({})).rejects.toThrow(
        new ConflictException(CONCURRENT_MODIFICATION),
      );
    });

    it('logs the new id and the actor only', async () => {
      await create({ title: 'หัวข้อลับ', text: 'ข้อความลับ' });
      expect(logSpy).toHaveBeenCalledWith(
        `Canned reply created id=clx_new by=${ACTOR}`,
      );
      expect(logged()).not.toContain('ลับ');
    });
  });

  // ── UPDATE ───────────────────────────────────────────────────────────────────────────────────
  describe('update', () => {
    it('{} → coded 400 CANNED_REPLY_UPDATE_EMPTY with no DB call at all', async () => {
      const e = await caught(service.update(ID, {}, ACTOR));
      expect(bodyOf(e)).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: CANNED_REPLY_UPDATE_EMPTY,
        code: 'CANNED_REPLY_UPDATE_EMPTY',
      });
      expect(cannedReply.updateMany).not.toHaveBeenCalled();
      expect(cannedReply.findUnique).not.toHaveBeenCalled();
    });

    it('a guarded updateMany by id; undefined fields are NOT in data; answers the re-read', async () => {
      cannedReply.findUnique.mockResolvedValue(row({ title: 'ใหม่' }));
      const dto = await service.update(ID, { title: 'ใหม่' }, ACTOR);

      const args = callArg<{ where: unknown; data: Record<string, unknown> }>(
        cannedReply.updateMany,
      );
      expect(args.where).toEqual({ id: ID });
      expect(args.data).toEqual({ title: 'ใหม่' });
      expect(Object.keys(args.data)).toEqual(['title']);
      expect(callArg<unknown>(cannedReply.findUnique)).toEqual({
        where: { id: ID },
        select: CANNED_REPLY_SELECT,
      });
      expect(dto).toEqual(toCannedReplyDto(row({ title: 'ใหม่' })));
      expect(logSpy).toHaveBeenCalledWith(
        `Canned reply updated id=${ID} by=${ACTOR}`,
      );
    });

    it('all three fields are written when all three are sent', async () => {
      await service.update(ID, { title: 'a', text: 'b', sortOrder: 0 }, ACTOR);
      expect(callArg<{ data: unknown }>(cannedReply.updateMany).data).toEqual({
        title: 'a',
        text: 'b',
        sortOrder: 0,
      });
    });

    it('unknown id (count 0) → coded 404 CANNED_REPLY_NOT_FOUND, no re-read', async () => {
      cannedReply.updateMany.mockResolvedValue({ count: 0 });
      const e = await caught(service.update('nope', { title: 'x' }, ACTOR));
      expect(e).toBeInstanceOf(NotFoundException);
      expect(bodyOf(e)).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: CANNED_REPLY_NOT_FOUND,
        code: 'CANNED_REPLY_NOT_FOUND',
      });
      expect(cannedReply.findUnique).not.toHaveBeenCalled();
    });

    it('a row deleted between the write and the re-read → coded 404', async () => {
      cannedReply.findUnique.mockResolvedValue(null);
      const e = await caught(service.update(ID, { text: 'x' }, ACTOR));
      expect(bodyOf(e)).toMatchObject({
        statusCode: 404,
        code: 'CANNED_REPLY_NOT_FOUND',
      });
    });
  });

  // ── REMOVE ───────────────────────────────────────────────────────────────────────────────────
  describe('remove', () => {
    it('a HARD delete by id → void, logged with ids only', async () => {
      await expect(service.remove(ID, ACTOR)).resolves.toBeUndefined();
      expect(callArg<unknown>(cannedReply.deleteMany)).toEqual({
        where: { id: ID },
      });
      expect(logSpy).toHaveBeenCalledWith(
        `Canned reply deleted id=${ID} by=${ACTOR}`,
      );
    });

    it('unknown id (count 0) → coded 404 CANNED_REPLY_NOT_FOUND', async () => {
      cannedReply.deleteMany.mockResolvedValue({ count: 0 });
      const e = await caught(service.remove('nope', ACTOR));
      expect(bodyOf(e)).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: CANNED_REPLY_NOT_FOUND,
        code: 'CANNED_REPLY_NOT_FOUND',
      });
    });
  });

  it('D-3 — only create takes the lock and counts; update and remove never do', async () => {
    await service.update(ID, { title: 'x' }, ACTOR);
    await service.remove(ID, ACTOR);
    expect($transaction).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect($executeRaw).not.toHaveBeenCalled();
    expect(tx.cannedReply.count).not.toHaveBeenCalled();
    expect(cannedReply.count).not.toHaveBeenCalled();
  });
});
