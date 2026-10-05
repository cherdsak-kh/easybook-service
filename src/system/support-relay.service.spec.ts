import { HttpException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SystemRole } from '@prisma/client';
import type { RedisService } from '../redis/redis.service';
import type { SupportIncidentDto } from './dto/support-incident.dto';
import {
  fallbackIncidentCode,
  SupportRelayService,
} from './support-relay.service';
import { SupportWebhookTransport } from './support-webhook.transport';

/** Sentinel on a reserved TLD (RFC 2606): can never resolve, and keeps the Discord-URL grep meaningful. */
const SENTINEL = 'https://relay.invalid/hook?token=sentinel-secret';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const PDF = Buffer.from('%PDF-1.7 not an image');

const file = (buffer: Buffer, name = 'x.png'): Express.Multer.File =>
  ({
    buffer,
    size: buffer.length,
    mimetype: 'image/png',
    originalname: name,
  }) as Express.Multer.File;

const dto = (over: Partial<SupportIncidentDto> = {}): SupportIncidentDto => ({
  category: 'web',
  severity: 'normal',
  path: '/backend/x',
  description: 'something broke',
  diagnostics: 'UA: jest',
  ...over,
});

const FENCE = '`'.repeat(3);

const user = {
  id: 'cuid-1',
  role: SystemRole.ADMIN,
  firstName: 'สมหญิง',
  lastName: 'รักดี',
  phoneNumber: '089-999-0000',
};

