import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { RedisService } from '../redis/redis.service';
import { DEFAULT_LINE_USER_THEME } from './dto/line-user-settings.dto';
import { LineService } from './line.service';
import {
  LINE_CLIENT_VERSION_STATUS,
  LineUserService,
  defaultNotificationPreferences,
} from './line-user.service';

/**
 * The settings half of `LineUserService` (`Q-C9` / Phase 7a), kept in its own spec rather than
 * appended to the 1,000-line `line-user.service.spec.ts`: none of it shares a fixture with the
 * registration/access flows, and that file's Prisma mock does not know about `lineUserSettings`.
 *
 * 🔴 THE TWO PROPERTIES THIS FILE EXISTS TO PIN, because both fail SILENTLY:
 *   1. A read of a user with no row must not WRITE one. The wrong version still answers correctly;
 *      it just quietly grows a row per follower, and nobody notices until the table is the size of
 *      the follower list.
 *   2. A patch of one toggle must not reset the other two. The wrong version also answers `200`,
 *      and the user only finds out when a notification they never turned off stops arriving.
 */
describe('LineUserService — settings (Q-C9)', () => {
  let service: LineUserService;

  const lineUser = {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
  };
  const lineUserSettings = {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    upsert: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const $transaction = jest.fn();

  const line = { push: jest.fn(), getProfile: jest.fn() };
  const realtime = {
    emitLineUserCreated: jest.fn(),
    emitLineUserUpdated: jest.fn(),
    emitLineUserDeleted: jest.fn(),
  };
  const redis = { getJson: jest.fn(), setJson: jest.fn(), del: jest.fn() };

  /** Every write mock on the Prisma double — the "no write occurred" assertion reads this list. */
  const allWriteMocks = [
    lineUser.create,
    lineUser.update,
    lineUser.upsert,
    lineUserSettings.create,
    lineUserSettings.update,
    lineUserSettings.upsert,
    $transaction,
  ];

  const SAVED_AT = new Date('2026-09-07T12:51:05.000Z');

  beforeEach(async () => {
    jest.clearAllMocks();
    redis.getJson.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LineUserService,
        {
          provide: PrismaService,
          useValue: { lineUser, lineUserSettings, $transaction },
        },
        { provide: LineService, useValue: line },
        { provide: RealtimeGateway, useValue: realtime },
        { provide: RedisService, useValue: redis },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(null) },
        },
      ],
    }).compile();
    service = module.get<LineUserService>(LineUserService);
  });

  // ───────────────────────────── getSettings ─────────────────────────────

  describe('getSettings', () => {
    it('answers the documented defaults when the user has no settings row — and writes NOTHING', async () => {
      // The normal case, not an edge case: every follower predates this table. A lazy create here
      // is the database footprint the ruling refuses, and it would still return the right JSON.
      lineUserSettings.findFirst.mockResolvedValue(null);

      const result = await service.getSettings('U-A');

      expect(result).toEqual({
        theme: DEFAULT_LINE_USER_THEME,
        notifications: {
          announcements: true,
          decisions: true,
          reminders: true,
        },
        updatedAt: null,
      });
      for (const write of allWriteMocks) expect(write).not.toHaveBeenCalled();
    });

    it('returns the stored values when a row exists', async () => {
      lineUserSettings.findFirst.mockResolvedValue({
        theme: 'dark',
        notifications: {
          announcements: false,
          decisions: true,
          reminders: false,
        },
        updatedAt: SAVED_AT,
      });

      await expect(service.getSettings('U-A')).resolves.toEqual({
        theme: 'dark',
        notifications: {
          announcements: false,
          decisions: true,
          reminders: false,
        },
        updatedAt: SAVED_AT,
      });
      for (const write of allWriteMocks) expect(write).not.toHaveBeenCalled();
    });

    it('reads through the CALLER’S verified sub only — user A cannot address user B’s row', async () => {
      // There is no id parameter to abuse, so the isolation is structural. This pins the one thing
      // that could break it: the `where` reaching Prisma must be built from the argument alone.
      lineUserSettings.findFirst.mockResolvedValue(null);

      await service.getSettings('U-A');
      await service.getSettings('U-B');

      expect(lineUserSettings.findFirst).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { lineUser: { lineUserId: 'U-A', deletedAt: null } },
        }),
      );
      expect(lineUserSettings.findFirst).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { lineUser: { lineUserId: 'U-B', deletedAt: null } },
        }),
      );
    });

    it('reads the row in ONE query rather than resolving the user first', async () => {
      lineUserSettings.findFirst.mockResolvedValue(null);

      await service.getSettings('U-A');

      expect(lineUserSettings.findFirst).toHaveBeenCalledTimes(1);
      expect(lineUser.findFirst).not.toHaveBeenCalled();
    });

    it('degrades a malformed JSONB blob to the defaults rather than to a lying response type', async () => {
      // Postgres accepts anything in a JSONB column, so a row written by anything other than this
      // service can hold a string, a missing key, or nothing at all. The declared DTO says three
      // booleans, and the read is the last place that can still be true.
      lineUserSettings.findFirst.mockResolvedValue({
        theme: 'system',
        notifications: { decisions: 'yes', reminders: false },
        updatedAt: SAVED_AT,
      });

      await expect(service.getSettings('U-A')).resolves.toMatchObject({
        notifications: {
          announcements: true, // absent  → default
          decisions: true, // not a boolean → default
          reminders: false, // a real boolean survives
        },
      });
    });

    it.each([[null], ['nonsense'], [[1, 2]]])(
      'treats a non-object notifications column (%p) as the defaults',
      async (stored) => {
        lineUserSettings.findFirst.mockResolvedValue({
          theme: 'system',
          notifications: stored,
          updatedAt: SAVED_AT,
        });

        await expect(service.getSettings('U-A')).resolves.toMatchObject({
          notifications: defaultNotificationPreferences(),
        });
      },
    );
  });

  // ───────────────────────────── patchSettings ─────────────────────────────

  describe('patchSettings', () => {
    /** The `LineUser` the caller's verified sub resolves to. */
    const arrangeUser = (id = 'lu-1') =>
      lineUser.findFirst.mockResolvedValue({ id, lineUserId: 'U-A' });

    const arrangeUpsert = (notifications: unknown, theme = 'system') =>
      lineUserSettings.upsert.mockResolvedValue({
        theme,
        notifications,
        updatedAt: SAVED_AT,
      });

    it('merges ONE toggle and leaves the other two exactly as they were', async () => {
      arrangeUser();
      lineUserSettings.findUnique.mockResolvedValue({
        theme: 'dark',
        notifications: {
          announcements: true,
          decisions: true,
          reminders: false,
        },
      });
      arrangeUpsert(
        { announcements: true, decisions: false, reminders: false },
        'dark',
      );

      const result = await service.patchSettings('U-A', {
        notifications: { decisions: false },
      });

      const [args] = lineUserSettings.upsert.mock.calls[0] as [
        {
          where: unknown;
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        },
      ];
      // The two untouched keys must reach the DB unchanged — `reminders` was already false and
      // must NOT be reset to its `true` default either.
      expect(args.update).toEqual({
        theme: 'dark',
        notifications: {
          announcements: true,
          decisions: false,
          reminders: false,
        },
      });
      expect(result.notifications).toEqual({
        announcements: true,
        decisions: false,
        reminders: false,
      });
    });

    it('does NOT let an absent DTO key overwrite a stored value with undefined', async () => {
      // `useDefineForClassFields` means a validated DTO instance carries all three properties even
      // when the client sent one, so `{...stored, ...dto.notifications}` would write
      // `announcements: undefined` and JSON.stringify would drop the key. This is that trap.
      arrangeUser();
      lineUserSettings.findUnique.mockResolvedValue({
        theme: 'system',
        notifications: {
          announcements: true,
          decisions: true,
          reminders: true,
        },
      });
      arrangeUpsert({
        announcements: true,
        decisions: true,
        reminders: false,
      });

      const dtoShapedLikeTheRealOne = {
        theme: undefined,
        notifications: {
          announcements: undefined,
          decisions: undefined,
          reminders: false,
        },
      };
      await service.patchSettings('U-A', dtoShapedLikeTheRealOne);

      const [args] = lineUserSettings.upsert.mock.calls[0] as [
        { update: { theme: string; notifications: Record<string, unknown> } },
      ];
      expect(args.update.notifications).toEqual({
        announcements: true,
        decisions: true,
        reminders: false,
      });
      // An absent theme is unchanged, never reset to the default.
      expect(args.update.theme).toBe('system');
    });

    it('creates the row from the defaults + the patch when the user has none', async () => {
      arrangeUser();
      lineUserSettings.findUnique.mockResolvedValue(null);
      arrangeUpsert({
        announcements: true,
        decisions: false,
        reminders: true,
      });

      await service.patchSettings('U-A', {
        notifications: { decisions: false },
      });

      const [args] = lineUserSettings.upsert.mock.calls[0] as [
        {
          where: unknown;
          create: Record<string, unknown>;
        },
      ];
      expect(args.where).toEqual({ lineUserId: 'lu-1' });
      expect(args.create).toEqual({
        lineUserId: 'lu-1',
        theme: DEFAULT_LINE_USER_THEME,
        notifications: {
          announcements: true,
          decisions: false,
          reminders: true,
        },
      });
    });

    it('persists a theme change and leaves the notifications untouched', async () => {
      arrangeUser();
      lineUserSettings.findUnique.mockResolvedValue({
        theme: 'system',
        notifications: {
          announcements: false,
          decisions: true,
          reminders: true,
        },
      });
      arrangeUpsert(
        { announcements: false, decisions: true, reminders: true },
        'light',
      );

      await service.patchSettings('U-A', { theme: 'light' });

      const [args] = lineUserSettings.upsert.mock.calls[0] as [
        { update: { theme: string; notifications: Record<string, unknown> } },
      ];
      expect(args.update.theme).toBe('light');
      expect(args.update.notifications).toEqual({
        announcements: false,
        decisions: true,
        reminders: true,
      });
    });

    it('never writes the two reserved columns', async () => {
      // `preferences` and `privacy` have no DTO field, so `forbidNonWhitelisted` already 400s an
      // attempt to send them. This is the other half of the rule: the service must not write them
      // either, or "reserved" quietly becomes "shapeless blob".
      arrangeUser();
      lineUserSettings.findUnique.mockResolvedValue(null);
      arrangeUpsert(defaultNotificationPreferences());

      await service.patchSettings('U-A', { theme: 'dark' });

      const [args] = lineUserSettings.upsert.mock.calls[0] as [
        { create: Record<string, unknown>; update: Record<string, unknown> },
      ];
      expect(args.create).not.toHaveProperty('preferences');
      expect(args.create).not.toHaveProperty('privacy');
      expect(args.update).not.toHaveProperty('preferences');
      expect(args.update).not.toHaveProperty('privacy');
    });

    it('writes against the CALLER’S own row — user A cannot patch user B’s settings', async () => {
      // The DTO has no `lineUserId` field, so the only id that can reach the write is the one this
      // service resolved from the verified sub. Pinned by asserting the lookup and the write key.
      lineUser.findFirst.mockResolvedValue({ id: 'lu-A', lineUserId: 'U-A' });
      lineUserSettings.findUnique.mockResolvedValue(null);
      arrangeUpsert(defaultNotificationPreferences());

      await service.patchSettings('U-A', {
        notifications: { reminders: false },
      });

      expect(lineUser.findFirst).toHaveBeenCalledWith({
        where: { lineUserId: 'U-A', deletedAt: null },
      });
      expect(lineUserSettings.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { lineUserId: 'lu-A' } }),
      );
      const [args] = lineUserSettings.upsert.mock.calls[0] as [
        { where: unknown; create: { lineUserId: string } },
      ];
      expect(args.where).toEqual({ lineUserId: 'lu-A' });
      expect(args.create.lineUserId).toBe('lu-A');
    });

    it('creates the LineUser row for a LIFF-first caller who has never been seen', async () => {
      // A PATCH is a write the user asked for, so materialising the parent row is correct here —
      // unlike the read path, which must stay footprint-free.
      lineUser.findFirst.mockResolvedValue(null);
      lineUser.create.mockResolvedValue({ id: 'lu-new', lineUserId: 'U-new' });
      lineUserSettings.findUnique.mockResolvedValue(null);
      arrangeUpsert(defaultNotificationPreferences());

      await service.patchSettings('U-new', { theme: 'dark' });

      expect(lineUser.create).toHaveBeenCalledWith({
        data: { lineUserId: 'U-new' },
      });
      const [args] = lineUserSettings.upsert.mock.calls[0] as [
        { where: unknown },
      ];
      expect(args.where).toEqual({ lineUserId: 'lu-new' });
    });

    it('returns the row the database actually saved, including its updatedAt', async () => {
      arrangeUser();
      lineUserSettings.findUnique.mockResolvedValue(null);
      arrangeUpsert(
        { announcements: true, decisions: true, reminders: false },
        'dark',
      );

      await expect(
        service.patchSettings('U-A', {
          theme: 'dark',
          notifications: { reminders: false },
        }),
      ).resolves.toEqual({
        theme: 'dark',
        notifications: {
          announcements: true,
          decisions: true,
          reminders: false,
        },
        updatedAt: SAVED_AT,
      });
    });
  });

  // ───────────────────────────── getClientVersion ─────────────────────────────

  describe('getClientVersion', () => {
    it('answers a semver-shaped version and an ok status', () => {
      const result = service.getClientVersion();

      expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(result.status).toBe(LINE_CLIENT_VERSION_STATUS);
    });

    it('prefers the deploy’s APP_VERSION stamp over npm’s dev fallback', () => {
      const previous = process.env.APP_VERSION;
      process.env.APP_VERSION = '9.9.9';
      try {
        expect(service.getClientVersion().version).toBe('9.9.9');
      } finally {
        if (previous === undefined) delete process.env.APP_VERSION;
        else process.env.APP_VERSION = previous;
      }
    });

    it('treats an EMPTY stamp as unset rather than answering an empty string', () => {
      // `.env.example` documents these by listing them blank, so a copied `.env` sets `''` — which
      // `??` would keep. A version screen showing "" is worse than one showing the fallback.
      const previous = process.env.APP_VERSION;
      process.env.APP_VERSION = '   ';
      try {
        expect(service.getClientVersion().version).toMatch(/^\d+\.\d+\.\d+/);
      } finally {
        if (previous === undefined) delete process.env.APP_VERSION;
        else process.env.APP_VERSION = previous;
      }
    });

    it('touches neither Prisma nor Redis — it is per-deploy, never per-user', () => {
      service.getClientVersion();

      expect(lineUser.findFirst).not.toHaveBeenCalled();
      expect(lineUserSettings.findFirst).not.toHaveBeenCalled();
      expect(redis.getJson).not.toHaveBeenCalled();
    });
  });
});
