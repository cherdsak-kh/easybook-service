// The LINE Login channel id the guard verifies id_token `aud` against. MUST be set before the app
// boots (ConfigModule reads process.env at forRoot). Digits only, per env.validation.
process.env.LINE_LOGIN_CHANNEL_ID =
  process.env.LINE_LOGIN_CHANNEL_ID ?? '1234567890';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { API_BASE_PATH } from '../src/common/api.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, prismaOf } from './e2e-app';

jest.setTimeout(120_000);

const CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;
const LU_PREFIX = 'e2eset-';
const url = (path: string) => `${API_BASE_PATH}${path}`;

interface SettingsBody {
  theme: string;
  notifications: {
    announcements: boolean;
    decisions: boolean;
    reminders: boolean;
  };
  updatedAt: string | null;
}

interface VersionBody {
  version: string;
  status: string;
}

/** The verify-endpoint mock's current answer. Mirrors `line-registration.e2e-spec.ts`. */
let currentSub = '';
const futureExp = () => Math.floor(Date.now() / 1000) + 3600;

/**
 * `GET`/`PATCH /line-users/settings` and `GET /line-users/version` (Phase 7a, `Q-C9` +
 * `NEEDS_DESIGN.md` §3), against the real HTTP pipeline `configureApp` assembles.
 *
 * 🔴 THREE OF THE PROPERTIES BELOW ARE UNREACHABLE FROM A UNIT SPEC, and each fails silently:
 *
 * 1. **Route order.** `PATCH /line-users/settings` and the admin `PATCH /line-users/:id` are both
 *    2-segment PATCHes, and `settings` is a perfectly good `:id`. Registered in the wrong order,
 *    every settings save is answered by the admin access-change handler behind `SessionGuard`.
 * 2. **The CSRF exemption.** The middleware runs BEFORE the router, so a missing entry in
 *    `CSRF_EXEMPT_PATHS` is a `403` that `LineIdTokenGuard` never even sees.
 * 3. **Defaults-on-read costing zero rows.** A lazy create returns byte-identical JSON; only a row
 *    count can tell the two apart.
 */