describe('SupportRelayService', () => {
  let configValue: string | undefined;
  let transportStatus: number;
  let transportError: Error | undefined;
  let incrementWindow: jest.Mock;
  let incrementSequence: jest.Mock;
  const calls: Array<{ url: URL; form: FormData; signal: AbortSignal }> = [];
  let logged: string[];

  const transport: SupportWebhookTransport = {
    post: jest.fn((url: URL, form: FormData, signal: AbortSignal) => {
      calls.push({ url, form, signal });
      return transportError
        ? Promise.reject(transportError)
        : Promise.resolve(transportStatus);
    }),
  };

  const make = () =>
    new SupportRelayService(
      { get: () => configValue } as unknown as ConfigService,
      { incrementWindow, incrementSequence } as unknown as RedisService,
      transport,
    );

  const payloadOf = (i = 0) =>
    JSON.parse(calls[i].form.get('payload_json') as string) as {
      username: string;
      content: string;
      allowed_mentions: { parse: string[] };
      embeds: unknown[];
      attachments: Array<{ id: number; filename: string }>;
    };

  const rejection = async (p: Promise<unknown>): Promise<HttpException> => {
    try {
      await p;
    } catch (e) {
      return e as HttpException;
    }
    throw new Error('expected a rejection');
  };

  beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    logged = [];
    configValue = SENTINEL;
    transportStatus = 200;
    transportError = undefined;
    incrementWindow = jest.fn().mockResolvedValue(1);
    incrementSequence = jest.fn().mockResolvedValue(43);
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((m: unknown) => void logged.push(String(m)));
    }
  });

  afterEach(() => jest.restoreAllMocks());

  describe('success', () => {
    it('relays and returns { success, code, timestamp } with INC-<1000+n>', async () => {
      const res = await make().submit(user, dto());
      expect(res.success).toBe(true);
      expect(res.code).toBe('INC-1043');
      expect(new Date(res.timestamp).toISOString()).toBe(res.timestamp);
      expect(calls).toHaveLength(1);
      expect(logged).toContain(
        'Support incident relayed. code=INC-1043 severity=normal files=0',
      );
    });

    it('posts to the configured host with wait=true, keeping any existing query', async () => {
      await make().submit(user, dto());
      expect(calls[0].url.hostname).toBe('relay.invalid');
      expect(calls[0].url.searchParams.get('wait')).toBe('true');
      expect(calls[0].url.searchParams.get('token')).toBe('sentinel-secret');
    });

    it('the message heading carries the same code as the response, and there is no embed', async () => {
      const res = await make().submit(user, dto());
      const p = payloadOf();
      expect(p.content).toContain(`# รายการปัญหาจากระบบ ที่ ${res.code}/`);
      expect(p.embeds).toEqual([]);
      // 'now' is a real clock here, so only check the shape of the date line.
      expect(p.content).toMatch(
        /\n> วันที่ \d{1,2} \S+ \d{4} {2}เวลา \d{2}\.\d{2} น\.\n/,
      );
    });

    it('uses the time-boxed signal', async () => {
      await make().submit(user, dto());
      expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    });

    it.each([
      ['normal', '', [], '🔵'],
      ['urgent', '@Tech Support\n', [], '🟡'],
      ['critical', '@here\n', ['everyone'], '🔴'],
    ] as const)(
      '%s payload: ping prefix, allowed_mentions, emoji, no embeds',
      async (severity, prefix, parse, emoji) => {
        await make().submit(user, dto({ severity }));
        const p = payloadOf();
        expect(p.username).toBe('EasyBook Incident Bot');
        expect(
          p.content.startsWith(`${prefix}# รายการปัญหาจากระบบ ที่ INC-1043/`),
        ).toBe(true);
        expect(p.content.split('\n')[prefix ? 1 : 0].endsWith(emoji)).toBe(
          true,
        );
        expect(p.allowed_mentions).toEqual({ parse });
        expect(p.embeds).toEqual([]);
        expect(p.content.length).toBeLessThanOrEqual(2000);
      },
    );

    it('the reporter role is the SESSION role, whatever the diagnostics claim', async () => {
      await make().submit(
        { id: 'u', role: SystemRole.VIEWER },
        dto({ diagnostics: 'บทบาท: ผู้ดูแลระบบสูงสุด (SUPER_ADMIN)' }),
      );
      expect(payloadOf().content).toContain('(ผู้ดูข้อมูล)');
    });

    it('the reporter name and phone come from the SESSION user', async () => {
      await make().submit(user, dto());
      const c = payloadOf().content;
      expect(c).toContain(
        `||${FENCE}สมหญิง รักดี  (เจ้าหน้าที่ดูแลระบบ)${FENCE}||`,
      );
      expect(c).toContain(`||${FENCE}089-999-0000${FENCE}||`);
    });

    it.each([
      ['no name, no phone', { id: 'u', role: SystemRole.ADMIN }],
      [
        'blank names, null phone',
        {
          id: 'u',
          role: SystemRole.ADMIN,
          firstName: '',
          lastName: '  ',
          phoneNumber: null,
        },
      ],
    ])(
      '%s -> placeholders, and the request still succeeds',
      async (_label, sparse) => {
        await expect(make().submit(sparse, dto())).resolves.toMatchObject({
          success: true,
        });
        const c = payloadOf().content;
        expect(c).toContain(`||${FENCE}—  (เจ้าหน้าที่ดูแลระบบ)${FENCE}||`);
        expect(c).toContain(`||${FENCE}ไม่ได้ระบุ${FENCE}||`);
      },
    );

    it('a one-sided name uses just that part', async () => {
      await make().submit({ ...user, lastName: '' }, dto());
      expect(payloadOf().content).toContain(`||${FENCE}สมหญิง  (`);
    });

    it('attaches N files as files[n] with server-generated, sniffed names', async () => {
      await make().submit(
        user,
        dto(),
        // the declared names/MIME lie; only the bytes count
        [file(PNG, '../../evil.exe'), file(JPG, 'a.png')],
      );
      expect(calls[0].form.get('files[0]')).toBeInstanceOf(Blob);
      expect((calls[0].form.get('files[0]') as File).name).toBe(
        'screenshot-1.png',
      );
      expect((calls[0].form.get('files[1]') as File).name).toBe(
        'screenshot-2.jpg',
      );
      expect(calls[0].form.get('files[2]')).toBeNull();
      expect(payloadOf().attachments).toEqual([
        { id: 0, filename: 'screenshot-1.png' },
        { id: 1, filename: 'screenshot-2.jpg' },
      ]);
    });
  });

  describe('503 not configured', () => {
    it.each([
      ['unset', undefined],
      ['blank', '   '],
      ['unparsable', 'not a url'],
      ['not https', 'http://relay.invalid/hook'],
    ])(
      '%s -> 503 SUPPORT_NOT_CONFIGURED, nothing sent, no quota used',
      async (_l, value) => {
        configValue = value;
        const e = await rejection(make().submit(user, dto()));
        expect(e.getStatus()).toBe(503);
        expect(e.getResponse()).toMatchObject({
          code: 'SUPPORT_NOT_CONFIGURED',
          message:
            'ระบบแจ้งปัญหายังไม่พร้อมใช้งาน กรุณาติดต่อทีมพัฒนาผ่าน Discord',
        });
        expect(calls).toHaveLength(0);
        expect(incrementWindow).not.toHaveBeenCalled();
      },
    );

    it('re-reads the config on every request (not captured at construction)', async () => {
      const svc = make();
      configValue = '';
      await rejection(svc.submit(user, dto()));
      configValue = SENTINEL;
      await expect(svc.submit(user, dto())).resolves.toMatchObject({
        success: true,
      });
    });

    it('an invalid value warns ONCE per process, naming the variable and never the value', async () => {
      configValue = 'http://relay.invalid/secret-path';
      const svc = make();
      await rejection(svc.submit(user, dto()));
      await rejection(svc.submit(user, dto()));
      const warns = logged.filter((l) => l.includes('Support relay disabled'));
      expect(warns).toEqual([
        'Support relay disabled: DISCORD_SUPPORT_WEBHOOK_URL is not a valid https URL.',
      ]);
      expect(logged.join('\n')).not.toContain('secret-path');
    });

    it('an unset value logs nothing', async () => {
      configValue = undefined;
      await rejection(make().submit(user, dto()));
      expect(logged).toEqual([]);
    });
  });

  describe('400 / 413 before the relay', () => {
    it('a renamed PDF is a coded 400 and nothing is sent', async () => {
      const e = await rejection(
        make().submit(user, dto(), [file(PDF, 'shot.png')]),
      );
      expect(e.getStatus()).toBe(400);
      expect(e.getResponse()).toMatchObject({
        code: 'SUPPORT_FILE_TYPE_UNSUPPORTED',
        message: 'ไฟล์แนบต้องเป็นภาพ PNG, JPG หรือ WEBP เท่านั้น',
      });
      expect(calls).toHaveLength(0);
      expect(incrementWindow).not.toHaveBeenCalled();
    });

    it('a 0-byte file is a 400', async () => {
      const e = await rejection(
        make().submit(user, dto(), [file(Buffer.alloc(0))]),
      );
      expect(e.getStatus()).toBe(400);
    });

    it('one bad file among good ones rejects the whole report', async () => {
      const e = await rejection(
        make().submit(user, dto(), [file(PNG), file(PDF)]),
      );
      expect(e.getStatus()).toBe(400);
    });

    it('combined size over 9.5 MiB is a coded 413 and uses no rate-limit slot', async () => {
      const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 - 20)]);
      const e = await rejection(
        make().submit(user, dto(), [file(big), file(big)]),
      );
      expect(e.getStatus()).toBe(413);
      expect(e.getResponse()).toMatchObject({
        code: 'SUPPORT_ATTACHMENTS_TOO_LARGE',
      });
      expect(incrementWindow).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    });
  });

  describe('429 rate limit (fail open)', () => {
    it('the 5th submission passes, the 6th is a coded 429', async () => {
      incrementWindow.mockResolvedValue(5);
      await expect(make().submit(user, dto())).resolves.toMatchObject({
        success: true,
      });
      incrementWindow.mockResolvedValue(6);
      const e = await rejection(make().submit(user, dto()));
      expect(e.getStatus()).toBe(429);
      expect(e.getResponse()).toMatchObject({
        statusCode: 429,
        error: 'Too Many Requests',
        code: 'SUPPORT_RATE_LIMITED',
        message: 'ส่งแจ้งปัญหาบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
      });
      expect(calls).toHaveLength(1);
    });

    it('keys the window on the session user id with a 600 s TTL', async () => {
      await make().submit({ id: 'cuid-xyz', role: SystemRole.ADMIN }, dto());
      expect(incrementWindow).toHaveBeenCalledWith('rate:cuid-xyz', 600);
    });

    it('Redis unavailable (null) -> fails OPEN and still relays', async () => {
      incrementWindow.mockResolvedValue(null);
      await expect(make().submit(user, dto())).resolves.toMatchObject({
        success: true,
      });
      expect(calls).toHaveLength(1);
    });
  });

  describe('incident code', () => {
    it('falls back to a Bangkok-clock BE code when the sequence is unavailable', async () => {
      incrementSequence.mockResolvedValue(null);
      const res = await make().submit(user, dto());
      expect(res.code).toMatch(/^INC-\d{8}-\d{6}$/);
    });

    it('fallbackIncidentCode: Bangkok clock, Buddhist year', () => {
      expect(fallbackIncidentCode(new Date('2026-10-05T15:31:07.000Z'))).toBe(
        'INC-25691005-223107',
      );
      // 17:30 UTC on the 5th is already the 6th in Bangkok.
      expect(fallbackIncidentCode(new Date('2026-10-05T17:30:00.000Z'))).toBe(
        'INC-25691006-003000',
      );
    });
  });

  describe('upstream failures', () => {
    it.each([400, 401, 404, 429, 500, 503])(
      'Discord %i -> 502 SUPPORT_RELAY_FAILED (Thai message)',
      async (status) => {
        transportStatus = status;
        const e = await rejection(make().submit(user, dto()));
        expect(e.getStatus()).toBe(502);
        expect(e.getResponse()).toMatchObject({
          code: 'SUPPORT_RELAY_FAILED',
          message:
            'ส่งแจ้งปัญหาถึงทีมพัฒนาไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หรือติดต่อทีมพัฒนาผ่าน Discord',
        });
        expect(logged).toContain(
          `Support relay failed. code=SUPPORT_RELAY_FAILED status=${status}`,
        );
      },
    );

    it('Discord 413 -> 413 SUPPORT_ATTACHMENTS_TOO_LARGE', async () => {
      transportStatus = 413;
      const e = await rejection(make().submit(user, dto()));
      expect(e.getStatus()).toBe(413);
      expect(e.getResponse()).toMatchObject({
        code: 'SUPPORT_ATTACHMENTS_TOO_LARGE',
      });
    });

    it('a timeout rejection -> 502 and is logged as reason=timeout', async () => {
      transportError = Object.assign(new Error('The operation timed out'), {
        name: 'TimeoutError',
      });
      const e = await rejection(make().submit(user, dto()));
      expect(e.getStatus()).toBe(502);
      expect(logged).toContain(
        'Support relay failed. code=SUPPORT_RELAY_FAILED reason=timeout',
      );
    });

    it('a network TypeError -> 502 reason=network', async () => {
      transportError = new TypeError('fetch failed');
      const e = await rejection(make().submit(user, dto()));
      expect(e.getStatus()).toBe(502);
      expect(logged).toContain(
        'Support relay failed. code=SUPPORT_RELAY_FAILED reason=network',
      );
    });
  });

  describe('secret hygiene (AC-B5)', () => {
    it('a transport error that embeds the URL leaks into no exception, cause, body or log line', async () => {
      transportError = new TypeError(
        `fetch failed: connect ECONNREFUSED ${SENTINEL}`,
      );
      transportError.cause = new Error(`inner ${SENTINEL}`);
      const e = await rejection(make().submit(user, dto()));

      expect(e.message).not.toContain('relay.invalid');
      expect(e.cause).toBeUndefined();
      expect(JSON.stringify(e.getResponse())).not.toContain('relay.invalid');
      expect(logged.join('\n')).not.toContain('relay.invalid');
      expect(logged.join('\n')).not.toContain('sentinel-secret');
    });

    it.each([200, 413, 500])(
      'with Discord %i no log line carries the URL or the user text',
      async (status) => {
        transportStatus = status;
        await make()
          .submit(user, dto({ description: 'my private description' }))
          .catch(() => undefined);
        const all = logged.join('\n');
        expect(all).not.toContain('relay.invalid');
        expect(all).not.toContain('sentinel-secret');
        expect(all).not.toContain('my private description');
        // Revision 2 sends name and phone to Discord on purpose; they still never reach a log.
        expect(all).not.toContain('สมหญิง');
        expect(all).not.toContain('รักดี');
        expect(all).not.toContain('089-999-0000');
      },
    );

    it('a failed relay carries neither name nor phone in the exception or the logs', async () => {
      transportStatus = 500;
      const e = await rejection(make().submit(user, dto()));
      const seen = JSON.stringify(e.getResponse()) + logged.join('\n');
      expect(seen).not.toContain('สมหญิง');
      expect(seen).not.toContain('089-999-0000');
    });

    it('the 503 and 429 bodies carry no URL either', async () => {
      configValue = '';
      const a = await rejection(make().submit(user, dto()));
      configValue = SENTINEL;
      incrementWindow.mockResolvedValue(99);
      const b = await rejection(make().submit(user, dto()));
      for (const e of [a, b]) {
        expect(JSON.stringify(e.getResponse())).not.toContain('relay.invalid');
        expect(e.cause).toBeUndefined();
      }
    });
  });
});
