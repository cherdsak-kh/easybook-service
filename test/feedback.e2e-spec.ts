// The LINE Login channel id the guard verifies id_token `aud` against. MUST be set before the app
// boots (ConfigModule reads process.env at forRoot). Digits only, per env.validation.
process.env.LINE_LOGIN_CHANNEL_ID =
  process.env.LINE_LOGIN_CHANNEL_ID ?? '1234567890';

import type { INestApplication } from '@nestjs/common';
import { AppAccess, FeedbackType } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { API_BASE_PATH } from '../src/common/api.constants';
import {
  FEEDBACK_DESCRIPTION_MAX,
  FEEDBACK_PHOTO_MAX_BYTES,
  FEEDBACK_SUBJECT_MAX,
} from '../src/feedback/feedback.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { R2StorageService } from '../src/storage/r2-storage.service';
import { createE2eApp, prismaOf } from './e2e-app';

jest.setTimeout(180_000);

const CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;
const LU_PREFIX = 'e2efb-';
const ROW_PREFIX = 'e2e-fb-';
const R2_BASE = 'https://cdn.e2e.invalid';

const url = (path: string) => `${API_BASE_PATH}${path}`;

interface FeedbackBody {
  id: string;
  code: string;
  type: FeedbackType;
  venueId: string | null;
  venueName: string | null;
  subject: string;
  description: string;
  photos: string[];
  createdAt: string;
}

/** A byte-accurate PNG header + filler. Mirrors the avatar and venue specs' helper. */
const pngBytes = (size = 64): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(Math.max(0, size - 8)),
  ]);
const jpegBytes = (size = 64): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(Math.max(0, size - 4)),
  ]);
/** "RIFF" …size… "WEBP" — an image the shared sniffer recognises and THIS route must refuse. */
const webpBytes = (): Buffer =>
  Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WEBP'),
    Buffer.alloc(52),
  ]);
const pdfBytes = (): Buffer =>
  Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(56)]);

/** The verify-endpoint mock's current answer. Mirrors `line-settings.e2e-spec.ts`. */
let currentSub = '';
const futureExp = () => Math.floor(Date.now() / 1000) + 3600;

/**
 * `POST /line-users/feedback` and `POST /line-users/feedback/photos` (`CLIENT-ISSUE-1`), against
 * the real HTTP pipeline `configureApp` assembles.
 *
 * 🔴 FOUR OF THE PROPERTIES BELOW ARE UNREACHABLE FROM A UNIT SPEC, and each fails silently:
 *
 * 1. **Route order (`SC-6`).** Both paths are literals on the `line-users` family, which four other
 *    controllers in two other modules also serve. A parameterised POST registered ahead of them
 *    would answer with somebody else's handler, and nothing would throw.
 * 2. **The CSRF exemption.** The middleware runs BEFORE the router, so a missing entry in
 *    `CSRF_EXEMPT_PATHS` is a `403` that `LineIdTokenGuard` never even sees. Every request below
 *    sends NO `x-csrf-token` header, deliberately.
 * 3. **`ValidationPipe` + `forbidNonWhitelisted`.** The DTO is the transport boundary; a unit spec
 *    calls the service with an object the pipe never saw.
 * 4. **400-not-413 on an oversized upload.** `FileInterceptor` maps multer's `LIMIT_FILE_SIZE` to a
 *    `PayloadTooLargeException` before any filter sees a `MulterError`, so only a real request over
 *    the real interceptor proves `MulterErrorTo400Filter` is wired.
 */
