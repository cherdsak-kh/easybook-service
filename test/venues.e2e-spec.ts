import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import { API_BASE_PATH } from '../src/common/api.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { R2StorageService } from '../src/storage/r2-storage.service';
import { TOMBSTONE_VENUE_TYPE_NAME } from '../src/venue-types/venue-types.constants';
import { VENUE_PHOTO_MAX_BYTES } from '../src/venues/venues.constants';
import {
  clearThrottleCounters,
  createE2eApp,
  ensureE2eOptions,
  prismaOf,
  purgeE2eUsers,
  redisOf,
  waitForRedis,
} from './e2e-app';

jest.setTimeout(180_000);

const SU_PREFIX = 'e2e-vnsu-';
const ROW_PREFIX = 'e2e-vn-';
const PASSWORD = 'E2e-correct-horse-battery-1';

const SUPER = `${SU_PREFIX}super@easybook.local`;
const ADMIN = `${SU_PREFIX}admin@easybook.local`;
const VIEWER = `${SU_PREFIX}viewer@easybook.local`;

const R2_BASE = 'https://cdn.e2e.invalid';
const STAGING = 'venues/_new/';

const url = (path: string) => `${API_BASE_PATH}${path}`;

interface Session {
  agent: request.Agent;
  token: string;
}

interface VenueBody {
  id: string;
  name: string;
  venueType: { id: number; name: string; isFallback: boolean };
  capacity: number;
  location: string | null;
  description: string | null;
  isOpen: boolean;
  closedReason: string | null;
  photos: { id: string; url: string; position: number }[];
  amenities: { id: number; name: string }[];
}

/** A byte-accurate PNG header + filler. Mirrors the avatar spec's helper. */
const pngBytes = (size = 64): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(Math.max(0, size - 8)),
  ]);

