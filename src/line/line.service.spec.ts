import { HTTPFetchError, messagingApi } from '@line/bot-sdk';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LineCallError } from './line-call-error';
import {
  LINE_MESSAGING_CLIENT,
  lineMessagingClientProvider,
} from './line-messaging-client';
import { lineRetryKey } from './line-retry-key';
import {
  LINE_BOT_INFO_TIMEOUT_MS,
  LINE_CALL_TIMEOUT_MS,
  LINE_MULTICAST_MAX_RECIPIENTS,
} from './line.constants';
import { LineService } from './line.service';

/**
 * `ANNOUNCE-API-2` — `LineService.multicast` / `getBotInfo` against a FAKE Messaging client.
 * 🔴 No test here constructs a client that could reach LINE: the fake is injected directly.
 */

const UUID_V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEED = 'clx_announcement|2026-09-22T08:05:00.000Z';
const TEXT: messagingApi.Message = { type: 'text', text: 'T\n\nB' };

/** `n` well-formed ids, in DESCENDING order — so "keeps the caller's order" cannot pass by sorting. */
const ids = (n: number): string[] =>
  Array.from(
    { length: n },
    (_v, i) => `U${(n - i).toString(16).padStart(32, '0')}`,
  );

const httpError = (status: number): HTTPFetchError =>
  new HTTPFetchError(`${status} - x`, {
    status,
    statusText: 'x',
    headers: new Headers(),
    body: '{"message":"secret"}',
  });

const config = {
  get: jest.fn((_key: string, fallback?: string) => fallback),
} as unknown as ConfigService;

type MulticastCall = [
  { to: string[]; messages: messagingApi.Message[] },
  string,
];

