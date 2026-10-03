import { Prisma } from '@prisma/client';
import {
  buildRecord,
  callerOf,
  contextOf,
  maskLineId,
  messageOf,
  scrub,
  stackOf,
} from './incident-redact';
import {
  MESSAGE_MAX,
  STACK_MAX_BYTES,
  STACK_MAX_LINES,
} from './incidents.constants';
import {
  IncidentCallerKind,
  IncidentComponent,
  IncidentSeverity,
  type IncidentDraft,
  type RequestLike,
} from './incident.types';

const LINE_ID = 'U4af4980629a1b2c3d4e5f60718293a4b';
const PHONE = '081-234-5678';
const EMAIL = 'somchai.jaidee@school.ac.th';
const SECRET = 'q9X2mP7vLk3Rt8YbN4cZ6wHs1JdFg5AaE0uVoXyBnMi';
const REPLY_TOKEN = 'nHuyWiB7yP5Zw52FIfUaRVyYg7rsF1e8Zdw3k0sXq9TnPm2L';
const COOKIE = 'eb.sid=s%3Asession-cookie-value.signature';
const AUTH = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
const SIGNATURE =
  'x-line-signature-value-abcdefghijklmnopqrstuvwxyz0123456789=';
const PASSWORD = 'Sup3r-Secret-Passw0rd!';

const draft = (over: Partial<IncidentDraft> = {}): IncidentDraft => ({
  severity: IncidentSeverity.ERROR,
  component: IncidentComponent.API,
  atMs: 1_759_500_000_000,
  ...over,
});

/** A request carrying every secret the design says must never be stored. */
const hostileReq = (): RequestLike =>
  ({
    method: 'POST',
    path: '/api/v1/booking-requests/abc/approve',
    route: { path: '/api/v1/booking-requests/:id/approve' },
    params: { id: 'cm0abc123' },
    query: { token: 'never-stored', page: '2' },
    ips: ['203.0.113.7'],
    ip: '10.0.0.1',
    headers: {
      'user-agent': 'Mozilla/5.0 (X11) contact admin@school.ac.th',
      cookie: COOKIE,
      authorization: AUTH,
      'x-line-signature': SIGNATURE,
      'x-csrf-token': 'csrf-token-value',
    },
    body: { password: PASSWORD, replyToken: REPLY_TOKEN },
    cookies: { 'eb.sid': COOKIE },
    systemUser: { id: 'cm0staff1', role: 'ADMIN' },
  }) as RequestLike;