describe('Venues (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let typeId = 0;
  let otherTypeId = 0;
  let tombstoneId = 0;
  let amenityA = 0;
  let amenityB = 0;

  // The R2 seam, faked. The e2e suite must NEVER hit real object storage.
  //
  // ⚠️ `isConfigured` AND `publicBaseUrl` BOTH MATTER HERE, unlike in the avatar spec. `VenuesService`
  // validates `photoUrls` against `publicBaseUrl()` and SKIPS the check when it is undefined, so a
  // fake that forgot to answer it would make every photo assertion below pass vacuously.
  const putImage = jest.fn();
  const deleteObject = jest.fn();
  const copyObject = jest.fn();
  let keyCounter = 0;
  const storageFake = {
    isConfigured: () => true,
    publicBaseUrl: () => R2_BASE,
    buildAvatarKey: (userId: string, type: string) =>
      `avatars/${userId}/${'a'.repeat(32)}.${type === 'image/png' ? 'png' : 'jpg'}`,
    // Mirrors the real shapes, INCLUDING the staging prefix — a fake that returned a final-looking
    // key would make the re-home assertions below pass without the re-home ever running.
    buildVenuePhotoKey: (type: string) =>
      `${STAGING}${String(++keyCounter).padStart(32, '0')}.${type === 'image/png' ? 'png' : 'jpg'}`,
    venuePhotoKeyFor: (venueId: string, stagingKey: string) =>
      `venues/${venueId}/${stagingKey.slice(STAGING.length)}`,
    isStagedVenuePhotoKey: (key: string) => key.startsWith(STAGING),
    publicUrlFor: (key: string) => `${R2_BASE}/${key}`,
    putImage,
    deleteObject,
    copyObject,
  };

  /** A URL as it looks straight after upload: still in the staging folder, owned by nobody. */
  const photoUrl = (n: number) =>
    `${R2_BASE}/${STAGING}${String(n).padStart(32, '0')}.png`;

  /** The same photo once a venue owns it. */
  const homedUrl = (venueId: string, n: number) =>
    `${R2_BASE}/venues/${venueId}/${String(n).padStart(32, '0')}.png`;

  const server = () => app.getHttpServer();

  const login = async (email: string): Promise<Session> => {
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

  /** Raw SQL — the application never hard-deletes, and fixtures must not accumulate. */
  const purgeRows = async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM venue_amenities WHERE "venueId" IN (SELECT id FROM venues WHERE "name" LIKE '${ROW_PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venue_photos WHERE "venueId" IN (SELECT id FROM venues WHERE "name" LIKE '${ROW_PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venues WHERE "name" LIKE '${ROW_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venue_types WHERE "name" LIKE '${ROW_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM amenities WHERE "name" LIKE '${ROW_PREFIX}%'`,
    );
  };

  const ensureVenueTypeTombstone = async (): Promise<number> => {
    await prisma.$executeRawUnsafe(
      `UPDATE venue_types SET "deletedAt" = NULL WHERE "name" = $1 AND "isSystemReserved" = true`,
      TOMBSTONE_VENUE_TYPE_NAME,
    );
    const existing = await prisma.venueType.findFirst({
      where: {
        name: TOMBSTONE_VENUE_TYPE_NAME,
        deletedAt: null,
        isSystemReserved: true,
      },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await prisma.venueType.create({
      data: { name: TOMBSTONE_VENUE_TYPE_NAME, isSystemReserved: true },
      select: { id: true },
    });
    return created.id;
  };

  const seed = async () => {
    await purgeE2eUsers(prisma, SU_PREFIX);
    await purgeRows();
    tombstoneId = await ensureVenueTypeTombstone();

    typeId = (
      await prisma.venueType.create({
        data: { name: `${ROW_PREFIX}hall` },
        select: { id: true },
      })
    ).id;
    otherTypeId = (
      await prisma.venueType.create({
        data: { name: `${ROW_PREFIX}gym` },
        select: { id: true },
      })
    ).id;
    amenityA = (
      await prisma.amenity.create({
        data: { name: `${ROW_PREFIX}sound` },
        select: { id: true },
      })
    ).id;
    amenityB = (
      await prisma.amenity.create({
        data: { name: `${ROW_PREFIX}projector` },
        select: { id: true },
      })
    ).id;

    const passwordHash = await new PasswordService().hash(PASSWORD);
    const base = {
      passwordHash,
      mustChangePassword: false,
      ...(await ensureE2eOptions(prisma)),
    };
    for (const [email, role] of [
      [SUPER, SystemRole.SUPER_ADMIN],
      [ADMIN, SystemRole.ADMIN],
      [VIEWER, SystemRole.VIEWER],
    ] as Array<[string, SystemRole]>) {
      await prisma.systemUser.create({
        data: { email, firstName: 'E2E', lastName: role, role, ...base },
        select: { id: true },
      });
    }
  };

  const create = async (
    s: Session,
    body: Record<string, unknown>,
  ): Promise<VenueBody> => {
    const res = await s.agent
      .post(url('/venues'))
      .set('x-csrf-token', s.token)
      .send({
        name: `${ROW_PREFIX}a`,
        venueTypeId: typeId,
        capacity: 10,
        ...body,
      })
      .expect(201);
    return res.body as VenueBody;
  };

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder.overrideProvider(R2StorageService).useValue(storageFake),
    );
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
  }, 60_000);

  beforeEach(async () => {
    putImage.mockReset();
    deleteObject.mockReset();
    copyObject.mockReset();
    putImage.mockResolvedValue(undefined);
    deleteObject.mockResolvedValue(true);
    copyObject.mockResolvedValue(true);
    await clearThrottleCounters(redis);
    await seed();
  });

  afterAll(async () => {
    await purgeE2eUsers(prisma, SU_PREFIX);
    await purgeRows();
    await ensureVenueTypeTombstone();
    await clearThrottleCounters(redis);
    await app.close();
  });

  // ── Guards ────────────────────────────────────────────────────────────────
  describe('access', () => {
    it('no session is 401 on both read and write', async () => {
      const anon = request.agent(server());
      const csrf = await anon.get(url('/auth/system/csrf')).expect(200);
      const token = (csrf.body as { csrfToken: string }).csrfToken;
      await anon.get(url('/venues')).expect(401);
      await anon
        .post(url('/venues'))
        .set('x-csrf-token', token)
        .send({ name: `${ROW_PREFIX}x`, venueTypeId: typeId, capacity: 1 })
        .expect(401);
    });

    /**
     * ⚠️ THE OPPOSITE SPLIT FROM `/venue-types`, AND BOTH ARE DELIBERATE. `การตั้งค่าระบบ` is an
     * action surface with no read-only value, so a VIEWER is denied outright there. A venue list is
     * exactly the sort of thing a supervisor is expected to look at, and `use-acl.ts` agrees — it
     * does not list `สถานที่จัดกิจกรรม` in `VIEWER_DENY`.
     *
     * Both halves in ONE test on purpose, so nobody can read the read-grant as a write-grant.
     */
    it('VIEWER reads but cannot write — and the backend is what says so', async () => {
      const { agent, token } = await login(VIEWER);
      await agent.get(url('/venues')).expect(200);
      await agent
        .post(url('/venues'))
        .set('x-csrf-token', token)
        .send({ name: `${ROW_PREFIX}v`, venueTypeId: typeId, capacity: 1 })
        .expect(403);

      const admin = await login(ADMIN);
      const venue = await create(admin, {});
      await agent
        .patch(url(`/venues/${venue.id}`))
        .set('x-csrf-token', token)
        .send({ capacity: 99 })
        .expect(403);
      await agent
        .post(url(`/venues/${venue.id}/close`))
        .set('x-csrf-token', token)
        .send({ reason: 'nope' })
        .expect(403);
      await agent
        .delete(url(`/venues/${venue.id}`))
        .set('x-csrf-token', token)
        .expect(403);
    });
  });

  // ── The write contract ────────────────────────────────────────────────────
  describe('create / update', () => {
    it('creates OPEN with no reason, and echoes the nested category', async () => {
      const s = await login(ADMIN);
      const v = await create(s, { location: ' ห้อง 1 ', description: '' });
      expect(v.isOpen).toBe(true);
      expect(v.closedReason).toBeNull();
      expect(v.venueType).toEqual({
        id: typeId,
        name: `${ROW_PREFIX}hall`,
        isFallback: false,
      });
      // Trimmed, and `''` became null rather than an empty string.
      expect(v.location).toBe('ห้อง 1');
      expect(v.description).toBeNull();
    });

    it('a duplicate ACTIVE name is 409, and the name is REUSABLE after a soft delete', async () => {
      const s = await login(ADMIN);
      const first = await create(s, { name: `${ROW_PREFIX}dup` });
      await s.agent
        .post(url('/venues'))
        .set('x-csrf-token', s.token)
        .send({ name: `${ROW_PREFIX}dup`, venueTypeId: typeId, capacity: 5 })
        .expect(409);

      await s.agent
        .delete(url(`/venues/${first.id}`))
        .set('x-csrf-token', s.token)
        .expect(204);
      await s.agent
        .post(url('/venues'))
        .set('x-csrf-token', s.token)
        .send({ name: `${ROW_PREFIX}dup`, venueTypeId: typeId, capacity: 5 })
        .expect(201);
    });

    /** AC-S1 — the FK accepts a soft-deleted row; the SERVICE is what must refuse it. */
    it('AC-S1 · a soft-deleted venueTypeId is 400, not 500', async () => {
      const s = await login(ADMIN);
      await prisma.venueType.update({
        where: { id: otherTypeId },
        data: { deletedAt: new Date() },
      });
      await s.agent
        .post(url('/venues'))
        .set('x-csrf-token', s.token)
        .send({
          name: `${ROW_PREFIX}dead-type`,
          venueTypeId: otherTypeId,
          capacity: 5,
        })
        .expect(400);
    });

    /**
     * AC-S2 — the reserved tombstone is refused with the SAME 400 an unknown id gets, never a 403.
     * The bodies are compared byte for byte: *reserved must be indistinguishable from never-existed*.
     */
    it('AC-S2 · the tombstone category is refused, and identically to an unknown id', async () => {
      const s = await login(SUPER);
      const reserved = await s.agent
        .post(url('/venues'))
        .set('x-csrf-token', s.token)
        .send({
          name: `${ROW_PREFIX}tomb`,
          venueTypeId: tombstoneId,
          capacity: 5,
        })
        .expect(400);
      const unknown = await s.agent
        .post(url('/venues'))
        .set('x-csrf-token', s.token)
        .send({
          name: `${ROW_PREFIX}tomb`,
          venueTypeId: 2_000_000,
          capacity: 5,
        })
        .expect(400);
      expect(reserved.body).toEqual(unknown.body);
    });

    /** AC-S3 — the deliberate opposite of AC-S2: the filter accepts what the form refuses. */
    it('AC-S3 · GET ?venueTypeId=<tombstone> is 200 and lists what fell in there', async () => {
      const s = await login(SUPER);
      const v = await create(s, { name: `${ROW_PREFIX}orphan` });
      // Deleting the category re-points its venues onto the tombstone.
      await s.agent
        .delete(url(`/venue-types/${typeId}`))
        .set('x-csrf-token', s.token)
        .expect(204);

      const res = await s.agent
        .get(url(`/venues?venueTypeId=${tombstoneId}`))
        .expect(200);
      const rows = res.body as VenueBody[];
      const moved = rows.find((r) => r.id === v.id);
      expect(moved).toBeDefined();
      // The card renders the tombstone differently, and keys off the FLAG rather than the name.
      expect(moved!.venueType.isFallback).toBe(true);
    });

    /** AC-S6 — `isOpen` is absent from the DTO, so `forbidNonWhitelisted` answers before the service. */
    it('AC-S6 · PATCH with isOpen is 400 and changes nothing', async () => {
      const s = await login(ADMIN);
      const v = await create(s, {});
      await s.agent
        .patch(url(`/venues/${v.id}`))
        .set('x-csrf-token', s.token)
        .send({ isOpen: false })
        .expect(400);
      const after = await prisma.venue.findUnique({ where: { id: v.id } });
      expect(after?.isOpen).toBe(true);
    });

    it('an amenity id that is not ACTIVE is 400, and nothing is written', async () => {
      const s = await login(ADMIN);
      await prisma.amenity.update({
        where: { id: amenityB },
        data: { deletedAt: new Date() },
      });
      await s.agent
        .post(url('/venues'))
        .set('x-csrf-token', s.token)
        .send({
          name: `${ROW_PREFIX}bad-amen`,
          venueTypeId: typeId,
          capacity: 5,
          amenityIds: [amenityA, amenityB],
        })
        .expect(400);
      expect(
        await prisma.venue.count({ where: { name: `${ROW_PREFIX}bad-amen` } }),
      ).toBe(0);
    });

    it('amenityIds REPLACE rather than merge, and [] clears them', async () => {
      const s = await login(ADMIN);
      const v = await create(s, { amenityIds: [amenityA, amenityB] });
      expect(v.amenities.map((a) => a.id).sort()).toEqual(
        [amenityA, amenityB].sort(),
      );

      const patched = await s.agent
        .patch(url(`/venues/${v.id}`))
        .set('x-csrf-token', s.token)
        .send({ amenityIds: [amenityA] })
        .expect(200);
      expect((patched.body as VenueBody).amenities.map((a) => a.id)).toEqual([
        amenityA,
      ]);

      const cleared = await s.agent
        .patch(url(`/venues/${v.id}`))
        .set('x-csrf-token', s.token)
        .send({ amenityIds: [] })
        .expect(200);
      expect((cleared.body as VenueBody).amenities).toEqual([]);
    });

    it('an OMITTED amenityIds means unchanged, not cleared', async () => {
      const s = await login(ADMIN);
      const v = await create(s, { amenityIds: [amenityA] });
      const patched = await s.agent
        .patch(url(`/venues/${v.id}`))
        .set('x-csrf-token', s.token)
        .send({ capacity: 42 })
        .expect(200);
      expect((patched.body as VenueBody).amenities.map((a) => a.id)).toEqual([
        amenityA,
      ]);
    });
  });

  // ── Photos ────────────────────────────────────────────────────────────────
  describe('photos', () => {
    /** AC-S7 — order in = order out, and `position` is a contiguous 0..n-1 in the table. */
    it('AC-S7 · the photo order round-trips and positions are contiguous from 0', async () => {
      const s = await login(ADMIN);
      const urls = [photoUrl(1), photoUrl(2), photoUrl(3)];
      const v = await create(s, { photoUrls: urls });
      // ⚠️ THE URLS COME BACK RE-HOMED, not as they were sent: the response names
      // `venues/<venueId>/…`, never the staging folder they were uploaded into. The ORDER is what
      // this test is about, and it survives the move.
      expect(v.photos.map((p) => p.url)).toEqual([
        homedUrl(v.id, 1),
        homedUrl(v.id, 2),
        homedUrl(v.id, 3),
      ]);
      expect(v.photos.map((p) => p.position)).toEqual([0, 1, 2]);

      // A new cover is a reordered set, not a flag — `photoUrls[0]` IS the cover. These are already
      // the venue's own urls, so nothing is copied a second time.
      const reordered = [
        homedUrl(v.id, 3),
        homedUrl(v.id, 1),
        homedUrl(v.id, 2),
      ];
      copyObject.mockClear();
      const patched = await s.agent
        .patch(url(`/venues/${v.id}`))
        .set('x-csrf-token', s.token)
        .send({ photoUrls: reordered })
        .expect(200);
      expect((patched.body as VenueBody).photos.map((p) => p.url)).toEqual(
        reordered,
      );
      // ⚠️ RE-HOMING AN ALREADY-HOMED PHOTO WOULD BE POINTLESS WORK AND A SECOND CHANCE TO FAIL.
      expect(copyObject).not.toHaveBeenCalled();

      const rows = await prisma.venuePhoto.findMany({
        where: { venueId: v.id },
        orderBy: { position: 'asc' },
        select: { position: true },
      });
      expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
    });

    /** AC-S8 — the ceiling is in the CONTRACT, not only in the file picker. */
    it('AC-S8 · an 11-photo set is 400 and the table does not change', async () => {
      const s = await login(ADMIN);
      const v = await create(s, { photoUrls: [photoUrl(1)] });
      const eleven = Array.from({ length: 11 }, (_, i) => photoUrl(i + 10));
      await s.agent
        .patch(url(`/venues/${v.id}`))
        .set('x-csrf-token', s.token)
        .send({ photoUrls: eleven })
        .expect(400);
      expect(await prisma.venuePhoto.count({ where: { venueId: v.id } })).toBe(
        1,
      );
    });

    it('a photo URL outside this deployment’s bucket is 400', async () => {
      const s = await login(ADMIN);
      await s.agent
        .post(url('/venues'))
        .set('x-csrf-token', s.token)
        .send({
          name: `${ROW_PREFIX}foreign`,
          venueTypeId: typeId,
          capacity: 5,
          photoUrls: ['https://example.invalid/venues/whatever.png'],
        })
        .expect(400);
    });

    it('replacing the set deletes the objects it dropped, and keeps the ones it did not', async () => {
      const s = await login(ADMIN);
      const v = await create(s, { photoUrls: [photoUrl(1), photoUrl(2)] });
      // ⚠️ CLEARED AFTER THE CREATE, because the re-home deletes the two staging originals — counting
      // from before it would measure the move rather than the drop.
      deleteObject.mockClear();
      await s.agent
        .patch(url(`/venues/${v.id}`))
        .set('x-csrf-token', s.token)
        .send({ photoUrls: [homedUrl(v.id, 2)] })
        .expect(200);
      expect(deleteObject).toHaveBeenCalledTimes(1);
      expect(deleteObject).toHaveBeenCalledWith(
        `venues/${v.id}/${String(1).padStart(32, '0')}.png`,
      );
    });

    /**
     * The re-home itself (PO, 25 ส.ค. 2569). Asserted on the OBJECT STORE and on the ROW, because
     * the response body alone would be satisfied by a service that renamed the url and moved nothing.
     */
    it('a newly uploaded photo is moved into the venue’s own folder', async () => {
      const s = await login(ADMIN);
      copyObject.mockClear();
      deleteObject.mockClear();
      const v = await create(s, { photoUrls: [photoUrl(1)] });

      const staged = `${STAGING}${String(1).padStart(32, '0')}.png`;
      const home = `venues/${v.id}/${String(1).padStart(32, '0')}.png`;
      expect(copyObject).toHaveBeenCalledWith(staged, home);
      // Copy FIRST, delete after — never the other way round, or a failed copy destroys the only
      // copy of the photo.
      expect(deleteObject).toHaveBeenCalledWith(staged);
      expect(v.photos[0].url).toBe(homedUrl(v.id, 1));

      const row = await prisma.venuePhoto.findFirst({
        where: { venueId: v.id },
        select: { url: true },
      });
      expect(row?.url).toBe(homedUrl(v.id, 1));
      // The filename is preserved across the move — it is the part carrying the entropy.
      expect(home.endsWith(staged.slice(STAGING.length))).toBe(true);
    });

    /**
     * ⚠️ A FAILED COPY MUST NOT FAIL THE SAVE, and must not strand the row either. The venue is
     * already committed by the time the move runs, so the honest outcome is a photo that stays in
     * the staging folder — untidy, and still renders. Anything else turns a storage hiccup into a
     * lost write or a broken image.
     */
    it('a copy failure leaves the venue saved and the photo still reachable', async () => {
      const s = await login(ADMIN);
      copyObject.mockResolvedValue(false);
      deleteObject.mockClear();
      const v = await create(s, {
        name: `${ROW_PREFIX}copyfail`,
        photoUrls: [photoUrl(1)],
      });

      expect(v.photos[0].url).toBe(photoUrl(1));
      // ⚠️ THE ORIGINAL IS NOT DELETED when the copy did not land — that is the whole reason the
      // delete is sequenced after it.
      expect(deleteObject).not.toHaveBeenCalled();
      const row = await prisma.venuePhoto.findFirst({
        where: { venueId: v.id },
        select: { url: true },
      });
      expect(row?.url).toBe(photoUrl(1));
    });

    it('uploads, and the key + ContentType come from the SNIFFED bytes', async () => {
      const s = await login(ADMIN);
      const res = await s.agent
        .post(url('/venues/photos'))
        .set('x-csrf-token', s.token)
        .attach('file', pngBytes(), {
          filename: '../../evil.php',
          contentType: 'image/png',
        })
        .expect(200);
      // Lands in STAGING — a venue does not exist yet on the create path, which is the whole reason
      // the staging folder is there.
      expect((res.body as { url: string }).url).toMatch(
        new RegExp(`^${R2_BASE}/${STAGING}[0-9a-f]+\\.png$`),
      );
      // `originalname` is attacker-controlled and must never reach the key.
      expect(JSON.stringify(putImage.mock.calls)).not.toContain('evil');
    });

    /** AC-S10 — the declared type is a first filter; the BYTES are the control. */
    it('AC-S10 · png headers with non-image bytes are 400 and nothing is stored', async () => {
      const s = await login(ADMIN);
      await s.agent
        .post(url('/venues/photos'))
        .set('x-csrf-token', s.token)
        .attach('file', Buffer.from('not an image at all'), {
          filename: 'x.png',
          contentType: 'image/png',
        })
        .expect(400);
      expect(putImage).not.toHaveBeenCalled();
    });

    /**
     * AC-S9 — 400, not the 413 the stack produces by default.
     *
     * ⚠️ `MAX + 1` IS THE TRIPWIRE, and `MAX` EXACTLY MUST STILL PASS. busboy's limit is exclusive,
     * so the interceptor is handed `MAX + 1`; getting that wrong makes the real ceiling `MAX - 1`
     * and nothing fails loudly. Both halves are asserted here for that reason.
     */
    it('AC-S9 · exactly 5 MB is accepted and 5 MB + 1 is 400 (not 413)', async () => {
      const s = await login(ADMIN);
      await s.agent
        .post(url('/venues/photos'))
        .set('x-csrf-token', s.token)
        .attach('file', pngBytes(VENUE_PHOTO_MAX_BYTES), {
          filename: 'ok.png',
          contentType: 'image/png',
        })
        .expect(200);

      await s.agent
        .post(url('/venues/photos'))
        .set('x-csrf-token', s.token)
        .attach('file', pngBytes(VENUE_PHOTO_MAX_BYTES + 1), {
          filename: 'big.png',
          contentType: 'image/png',
        })
        .expect(400);
    });

    /**
     * The discard endpoint — the cancel path of option ข, and its one safety property.
     */
    it('discards an UNBOUND object, and refuses one a venue still references', async () => {
      const s = await login(ADMIN);
      await s.agent
        .delete(url('/venues/photos'))
        .set('x-csrf-token', s.token)
        .send({ url: photoUrl(7) })
        .expect(204);
      // An UNBOUND photo is still in staging by definition — nothing has claimed it, so nothing has
      // moved it.
      expect(deleteObject).toHaveBeenCalledWith(
        `${STAGING}${String(7).padStart(32, '0')}.png`,
      );

      const v = await create(s, { photoUrls: [photoUrl(8)] });
      deleteObject.mockClear();
      // ⚠️ THE VENUE'S URL, NOT THE STAGING ONE IT WAS UPLOADED AS. After the re-home the row names
      // `venues/<id>/…`, so that is the url the guard has to recognise as referenced. Sending the
      // stale staging url would be a 204 — and correctly so: nothing points at it any more.
      await s.agent
        .delete(url('/venues/photos'))
        .set('x-csrf-token', s.token)
        .send({ url: homedUrl(v.id, 8) })
        .expect(409);
      // The guard is what keeps a live row from ever pointing at a dead object.
      expect(deleteObject).not.toHaveBeenCalled();
      expect(await prisma.venuePhoto.count({ where: { venueId: v.id } })).toBe(
        1,
      );
    });

    it('discarding a URL outside the bucket is 400 and never reaches storage', async () => {
      const s = await login(ADMIN);
      await s.agent
        .delete(url('/venues/photos'))
        .set('x-csrf-token', s.token)
        .send({ url: 'https://example.invalid/venues/x.png' })
        .expect(400);
      expect(deleteObject).not.toHaveBeenCalled();
    });
  });

  // ── close / reopen ────────────────────────────────────────────────────────
  describe('close / reopen', () => {
    /** AC-S4 — a blank reason must not close the venue. */
    it('AC-S4 · closing with a blank reason is 400 and the row does not move', async () => {
      const s = await login(ADMIN);
      const v = await create(s, {});
      await s.agent
        .post(url(`/venues/${v.id}/close`))
        .set('x-csrf-token', s.token)
        .send({ reason: '   ' })
        .expect(400);
      const after = await prisma.venue.findUnique({ where: { id: v.id } });
      expect(after?.isOpen).toBe(true);
      expect(after?.closedReason).toBeNull();
    });

    /** AC-S5 — reopen clears the reason to NULL, never to an empty string. */
    it('AC-S5 · close then reopen leaves closedReason NULL, not ""', async () => {
      const s = await login(ADMIN);
      const v = await create(s, {});
      const closed = await s.agent
        .post(url(`/venues/${v.id}/close`))
        .set('x-csrf-token', s.token)
        .send({ reason: 'ปิดปรับปรุงพื้น' })
        .expect(200);
      expect((closed.body as VenueBody).isOpen).toBe(false);
      expect((closed.body as VenueBody).closedReason).toBe('ปิดปรับปรุงพื้น');

      const reopened = await s.agent
        .post(url(`/venues/${v.id}/reopen`))
        .set('x-csrf-token', s.token)
        .expect(200);
      expect((reopened.body as VenueBody).isOpen).toBe(true);
      expect((reopened.body as VenueBody).closedReason).toBeNull();
      const row = await prisma.venue.findUnique({ where: { id: v.id } });
      expect(row?.closedReason).toBeNull();
    });

    it('closing an already-closed venue is 409 and does not overwrite the reason', async () => {
      const s = await login(ADMIN);
      const v = await create(s, {});
      await s.agent
        .post(url(`/venues/${v.id}/close`))
        .set('x-csrf-token', s.token)
        .send({ reason: 'first' })
        .expect(200);
      await s.agent
        .post(url(`/venues/${v.id}/close`))
        .set('x-csrf-token', s.token)
        .send({ reason: 'second' })
        .expect(409);
      const row = await prisma.venue.findUnique({ where: { id: v.id } });
      expect(row?.closedReason).toBe('first');
    });

    it('the status filter follows the transition', async () => {
      const s = await login(ADMIN);
      const open = await create(s, { name: `${ROW_PREFIX}open` });
      const shut = await create(s, { name: `${ROW_PREFIX}shut` });
      await s.agent
        .post(url(`/venues/${shut.id}/close`))
        .set('x-csrf-token', s.token)
        .send({ reason: 'ปิด' })
        .expect(200);

      const closedList = await s.agent
        .get(url('/venues?status=closed'))
        .expect(200);
      const ids = (closedList.body as VenueBody[]).map((v) => v.id);
      expect(ids).toContain(shut.id);
      expect(ids).not.toContain(open.id);
    });
  });

  // ── delete ────────────────────────────────────────────────────────────────
  describe('delete', () => {
    it('is a SOFT delete, invisible to the list, and a second one is 404', async () => {
      const s = await login(ADMIN);
      const v = await create(s, {});
      await s.agent
        .delete(url(`/venues/${v.id}`))
        .set('x-csrf-token', s.token)
        .expect(204);

      const list = await s.agent.get(url('/venues')).expect(200);
      expect((list.body as VenueBody[]).map((r) => r.id)).not.toContain(v.id);
      // The ROW survives — a future `Booking.venueId` must keep resolving a name.
      const row = await prisma.venue.findUnique({ where: { id: v.id } });
      expect(row).not.toBeNull();
      expect(row?.deletedAt).not.toBeNull();

      await s.agent
        .delete(url(`/venues/${v.id}`))
        .set('x-csrf-token', s.token)
        .expect(404);
    });

    it('an unknown id is the same 404 as an already-deleted one', async () => {
      const s = await login(ADMIN);
      const v = await create(s, {});
      await s.agent
        .delete(url(`/venues/${v.id}`))
        .set('x-csrf-token', s.token)
        .expect(204);
      const gone = await s.agent
        .delete(url(`/venues/${v.id}`))
        .set('x-csrf-token', s.token)
        .expect(404);
      const never = await s.agent
        .delete(url('/venues/clx000000000000000000000'))
        .set('x-csrf-token', s.token)
        .expect(404);
      expect(gone.body).toEqual(never.body);
    });
  });

  // ── The counts on the two curated screens ─────────────────────────────────
  describe('holderCount on the option screens', () => {
    /**
     * 🔴 THE CACHE TRAP, MEASURED. `holderCount` is counted over `venues`, not over the category
     * table, so a venue write that touches no category at all still has to drop the category keys.
     * The list is read FIRST here on purpose — that is what fills the cache and makes the assertion
     * meaningful rather than a fresh query every time.
     */
    it('creating a venue moves the ประเภทสถานที่ count immediately, not in 300 seconds', async () => {
      const s = await login(ADMIN);
      const before = await s.agent.get(url('/venue-types')).expect(200);
      expect(
        (before.body as { id: number; holderCount: number }[]).find(
          (r) => r.id === typeId,
        )?.holderCount,
      ).toBe(0);

      await create(s, {});

      const after = await s.agent.get(url('/venue-types')).expect(200);
      expect(
        (after.body as { id: number; holderCount: number }[]).find(
          (r) => r.id === typeId,
        )?.holderCount,
      ).toBe(1);
    });

    it('a soft-deleted venue stops counting', async () => {
      const s = await login(ADMIN);
      const v = await create(s, {});
      await s.agent
        .delete(url(`/venues/${v.id}`))
        .set('x-csrf-token', s.token)
        .expect(204);
      const after = await s.agent.get(url('/venue-types')).expect(200);
      expect(
        (after.body as { id: number; holderCount: number }[]).find(
          (r) => r.id === typeId,
        )?.holderCount,
      ).toBe(0);
    });

    /** AC-A1 — the ticks go, the venues stay, and the count reported is the count that happened. */
    it('AC-A1 · deleting an amenity releases its ticks and reports how many venues lost one', async () => {
      const s = await login(ADMIN);
      const v1 = await create(s, {
        name: `${ROW_PREFIX}a1`,
        amenityIds: [amenityA],
      });
      const v2 = await create(s, {
        name: `${ROW_PREFIX}a2`,
        amenityIds: [amenityA, amenityB],
      });

      const listed = await s.agent.get(url('/amenities')).expect(200);
      expect(
        (listed.body as { id: number; holderCount: number }[]).find(
          (r) => r.id === amenityA,
        )?.holderCount,
      ).toBe(2);

      const res = await s.agent
        .delete(url(`/amenities/${amenityA}`))
        .set('x-csrf-token', s.token)
        .expect(200);
      expect(res.body).toEqual({ releasedVenueCount: 2 });

      // The VENUES are untouched — only the ticks went.
      expect(
        await prisma.venue.count({ where: { id: { in: [v1.id, v2.id] } } }),
      ).toBe(2);
      expect(
        await prisma.venueAmenity.count({ where: { amenityId: amenityA } }),
      ).toBe(0);
      const after = await s.agent.get(url(`/venues`)).expect(200);
      const rowV2 = (after.body as VenueBody[]).find((r) => r.id === v2.id);
      expect(rowV2!.amenities.map((a) => a.id)).toEqual([amenityB]);
    });

    /** AC-A2 — no tombstone is resolved on this path, so an unseeded database cannot 500 it. */
    it('AC-A2 · deleting an amenity works with no reserved rows anywhere', async () => {
      const s = await login(ADMIN);
      await prisma.$executeRawUnsafe(
        `UPDATE venue_types SET "deletedAt" = now() WHERE "isSystemReserved" = true`,
      );
      try {
        await s.agent
          .delete(url(`/amenities/${amenityB}`))
          .set('x-csrf-token', s.token)
          .expect(200);
      } finally {
        await ensureVenueTypeTombstone();
      }
    });

    /** AC-A3 — the only curated table that may legitimately be empty. */
    it('AC-A3 · a venue can still be created with zero amenities in the system', async () => {
      const s = await login(ADMIN);
      await prisma.$executeRawUnsafe(
        `UPDATE amenities SET "deletedAt" = now()`,
      );
      const res = await s.agent
        .post(url('/venues'))
        .set('x-csrf-token', s.token)
        .send({
          name: `${ROW_PREFIX}no-amen`,
          venueTypeId: typeId,
          capacity: 5,
        })
        .expect(201);
      expect((res.body as VenueBody).amenities).toEqual([]);
    });

    /**
     * Deleting a CATEGORY re-points its venues onto the tombstone — the half of
     * `VenueTypesService.softDelete` that was a comment until VENUE-1.
     */
    it('deleting a category moves its venues to the tombstone rather than stranding them', async () => {
      const s = await login(SUPER);
      const v = await create(s, { name: `${ROW_PREFIX}moved` });
      await s.agent
        .delete(url(`/venue-types/${typeId}`))
        .set('x-csrf-token', s.token)
        .expect(204);

      const row = await prisma.venue.findUnique({ where: { id: v.id } });
      expect(row?.venueTypeId).toBe(tombstoneId);
      // And the venue is still readable — the nested category resolves without a `deletedAt` filter.
      const list = await s.agent.get(url('/venues')).expect(200);
      const found = (list.body as VenueBody[]).find((r) => r.id === v.id);
      expect(found?.venueType.isFallback).toBe(true);
    });
  });

  // ── AC-X ──────────────────────────────────────────────────────────────────
  /**
   * `SystemRole` may appear in `src/venues` ONLY inside `@Roles()`. The same rule `src/options`
   * carries, for the same reason: a role read anywhere else is an authorization decision made outside
   * the one file allowed to make them.
   *
   * ⚠️ THE ALLOWLIST IS DELIBERATELY NARROW. An earlier version of this scanner allowed any line
   * CONTAINING `SystemRole.`, which would have passed `user.role === SystemRole.ADMIN` — the exact
   * expression it exists to catch. Comment lines are skipped so the note explaining the rule does not
   * fail it.
   */
  it('AC-X · src/venues mentions SystemRole only in @Roles()', () => {
    const dir = join(__dirname, '..', 'src', 'venues');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(dir);

    const offenders: string[] = [];
    for (const path of files) {
      for (const raw of readFileSync(path, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line.includes('SystemRole')) continue;
        if (
          line.startsWith('*') ||
          line.startsWith('//') ||
          line.startsWith('/*')
        )
          continue;
        if (line === "import { SystemRole } from '@prisma/client';") continue;
        if (line.startsWith('@Roles(')) continue;
        offenders.push(`${path}: ${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