describe('LineService — multicast / getBotInfo', () => {
  const fake = {
    multicast: jest.fn(),
    getBotInfo: jest.fn(),
    pushMessage: jest.fn(),
  };
  let service: LineService;
  let logs: jest.SpyInstance[];

  const calls = () => fake.multicast.mock.calls as MulticastCall[];
  const logged = () =>
    logs
      .flatMap((s) => (s.mock.calls as unknown[][]).map((c) => String(c[0])))
      .join('\n');

  beforeEach(() => {
    jest.clearAllMocks();
    fake.multicast.mockResolvedValue({});
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    service = new LineService(
      config,
      fake as unknown as messagingApi.MessagingApiClient,
    );
  });

  afterEach(() => {
    logs.forEach((s) => s.mockRestore());
    jest.useRealTimers();
  });

  const send = (to: string[], opts: { deadlineAt?: number } = {}) =>
    service.multicast(to, [TEXT], { retryKeySeed: SEED, ...opts });

  // ── AC-1: chunking ────────────────────────────────────────────────────────────────────────────
  describe('AC-1 — chunks of ≤ 500, in the caller’s order, each with a retry key', () => {
    it.each([
      [0, 0],
      [1, 1],
      [500, 1],
      [501, 2],
      [1001, 3],
    ])('%i recipients → %i request(s)', async (n, requests) => {
      const to = ids(n);
      const outcome = await send(to);

      expect(fake.multicast).toHaveBeenCalledTimes(requests);
      for (const [req, key] of calls()) {
        expect(req.to.length).toBeLessThanOrEqual(
          LINE_MULTICAST_MAX_RECIPIENTS,
        );
        expect(req.messages).toEqual([TEXT]);
        expect(key).toMatch(UUID_V5);
        expect(key).toBe(lineRetryKey(SEED, req.to));
      }
      // Concatenated in call order, the chunks are exactly the input, in the input's order.
      expect(calls().flatMap(([req]) => req.to)).toEqual(to);
      expect(outcome).toEqual({
        targetedCount: n,
        acceptedCount: n,
        requestCount: requests,
        failure: null,
      });
    });

    it('chunks carry distinct keys', async () => {
      await send(ids(1001));
      expect(new Set(calls().map(([, key]) => key)).size).toBe(3);
    });

    it('de-duplicates defensively, keeping first-seen order', async () => {
      const [a, b] = ids(2);
      const outcome = await send([a, b, a]);
      expect(fake.multicast).toHaveBeenCalledTimes(1);
      expect(calls()[0][0].to).toEqual([a, b]);
      expect(outcome.targetedCount).toBe(2);
    });
  });

  // ── AC-12: 409 and retry ──────────────────────────────────────────────────────────────────────
  describe('AC-12 — 409 on the retry key, and the one retry', () => {
    it('LINE 409 counts as accepted, and the next chunk is still sent', async () => {
      fake.multicast.mockRejectedValueOnce(httpError(409));
      const outcome = await send(ids(501));

      expect(fake.multicast).toHaveBeenCalledTimes(2);
      expect(outcome.acceptedCount).toBe(501);
      expect(outcome.failure).toBeNull();
    });

    it('a transient 5xx is retried ONCE with the SAME key, then accepted', async () => {
      fake.multicast.mockRejectedValueOnce(httpError(500));
      const outcome = await send(ids(3));

      expect(fake.multicast).toHaveBeenCalledTimes(2);
      expect(calls()[1][1]).toBe(calls()[0][1]);
      expect(calls()[1][0].to).toEqual(calls()[0][0].to);
      expect(outcome).toEqual({
        targetedCount: 3,
        acceptedCount: 3,
        requestCount: 2,
        failure: null,
      });
    });

    it('a network error is transient too — retried with the same key', async () => {
      fake.multicast.mockRejectedValueOnce(new TypeError('fetch failed'));
      const outcome = await send(ids(3));
      expect(fake.multicast).toHaveBeenCalledTimes(2);
      expect(calls()[1][1]).toBe(calls()[0][1]);
      expect(outcome.acceptedCount).toBe(3);
    });

    it('5xx twice → failure TRANSIENT on chunk 0, exactly 2 calls, chunk 1 never sent', async () => {
      fake.multicast
        .mockRejectedValueOnce(httpError(500))
        .mockRejectedValueOnce(httpError(502));
      const outcome = await send(ids(501));

      expect(fake.multicast).toHaveBeenCalledTimes(2);
      expect(outcome).toEqual({
        targetedCount: 501,
        acceptedCount: 0,
        requestCount: 2,
        failure: { chunkIndex: 0, kind: 'TRANSIENT', status: 502 },
      });
    });

    it.each([
      [429, 'RATE_LIMITED'],
      [401, 'NOT_CONFIGURED'],
      [403, 'NOT_CONFIGURED'],
      [400, 'REJECTED'],
    ])('HTTP %i is NOT retried → %s', async (status, kind) => {
      fake.multicast.mockRejectedValueOnce(httpError(status));
      const outcome = await send(ids(501));

      expect(fake.multicast).toHaveBeenCalledTimes(1);
      expect(outcome.acceptedCount).toBe(0);
      expect(outcome.failure).toEqual({ chunkIndex: 0, kind, status });
    });
  });

  // ── Partial failure (AC-11's LINE half) ───────────────────────────────────────────────────────
  it('partial: chunk 0 accepted, chunk 1 fails twice → 500 accepted of 1001, chunk 2 never sent', async () => {
    fake.multicast
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(500));
    const outcome = await send(ids(1001));

    expect(fake.multicast).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({
      targetedCount: 1001,
      acceptedCount: 500,
      requestCount: 3,
      failure: { chunkIndex: 1, kind: 'TRANSIENT', status: 500 },
    });
    expect(logged()).toContain('chunk=1/3 kind=TRANSIENT status=500');
  });

  // ── Timeout and deadline (design S-2) ─────────────────────────────────────────────────────────
  describe('S-2 — per-call timeout and send deadline', () => {
    it('a call that never settles times out as TRANSIENT and is retried with the same key; no unhandled rejection', async () => {
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      jest.useFakeTimers();
      try {
        let rejectHung!: (e: Error) => void;
        fake.multicast
          .mockImplementationOnce(
            () => new Promise((_r, reject) => (rejectHung = reject)),
          )
          .mockResolvedValueOnce({});

        const pending = send(ids(2));
        await jest.advanceTimersByTimeAsync(LINE_CALL_TIMEOUT_MS);
        const outcome = await pending;

        expect(fake.multicast).toHaveBeenCalledTimes(2);
        expect(calls()[1][1]).toBe(calls()[0][1]);
        expect(outcome.acceptedCount).toBe(2);
        expect(outcome.failure).toBeNull();

        // The abandoned first request finally fails — it must not surface anywhere.
        rejectHung(new TypeError('fetch failed'));
        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 20));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('two timeouts → failure TRANSIENT, status null', async () => {
      jest.useFakeTimers();
      fake.multicast.mockImplementation(() => new Promise(() => undefined));
      const pending = send(ids(2));
      await jest.advanceTimersByTimeAsync(LINE_CALL_TIMEOUT_MS * 2);
      const outcome = await pending;
      expect(fake.multicast).toHaveBeenCalledTimes(2);
      expect(outcome.failure).toEqual({
        chunkIndex: 0,
        kind: 'TRANSIENT',
        status: null,
      });
    });

    it('a deadline already past → no call at all, failure TRANSIENT', async () => {
      const outcome = await send(ids(2), { deadlineAt: Date.now() - 1 });
      expect(fake.multicast).not.toHaveBeenCalled();
      expect(outcome).toEqual({
        targetedCount: 2,
        acceptedCount: 0,
        requestCount: 0,
        failure: { chunkIndex: 0, kind: 'TRANSIENT', status: null },
      });
    });

    it('the deadline is checked before the RETRY too', async () => {
      const deadlineAt = 1_000_000;
      const now = jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(deadlineAt - 1) // attempt 1 may start
        .mockReturnValue(deadlineAt); // the retry may not
      try {
        fake.multicast.mockRejectedValueOnce(httpError(500));
        const outcome = await send(ids(2), { deadlineAt });
        expect(fake.multicast).toHaveBeenCalledTimes(1);
        expect(outcome.failure).toEqual({
          chunkIndex: 0,
          kind: 'TRANSIENT',
          status: null,
        });
      } finally {
        now.mockRestore();
      }
    });

    it('the deadline stops later chunks after an accepted one (a partial outcome)', async () => {
      const deadlineAt = 1_000_000;
      const now = jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(deadlineAt - 1)
        .mockReturnValue(deadlineAt);
      try {
        const outcome = await send(ids(501), { deadlineAt });
        expect(fake.multicast).toHaveBeenCalledTimes(1);
        expect(outcome.acceptedCount).toBe(500);
        expect(outcome.failure).toEqual({
          chunkIndex: 1,
          kind: 'TRANSIENT',
          status: null,
        });
      } finally {
        now.mockRestore();
      }
    });
  });

  // ── Programmer errors ─────────────────────────────────────────────────────────────────────────
  it.each([0, 6])('%i messages → throws, no call', async (n) => {
    await expect(
      service.multicast(ids(1), Array<messagingApi.Message>(n).fill(TEXT), {
        retryKeySeed: SEED,
      }),
    ).rejects.toThrow('multicast takes 1-5 messages');
    expect(fake.multicast).not.toHaveBeenCalled();
  });

  // ── getBotInfo (D-G) ──────────────────────────────────────────────────────────────────────────
  describe('getBotInfo', () => {
    it('maps pictureUrl undefined → null and drops userId / premiumId', async () => {
      fake.getBotInfo.mockResolvedValue({
        userId: 'U-the-bot',
        basicId: '@e2e',
        premiumId: 'premium',
        displayName: 'EB',
        chatMode: 'chat',
        markAsReadMode: 'auto',
      });
      await expect(service.getBotInfo()).resolves.toEqual({
        basicId: '@e2e',
        displayName: 'EB',
        pictureUrl: null,
        chatMode: 'chat',
        markAsReadMode: 'auto',
      });
    });

    it('keeps a present pictureUrl', async () => {
      fake.getBotInfo.mockResolvedValue({
        userId: 'x',
        basicId: '@e2e',
        displayName: 'EB',
        pictureUrl: 'https://example.test/p.png',
        chatMode: 'bot',
        markAsReadMode: 'manual',
      });
      expect((await service.getBotInfo()).pictureUrl).toBe(
        'https://example.test/p.png',
      );
    });

    it.each([
      [httpError(401), 'NOT_CONFIGURED'],
      [httpError(429), 'RATE_LIMITED'],
      [httpError(500), 'TRANSIENT'],
      [new TypeError('fetch failed'), 'TRANSIENT'],
    ])(
      'a rejection becomes a classified LineCallError (%#)',
      async (err, kind) => {
        fake.getBotInfo.mockRejectedValue(err);
        await expect(service.getBotInfo()).rejects.toMatchObject({
          name: 'LineCallError',
          kind,
        });
      },
    );

    it('times out as TRANSIENT, with no retry', async () => {
      jest.useFakeTimers();
      fake.getBotInfo.mockImplementation(() => new Promise(() => undefined));
      const pending = service.getBotInfo();
      const assertion = expect(pending).rejects.toMatchObject({
        kind: 'TRANSIENT',
      });
      await jest.advanceTimersByTimeAsync(LINE_BOT_INFO_TIMEOUT_MS);
      await assertion;
      expect(fake.getBotInfo).toHaveBeenCalledTimes(1);
    });
  });

  it('AC-14 — no log line carries a recipient id, a retry key or message content', async () => {
    const to = ids(1001);
    fake.multicast
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(500));
    await send(to);

    const text = logged();
    expect(text).not.toMatch(/U[0-9a-f]{32}/);
    for (const [, key] of calls()) expect(text).not.toContain(key);
    expect(text).not.toContain('T\n\nB');
  });
});

