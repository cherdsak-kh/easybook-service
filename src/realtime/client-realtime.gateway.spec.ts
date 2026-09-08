import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppAccess } from '@prisma/client';
import type { Namespace, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import {
  ClientRealtimeGateway,
  authenticateClientSocket,
  createClientAuthenticateMiddleware,
  parseVenueWatch,
  readHandshakeToken,
} from './client-realtime.gateway';
import {
  CLIENT_MAX_ROOMS_PER_SOCKET,
  CLIENT_REALTIME_EVENTS,
  CLIENT_SCHEDULE_ROOM,
  REALTIME_ERRORS,
} from './realtime.constants';

const CHANNEL_ID = '1234567890';
const SUB = 'U0123456789abcdef0123456789abcdef';
const CUID = 'clx0lineuser000000000000';

const configFor = (channelId: string | undefined): ConfigService =>
  ({
    get: (_key: string, def?: string) => channelId ?? def,
  }) as unknown as ConfigService;

const futureExp = () => Math.floor(Date.now() / 1000) + 3600;

/** LINE's verify endpoint, stubbed. `verifyLineIdToken` is the ONE verifier and it calls `fetch`. */
const mockVerifyResponse = (
  status: number,
  body: unknown = {
    iss: 'https://access.line.me',
    sub: SUB,
    aud: CHANNEL_ID,
    exp: futureExp(),
  },
): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as Response;

interface FakeSocket {
  id: string;
  handshake: {
    auth: Record<string, unknown>;
    headers: Record<string, string | undefined>;
  };
  data: Record<string, unknown>;
  rooms: Set<string>;
  join: jest.Mock;
  leave: jest.Mock;
  disconnect: jest.Mock;
}

const fakeSocket = (
  over: Partial<FakeSocket['handshake']> = {},
): FakeSocket => {
  const rooms = new Set<string>(['socket-id']);
  return {
    id: 'socket-id',
    handshake: { auth: {}, headers: {}, ...over },
    data: {},
    rooms,
    join: jest.fn((room: string) => rooms.add(room)),
    leave: jest.fn((room: string) => rooms.delete(room)),
    disconnect: jest.fn(),
  };
};

const asSocket = (socket: FakeSocket): Socket => socket as unknown as Socket;

const prismaWith = (findFirst: jest.Mock): PrismaService =>
  ({ lineUser: { findFirst } }) as unknown as PrismaService;

const silentLogger = (): Logger =>
  ({
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }) as unknown as Logger;

describe('readHandshakeToken', () => {
  it('prefers handshake.auth.token', () => {
    const socket = fakeSocket({
      auth: { token: '  from-auth  ' },
      headers: { authorization: 'Bearer from-header' },
    });

    expect(readHandshakeToken(asSocket(socket))).toBe('from-auth');
  });

  it('falls back to the Authorization header', () => {
    const socket = fakeSocket({ headers: { authorization: 'Bearer tok' } });

    expect(readHandshakeToken(asSocket(socket))).toBe('tok');
  });

  it('is null when neither is present, blank, or wrongly shaped', () => {
    expect(readHandshakeToken(asSocket(fakeSocket()))).toBeNull();
    expect(
      readHandshakeToken(asSocket(fakeSocket({ auth: { token: '   ' } }))),
    ).toBeNull();
    expect(
      readHandshakeToken(asSocket(fakeSocket({ auth: { token: 42 } }))),
    ).toBeNull();
    expect(
      readHandshakeToken(
        asSocket(fakeSocket({ headers: { authorization: 'Basic abc' } })),
      ),
    ).toBeNull();
  });
});

describe('parseVenueWatch', () => {
  it('accepts a well-formed payload and trims it', () => {
    expect(parseVenueWatch({ venueId: '  venue-1  ' })).toBe('venue-1');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a bare string', 'venue-1'],
    ['an array', ['venue-1']],
    ['a missing venueId', {}],
    ['a non-string venueId', { venueId: 7 }],
    ['an empty venueId', { venueId: '' }],
    ['a whitespace-only venueId', { venueId: '   ' }],
    ['an over-long venueId', { venueId: 'x'.repeat(65) }],
    ['an extra property', { venueId: 'venue-1', role: 'ADMIN' }],
  ])('refuses %s', (_name, body) => {
    expect(parseVenueWatch(body)).toBeNull();
  });
});

describe('authenticateClientSocket', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    // Default to a rejection so a test that forgets to stub `fetch` fails fast rather than reaching
    // the real LINE endpoint — the same guard `line-id-token.guard.spec.ts` uses.
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('network disabled in tests'));
  });

  afterEach(() => jest.restoreAllMocks());

  const authenticate = (socket: FakeSocket, findFirst: jest.Mock) =>
    authenticateClientSocket(
      configFor(CHANNEL_ID),
      prismaWith(findFirst),
      asSocket(socket),
      silentLogger(),
    );

  it('accepts an ALLOWED LINE user and yields the cuid + the U… sub', async () => {
    fetchSpy.mockResolvedValue(mockVerifyResponse(200));
    const findFirst = jest.fn().mockResolvedValue({
      id: CUID,
      lineUserId: SUB,
      access: AppAccess.ALLOWED,
    });

    const result = await authenticate(
      fakeSocket({ auth: { token: 'good' } }),
      findFirst,
    );

    expect(result).toEqual({
      ok: true,
      lineUser: { id: CUID, lineUserId: SUB },
    });
    // The verified `sub` resolves the row by `lineUserId`, and a soft-deleted follower is invisible.
    expect(findFirst).toHaveBeenCalledWith({
      where: { lineUserId: SUB, deletedAt: null },
      select: { id: true, lineUserId: true, access: true },
    });
  });

  it('refuses a socket with no token, without calling LINE or the database', async () => {
    const findFirst = jest.fn();

    const result = await authenticate(fakeSocket(), findFirst);

    expect(result).toEqual({
      ok: false,
      code: REALTIME_ERRORS.unauthenticated,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('refuses a token LINE rejects (4xx) as UNAUTHENTICATED', async () => {
    fetchSpy.mockResolvedValue(mockVerifyResponse(400, {}));
    const findFirst = jest.fn();

    const result = await authenticate(
      fakeSocket({ auth: { token: 'bad' } }),
      findFirst,
    );

    expect(result).toEqual({
      ok: false,
      code: REALTIME_ERRORS.unauthenticated,
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('refuses a token minted for another channel (aud re-check)', async () => {
    fetchSpy.mockResolvedValue(
      mockVerifyResponse(200, {
        iss: 'https://access.line.me',
        sub: SUB,
        aud: '9999999999',
        exp: futureExp(),
      }),
    );

    const result = await authenticate(
      fakeSocket({ auth: { token: 'other-channel' } }),
      jest.fn(),
    );

    expect(result).toEqual({
      ok: false,
      code: REALTIME_ERRORS.unauthenticated,
    });
  });

  /**
   * ⚠️ THE ONE PLACE THIS DIVERGES FROM THE HTTP GUARD. `verifyLineIdToken` throws a retryable
   * `BadGatewayException` when LINE is unreachable, which REST answers as a 502 — but a socket that
   * cannot prove who it belongs to must not be held open, so it collapses to a refusal.
   */
  it('fails CLOSED when LINE verify is unreachable', async () => {
    fetchSpy.mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await authenticate(
      fakeSocket({ auth: { token: 'good' } }),
      jest.fn(),
    );

    expect(result).toEqual({
      ok: false,
      code: REALTIME_ERRORS.unauthenticated,
    });
  });

  it('refuses when LINE_LOGIN_CHANNEL_ID is unset, without calling LINE', async () => {
    const result = await authenticateClientSocket(
      configFor(undefined),
      prismaWith(jest.fn()),
      asSocket(fakeSocket({ auth: { token: 'good' } })),
      silentLogger(),
    );

    expect(result).toEqual({
      ok: false,
      code: REALTIME_ERRORS.unauthenticated,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a verified sub with no (or a soft-deleted) LineUser row is UNAUTHENTICATED', async () => {
    fetchSpy.mockResolvedValue(mockVerifyResponse(200));

    const result = await authenticate(
      fakeSocket({ auth: { token: 'good' } }),
      jest.fn().mockResolvedValue(null),
    );

    expect(result).toEqual({
      ok: false,
      code: REALTIME_ERRORS.unauthenticated,
    });
  });

  /** The row exists — that is a 403's analogue, not a 401's. */
  it.each([
    AppAccess.UNREGISTERED,
    AppAccess.PENDING,
    AppAccess.REJECTED,
    AppAccess.BLOCKED,
  ])('a %s LINE user is FORBIDDEN, not UNAUTHENTICATED', async (access) => {
    fetchSpy.mockResolvedValue(mockVerifyResponse(200));

    const result = await authenticate(
      fakeSocket({ auth: { token: 'good' } }),
      jest.fn().mockResolvedValue({ id: CUID, lineUserId: SUB, access }),
    );

    expect(result).toEqual({ ok: false, code: REALTIME_ERRORS.forbidden });
  });

  it('never puts the token in a log line', async () => {
    fetchSpy.mockResolvedValue(mockVerifyResponse(400, {}));
    const warn = jest.fn<void, [unknown]>();
    const logger = {
      log: jest.fn(),
      warn,
      error: jest.fn(),
    } as unknown as Logger;

    await authenticateClientSocket(
      configFor(CHANNEL_ID),
      prismaWith(jest.fn()),
      asSocket(fakeSocket({ auth: { token: 'super-secret-id-token' } })),
      logger,
    );

    const text = warn.mock.calls.map(([first]) => String(first)).join('\n');
    expect(text).not.toContain('super-secret-id-token');
  });
});

describe('createClientAuthenticateMiddleware', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('network disabled in tests'));
  });

  afterEach(() => jest.restoreAllMocks());

  const run = (socket: FakeSocket, prisma: PrismaService): Promise<unknown> =>
    new Promise((resolve) => {
      createClientAuthenticateMiddleware(
        configFor(CHANNEL_ID),
        prisma,
        silentLogger(),
      )(asSocket(socket), resolve);
    });

  it('pins the identity onto socket.data and calls next() cleanly', async () => {
    fetchSpy.mockResolvedValue(mockVerifyResponse(200));
    const socket = fakeSocket({ auth: { token: 'good' } });

    const error = await run(
      socket,
      prismaWith(
        jest.fn().mockResolvedValue({
          id: CUID,
          lineUserId: SUB,
          access: AppAccess.ALLOWED,
        }),
      ),
    );

    expect(error).toBeUndefined();
    expect(socket.data.lineUser).toEqual({ id: CUID, lineUserId: SUB });
  });

  it('rejects with the client-visible code and pins nothing', async () => {
    const socket = fakeSocket();

    const error = await run(socket, prismaWith(jest.fn()));

    expect((error as Error).message).toBe(REALTIME_ERRORS.unauthenticated);
    expect(socket.data.lineUser).toBeUndefined();
  });

  it('a database failure fails CLOSED rather than letting the socket through', async () => {
    fetchSpy.mockResolvedValue(mockVerifyResponse(200));

    const error = await run(
      fakeSocket({ auth: { token: 'good' } }),
      prismaWith(jest.fn().mockRejectedValue(new Error('connection lost'))),
    );

    expect((error as Error).message).toBe(REALTIME_ERRORS.unauthenticated);
  });
});

describe('ClientRealtimeGateway', () => {
  let gateway: ClientRealtimeGateway;

  beforeEach(() => {
    gateway = new ClientRealtimeGateway(
      configFor(CHANNEL_ID),
      prismaWith(jest.fn()),
    );
  });

  describe('handleConnection', () => {
    it('joins the caller’s own room and the shared schedule room, and nothing else', () => {
      const socket = fakeSocket();
      socket.data.lineUser = { id: CUID, lineUserId: SUB };

      gateway.handleConnection(asSocket(socket));

      expect(socket.join.mock.calls.map(([room]) => room as string)).toEqual([
        `user:${CUID}`,
        CLIENT_SCHEDULE_ROOM,
      ]);
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    /** The room is keyed on the cuid. A `U…` sub here would be a room nobody is ever in. */
    it('keys the user room on LineUser.id, never on the LINE-side U… sub', () => {
      const socket = fakeSocket();
      socket.data.lineUser = { id: CUID, lineUserId: SUB };

      gateway.handleConnection(asSocket(socket));

      const rooms = socket.join.mock.calls.map(([room]) => room as string);
      expect(rooms).toContain(`user:${CUID}`);
      expect(rooms).not.toContain(`user:${SUB}`);
    });

    it('closes a socket that somehow arrived with no identity', () => {
      const socket = fakeSocket();

      gateway.handleConnection(asSocket(socket));

      expect(socket.join).not.toHaveBeenCalled();
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('venue subscriptions', () => {
    it('venue:watch joins venue:<id> and acknowledges', () => {
      const socket = fakeSocket();

      const ack = gateway.handleVenueWatch(asSocket(socket), {
        venueId: 'venue-1',
      });

      expect(ack).toEqual({ ok: true });
      expect(socket.join).toHaveBeenCalledWith('venue:venue-1');
    });

    it('venue:unwatch leaves venue:<id>', () => {
      const socket = fakeSocket();

      const ack = gateway.handleVenueUnwatch(asSocket(socket), {
        venueId: 'venue-1',
      });

      expect(ack).toEqual({ ok: true });
      expect(socket.leave).toHaveBeenCalledWith('venue:venue-1');
    });

    /** 🔴 An unvalidated venueId is a client choosing its own room name. */
    it.each([
      ['no payload', undefined],
      ['a bare string', 'venue-1'],
      ['an empty venueId', { venueId: '' }],
      ['an unknown extra field', { venueId: 'venue-1', room: 'user:someone' }],
    ])('venue:watch refuses %s and joins nothing', (_name, body) => {
      const socket = fakeSocket();

      expect(gateway.handleVenueWatch(asSocket(socket), body)).toEqual({
        ok: false,
      });
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('venue:unwatch refuses a bad payload and leaves nothing', () => {
      const socket = fakeSocket();

      expect(gateway.handleVenueUnwatch(asSocket(socket), {})).toEqual({
        ok: false,
      });
      expect(socket.leave).not.toHaveBeenCalled();
    });

    it('refuses to grow past the per-socket room ceiling', () => {
      const socket = fakeSocket();
      for (let n = 0; n < CLIENT_MAX_ROOMS_PER_SOCKET; n++) {
        socket.rooms.add(`venue:filler-${n}`);
      }

      expect(
        gateway.handleVenueWatch(asSocket(socket), { venueId: 'one-too-many' }),
      ).toEqual({ ok: false });
      expect(socket.join).not.toHaveBeenCalled();
    });
  });

  describe('the emit surface', () => {
    const to = jest.fn();
    const emit = jest.fn();

    const attachNamespace = (): void => {
      to.mockReturnValue({ emit });
      gateway.afterInit({
        use: jest.fn(),
        to,
      } as unknown as Namespace);
    };

    beforeEach(() => {
      jest.clearAllMocks();
      attachNamespace();
    });

    it('emitToUser targets user:<cuid>', () => {
      gateway.emitToUser(CUID, CLIENT_REALTIME_EVENTS.bookingUpdated, {
        id: 'a',
      });

      expect(to).toHaveBeenCalledWith(`user:${CUID}`);
      expect(emit).toHaveBeenCalledWith(CLIENT_REALTIME_EVENTS.bookingUpdated, {
        id: 'a',
      });
    });

    it('emitToVenue targets venue:<id>', () => {
      gateway.emitToVenue(
        'venue-1',
        CLIENT_REALTIME_EVENTS.venueAvailabilityChanged,
        { venueId: 'venue-1' },
      );

      expect(to).toHaveBeenCalledWith('venue:venue-1');
    });

    /** 🔴 `D-C13`: everyone is in `schedule:all`, so the pulse must put nothing on the wire. */
    it('emitSchedulePulse broadcasts to schedule:all with NO payload argument', () => {
      gateway.emitSchedulePulse();

      expect(to).toHaveBeenCalledWith(CLIENT_SCHEDULE_ROOM);
      expect(emit).toHaveBeenCalledWith(CLIENT_REALTIME_EVENTS.scheduleUpdated);
      expect(emit.mock.calls[0]).toHaveLength(1);
    });

    it('is fail-soft: a throwing transport is swallowed, never rethrown', () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      emit.mockImplementationOnce(() => {
        throw new Error('transport down');
      });

      expect(() => gateway.emitSchedulePulse()).not.toThrow();
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
    });

    it('is fail-soft before afterInit too — an emit with no namespace is a warn, not a crash', () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const fresh = new ClientRealtimeGateway(
        configFor(CHANNEL_ID),
        prismaWith(jest.fn()),
      );

      expect(() => fresh.emitSchedulePulse()).not.toThrow();
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
    });
  });

  it('afterInit installs exactly one handshake middleware on the namespace', () => {
    const use = jest.fn();

    gateway.afterInit({ use, to: jest.fn() } as unknown as Namespace);

    expect(use).toHaveBeenCalledTimes(1);
  });
});