describe('LINE settings + consumer version (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const server = () => app.getHttpServer();

  const purgeLineUsers = () =>
    // `line_user_settings` is ON DELETE CASCADE, so this removes both tables' fixtures.
    prisma.$executeRawUnsafe(
      `DELETE FROM line_users WHERE "lineUserId" LIKE '${LU_PREFIX}%'`,
    );

  const settingsRowCount = () =>
    prisma.lineUserSettings.count({
      where: { lineUser: { lineUserId: { startsWith: LU_PREFIX } } },
    });

  const lineUserCount = () =>
    prisma.lineUser.count({
      where: { lineUserId: { startsWith: LU_PREFIX } },
    });

  beforeAll(async () => {
    jest.spyOn(global, 'fetch').mockImplementation((_input, init) => {
      const body = init?.body as URLSearchParams | undefined;
      const token = body?.get('id_token');
      if (token === 'invalid') {
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

    app = await createE2eApp();
    prisma = prismaOf(app);
    await purgeLineUsers();
  }, 60_000);

  beforeEach(async () => {
    await purgeLineUsers();
  });

  afterAll(async () => {
    await purgeLineUsers();
    jest.restoreAllMocks();
    await app.close();
  });

  const bearer = (token = 'good-token') => `Bearer ${token}`;

  const getSettings = (sub: string) => {
    currentSub = sub;
    return request(server())
      .get(url('/line-users/settings'))
      .set('Authorization', bearer());
  };

  const patchSettings = (sub: string, body: object) => {
    currentSub = sub;
    return request(server())
      .patch(url('/line-users/settings'))
      .set('Authorization', bearer())
      .send(body);
  };

  // ─────────────────────────── auth (guard) ───────────────────────────

  it('GET /settings with no Authorization header is 401', async () => {
    await request(server()).get(url('/line-users/settings')).expect(401);
  });

  it('PATCH /settings with no Authorization header is 401 and writes nothing', async () => {
    await request(server())
      .patch(url('/line-users/settings'))
      .send({ theme: 'dark' })
      .expect(401);
    expect(await settingsRowCount()).toBe(0);
  });

  it('GET /version with an invalid token is 401 (LINE rejected)', async () => {
    currentSub = `${LU_PREFIX}U-invalid`;
    await request(server())
      .get(url('/line-users/version'))
      .set('Authorization', bearer('invalid'))
      .expect(401);
  });

  // ─────────────────────────── defaults-on-read ───────────────────────────

  it('Q-C9 — a user who has never saved gets the defaults, and the read creates NO rows', async () => {
    const sub = `${LU_PREFIX}U-fresh`;
    const res = await getSettings(sub).expect(200);

    expect(res.body as SettingsBody).toEqual({
      theme: 'system',
      notifications: { announcements: true, decisions: true, reminders: true },
      updatedAt: null,
    });
    // The whole point of defaults-on-read: not one row, in either table. A lazy upsert would
    // return this same JSON and still be wrong.
    expect(await settingsRowCount()).toBe(0);
    expect(await lineUserCount()).toBe(0);
  });

  it('answers the defaults repeatedly without ever accumulating a row', async () => {
    const sub = `${LU_PREFIX}U-repeat`;
    await getSettings(sub).expect(200);
    await getSettings(sub).expect(200);
    await getSettings(sub).expect(200);
    expect(await settingsRowCount()).toBe(0);
  });

  // ─────────────────────────── the merge ───────────────────────────

  it('PATCH creates the row on first save — and reaching the handler at all proves the route order and the CSRF exemption', async () => {
    // 🔴 A 200 here is the load-bearing assertion. `PATCH /line-users/:id` (admin, SessionGuard)
    // would answer 401/403, and a missing CSRF exemption would answer 403 before any guard ran.
    const sub = `${LU_PREFIX}U-first`;
    const res = await patchSettings(sub, { theme: 'dark' }).expect(200);

    const body = res.body as SettingsBody;
    expect(body.theme).toBe('dark');
    expect(body.notifications).toEqual({
      announcements: true,
      decisions: true,
      reminders: true,
    });
    expect(body.updatedAt).toEqual(expect.any(String));
    expect(await settingsRowCount()).toBe(1);
  });

  it('Q-C9 — patching ONE toggle leaves the other two untouched, across two separate requests', async () => {
    const sub = `${LU_PREFIX}U-merge`;
    await patchSettings(sub, { notifications: { decisions: false } }).expect(
      200,
    );
    const second = await patchSettings(sub, {
      notifications: { reminders: false },
    }).expect(200);

    // If the write replaced the column instead of merging it, `decisions` would be back to `true`.
    expect((second.body as SettingsBody).notifications).toEqual({
      announcements: true,
      decisions: false,
      reminders: false,
    });

    const read = await getSettings(sub).expect(200);
    expect((read.body as SettingsBody).notifications).toEqual({
      announcements: true,
      decisions: false,
      reminders: false,
    });
    expect(await settingsRowCount()).toBe(1);
  });

  it('leaves the two RESERVED columns null — nothing writes a key no document describes', async () => {
    const sub = `${LU_PREFIX}U-reserved`;
    await patchSettings(sub, {
      theme: 'light',
      notifications: { announcements: false },
    }).expect(200);

    const row = await prisma.lineUserSettings.findFirst({
      where: { lineUser: { lineUserId: sub } },
      select: { preferences: true, privacy: true },
    });
    expect(row?.preferences).toBeNull();
    expect(row?.privacy).toBeNull();
  });

  // ─────────────────────────── validation (400s) ───────────────────────────

  it.each([
    ['an unknown top-level key', { darkMode: true }],
    ['a client-supplied lineUserId', { lineUserId: 'U-evil' }],
    ['a reserved column', { preferences: { anything: 1 } }],
    ['an unsupported theme', { theme: 'solarized' }],
    ['an unknown nested key', { notifications: { sms: true } }],
    ['a non-boolean toggle', { notifications: { decisions: 'yes' } }],
    ['an explicitly null toggle', { notifications: { decisions: null } }],
  ])('PATCH rejects %s with 400 and writes nothing', async (_label, body) => {
    const sub = `${LU_PREFIX}U-bad`;
    await patchSettings(sub, body).expect(400);
    expect(await settingsRowCount()).toBe(0);
  });

  // ─────────────────────────── cross-user isolation ───────────────────────────

  it('LINK-LINE-1 — user A’s save is invisible to user B, who still sees the defaults', async () => {
    const a = `${LU_PREFIX}U-alice`;
    const b = `${LU_PREFIX}U-bob`;
    await patchSettings(a, {
      theme: 'dark',
      notifications: { decisions: false },
    }).expect(200);

    const bobReads = await getSettings(b).expect(200);
    expect(bobReads.body as SettingsBody).toEqual({
      theme: 'system',
      notifications: { announcements: true, decisions: true, reminders: true },
      updatedAt: null,
    });

    // And Bob's write cannot reach Alice's row: there is no id anywhere in the contract to aim one
    // with, and the body key that would carry one is a 400.
    await patchSettings(b, { theme: 'light' }).expect(200);
    const aliceReads = await getSettings(a).expect(200);
    expect((aliceReads.body as SettingsBody).theme).toBe('dark');
    expect((aliceReads.body as SettingsBody).notifications.decisions).toBe(
      false,
    );
  });

  // ─────────────────────────── version ───────────────────────────

  it('NEEDS_DESIGN §3 — GET /version answers a semver-shaped version and status ok', async () => {
    currentSub = `${LU_PREFIX}U-version`;
    const res = await request(server())
      .get(url('/line-users/version'))
      .set('Authorization', bearer())
      .expect(200);

    const body = res.body as VersionBody;
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.status).toBe('ok');
    // Per-deploy, never per-user: reading it must not materialise the caller.
    expect(await lineUserCount()).toBe(0);
  });
});
