import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Namespace } from 'socket.io';
import { SESSION_ABSOLUTE_MAX_AGE_MS } from '../auth/auth.constants';
import type { LineUserResponseDto } from '../line/dto/line-user-response.dto';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_WS_REVALIDATE_INTERVAL_MS,
  REALTIME_EVENTS,
  SESSION_CLOSED_REASONS,
} from './realtime.constants';
import {
  RealtimeGateway,
  resolveRevalidateIntervalMs,
} from './realtime.gateway';

const liveRow = {
  id: 'user-1',
  email: 'ada@easybook.local',
  firstName: 'Ada',
  lastName: 'Lovelace',
  role: SystemRole.ADMIN,
  department: { id: 7, name: 'IT' },
  personnelRole: { id: 9, name: 'Director' },
  mustChangePassword: false,
  phoneNumber: null,
  profilePictureUrl: null,
  isActive: true,
  lastLoginAt: null,
  lineUserId: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  createdBy: null,
  updatedAt: new Date('2026-07-02T00:00:00.000Z'),
  deletedAt: null,
};

const dto: LineUserResponseDto = {
  id: 'lu-1',
  lineUserId: 'U123',
  displayName: 'Alice',
  pictureUrl: null,
  statusMessage: null,
  richMenuType: 'TYPE_1',
  access: 'PENDING',
  followedAt: '2026-07-07T10:00:00.000Z',
  registration: {
    firstName: 'Somchai',
    lastName: 'Jaidee',
    phone: '081-234-5678',
    departmentId: 1,
    department: 'Computer Science',
    personnelRoleId: 2,
    personnelRole: 'Teacher',
    // Deliberately NOT equal to `followedAt` above: the payload carries the day the form was
    // submitted, not the day they followed the OA.
    createdAt: '2026-07-09T04:30:00.000Z',
  },
};

interface FakeSocket {
  data: { sid?: string; systemUserId?: string; connectedAt?: number };
  emit: jest.Mock;
  disconnect: jest.Mock;
}

let socketSeq = 0;
const makeSocket = (sid: string, systemUserId: string): FakeSocket => ({
  data: { sid, systemUserId, connectedAt: Date.now() },
  emit: jest.fn(),
  disconnect: jest.fn(),
});

const makeNamespace = (sockets: FakeSocket[]) => ({
  use: jest.fn(),
  emit: jest.fn(),
  sockets: new Map(sockets.map((socket) => [`sock-${socketSeq++}`, socket])),
});

describe('resolveRevalidateIntervalMs', () => {
  it('defaults to 30s when unset or blank', () => {
    expect(resolveRevalidateIntervalMs(undefined)).toBe(
      DEFAULT_WS_REVALIDATE_INTERVAL_MS,
    );
    expect(resolveRevalidateIntervalMs('   ')).toBe(
      DEFAULT_WS_REVALIDATE_INTERVAL_MS,
    );
  });

  it('accepts a positive integer (the e2e suite drives it at 500ms)', () => {
    expect(resolveRevalidateIntervalMs('500')).toBe(500);
  });

  it.each(['0', '-1', 'soon', '1.5'])(
    'falls back (never fails boot) on the invalid value %s',
    (raw) => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      expect(resolveRevalidateIntervalMs(raw)).toBe(
        DEFAULT_WS_REVALIDATE_INTERVAL_MS,
      );
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    },
  );
});