describe('incident-redact', () => {
  describe('scrub', () => {
    it('masks a full LINE user id to U + 5 hex ... last 4', () => {
      expect(scrub(`user ${LINE_ID} failed`)).toBe(
        `user ${maskLineId(LINE_ID)} failed`,
      );
      expect(maskLineId(LINE_ID)).toBe('U4af49…3a4b');
    });

    it('replaces e-mails, Thai phone numbers and JWT-like tokens', () => {
      const out = scrub(`${EMAIL} ${PHONE} ${AUTH}`);
      expect(out).not.toContain(EMAIL);
      expect(out).not.toContain('081-234-5678');
      expect(out).not.toContain('eyJhbGciOi');
      expect(out).toContain('[email]');
      expect(out).toContain('[phone]');
      expect(out).toContain('[token]');
    });

    it('replaces a 32+ character token-like run, but not in a stack frame', () => {
      expect(scrub(`secret ${SECRET}`)).toBe('secret [redacted]');
      const frame = `    at handler (/srv/app/dist/${'a'.repeat(40)}/file.js:1:1)`;
      expect(scrub(frame, { frame: true })).toBe(frame);
    });
  });

  describe('messageOf / stackOf', () => {
    it('keeps a Prisma known error to its code and last line', () => {
      const e = new Prisma.PrismaClientKnownRequestError(
        'Invalid `prisma.user.findMany()` invocation:\n\n\nUnique constraint failed on the fields: (`email`)',
        { code: 'P2002', clientVersion: '7.8.0' },
      );
      expect(messageOf(e)).toBe(
        'P2002: Unique constraint failed on the fields: (`email`)',
      );
    });

    it('withholds a Prisma validation error entirely (its excerpt echoes arguments)', () => {
      const e = new Prisma.PrismaClientValidationError(
        `Invalid \`prisma.x.create()\` invocation:\n{ data: { email: "${EMAIL}", password: "${PASSWORD}" } }`,
        { clientVersion: '7.8.0' },
      );
      expect(messageOf(e)).toBe('Invalid Prisma query (arguments withheld)');
      const stack = stackOf(e) ?? '';
      expect(stack).not.toContain(EMAIL);
      expect(stack).not.toContain(PASSWORD);
    });

    it('truncates the message to 500 characters', () => {
      expect(messageOf(new Error('x '.repeat(600))).length).toBeLessThanOrEqual(
        MESSAGE_MAX,
      );
    });

    it('keeps frames only, caps lines and bytes, and appends at most two causes', () => {
      const e = new Error('boom');
      e.stack = [
        'Error: boom',
        ...Array.from(
          { length: 200 },
          (_, i) => `    at fn${i} (/srv/${'p'.repeat(200)}.js:1:1)`,
        ),
      ].join('\n');
      (e as { cause?: unknown }).cause = new Error('c1', {
        cause: new Error('c2', { cause: new Error('c3') }),
      });
      const stack = stackOf(e) ?? '';
      expect(stack.split('\n').length).toBeLessThanOrEqual(STACK_MAX_LINES);
      expect(Buffer.byteLength(stack, 'utf8')).toBeLessThanOrEqual(
        STACK_MAX_BYTES,
      );
      expect(stack.startsWith('Error: boom')).toBe(true);
    });

    it('returns null for a non-Error', () => {
      expect(stackOf('just a string')).toBeNull();
    });

    it('lists the causes after the frames', () => {
      const e = new Error('top', {
        cause: new Error('mid', { cause: new Error('root') }),
      });
      const stack = stackOf(e) ?? '';
      expect(stack).toContain('Caused by: Error: mid');
      expect(stack).toContain('Caused by: Error: root');
    });
  });

  describe('callerOf', () => {
    it('is staff:<id> (<ROLE>) with no name', () => {
      expect(callerOf(hostileReq(), IncidentComponent.API, undefined)).toEqual({
        kind: IncidentCallerKind.STAFF,
        label: 'staff:cm0staff1 (ADMIN)',
      });
    });

    it('masks a LINE user id', () => {
      const c = callerOf(
        { lineUserId: LINE_ID },
        IncidentComponent.API,
        undefined,
      );
      expect(c.kind).toBe(IncidentCallerKind.LINE_USER);
      expect(c.label).toBe(`line-user:${maskLineId(LINE_ID)}`);
      expect(c.label).not.toContain(LINE_ID);
    });

    it('recognises the webhook, anonymous callers and system work', () => {
      expect(
        callerOf(
          { path: '/api/v1/line/webhook' },
          IncidentComponent.API,
          undefined,
        ).kind,
      ).toBe(IncidentCallerKind.LINE_PLATFORM);
      expect(callerOf({}, IncidentComponent.API, undefined).kind).toBe(
        IncidentCallerKind.ANONYMOUS,
      );
      expect(callerOf(null, IncidentComponent.LINE_OA, 'push')).toEqual({
        kind: IncidentCallerKind.SYSTEM,
        label: 'system (LINE OA push)',
      });
    });
  });

  describe('contextOf', () => {
    it('copies only whitelisted keys with the right types', () => {
      const out = contextOf(
        {
          operation: 'push',
          attempts: 2,
          latencyMs: 3100,
          bucket: 'photos',
          secret: 'x',
          attempt: 'NaN',
        } as never,
        {},
      );
      expect(out).toEqual({
        operation: 'push',
        attempts: 2,
        latencyMs: 3100,
        bucket: 'photos',
      });
    });
  });

  describe('buildRecord (AC-D4)', () => {
    const error = new Error(
      `failed for ${LINE_ID} phone ${PHONE} mail ${EMAIL} secret ${SECRET} replyToken ${REPLY_TOKEN}`,
    );
    const record = buildRecord({
      draft: draft({ error, errorCode: 'Error' }),
      req: hostileReq(),
      traceId: 'tr-0123456789abcdef',
      status: 500,
      method: 'POST',
    });
    const dump = JSON.stringify(record);

    it.each([
      ['password', PASSWORD],
      ['cookie', COOKIE],
      ['cookie value', 'session-cookie-value'],
      ['Authorization', 'Bearer'],
      ['JWT', 'eyJhbGciOiJIUzI1NiJ9'],
      ['x-line-signature', SIGNATURE],
      ['replyToken', REPLY_TOKEN],
      ['full LINE user id', LINE_ID],
      ['Thai phone', PHONE],
      ['e-mail', EMAIL],
      ['channel-secret-shaped string', SECRET],
      ['csrf token', 'csrf-token-value'],
      ['a query value', 'never-stored'],
    ])('stores no %s verbatim', (_label, needle) => {
      expect(dump).not.toContain(needle);
    });

    it('keeps the route template, substituted path, query KEYS and the caller', () => {
      expect(record.routeTemplate).toBe('/api/v1/booking-requests/:id/approve');
      expect(record.path).toBe('/api/v1/booking-requests/cm0abc123/approve');
      expect(record.queryKeys).toEqual(['token', 'page']);
      expect(record.caller.label).toBe('staff:cm0staff1 (ADMIN)');
      expect(record.ip).toBe('203.0.113.7');
      expect(record.context.params).toEqual({ id: 'cm0abc123' });
    });

    it('caps the message and the stack, and holds no body field', () => {
      expect(record.message.length).toBeLessThanOrEqual(MESSAGE_MAX);
      expect((record.stack ?? '').split('\n').length).toBeLessThanOrEqual(
        STACK_MAX_LINES,
      );
      expect(Object.keys(record)).not.toEqual(
        expect.arrayContaining(['body', 'headers', 'cookies']),
      );
      expect(dump).not.toContain('"body"');
    });

    it('scrubs the user agent', () => {
      expect(record.userAgent).toBe('Mozilla/5.0 (X11) contact [email]');
    });

    it('builds a message for an external draft with no error', () => {
      const r = buildRecord({
        draft: draft({
          component: IncidentComponent.LINE_OA,
          operation: 'push',
          message: 'push took 3500 ms (budget 3000 ms)',
        }),
        req: null,
        traceId: 'tr-aaaaaaaaaaaaaaaa',
        status: null,
        method: null,
      });
      expect(r.message).toBe('push took 3500 ms (budget 3000 ms)');
      expect(r.caller.label).toBe('system (LINE OA push)');
      expect(r.status).toBeNull();
      expect(r.stack).toBeNull();
    });
  });
});