describe('LineService — no Messaging client (design S-1)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('the provider yields null for an empty token, and Nest injects that null', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        lineMessagingClientProvider,
        LineService,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    expect(moduleRef.get(LINE_MESSAGING_CLIENT)).toBeNull();
    const service = moduleRef.get(LineService);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('LINE_CHANNEL_ACCESS_TOKEN is not set'),
    );

    const outcome = await service.multicast([`U${'a'.repeat(32)}`], [TEXT], {
      retryKeySeed: SEED,
    });
    expect(outcome.failure).toEqual({
      chunkIndex: 0,
      kind: 'NOT_CONFIGURED',
      status: null,
    });
    expect(outcome.requestCount).toBe(0);
    await expect(service.getBotInfo()).rejects.toEqual(
      new LineCallError('NOT_CONFIGURED', null),
    );
  });

  it('legacy methods REJECT (never throw synchronously) with NOT_CONFIGURED', async () => {
    const service = new LineService(config, null);
    const pushed = service.push('U', [TEXT]);
    expect(pushed).toBeInstanceOf(Promise);
    await expect(pushed).rejects.toMatchObject({ kind: 'NOT_CONFIGURED' });
    await expect(service.reply('rt', [TEXT])).rejects.toMatchObject({
      kind: 'NOT_CONFIGURED',
    });
    await expect(service.getProfile('U')).rejects.toMatchObject({
      kind: 'NOT_CONFIGURED',
    });
    await expect(
      service.findRichMenuId({ name: 'x', width: 1, height: 1 }),
    ).rejects.toMatchObject({ kind: 'NOT_CONFIGURED' });
  });

  it('the provider builds a real client when a token is set (constructed only — never called)', () => {
    const withToken = {
      get: () => 'not-a-real-token',
    } as unknown as ConfigService;
    const client = lineMessagingClientProvider.useFactory(withToken);
    expect(client).toBeInstanceOf(messagingApi.MessagingApiClient);
  });
});