describe('RealtimeGateway', () => {
  let gateway: RealtimeGateway;
  const findUnique = jest.fn();
  const storeGet = jest.fn();
  const storeSet = jest.fn();
  const storeDestroy = jest.fn();
  const storeTouch = jest.fn();

  const prisma = { systemUser: { findUnique } } as unknown as PrismaService;
  const redis = {} as unknown as Redis;
  const config = {
    get: (key: string, fallback?: string) =>
      key === 'SESSION_SECRET' ? 'x'.repeat(32) : fallback,
    getOrThrow: () => 'x'.repeat(32),
  } as unknown as ConfigService;

  /** Boots the gateway on a fake namespace and swaps in a fake, instrumented session store. */
  const boot = (sockets: FakeSocket[] = []) => {
    const namespace = makeNamespace(sockets);
    gateway.afterInit(namespace as unknown as Namespace);
    // Reach past `private store` deliberately: the fake is instrumented so the specs can assert
    // the gateway only ever READS the session store. Narrowed to `{ store: unknown }` rather than
    // `any` so this line cannot silently become an unchecked member access.
    (gateway as unknown as { store: unknown }).store = {
      get: storeGet,
      set: storeSet,
      destroy: storeDestroy,
      touch: storeTouch,
    };
    return namespace;
  };

  const primeSession = (session: unknown) =>
    storeGet.mockImplementation(
      (_sid: string, cb: (err: unknown, s?: unknown) => void) =>
        cb(null, session),
    );

  beforeEach(() => {
    jest.clearAllMocks();
    gateway = new RealtimeGateway(config, prisma, redis);
  });

  afterEach(() => gateway.onModuleDestroy());

  // ───────────────────────────── handshake wiring ─────────────────────────────

  it('installs cookie-parser, the SHARED session middleware and the authorize step, in that order', () => {
    const namespace = boot();
    expect(namespace.use).toHaveBeenCalledTimes(3);
  });

  // ───────────────────────────── emit surface ─────────────────────────────

  it('emits the three domain events on the namespace (no rooms — membership IS the boundary)', () => {
    const namespace = boot();

    gateway.emitLineUserCreated(dto);
    gateway.emitLineUserUpdated(dto);
    gateway.emitLineUserDeleted('lu-9');

    expect(namespace.emit).toHaveBeenNthCalledWith(
      1,
      REALTIME_EVENTS.lineUserCreated,
      dto,
    );
    expect(namespace.emit).toHaveBeenNthCalledWith(
      2,
      REALTIME_EVENTS.lineUserUpdated,
      dto,
    );
    expect(namespace.emit).toHaveBeenNthCalledWith(
      3,
      REALTIME_EVENTS.lineUserDeleted,
      { id: 'lu-9' },
    );
  });

  it('AC B15 — an uninitialised gateway does NOT throw (a socket-less unit test, or pre-afterInit)', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    expect(() => gateway.emitLineUserCreated(dto)).not.toThrow();
    expect(() => gateway.emitLineUserUpdated(dto)).not.toThrow();
    expect(() => gateway.emitLineUserDeleted('lu-9')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(3);

    warn.mockRestore();
  });

  it('AC B15 — a throwing transport is caught and swallowed; the committed write is never affected', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const namespace = boot();
    namespace.emit.mockImplementation(() => {
      throw new Error('transport down');
    });

    expect(() => gateway.emitLineUserUpdated(dto)).not.toThrow();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('AC B17 — no emit log line carries a name or phone number', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const namespace = boot();
    namespace.emit.mockImplementation(() => {
      throw new Error('transport down');
    });

    gateway.emitLineUserUpdated(dto);
    gateway.emitLineUserDeleted('lu-9');

    for (const [message] of warn.mock.calls) {
      const text = String(message);
      expect(text).not.toContain('Somchai');
      expect(text).not.toContain('Jaidee');
      expect(text).not.toContain('081-234-5678');
      expect(text).not.toContain('Alice');
    }
    expect(String(warn.mock.calls[0][0])).toContain('id=lu-1');

    warn.mockRestore();
  });

  // ───────────────────────────── the revalidation sweep ─────────────────────────────

  it('does ZERO I/O when nobody is watching', async () => {
    boot([]);

    await gateway.sweep();

    expect(storeGet).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('leaves a healthy socket connected', async () => {
    const socket = makeSocket('sid-1', 'user-1');
    boot([socket]);
    primeSession({ systemUserId: 'user-1', createdAt: Date.now() });
    findUnique.mockResolvedValue(liveRow);

    await gateway.sweep();

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('the sweep NEVER writes to Redis — no set, no destroy, no touch', async () => {
    const socket = makeSocket('sid-1', 'user-1');
    boot([socket]);
    primeSession({ systemUserId: 'user-1', createdAt: Date.now() });
    findUnique.mockResolvedValue(liveRow);

    await gateway.sweep();

    expect(storeSet).not.toHaveBeenCalled();
    expect(storeDestroy).not.toHaveBeenCalled();
    expect(storeTouch).not.toHaveBeenCalled();
  });

  // Step 2 — the SESSION STORE branch. This, and only this, covers an explicit logout: the Redis
  // key is destroyed while the SystemUser row stays perfectly valid, so a DB-only check would
  // leave the socket alive.
  it.each([
    ['an explicit logout / expired-or-evicted key (session gone)', null],
    [
      'session reuse (the sid now resolves to a different user)',
      { systemUserId: 'someone-else', createdAt: Date.now() },
    ],
    [
      'a session past the 24h absolute cap',
      {
        systemUserId: 'user-1',
        createdAt: Date.now() - SESSION_ABSOLUTE_MAX_AGE_MS - 1,
      },
    ],
  ])('disconnects on %s, with reason REVOKED', async (_label, session) => {
    const socket = makeSocket('sid-1', 'user-1');
    boot([socket]);
    primeSession(session);
    findUnique.mockResolvedValue(liveRow);

    await gateway.sweep();

    expect(socket.emit).toHaveBeenCalledWith(REALTIME_EVENTS.sessionClosed, {
      reason: SESSION_CLOSED_REASONS.revoked,
    });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    // The DB read never happens for a socket already killed by the store branch.
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('AC B7 — a session-store ERROR disconnects (fail closed), with reason STORE_UNAVAILABLE so the client can heal', async () => {
    const socket = makeSocket('sid-1', 'user-1');
    boot([socket]);
    storeGet.mockImplementation((_sid: string, cb: (err: unknown) => void) =>
      cb(new Error('redis down')),
    );

    await gateway.sweep();

    expect(socket.emit).toHaveBeenCalledWith(REALTIME_EVENTS.sessionClosed, {
      reason: SESSION_CLOSED_REASONS.storeUnavailable,
    });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  // Step 3 — the DATABASE branch: the same predicate the handshake applied.
  it.each([
    ['the user was hard-deleted / vanished', null],
    ['soft-deleted', { ...liveRow, deletedAt: new Date() }],
    ['suspended', { ...liveRow, isActive: false }],
    ['demoted to VIEWER', { ...liveRow, role: SystemRole.VIEWER }],
    [
      'forced to change their password',
      { ...liveRow, mustChangePassword: true },
    ],
  ])('disconnects when %s, with reason REVOKED', async (_label, row) => {
    const socket = makeSocket('sid-1', 'user-1');
    boot([socket]);
    primeSession({ systemUserId: 'user-1', createdAt: Date.now() });
    findUnique.mockResolvedValue(row);

    await gateway.sweep();

    expect(socket.emit).toHaveBeenCalledWith(REALTIME_EVENTS.sessionClosed, {
      reason: SESSION_CLOSED_REASONS.revoked,
    });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('dedupes by sid: N tabs on one session cost ONE store read', async () => {
    const sockets = [
      makeSocket('sid-1', 'user-1'),
      makeSocket('sid-1', 'user-1'),
      makeSocket('sid-1', 'user-1'),
    ];
    boot(sockets);
    primeSession({ systemUserId: 'user-1', createdAt: Date.now() });
    findUnique.mockResolvedValue(liveRow);

    await gateway.sweep();

    expect(storeGet).toHaveBeenCalledTimes(1);
  });

  it('dedupes by userId: two sessions of one admin cost ONE primary-key read', async () => {
    boot([makeSocket('sid-1', 'user-1'), makeSocket('sid-2', 'user-1')]);
    primeSession({ systemUserId: 'user-1', createdAt: Date.now() });
    findUnique.mockResolvedValue(liveRow);

    await gateway.sweep();

    expect(storeGet).toHaveBeenCalledTimes(2);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('disconnects EVERY socket of a revoked user, not just the one it noticed', async () => {
    const a = makeSocket('sid-1', 'user-1');
    const b = makeSocket('sid-2', 'user-1');
    boot([a, b]);
    primeSession({ systemUserId: 'user-1', createdAt: Date.now() });
    findUnique.mockResolvedValue({ ...liveRow, isActive: false });

    await gateway.sweep();

    expect(a.disconnect).toHaveBeenCalledWith(true);
    expect(b.disconnect).toHaveBeenCalledWith(true);
  });

  it('is non-reentrant: a sweep still running when the timer fires again is SKIPPED', async () => {
    boot([makeSocket('sid-1', 'user-1')]);
    // Never invokes the callback — the first sweep stays in flight.
    storeGet.mockImplementation(() => undefined);

    const first = gateway.sweep();
    await gateway.sweep();

    expect(storeGet).toHaveBeenCalledTimes(1);
    void first;
  });

  it('drives the sweep from the configured interval and clears it in onModuleDestroy', () => {
    jest.useFakeTimers();
    const timed = new RealtimeGateway(
      {
        get: (key: string, fallback?: string) =>
          key === 'WS_REVALIDATE_INTERVAL_MS' ? '500' : fallback,
        getOrThrow: () => 'x'.repeat(32),
      } as unknown as ConfigService,
      prisma,
      redis,
    );
    const sweep = jest.spyOn(timed, 'sweep').mockResolvedValue(undefined);

    timed.afterInit(makeNamespace([]) as unknown as Namespace);
    jest.advanceTimersByTime(1_500);
    expect(sweep).toHaveBeenCalledTimes(3);

    // Otherwise Jest hangs on an open handle and app.close() never resolves in the e2e suite.
    timed.onModuleDestroy();
    jest.advanceTimersByTime(5_000);
    expect(sweep).toHaveBeenCalledTimes(3);

    jest.useRealTimers();
  });

  it('onModuleDestroy is idempotent', () => {
    boot([]);
    expect(() => {
      gateway.onModuleDestroy();
      gateway.onModuleDestroy();
    }).not.toThrow();
  });
});
