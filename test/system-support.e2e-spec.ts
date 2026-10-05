import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import { API_BASE_PATH } from '../src/common/api.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { SupportWebhookTransport } from '../src/system/support-webhook.transport';
import {
  clearThrottleCounters,
  createE2eApp,
  ensureE2eOptions,
  prismaOf,
  purgeE2eUsers,
  redisOf,
  waitForRedis,
} from './e2e-app';

jest.setTimeout(120_000);

/**
 * `POST /api/v1/system/support/incident` — the Discord incident relay.
 *
 * 🔴 THE DEV `.env` HOLDS THE REAL WEBHOOK, so nothing here may reach Discord. Three independent layers
 * (design §2.10), any one of which is enough on its own:
 *   1. `SupportWebhookTransport` is replaced by a fake at the module boundary — the real `fetch` call
 *      lives only in the class this replaces.
 *   2. `ConfigService.get('DISCORD_SUPPORT_WEBHOOK_URL')` is spied to return a sentinel on a reserved
 *      TLD (or `''`), so the real value is never even read into a request.
 *   3. `global.fetch` is tripwired: every call is recorded and rejected, and the suite asserts that no
 *      recorded host is a Discord one. (supertest speaks `http`, not `fetch`, so it is unaffected.)
 */

const PREFIX = 'e2e-support-';
const PASSWORD = 'E2e-correct-horse-battery-1';
const SUPER = `${PREFIX}super@easybook.local`;
const ADMIN = `${PREFIX}admin@easybook.local`;
const VIEWER = `${PREFIX}viewer@easybook.local`;
const OTHER = `${PREFIX}other@easybook.local`;
const SENTINEL = 'https://relay.invalid/hook';
const WEBHOOK_ENV = 'DISCORD_SUPPORT_WEBHOOK_URL';
const DISCORD_HOST = /(^|\.)discord(app)?\.com$/;

const FENCE = '`'.repeat(3);
/** Fixture phone for every user except VIEWER, who has none on file. */
const PHONE = '081-555-0100';

const url = (path: string) => `${API_BASE_PATH}${path}`;

interface Session {
  agent: request.Agent;
  token: string;
  id: string;
}

interface Call {
  url: URL;
  form: FormData;
}

interface Payload {
  username: string;
  content: string;
  allowed_mentions: { parse: string[] };
  embeds: unknown[];
  attachments: Array<{ id: number; filename: string }>;
}

interface ErrorBody {
  statusCode: number;
  message: string | string[];
  code?: string;
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 2),
]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const pngOfSize = (bytes: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(bytes - 8, 3),
  ]);

const FIELDS = {
  category: 'web',
  severity: 'normal',
  path: '/backend/bookings/requests',
  description: 'ปุ่มบันทึกไม่ทำงาน',
  diagnostics: 'UA: e2e',
};

