import { Logger } from '@nestjs/common';
import { AppAccess, Prisma } from '@prisma/client';
import type { NotificationsService } from '../notifications.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RedisService } from '../../redis/redis.service';
import {
  AdminNotificationTriggers,
  safeReason,
} from './admin-notification-triggers.service';

/** `mock.calls[0][0]`, without `no-unsafe-member-access` — bare `jest.Mock`/`SpyInstance` collapse
 * their call-args tuple to `any`, and indexing an `any` a second time is what the rule flags. */
const firstArg = (spy: jest.Mock | jest.SpyInstance): unknown =>
  (spy.mock.calls[0] as unknown[])[0];

const PERSON = {
  firstName: 'สมชาย',
  lastName: 'ใจดี',
  personnelRole: { name: 'ครู' },
  department: { name: 'ฝ่ายวิชาการ' },
};

describe('AdminNotificationTriggers', () => {
  let create: jest.Mock;
  let claimOnce: jest.Mock;
  let prisma: {
    lineUser: { findUnique: jest.Mock };
    bookingRequest: { findUnique: jest.Mock; findMany: jest.Mock };
    feedback: { findUnique: jest.Mock };
    systemUser: { findUnique: jest.Mock };
  };
  let warn: jest.SpyInstance;

  const build = (enabled: boolean) =>
    new AdminNotificationTriggers(
      { create } as unknown as NotificationsService,
      prisma as unknown as PrismaService,
      { claimOnce } as unknown as RedisService,
      enabled,
    );

  beforeEach(() => {
    create = jest.fn().mockResolvedValue({ id: 'notif-1' });
    claimOnce = jest.fn().mockResolvedValue(true);
    prisma = {
      lineUser: { findUnique: jest.fn() },
      bookingRequest: { findUnique: jest.fn(), findMany: jest.fn() },
      feedback: { findUnique: jest.fn() },
      systemUser: { findUnique: jest.fn() },
    };
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => warn.mockRestore());

  const ACTOR = { id: 'op-1', name: 'วีระ ทองดี' };

  // ── Disabled: no read, no write, no Redis ────────────────────────────────────────────────────
  it('disabled: every method resolves without touching Prisma, Redis or create', async () => {
    const triggers = build(false);
    await Promise.all([
      triggers.registrationSubmitted({
        lineUserId: 'lu',
        person: { ...PERSON, phone: 'x' },
      }),
      triggers.registrationResubmitted({ lineUserId: 'lu', person: PERSON }),
      triggers.unfollowedWithPending({ lineUserId: 'lu' }),
      triggers.bookingRequested({ bookingId: 'b' }),
      triggers.bookingCancelledByRequester({ bookingId: 'b' }),
      triggers.bookingsExpired({ bookingIds: ['b'] }),
      triggers.bookingsAutoRejected({
        approvedBookingId: 'b',
        losers: [{ id: 'l', code: 'c' }],
        actor: ACTOR,
      }),
      triggers.directBookingCreated({ bookingId: 'b', actor: ACTOR }),
      triggers.feedbackSubmitted({ feedbackId: 'f' }),
      triggers.lineDeliveryFailed({
        operation: 'push',
        kind: 'RATE_LIMITED',
        status: 429,
      }),
      triggers.versionChanged({ previous: '0.1.0', current: '0.2.0' }),
      triggers.venueClosed({
        venueId: 'v',
        venueName: 'A',
        reason: 'r',
        actor: ACTOR,
      }),
      triggers.settingChanged({
        key: 'booking.cancel_lead_minutes',
        oldValue: '1',
        newValue: '2',
        actor: ACTOR,
      }),
      triggers.serverError({
        status: 500,
        errorCode: 'Error',
        handler: 'X.y',
        method: 'GET',
        routeTemplate: null,
      }),
    ]);

    expect(create).not.toHaveBeenCalled();
    expect(claimOnce).not.toHaveBeenCalled();
    expect(prisma.lineUser.findUnique).not.toHaveBeenCalled();
    expect(prisma.bookingRequest.findUnique).not.toHaveBeenCalled();
    expect(prisma.bookingRequest.findMany).not.toHaveBeenCalled();
    expect(prisma.feedback.findUnique).not.toHaveBeenCalled();
    expect(prisma.systemUser.findUnique).not.toHaveBeenCalled();
  });

  it('isEnabled reflects the constructor flag', () => {
    expect(build(true).isEnabled).toBe(true);
    expect(build(false).isEnabled).toBe(false);
  });

  // ── AC-4 negative cases ──────────────────────────────────────────────────────────────────────
  describe('AC-4 negative cases', () => {
    it('U3: a pending count of 0 creates no row', async () => {
      prisma.lineUser.findUnique.mockResolvedValue({
        access: AppAccess.ALLOWED,
        registration: null,
        bookingRequests: [],
        _count: { bookingRequests: 0 },
      });
      await build(true).unfollowedWithPending({ lineUserId: 'lu' });
      expect(create).not.toHaveBeenCalled();
    });

    it('B3: an empty id list creates no row and reads nothing', async () => {
      await build(true).bookingsExpired({ bookingIds: [] });
      expect(create).not.toHaveBeenCalled();
      expect(prisma.bookingRequest.findMany).not.toHaveBeenCalled();
    });

    it('B4: no losers creates no row and reads nothing', async () => {
      await build(true).bookingsAutoRejected({
        approvedBookingId: 'b',
        losers: [],
        actor: ACTOR,
      });
      expect(create).not.toHaveBeenCalled();
      expect(prisma.bookingRequest.findUnique).not.toHaveBeenCalled();
    });

    it.each(['REJECTED', 'ALREADY_ACCEPTED'] as const)(
      'C1: kind=%s never fires and never claims',
      async (kind) => {
        await build(true).lineDeliveryFailed({
          operation: 'push',
          kind,
          status: 400,
        });
        expect(create).not.toHaveBeenCalled();
        expect(claimOnce).not.toHaveBeenCalled();
      },
    );

    it('C4: a non-allowlisted key creates no row', async () => {
      await build(true).settingChanged({
        key: 'some.other.key',
        oldValue: '1',
        newValue: '2',
        actor: ACTOR,
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('C4: line.channel_secret is denied before its value is ever read', async () => {
      await build(true).settingChanged({
        key: 'line.channel_secret',
        oldValue: 'a',
        newValue: 'b',
        actor: ACTOR,
      });
      expect(create).not.toHaveBeenCalled();
      expect(prisma.systemUser.findUnique).not.toHaveBeenCalled();
    });

    it('C4: an unchanged value creates no row', async () => {
      await build(true).settingChanged({
        key: 'booking.cancel_lead_minutes',
        oldValue: '60',
        newValue: '60',
        actor: ACTOR,
      });
      expect(create).not.toHaveBeenCalled();
    });
  });

  // ── Dedupe ───────────────────────────────────────────────────────────────────────────────────
  it('C1: claimOnce → false means no create', async () => {
    claimOnce.mockResolvedValue(false);
    await build(true).lineDeliveryFailed({
      operation: 'push',
      kind: 'RATE_LIMITED',
      status: 429,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('C5: claimOnce → false means no create', async () => {
    claimOnce.mockResolvedValue(false);
    await build(true).serverError({
      status: 500,
      errorCode: 'Error',
      handler: 'X.y',
      method: 'GET',
      routeTemplate: null,
    });
    expect(create).not.toHaveBeenCalled();
  });

  // ── R-8: actor read fails but the notification still fires ─────────────────────────────────
  it('a failed actor read still creates a row, falling back to actor.name', async () => {
    prisma.systemUser.findUnique.mockRejectedValue(new Error('DB down'));
    await build(true).venueClosed({
      venueId: 'v',
      venueName: 'ห้อง A',
      reason: 'ปิดปรับปรุง',
      actor: ACTOR,
    });
    expect(create).toHaveBeenCalledTimes(1);
    const input = firstArg(create) as { body: string };
    expect(input.body).toContain(ACTOR.name);
  });

  it('a missing SystemUser row still creates a row, falling back to actor.name', async () => {
    prisma.systemUser.findUnique.mockResolvedValue(null);
    await build(true).venueClosed({
      venueId: 'v',
      venueName: 'ห้อง A',
      reason: 'ปิดปรับปรุง',
      actor: ACTOR,
    });
    expect(create).toHaveBeenCalledTimes(1);
    const input = firstArg(create) as { body: string };
    expect(input.body).toContain(ACTOR.name);
  });

  // ── Fail-safe: create() rejecting logs a warn without title/body/PII ────────────────────────
  it('a rejecting create() logs exactly one warn with no title/body/PII', async () => {
    create.mockRejectedValue(new Error('boom'));
    prisma.feedback.findUnique.mockResolvedValue({
      code: 'FDB-1',
      type: 'FEEDBACK',
      subject: 'ขอบคุณมากครับ',
      venue: null,
      lineUser: { registration: PERSON },
    });
    await build(true).feedbackSubmitted({ feedbackId: 'f' });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(firstArg(warn));
    expect(line).not.toMatch(/ขอบคุณ|สมชาย|ใจดี/);
    expect(line).toContain('feedback=f');
  });
});

describe('safeReason', () => {
  it('never returns a PrismaClientValidationError message', () => {
    const err = new Prisma.PrismaClientValidationError(
      'secret argument value',
      {
        clientVersion: 'x',
      },
    );
    const reason = safeReason(err);
    expect(reason).not.toContain('secret');
    expect(reason).toBe('PrismaClientValidationError');
  });

  it('a known Prisma error gives ClassName:code', () => {
    const err = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'x',
    });
    expect(safeReason(err)).toBe('PrismaClientKnownRequestError:P2002');
  });

  it('an AdminNotification.create message passes through verbatim (field names only)', () => {
    const err = new Error('AdminNotification.create: title must be a string');
    expect(safeReason(err)).toBe(
      'AdminNotification.create: title must be a string',
    );
  });

  it('a plain Error gives just its class name', () => {
    expect(safeReason(new Error('do not leak this'))).toBe('Error');
  });

  it('a non-Error gives UnknownError', () => {
    expect(safeReason('a string')).toBe('UnknownError');
  });
});
