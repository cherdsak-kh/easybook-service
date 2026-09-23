import { SystemRole } from '@prisma/client';
import type { Socket } from 'socket.io';
import { SESSION_ABSOLUTE_MAX_AGE_MS } from '../auth/auth.constants';
import type { SessionPayload } from '../auth/session-user.resolver';
import { PrismaService } from '../prisma/prisma.service';
import { REALTIME_ERRORS } from './realtime.constants';
import {
  createAuthenticateMiddleware,
  isRealtimeEligible,
  socketData,
  wrapExpressMiddleware,
  wrapSessionMiddleware,
  type SocketMiddleware,
} from './realtime.handshake';

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

/** Drives a socket.io middleware to completion and yields whatever it passed to `next`. */
const run = (
  mw: SocketMiddleware,
  socket: Socket,
): Promise<Error | undefined> =>
  new Promise((resolve) => mw(socket, (err) => resolve(err)));

describe('isRealtimeEligible', () => {
  // The RBAC enum is the ONLY thing consulted. A `PersonnelRole` row named "ADMIN" grants nothing.
  it.each([
    [SystemRole.SUPER_ADMIN, false, true],
    [SystemRole.ADMIN, false, true],
    [SystemRole.VIEWER, false, false],
    [SystemRole.SUPER_ADMIN, true, false],
    [SystemRole.ADMIN, true, false],
    [SystemRole.VIEWER, true, false],
  ])(
    'role=%s mustChangePassword=%s -> %s',
    (role, mustChangePassword, expected) => {
      expect(isRealtimeEligible({ role, mustChangePassword })).toBe(expected);
    },
  );
});

describe('wrapExpressMiddleware', () => {
  it('hands the raw handshake request to the express middleware with a stub response', async () => {
    const request = { headers: {} };
    const socket = { request, data: {} } as unknown as Socket;
    const seen: unknown[] = [];

    await run(
      wrapExpressMiddleware((req, _res, next) => {
        seen.push(req);
        next();
      }),
      socket,
    );

    expect(seen[0]).toBe(request);
  });

  it('rejects the connection when the wrapped middleware calls next(err)', async () => {
    const socket = { request: { headers: {} }, data: {} } as unknown as Socket;

    const error = await run(
      wrapExpressMiddleware((_req, _res, next) => next(new Error('boom'))),
      socket,
    );

    expect(error).toBeInstanceOf(Error);
  });
});