describe('System support incident relay (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let config: ConfigService;
  let sessions: Record<string, Session> = {};
  let realFetch: typeof fetch;

  /** Layer 3: every `fetch` the process makes while this suite runs. */
  const fetchedUrls: string[] = [];
  /** Layer 1: what the fake transport saw. */
  const calls: Call[] = [];
  let transportStatus = 200;
  let transportError: Error | undefined;
  /** Layer 2: what `ConfigService.get(DISCORD_SUPPORT_WEBHOOK_URL)` answers. */
  let webhookValue: string = SENTINEL;

  const fakeTransport = {
    post: jest.fn((u: URL, form: FormData) => {
      calls.push({ url: u, form });
      return transportError
        ? Promise.reject(transportError)
        : Promise.resolve(transportStatus);
    }),
  };

  const server = () => app.getHttpServer();
  const as = (email: string) => sessions[email];

  const payloadOf = (i = 0): Payload =>
    JSON.parse(calls[i].form.get('payload_json') as string) as Payload;

  const login = async (email: string): Promise<Omit<Session, 'id'>> => {
    const agent = request.agent(server());
    const csrf = await agent.get(url('/auth/system/csrf')).expect(200);
    const token = (csrf.body as { csrfToken: string }).csrfToken;
    await agent
      .post(url('/auth/system/login'))
      .set('x-csrf-token', token)
      .send({ email, password: PASSWORD })
      .expect(200);
    return { agent, token };
  };

  /** Multipart POST as a signed-in user. `fields` overrides the valid baseline; `undefined` drops one. */
  const submit = (
    email: string,
    opts: {
      fields?: Record<string, string | undefined>;
      files?: Array<{ buffer: Buffer; name: string; type?: string }>;
      csrf?: boolean;
    } = {},
  ) => {
    const s = as(email);
    let req = s.agent.post(url('/system/support/incident'));
    if (opts.csrf !== false) req = req.set('x-csrf-token', s.token);
    const fields: Record<string, string | undefined> = {
      ...FIELDS,
      ...opts.fields,
    };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) req = req.field(k, v);
    }
    for (const f of opts.files ?? []) {
      req = req.attach('files', f.buffer, {
        filename: f.name,
        contentType: f.type ?? 'image/png',
      });
    }
    return req;
  };

  beforeAll(async () => {
    realFetch = global.fetch;
    // Layer 3.
    jest.spyOn(global, 'fetch').mockImplementation((input) => {
      const href =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      fetchedUrls.push(href);
      return Promise.reject(new Error('e2e tripwire: no outbound fetch'));
    });

    // Layer 1.
    app = await createE2eApp((b) =>
      b.overrideProvider(SupportWebhookTransport).useValue(fakeTransport),
    );

    // Layer 2.
    config = app.get(ConfigService);
    const originalGet = config.get.bind(config) as (
      ...args: unknown[]
    ) => unknown;
    jest
      .spyOn(config, 'get')
      .mockImplementation((...args: unknown[]) =>
        args[0] === WEBHOOK_ENV ? webhookValue : originalGet(...args),
      );

    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
    await clearThrottleCounters(redis);
    await purgeE2eUsers(prisma, PREFIX);

    const options = await ensureE2eOptions(prisma);
    const passwordHash = await new PasswordService().hash(PASSWORD);
    const ids: Record<string, string> = {};
    for (const [email, role] of [
      [SUPER, SystemRole.SUPER_ADMIN],
      [ADMIN, SystemRole.ADMIN],
      [VIEWER, SystemRole.VIEWER],
      [OTHER, SystemRole.ADMIN],
    ] as Array<[string, SystemRole]>) {
      const row = await prisma.systemUser.create({
        data: {
          email,
          firstName: 'E2E',
          lastName: role,
          phoneNumber: email === VIEWER ? null : PHONE,
          role,
          passwordHash,
          mustChangePassword: false,
          ...options,
        },
        select: { id: true },
      });
      ids[email] = row.id;
    }
    sessions = {};
    for (const email of [SUPER, ADMIN, VIEWER, OTHER]) {
      sessions[email] = { ...(await login(email)), id: ids[email] };
    }
  }, 120_000);

  beforeEach(async () => {
    calls.length = 0;
    fakeTransport.post.mockClear();
    transportStatus = 200;
    transportError = undefined;
    webhookValue = SENTINEL;
    // The per-user window must not leak between tests (the 429 test spends the whole quota).
    await redis.del(
      ...Object.values(sessions).map((s) => `eb:support:rate:${s.id}`),
    );
  });

  afterAll(async () => {
    // AC-B6: whatever else happened, nothing may have been fetched from a Discord host.
    const hosts = fetchedUrls.map((u) => new URL(u).hostname);
    expect(hosts.filter((h) => DISCORD_HOST.test(h))).toEqual([]);
    // ...and the relay never used `fetch` at all in this suite (the fake transport took every call).
    expect(fetchedUrls).toEqual([]);

    if (prisma) {
      await redis.del(
        ...Object.values(sessions).map((s) => `eb:support:rate:${s.id}`),
      );
      await purgeE2eUsers(prisma, PREFIX);
    }
    if (app) await app.close();
    jest.restoreAllMocks();
    global.fetch = realFetch;
  });

  describe('auth (AC-B2)', () => {
    it('no session (but a valid CSRF token) -> 401', async () => {
      // The CSRF middleware runs first, so an anonymous caller needs a token to reach the session guard.
      const agent = request.agent(server());
      const csrf = await agent.get(url('/auth/system/csrf')).expect(200);
      await agent
        .post(url('/system/support/incident'))
        .set('x-csrf-token', (csrf.body as { csrfToken: string }).csrfToken)
        .field('category', 'web')
        .expect(401);
      expect(calls).toHaveLength(0);
    });

    it('a valid session without the CSRF token -> 403', async () => {
      await submit(SUPER, { csrf: false }).expect(403);
      expect(calls).toHaveLength(0);
    });
  });

  describe('success for every role (AC-B4)', () => {
    it.each([
      [SUPER, SystemRole.SUPER_ADMIN, 'ผู้ดูแลระบบสูงสุด', PHONE],
      [ADMIN, SystemRole.ADMIN, 'เจ้าหน้าที่ดูแลระบบ', PHONE],
      [VIEWER, SystemRole.VIEWER, 'ผู้ดูข้อมูล', 'ไม่ได้ระบุ'],
    ])(
      '%s -> 200 and the message carries the SESSION role, name and phone',
      async (email, role, label, phone) => {
        const res = await submit(email, {
          fields: {
            // A forged role in diagnostics must be ignored.
            diagnostics: 'บทบาท: ผู้ดูแลระบบสูงสุด (SUPER_ADMIN)',
          },
        }).expect(200);

        const body = res.body as {
          success: boolean;
          code: string;
          timestamp: string;
        };
        expect(body.success).toBe(true);
        expect(body.code).toMatch(/^INC-\d+$/);
        expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);

        // The stub WAS hit, on the sentinel host, with wait=true (AC-B6).
        expect(fakeTransport.post).toHaveBeenCalledTimes(1);
        expect(calls[0].url.hostname).toBe('relay.invalid');
        expect(calls[0].url.searchParams.get('wait')).toBe('true');

        const p = payloadOf();
        expect(p.username).toBe('EasyBook Incident Bot');
        expect(p.embeds).toEqual([]);
        expect(p.content).toContain(`# รายการปัญหาจากระบบ ที่ ${body.code}/`);
        // Name and phone are the signed-in user's own row, not anything the client sent.
        expect(p.content).toContain(
          `||${FENCE}E2E ${role}  (${label})${FENCE}||`,
        );
        expect(p.content).toContain(`||${FENCE}${phone}${FENCE}||`);
        expect(p.content.length).toBeLessThanOrEqual(2000);
      },
    );

    it('a forged name or phone in the body is refused (400) and never relayed', async () => {
      for (const forged of [
        { reporterName: 'Forged Name' },
        { phoneNumber: '000-000-0000' },
        { firstName: 'Forged', lastName: 'Name' },
        { phone: '000-000-0000' },
      ]) {
        await submit(ADMIN, { fields: forged }).expect(400);
      }
      expect(calls).toHaveLength(0);

      // The honest request right after carries the SESSION identity.
      await submit(ADMIN).expect(200);
      const c = payloadOf().content;
      expect(c).toContain(`||${FENCE}E2E ADMIN  (`);
      expect(c).toContain(`||${FENCE}${PHONE}${FENCE}||`);
      expect(c).not.toContain('Forged');
      expect(c).not.toContain('000-000-0000');
    });

    it('a browser-style CRLF description arrives with LF only, inside its fence', async () => {
      await submit(ADMIN, {
        fields: { description: 'line one\r\nline two', diagnostics: 'a\r\nb' },
      }).expect(200);
      const c = payloadOf().content;
      expect(c).not.toContain('\r');
      expect(c).toContain(`${FENCE}\nline one\nline two\n${FENCE}`);
    });

    it.each([
      ['normal', '', [], '🔵'],
      ['urgent', '@Tech Support\n', [], '🟡'],
      ['critical', '@here\n', ['everyone'], '🔴'],
    ] as const)(
      '%s -> ping prefix %j, allowed_mentions %j, emoji %s',
      async (severity, prefix, parse, emoji) => {
        await submit(ADMIN, { fields: { severity } }).expect(200);
        const p = payloadOf();
        expect(p.content.startsWith(`${prefix}# รายการปัญหาจากระบบ ที่ `)).toBe(
          true,
        );
        expect(p.content).toContain(` ${emoji}\n> วันที่ `);
        expect(p.allowed_mentions).toEqual({ parse });
        expect(p.embeds).toEqual([]);
      },
    );

    it('the widest legal report fits the 2000-character limit', async () => {
      await submit(ADMIN, {
        fields: {
          severity: 'critical',
          path: '/'.repeat(200),
          description: 'ก'.repeat(1000),
          diagnostics: 'x'.repeat(2000),
        },
      }).expect(200);
      const { content } = payloadOf();
      expect(content.length).toBeLessThanOrEqual(2000);
      expect([...content].length).toBeLessThanOrEqual(2000);
    });

    it('N files -> N files[n] attachments, named by the SNIFFED type', async () => {
      await submit(ADMIN, {
        files: [
          // Declared type and filename both lie; the bytes decide.
          { buffer: PNG, name: 'a.jpg', type: 'image/jpeg' },
          { buffer: JPG, name: 'b.png', type: 'image/png' },
          { buffer: PNG, name: 'c.txt', type: 'text/plain' },
        ],
      }).expect(200);
      expect(payloadOf().attachments).toEqual([
        { id: 0, filename: 'screenshot-1.png' },
        { id: 1, filename: 'screenshot-2.jpg' },
        { id: 2, filename: 'screenshot-3.png' },
      ]);
      expect(calls[0].form.get('files[0]')).not.toBeNull();
      expect(calls[0].form.get('files[2]')).not.toBeNull();
      expect(calls[0].form.get('files[3]')).toBeNull();
    });

    it('a file of exactly 5 MiB is accepted', async () => {
      await submit(ADMIN, {
        files: [{ buffer: pngOfSize(5 * 1024 * 1024), name: 'big.png' }],
      }).expect(200);
    });

    it('the incident code increases monotonically', async () => {
      const a = (await submit(ADMIN).expect(200)).body as { code: string };
      const b = (await submit(ADMIN).expect(200)).body as { code: string };
      expect(Number(b.code.slice(4))).toBe(Number(a.code.slice(4)) + 1);
    });
  });

  describe('400 validation (AC-B3)', () => {
    it.each([
      ['bad category enum', { category: 'nope' }],
      ['bad severity enum', { severity: 'apocalyptic' }],
      ['empty description', { description: '' }],
      ['whitespace-only description', { description: '   ' }],
      ['description of 1001 chars', { description: 'ก'.repeat(1001) }],
      ['missing path', { path: undefined }],
      ['path of 201 chars', { path: '/'.repeat(201) }],
      ['diagnostics of 2001 chars', { diagnostics: 'x'.repeat(2001) }],
      ['an unknown field', { role: 'SUPER_ADMIN' }],
    ])('%s -> 400 and nothing is relayed', async (_label, fields) => {
      await submit(ADMIN, { fields }).expect(400);
      expect(calls).toHaveLength(0);
    });

    it('a description of exactly 1000 chars is accepted', async () => {
      await submit(ADMIN, { fields: { description: 'ก'.repeat(1000) } }).expect(
        200,
      );
    });

    it('a 4th file -> 400', async () => {
      await submit(ADMIN, {
        files: [PNG, PNG, PNG, PNG].map((buffer, i) => ({
          buffer,
          name: `${i}.png`,
        })),
      }).expect(400);
      expect(calls).toHaveLength(0);
    });

    it('a renamed PDF is rejected by its BYTES -> coded 400', async () => {
      const res = await submit(ADMIN, {
        files: [{ buffer: PDF, name: 'screenshot.png', type: 'image/png' }],
      }).expect(400);
      expect((res.body as ErrorBody).code).toBe(
        'SUPPORT_FILE_TYPE_UNSUPPORTED',
      );
      expect((res.body as ErrorBody).message).toBe(
        'ไฟล์แนบต้องเป็นภาพ PNG, JPG หรือ WEBP เท่านั้น',
      );
      expect(calls).toHaveLength(0);
    });

    it('a file sent under the wrong part name -> 400', async () => {
      await as(ADMIN)
        .agent.post(url('/system/support/incident'))
        .set('x-csrf-token', as(ADMIN).token)
        .field('category', 'web')
        .field('severity', 'normal')
        .field('path', '/x')
        .field('description', 'd')
        .attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' })
        .expect(400);
    });
  });

  describe('413 (AC-B3)', () => {
    it('a file of 5 MiB + 1 byte -> 413 SUPPORT_FILE_TOO_LARGE', async () => {
      const res = await submit(ADMIN, {
        files: [{ buffer: pngOfSize(5 * 1024 * 1024 + 1), name: 'big.png' }],
      }).expect(413);
      expect((res.body as ErrorBody).code).toBe('SUPPORT_FILE_TOO_LARGE');
      expect((res.body as ErrorBody).message).toBe(
        'ไฟล์ภาพแต่ละไฟล์ต้องมีขนาดไม่เกิน 5 MB',
      );
      expect(calls).toHaveLength(0);
    });

    it('two near-5 MiB files exceed the combined budget -> 413 SUPPORT_ATTACHMENTS_TOO_LARGE', async () => {
      const res = await submit(ADMIN, {
        files: [
          { buffer: pngOfSize(5 * 1024 * 1024), name: 'a.png' },
          { buffer: pngOfSize(5 * 1024 * 1024), name: 'b.png' },
        ],
      }).expect(413);
      expect((res.body as ErrorBody).code).toBe(
        'SUPPORT_ATTACHMENTS_TOO_LARGE',
      );
      expect(calls).toHaveLength(0);
    });

    it('Discord answering 413 -> 413 SUPPORT_ATTACHMENTS_TOO_LARGE', async () => {
      transportStatus = 413;
      const res = await submit(ADMIN).expect(413);
      expect((res.body as ErrorBody).code).toBe(
        'SUPPORT_ATTACHMENTS_TOO_LARGE',
      );
      expect(calls).toHaveLength(1);
    });
  });

  describe('503 not configured (AC-B5)', () => {
    it.each([
      ['blank', ''],
      ['malformed', 'not a url'],
    ])(
      '%s webhook -> 503 SUPPORT_NOT_CONFIGURED with a Thai message',
      async (_l, value) => {
        webhookValue = value;
        const res = await submit(ADMIN).expect(503);
        const body = res.body as ErrorBody;
        expect(body.code).toBe('SUPPORT_NOT_CONFIGURED');
        expect(body.message).toBe(
          'ระบบแจ้งปัญหายังไม่พร้อมใช้งาน กรุณาติดต่อทีมพัฒนาผ่าน Discord',
        );
        expect(calls).toHaveLength(0);
      },
    );

    it('a 503 does not spend rate-limit quota', async () => {
      webhookValue = '';
      for (let i = 0; i < 7; i++) await submit(ADMIN).expect(503);
      webhookValue = SENTINEL;
      await submit(ADMIN).expect(200);
    });
  });

  describe('502 relay failed (AC-B5)', () => {
    it('Discord answering 500 -> 502 SUPPORT_RELAY_FAILED, no URL in the body', async () => {
      transportStatus = 500;
      const res = await submit(ADMIN).expect(502);
      const body = res.body as ErrorBody;
      expect(body.code).toBe('SUPPORT_RELAY_FAILED');
      expect(body.message).toBe(
        'ส่งแจ้งปัญหาถึงทีมพัฒนาไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หรือติดต่อทีมพัฒนาผ่าน Discord',
      );
      expect(JSON.stringify(res.body)).not.toContain('relay.invalid');
    });

    it('Discord answering 429 -> 502 (not our 429)', async () => {
      transportStatus = 429;
      await submit(ADMIN).expect(502);
    });

    it('a timeout / abort -> 502, and the URL the error carried never reaches the body', async () => {
      transportError = Object.assign(
        new Error(`The operation was aborted ${SENTINEL}`),
        { name: 'TimeoutError' },
      );
      const res = await submit(ADMIN).expect(502);
      expect((res.body as ErrorBody).code).toBe('SUPPORT_RELAY_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('relay.invalid');
    });

    it('a network error -> 502', async () => {
      transportError = new TypeError(`fetch failed ${SENTINEL}`);
      await submit(ADMIN).expect(502);
    });
  });

  describe('429 rate limit (AC-B7)', () => {
    it('the 6th report in the window -> 429, and a different user is unaffected', async () => {
      for (let i = 0; i < 5; i++) await submit(ADMIN).expect(200);

      const res = await submit(ADMIN).expect(429);
      const body = res.body as ErrorBody;
      expect(body.code).toBe('SUPPORT_RATE_LIMITED');
      expect(body.message).toBe(
        'ส่งแจ้งปัญหาบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
      );
      expect(calls).toHaveLength(5);

      // Another user, same role, is on their own window.
      await submit(OTHER).expect(200);
      expect(calls).toHaveLength(6);
    });

    it('the window key carries a TTL (it can never become a permanent ban)', async () => {
      await submit(VIEWER).expect(200);
      const ttl = await redis.ttl(`eb:support:rate:${as(VIEWER).id}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(600);
    });

    it('a Discord failure still uses a slot (retry-storm brake)', async () => {
      transportStatus = 500;
      for (let i = 0; i < 5; i++) await submit(ADMIN).expect(502);
      await submit(ADMIN).expect(429);
    });
  });
});