describe('Feedback (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let allowedId = '';
  let venueId = '';
  let deletedVenueId = '';

  const server = () => app.getHttpServer();

  // The R2 seam, faked. The e2e suite must NEVER hit real object storage.
  //
  // ⚠️ `publicBaseUrl` MATTERS AS MUCH AS `putImage`: `FeedbackService` validates every submitted
  // photo URL against it, so a fake that forgot to answer it would make every photo assertion below
  // pass vacuously (it would 400 everything instead).
  /** Typed because the tests READ its arguments — a bare jest.fn() makes them `any`. */
  const putImage = jest.fn<Promise<void>, [string, Buffer, string]>();
  let keyCounter = 0;
  const storageFake = {
    isConfigured: () => true,
    publicBaseUrl: () => R2_BASE,
    buildFeedbackPhotoKey: (type: string) =>
      `feedback/${String(++keyCounter).padStart(32, '0')}.${
        type === 'image/png' ? 'png' : 'jpg'
      }`,
    publicUrlFor: (key: string) => `${R2_BASE}/${key}`,
    putImage,
  };

  const purge = async () => {
    // `feedbacks.lineUserId` is ON DELETE CASCADE, so removing the fixture users removes their
    // submissions; the venue-scoped delete covers the rows a deleted user never owned.
    await prisma.$executeRawUnsafe(
      `DELETE FROM feedbacks WHERE "venueId" IN (SELECT id FROM venues WHERE "name" LIKE '${ROW_PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM line_users WHERE "lineUserId" LIKE '${LU_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venues WHERE "name" LIKE '${ROW_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venue_types WHERE "name" LIKE '${ROW_PREFIX}%'`,
    );
  };

  const seed = async () => {
    await purge();
    const type = await prisma.venueType.create({
      data: { name: `${ROW_PREFIX}hall` },
      select: { id: true },
    });
    venueId = (
      await prisma.venue.create({
        data: {
          name: `${ROW_PREFIX}room`,
          venueTypeId: type.id,
          capacity: 20,
          // CLOSED on purpose: a closed venue is exactly the one somebody reports a problem about,
          // so this fixture also proves `isOpen` is not part of the lookup.
          isOpen: false,
          closedReason: 'ปิดปรับปรุง',
        },
        select: { id: true },
      })
    ).id;
    deletedVenueId = (
      await prisma.venue.create({
        data: {
          name: `${ROW_PREFIX}gone`,
          venueTypeId: type.id,
          capacity: 20,
          deletedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;

    allowedId = (
      await prisma.lineUser.create({
        data: { lineUserId: `${LU_PREFIX}allowed`, access: AppAccess.ALLOWED },
        select: { id: true },
      })
    ).id;
    await prisma.lineUser.create({
      data: { lineUserId: `${LU_PREFIX}pending`, access: AppAccess.PENDING },
    });
    await prisma.lineUser.create({
      data: {
        lineUserId: `${LU_PREFIX}gone`,
        access: AppAccess.ALLOWED,
        deletedAt: new Date(),
      },
    });
  };

  beforeAll(async () => {
    jest.spyOn(global, 'fetch').mockImplementation((_input, init) => {
      const body = init?.body as URLSearchParams | undefined;
      if (body?.get('id_token') === 'invalid') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: 'invalid_request' }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            iss: 'https://access.line.me',
            sub: currentSub,
            aud: CHANNEL_ID,
            exp: futureExp(),
          }),
      } as Response);
    });

    app = await createE2eApp((builder) =>
      builder.overrideProvider(R2StorageService).useValue(storageFake),
    );
    prisma = prismaOf(app);
    await seed();
  }, 60_000);

  beforeEach(async () => {
    putImage.mockReset();
    putImage.mockResolvedValue(undefined);
    await prisma.$executeRawUnsafe(
      `DELETE FROM feedbacks WHERE "lineUserId" IN (SELECT id FROM line_users WHERE "lineUserId" LIKE '${LU_PREFIX}%')`,
    );
  });

  afterAll(async () => {
    await purge();
    jest.restoreAllMocks();
    await app.close();
  });

  /** 🔴 NO `x-csrf-token` ANYWHERE IN THIS FILE — that absence is assertion #2 above. */
  const submit = (sub: string, body: unknown) => {
    currentSub = sub;
    return request(server())
      .post(url('/line-users/feedback'))
      .set('Authorization', 'Bearer good-token')
      .send(body as object);
  };

  const uploadPhoto = (
    sub: string,
    bytes: Buffer,
    filename: string,
    contentType: string,
  ) => {
    currentSub = sub;
    return request(server())
      .post(url('/line-users/feedback/photos'))
      .set('Authorization', 'Bearer good-token')
      .attach('file', bytes, { filename, contentType });
  };

  const valid = (over: Record<string, unknown> = {}) => ({
    type: FeedbackType.ISSUE,
    subject: 'แอร์ไม่เย็น',
    description: 'แอร์ฝั่งหน้าต่างไม่ทำงานมา 3 วันแล้วครับ',
    ...over,
  });

  const rowCount = () =>
    prisma.feedback.count({
      where: { lineUser: { lineUserId: { startsWith: LU_PREFIX } } },
    });

  // ─────────────────────────── auth (AC-33, AC-35) ───────────────────────────

  it('both routes are 401 without an Authorization header, and write nothing', async () => {
    await request(server())
      .post(url('/line-users/feedback'))
      .send(valid())
      .expect(401);
    await request(server())
      .post(url('/line-users/feedback/photos'))
      .attach('file', pngBytes(), {
        filename: 'a.png',
        contentType: 'image/png',
      })
      .expect(401);

    expect(await rowCount()).toBe(0);
    expect(putImage).not.toHaveBeenCalled();
  });

  it('a token LINE rejects is 401, never a 403 or a 500', async () => {
    currentSub = `${LU_PREFIX}allowed`;
    await request(server())
      .post(url('/line-users/feedback'))
      .set('Authorization', 'Bearer invalid')
      .send(valid())
      .expect(401);
  });

  it.each([
    ['a PENDING account', `${LU_PREFIX}pending`],
    ['an unfollowed (soft-deleted) account', `${LU_PREFIX}gone`],
    ['a sub with no row at all', `${LU_PREFIX}ghost`],
  ])('submitting with %s is 403 and writes nothing', async (_label, sub) => {
    await submit(sub, valid()).expect(403);
    expect(await rowCount()).toBe(0);
  });

  it('🔴 the photo route requires ALLOWED too (D-A6) — it is not open to any follower', async () => {
    // Beyond AC-35's literal wording on purpose: this route writes 5 MB objects into a public-read
    // bucket, so a token-bearing PENDING/BLOCKED follower would otherwise get free storage.
    await uploadPhoto(
      `${LU_PREFIX}pending`,
      pngBytes(),
      'a.png',
      'image/png',
    ).expect(403);
    expect(putImage).not.toHaveBeenCalled();
  });

  // ─────────────────────────── the happy path (AC-37, AC-38, AC-41) ───────────────────────────

  it('submits with NO CSRF token and answers 201 with a human-readable code', async () => {
    const res = await submit(`${LU_PREFIX}allowed`, valid()).expect(201);
    const body = res.body as FeedbackBody;

    expect(body.code).toMatch(/^ISS-\d{8}-\d{3,}$/);
    expect(body.venueId).toBeNull();
    expect(body.venueName).toBeNull();
    expect(body.photos).toEqual([]);

    const row = await prisma.feedback.findUnique({
      where: { code: body.code },
      select: { lineUserId: true, status: true, venueId: true },
    });
    // 🔴 AC-34: the FK holds the CUID, never the `U…` sub. Both are strings, so the wrong one
    // type-checks perfectly — only a real row can tell them apart.
    expect(row?.lineUserId).toBe(allowedId);
    expect(row?.status).toBe('PENDING');
    expect(row?.venueId).toBeNull();
  });

  it('numbers the per-day sequence per TYPE — the two prefixes are two counters', async () => {
    const first = (await submit(`${LU_PREFIX}allowed`, valid()).expect(201))
      .body as FeedbackBody;
    const second = (await submit(`${LU_PREFIX}allowed`, valid()).expect(201))
      .body as FeedbackBody;
    const suggestion = (
      await submit(
        `${LU_PREFIX}allowed`,
        valid({ type: FeedbackType.FEEDBACK }),
      ).expect(201)
    ).body as FeedbackBody;

    const seq = (code: string) => code.split('-')[2];
    expect(Number(seq(second.code))).toBe(Number(seq(first.code)) + 1);
    // The suggestion starts its own sequence: a shared counter would skip a visible number and the
    // reference a reporter reads as "the 3rd issue today" would be a lie.
    expect(suggestion.code.startsWith('FDB-')).toBe(true);
    expect(seq(suggestion.code)).toBe('001');
    expect(new Set([first.code, second.code, suggestion.code]).size).toBe(3);
  });

  it('accepts a CLOSED venue and echoes its name (AC-10 / E-5’s other half)', async () => {
    const body = (
      await submit(`${LU_PREFIX}allowed`, valid({ venueId })).expect(201)
    ).body as FeedbackBody;

    expect(body.venueId).toBe(venueId);
    expect(body.venueName).toBe(`${ROW_PREFIX}room`);
  });

  it('accepts an explicit null venueId as “ปัญหาทั่วไป”', async () => {
    const body = (
      await submit(`${LU_PREFIX}allowed`, valid({ venueId: null })).expect(201)
    ).body as FeedbackBody;
    expect(body.venueId).toBeNull();
  });

  it.each([
    ['an unknown id', 'clx_does_not_exist'],
    ['a soft-deleted venue', 'DELETED'],
  ])('🔴 %s is a 400, never a 404 and never a 500 (E-5)', async (_l, id) => {
    const target = id === 'DELETED' ? deletedVenueId : id;
    await submit(`${LU_PREFIX}allowed`, valid({ venueId: target })).expect(400);
    expect(await rowCount()).toBe(0);
  });

  // ─────────────────────────── validation (AC-36, E-9, D-4) ───────────────────────────

  it('refuses an unknown extra key — including a `category` (D-4)', async () => {
    await submit(`${LU_PREFIX}allowed`, valid({ category: 'AIRCON' })).expect(
      400,
    );
    // And the two identity/ownership fields a client must never be able to send.
    await submit(
      `${LU_PREFIX}allowed`,
      valid({ lineUserId: 'U_someone_else' }),
    ).expect(400);
    await submit(`${LU_PREFIX}allowed`, valid({ status: 'RESOLVED' })).expect(
      400,
    );
    expect(await rowCount()).toBe(0);
  });

  it.each([
    ['a missing type', { type: undefined }],
    ['an unknown type', { type: 'COMPLAINT' }],
    ['a lowercase type', { type: 'issue' }],
    ['a blank subject', { subject: '   ' }],
    ['a blank description', { description: '   ' }],
    ['an over-long subject', { subject: 'ก'.repeat(FEEDBACK_SUBJECT_MAX + 1) }],
    ['four photos', { photos: Array(4).fill(`${R2_BASE}/feedback/a.jpg`) }],
    ['a foreign photo URL', { photos: ['https://evil.example.com/x.jpg'] }],
    [
      'a photo URL under another prefix',
      { photos: [`${R2_BASE}/avatars/x.jpg`] },
    ],
  ])('%s is a 400', async (_label, over) => {
    await submit(`${LU_PREFIX}allowed`, valid(over)).expect(400);
    expect(await rowCount()).toBe(0);
  });

  it('🔴 E-9 · exactly 500 characters is valid and 501 is not — AFTER trimming', async () => {
    const at = 'ก'.repeat(FEEDBACK_DESCRIPTION_MAX);
    // Whitespace is trimmed BEFORE the count, so a padded 500 still fits. If the two sides counted
    // differently, the boundary the client draws and the one the server enforces would disagree by
    // exactly the padding.
    await submit(
      `${LU_PREFIX}allowed`,
      valid({ description: `  ${at}  ` }),
    ).expect(201);
    await submit(
      `${LU_PREFIX}allowed`,
      valid({ description: `${at}ก` }),
    ).expect(400);
  });

  // ─────────────────────────── photos (AC-39, AC-40) ───────────────────────────

  it('uploads with NO CSRF token; the key and ContentType come from the SNIFFED bytes', async () => {
    const res = await uploadPhoto(
      `${LU_PREFIX}allowed`,
      pngBytes(),
      // `originalname` is attacker-controlled and must never reach the key.
      '../../evil.php',
      'image/png',
    ).expect(200);

    expect((res.body as { url: string }).url).toMatch(
      new RegExp(`^${R2_BASE}/feedback/[0-9a-f]+\\.png$`),
    );
    expect(putImage.mock.calls[0][2]).toBe('image/png');
    expect(JSON.stringify(putImage.mock.calls)).not.toContain('evil');
  });

  it('AC-39 · a `.png`-named JPEG is stored as JPEG', async () => {
    const res = await uploadPhoto(
      `${LU_PREFIX}allowed`,
      jpegBytes(),
      'holiday.png',
      'image/jpeg',
    ).expect(200);

    expect((res.body as { url: string }).url).toMatch(/\.jpg$/);
    expect(putImage.mock.calls[0][2]).toBe('image/jpeg');
  });

  it.each([
    ['a `.jpg`-named PDF', pdfBytes(), 'invoice.jpg', 'image/jpeg'],
    ['a mislabelled JPEG', jpegBytes(), 'x.png', 'image/png'],
    ['🔴 a real WEBP (D-A8)', webpBytes(), 'x.webp', 'image/webp'],
    ['plain text', Buffer.from('not an image at all'), 'x.png', 'image/png'],
  ])('AC-39 · %s is a 400 and nothing is stored', async (_l, b, n, t) => {
    await uploadPhoto(`${LU_PREFIX}allowed`, b, n, t).expect(400);
    expect(putImage).not.toHaveBeenCalled();
  });

  it('a part named anything but `file` is a 400', async () => {
    currentSub = `${LU_PREFIX}allowed`;
    await request(server())
      .post(url('/line-users/feedback/photos'))
      .set('Authorization', 'Bearer good-token')
      .attach('photo', pngBytes(), {
        filename: 'a.png',
        contentType: 'image/png',
      })
      .expect(400);
    expect(putImage).not.toHaveBeenCalled();
  });

  /**
   * AC-40 — 400, not the 413 the stack produces by default.
   *
   * ⚠️ `MAX + 1` IS THE TRIPWIRE, AND `MAX` EXACTLY MUST STILL PASS. busboy's limit is exclusive, so
   * the interceptor is handed `MAX + 1`; getting that wrong makes the real ceiling `MAX - 1` and
   * silently contradicts both the message and the client's own pre-check.
   */
  it('AC-40 · exactly 5 MB is accepted and 5 MB + 1 is 400 (not 413)', async () => {
    await uploadPhoto(
      `${LU_PREFIX}allowed`,
      pngBytes(FEEDBACK_PHOTO_MAX_BYTES),
      'ok.png',
      'image/png',
    ).expect(200);

    await uploadPhoto(
      `${LU_PREFIX}allowed`,
      pngBytes(FEEDBACK_PHOTO_MAX_BYTES + 1),
      'big.png',
      'image/png',
    ).expect(400);
  });

  it('round-trips: an uploaded URL is accepted by the submit route', async () => {
    const upload = await uploadPhoto(
      `${LU_PREFIX}allowed`,
      pngBytes(),
      'a.png',
      'image/png',
    ).expect(200);
    const photo = (upload.body as { url: string }).url;

    const body = (
      await submit(`${LU_PREFIX}allowed`, valid({ photos: [photo] })).expect(
        201,
      )
    ).body as FeedbackBody;

    expect(body.photos).toEqual([photo]);
    const row = await prisma.feedback.findUnique({
      where: { code: body.code },
      select: { photos: true },
    });
    expect(row?.photos).toEqual([photo]);
  });
});