describe('wrapSessionMiddleware (AC B7 — Redis fails closed)', () => {
  const socket = () =>
    ({ request: { headers: {} }, data: {} }) as unknown as Socket;

  it('rejects with SESSION_STORE_UNAVAILABLE when the store errors', async () => {
    // This is EXACTLY the production code path: express-session itself calls next(err) when
    // store.get fails, and in a socket.io chain next(err) rejects the connection. Unit-tested
    // rather than e2e-tested on purpose — the e2e suite pins maxWorkers:1 against ONE shared
    // Redis, so downing it would break every other suite.
    const error = await run(
      wrapSessionMiddleware((_req, _res, next) =>
        next(new Error('Redis connection is closed')),
      ),
      socket(),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(REALTIME_ERRORS.sessionStoreUnavailable);
  });

  it('never leaks the underlying store error to the client', async () => {
    const error = await run(
      wrapSessionMiddleware((_req, _res, next) =>
        next(new Error('ECONNREFUSED 127.0.0.1:6379')),
      ),
      socket(),
    );

    expect(error?.message).not.toContain('6379');
    expect(error?.message).not.toContain('ECONNREFUSED');
  });

  it('passes the connection through when the session loads', async () => {
    const error = await run(
      wrapSessionMiddleware((_req, _res, next) => next()),
      socket(),
    );

    expect(error).toBeUndefined();
  });
});

describe('the authorize step (design §3.4 outcome table)', () => {
  const findUnique = jest.fn();
  const prisma = { systemUser: { findUnique } } as unknown as PrismaService;
  const authenticate = createAuthenticateMiddleware(prisma);

  const destroy = jest.fn();
  const save = jest.fn();
  const touch = jest.fn();

  const makeSocket = (session: SessionPayload | undefined, sid = 'sid-1') =>
    ({
      request: session
        ? {
            headers: {},
            sessionID: sid,
            session: { ...session, destroy, save, touch },
          }
        : { headers: {}, sessionID: sid },
      data: {},
    }) as unknown as Socket;

  const fresh = () => ({ systemUserId: 'user-1', createdAt: Date.now() });

  beforeEach(() => jest.clearAllMocks());

  it('no session cookie -> UNAUTHENTICATED', async () => {
    const error = await run(authenticate, makeSocket(undefined));
    expect(error?.message).toBe(REALTIME_ERRORS.unauthenticated);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('cookie present but the session key is absent/expired in Redis -> UNAUTHENTICATED', async () => {
    // express-session generates a fresh, empty session when the key is gone.
    const error = await run(authenticate, makeSocket({}));
    expect(error?.message).toBe(REALTIME_ERRORS.unauthenticated);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('session past the 24h absolute cap -> UNAUTHENTICATED', async () => {
    const error = await run(
      authenticate,
      makeSocket({
        systemUserId: 'user-1',
        createdAt: Date.now() - SESSION_ABSOLUTE_MAX_AGE_MS - 1,
      }),
    );
    expect(error?.message).toBe(REALTIME_ERRORS.unauthenticated);
  });

  it('SystemUser row missing -> UNAUTHENTICATED', async () => {
    findUnique.mockResolvedValue(null);
    const error = await run(authenticate, makeSocket(fresh()));
    expect(error?.message).toBe(REALTIME_ERRORS.unauthenticated);
  });

  // Orthogonal flags: a soft-deleted user is normally still isActive.
  it.each([
    ['soft-deleted', { ...liveRow, deletedAt: new Date() }],
    ['suspended', { ...liveRow, isActive: false }],
  ])('%s -> UNAUTHENTICATED', async (_label, row) => {
    findUnique.mockResolvedValue(row);
    const error = await run(authenticate, makeSocket(fresh()));
    expect(error?.message).toBe(REALTIME_ERRORS.unauthenticated);
  });

  it('VIEWER -> FORBIDDEN', async () => {
    findUnique.mockResolvedValue({ ...liveRow, role: SystemRole.VIEWER });
    const error = await run(authenticate, makeSocket(fresh()));
    expect(error?.message).toBe(REALTIME_ERRORS.forbidden);
  });

  it('mustChangePassword -> FORBIDDEN (unconditional; no decorator can exempt a socket)', async () => {
    findUnique.mockResolvedValue({ ...liveRow, mustChangePassword: true });
    const error = await run(authenticate, makeSocket(fresh()));
    expect(error?.message).toBe(REALTIME_ERRORS.forbidden);
  });

  it.each([SystemRole.SUPER_ADMIN, SystemRole.ADMIN])(
    '%s -> accepted, with sid + systemUserId pinned for the sweep',
    async (role) => {
      findUnique.mockResolvedValue({ ...liveRow, role });
      const socket = makeSocket(fresh(), 'sid-42');

      const error = await run(authenticate, socket);

      expect(error).toBeUndefined();
      expect(socketData(socket)).toMatchObject({
        systemUserId: 'user-1',
        sid: 'sid-42',
      });
      expect(socketData(socket).connectedAt).toEqual(expect.any(Number));
    },
  );

  it('a DB failure fails CLOSED, and the client learns nothing about it', async () => {
    findUnique.mockRejectedValue(new Error('connection terminated'));
    const error = await run(authenticate, makeSocket(fresh()));
    expect(error?.message).toBe(REALTIME_ERRORS.unauthenticated);
    expect(error?.message).not.toContain('connection terminated');
  });

  it('never destroys, saves or touches the session — the socket is READ-ONLY against Redis', async () => {
    findUnique.mockResolvedValue(liveRow);
    await run(authenticate, makeSocket(fresh()));
    await run(authenticate, makeSocket({}));

    expect(destroy).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
  });

  it('rejections carry a coarse status class ONLY — no id, email or role', async () => {
    findUnique.mockResolvedValue({ ...liveRow, role: SystemRole.VIEWER });
    const error = await run(authenticate, makeSocket(fresh()));

    expect(error?.message).toBe('FORBIDDEN');
    expect(error?.message).not.toContain('user-1');
    expect(error?.message).not.toContain('ada@easybook.local');
    expect(error?.message).not.toContain('VIEWER');
  });
});
