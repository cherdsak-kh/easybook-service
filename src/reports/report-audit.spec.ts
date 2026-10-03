import {
  AnnouncementAudience,
  BookingStatus,
  SystemRole,
} from '@prisma/client';
import { AUTO_REJECTED_REASON } from '../bookings/bookings.constants';
import {
  AUDIT_ACTION_LABEL,
  AUDIT_ACTOR_HARD_DELETED,
  AUDIT_ACTOR_UNRECORDED,
  AUDIT_ROLE_LABEL,
  AUDIT_TARGET_KIND_LABEL,
} from './audit-labels';
import {
  actorDisplayOf,
  AUDIT_CAPABILITIES,
  auditActorOptionsOf,
  auditKpisOf,
  filterAuditEvents,
  isAuditFiltered,
  synthesiseAuditEvents,
  type AuditActorRow,
  type AuditRequestRow,
  type AuditSlotRow,
  type AuditSources,
} from './report-audit';
import { AuditAction, AuditActorState, AuditTargetKind } from './dto/audit.dto';

const bkk = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0, ms = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm, ss, ms) - 7 * 3_600_000);

const FROM = bkk(2026, 9, 1);
const TO = bkk(2026, 10, 1); // exclusive

const venue = { name: 'หอประชุม', deletedAt: null };

const actor = (over: Partial<AuditActorRow> = {}): AuditActorRow => ({
  id: 'a1',
  firstName: 'สมหญิง',
  lastName: 'เรืองศรี',
  role: SystemRole.ADMIN,
  deletedAt: null,
  department: { name: 'ฝ่ายบริหารงานทั่วไป', isSystemReserved: false },
  personnelRole: { name: 'เจ้าหน้าที่', isSystemReserved: false },
  ...over,
});

const request = (over: Partial<AuditRequestRow> = {}): AuditRequestRow => ({
  id: 'r1',
  code: 'BR-25690910-001',
  status: BookingStatus.APPROVED,
  rejectReason: null,
  createdAt: bkk(2026, 9, 9, 8),
  updatedAt: bkk(2026, 9, 10, 9),
  approvedAt: bkk(2026, 9, 10, 9, 15, 42),
  approvedById: 'a1',
  createdById: null,
  firstStartAt: bkk(2026, 9, 15, 9),
  venue,
  departmentId: 1,
  lineUser: null,
  ...over,
});

const slotRow = (
  over: Partial<AuditSlotRow> = {},
  reqOver = {},
): AuditSlotRow => ({
  bookingRequestId: 'r9',
  cancelledAt: bkk(2026, 9, 12, 14),
  cancelledById: 'a1',
  cancelledByRole: 'ADMIN',
  cancelReason: 'ห้องซ่อม',
  bookingRequest: {
    id: 'r9',
    code: 'BR-25690920-009',
    firstStartAt: bkk(2026, 9, 20, 9),
    venue,
    departmentId: 1,
    lineUser: null,
    slots: [
      { isCancelled: true, cancelledAt: bkk(2026, 9, 12, 14) },
      { isCancelled: true, cancelledAt: bkk(2026, 9, 12, 14) },
    ],
    ...reqOver,
  },
  ...over,
});

const sources = (over: Partial<AuditSources> = {}): AuditSources => ({
  from: FROM,
  to: TO,
  requests: [],
  cancelSlots: [],
  accounts: [],
  announcements: [],
  departments: [
    { id: 1, name: 'ฝ่ายวิชาการ', isSystemReserved: false },
    { id: 9, name: 'System Developer', isSystemReserved: true },
  ],
  actors: new Map([['a1', actor()]]),
  maySeeReserved: false,
  ...over,
});

const one = (src: AuditSources) => {
  const events = synthesiseAuditEvents(src);
  expect(events).toHaveLength(1);
  return events[0];
};

describe('synthesiseAuditEvents (design §1.2.1)', () => {
  describe('APPROVE', () => {
    it('a LIFF request a staff member approved', () => {
      const e = one(sources({ requests: [request()] }));
      expect(e).toMatchObject({
        id: 'APV-BR-25690910-001',
        action: AuditAction.APPROVE,
        at: bkk(2026, 9, 10, 9, 15, 42).toISOString(),
        atIsApproximate: false,
        summary: 'อนุมัติการใช้หอประชุม วันที่ 15 ก.ย. 2569',
        changes: [
          { field: 'สถานะคำขอ', before: 'รอพิจารณา', after: 'อนุมัติแล้ว' },
        ],
        note: null,
        ip: null,
        userAgent: null,
      });
      expect(e.actor).toEqual({
        id: 'a1',
        name: 'สมหญิง เรืองศรี',
        role: SystemRole.ADMIN,
        position: 'เจ้าหน้าที่',
        department: 'ฝ่ายบริหารงานทั่วไป',
        state: AuditActorState.ACTIVE,
      });
      expect(e.target).toEqual({
        kind: AuditTargetKind.BOOKING_REQUEST,
        id: 'r1',
        label: 'BR-25690910-001',
        detail: 'หอประชุม · ฝ่ายวิชาการ',
        isDeleted: false,
      });
    });

    it('an approver whose FK was nulled (hard delete) is HARD_DELETED with no name or id', () => {
      const e = one(sources({ requests: [request({ approvedById: null })] }));
      expect(e.actor).toEqual({
        id: null,
        name: null,
        role: null,
        position: null,
        department: null,
        state: AuditActorState.HARD_DELETED,
      });
    });

    it('a soft-deleted approver still resolves, flagged', () => {
      const e = one(
        sources({
          requests: [request()],
          actors: new Map([['a1', actor({ deletedAt: new Date() })]]),
        }),
      );
      expect(e.actor?.state).toBe(AuditActorState.SOFT_DELETED);
      expect(e.actor?.name).toBe('สมหญิง เรืองศรี');
    });
  });

  describe('DIRECT_BOOKING', () => {
    it('is attributed to the creator at createdAt, with the folded department in the summary', () => {
      const e = one(
        sources({
          requests: [
            request({
              createdById: 'a1',
              createdAt: bkk(2026, 9, 11, 10),
              approvedAt: bkk(2026, 9, 11, 10),
              approvedById: 'a1',
            }),
          ],
        }),
      );
      expect(e).toMatchObject({
        id: 'DIR-BR-25690910-001',
        action: AuditAction.DIRECT_BOOKING,
        at: bkk(2026, 9, 11, 10).toISOString(),
        summary: 'จองแทนฝ่ายวิชาการ ที่หอประชุม วันที่ 15 ก.ย. 2569',
        changes: [{ field: 'สถานะคำขอ', before: '-', after: 'อนุมัติแล้ว' }],
      });
      expect(e.actor?.id).toBe('a1');
    });

    it('does NOT also produce an APPROVE (creation is the approval)', () => {
      const events = synthesiseAuditEvents(
        sources({
          requests: [
            request({ createdById: 'a1', createdAt: bkk(2026, 9, 11, 10) }),
          ],
        }),
      );
      expect(events.map((x) => x.action)).toEqual([AuditAction.DIRECT_BOOKING]);
    });
  });

  describe('REJECT (manual)', () => {
    const rejected = (over: Partial<AuditRequestRow> = {}) =>
      request({
        status: BookingStatus.REJECTED,
        rejectReason: 'ไม่เหมาะสมกับสถานที่',
        approvedAt: null,
        approvedById: null,
        updatedAt: bkk(2026, 9, 13, 16, 5),
        ...over,
      });

    it('has no actor, an approximate time and the reason as its note', () => {
      const e = one(sources({ requests: [rejected()] }));
      expect(e).toMatchObject({
        id: 'REJ-BR-25690910-001',
        action: AuditAction.REJECT,
        actor: null,
        atIsApproximate: true,
        at: bkk(2026, 9, 13, 16, 5).toISOString(),
        note: 'ไม่เหมาะสมกับสถานที่',
        summary: 'ปฏิเสธคำขอใช้หอประชุม วันที่ 15 ก.ย. 2569',
      });
    });

    it('a reject with no reason (NULL) is still a manual reject', () => {
      expect(
        one(sources({ requests: [rejected({ rejectReason: null })] })).note,
      ).toBeNull();
    });

    it('an AUTO-reject is system automation and is excluded (D-15)', () => {
      expect(
        synthesiseAuditEvents(
          sources({
            requests: [rejected({ rejectReason: AUTO_REJECTED_REASON })],
          }),
        ),
      ).toEqual([]);
    });

    it('an EXPIRED request (expiry cron) is excluded', () => {
      expect(
        synthesiseAuditEvents(
          sources({
            requests: [
              rejected({
                status: BookingStatus.EXPIRED,
                rejectReason: 'หมดอายุ',
              }),
            ],
          }),
        ),
      ).toEqual([]);
    });
  });

  describe('CANCEL', () => {
    it('groups a 2-slot series cancelled in one call into ONE event with its slot count', () => {
      const e = one(sources({ cancelSlots: [slotRow(), slotRow()] }));
      expect(e).toMatchObject({
        id: `CAN-BR-25690920-009-${bkk(2026, 9, 12, 14).getTime().toString(36)}`,
        action: AuditAction.CANCEL,
        summary: 'ยกเลิกการจองหอประชุม วันที่ 20 ก.ย. 2569 จำนวน 2 ช่วงเวลา',
        note: 'ห้องซ่อม',
        changes: [
          { field: 'สถานะคำขอ', before: 'อนุมัติแล้ว', after: 'ยกเลิก' },
          { field: 'ช่วงเวลาที่ยกเลิก', before: '-', after: '2 ช่วงเวลา' },
        ],
      });
    });

    it('two cancels at different instants are two events, the earlier one partial (E-11)', () => {
      const later = bkk(2026, 9, 14, 9);
      const slots = [
        { isCancelled: true, cancelledAt: bkk(2026, 9, 12, 14) },
        { isCancelled: true, cancelledAt: later },
      ];
      const events = synthesiseAuditEvents(
        sources({
          cancelSlots: [
            slotRow({ cancelledAt: bkk(2026, 9, 12, 14) }, { slots }),
            slotRow({ cancelledAt: later }, { slots }),
          ],
        }),
      );
      expect(events).toHaveLength(2);
      const byAt = new Map(events.map((x) => [x.at, x]));
      expect(byAt.get(later.toISOString())?.changes?.[0].after).toBe('ยกเลิก');
      expect(
        byAt.get(bkk(2026, 9, 12, 14).toISOString())?.changes?.[0].after,
      ).toBe('อนุมัติแล้ว (ยกเลิกบางช่วงเวลา)');
    });

    it("carries the role AT THE TIME, not the actor's current role", () => {
      const e = one(
        sources({
          cancelSlots: [slotRow({ cancelledByRole: 'SUPER_ADMIN' })],
          actors: new Map([['a1', actor({ role: SystemRole.VIEWER })]]),
        }),
      );
      expect(e.actor?.role).toBe(SystemRole.SUPER_ADMIN);
    });

    it('a canceller whose row is gone keeps the id and role but no name (HARD_DELETED)', () => {
      const e = one(sources({ cancelSlots: [slotRow()], actors: new Map() }));
      expect(e.actor).toEqual({
        id: 'a1',
        name: null,
        role: SystemRole.ADMIN,
        position: null,
        department: null,
        state: AuditActorState.HARD_DELETED,
      });
    });
  });

  describe('ACCOUNT and BROADCAST', () => {
    it('lists a staff account created by another staff member, never the seeded one', () => {
      const created = {
        id: 's2',
        firstName: 'วีระ',
        lastName: 'พงศ์ไพบูลย์',
        createdAt: bkk(2026, 9, 5, 11),
        createdById: 'a1',
        deletedAt: null,
        department: { name: 'ฝ่ายอาคารสถานที่', isSystemReserved: false },
        personnelRole: { name: 'ครู', isSystemReserved: false },
      };
      const e = one(
        sources({
          accounts: [created, { ...created, id: 's0', createdById: null }],
        }),
      );
      expect(e).toMatchObject({
        id: 'ACC-s2',
        action: AuditAction.ACCOUNT,
        summary: 'สร้างบัญชีเจ้าหน้าที่ใหม่',
        changes: null,
      });
      expect(e.target).toEqual({
        kind: AuditTargetKind.STAFF_ACCOUNT,
        id: 's2',
        label: 'วีระ พงศ์ไพบูลย์',
        detail: 'ครู · ฝ่ายอาคารสถานที่',
        isDeleted: false,
      });
      expect(e.actor?.id).toBe('a1');
    });

    it('lists a sent announcement with no actor (the sender is not recorded)', () => {
      const e = one(
        sources({
          announcements: [
            {
              id: 'n1',
              title: 'ปิดภาคเรียน',
              sentAt: bkk(2026, 9, 20, 8),
              sentCount: 1234,
              audience: AnnouncementAudience.ALL,
              deletedAt: new Date(),
              department: null,
            },
          ],
        }),
      );
      expect(e).toMatchObject({
        id: 'ANN-n1',
        action: AuditAction.BROADCAST,
        actor: null,
        summary: 'ส่งประกาศถึงผู้ใช้ 1,234 คน',
        changes: [
          { field: 'สถานะ', before: 'ฉบับร่าง', after: 'ส่งแล้ว' },
          { field: 'จำนวนผู้รับ', before: '-', after: '1,234 คน' },
        ],
      });
      expect(e.target).toMatchObject({
        detail: 'ผู้รับ ทุกคน',
        isDeleted: true,
      });
    });
  });

  describe("range by the event's OWN timestamp (AC-A3)", () => {
    const approvedAt = (at: Date) =>
      sources({ requests: [request({ approvedAt: at })] });

    it('23:59:59.999 Bangkok on the last day is in', () => {
      expect(
        synthesiseAuditEvents(approvedAt(bkk(2026, 9, 30, 23, 59, 59, 999))),
      ).toHaveLength(1);
    });

    it('00:00:00 the next day is out', () => {
      expect(
        synthesiseAuditEvents(approvedAt(bkk(2026, 10, 1, 0, 0, 0))),
      ).toHaveLength(0);
    });

    it('00:00:00 on the first day is in; the last millisecond before it is out', () => {
      expect(
        synthesiseAuditEvents(approvedAt(bkk(2026, 9, 1, 0, 0, 0))),
      ).toHaveLength(1);
      expect(
        synthesiseAuditEvents(approvedAt(bkk(2026, 8, 31, 23, 59, 59, 999))),
      ).toHaveLength(0);
    });

    it('ignores the booking use date entirely', () => {
      expect(
        synthesiseAuditEvents(
          sources({ requests: [request({ firstStartAt: bkk(2030, 1, 1) })] }),
        ),
      ).toHaveLength(1);
    });
  });

  describe('order', () => {
    it('is newest first, with a stable id tiebreak for identical instants', () => {
      const at = bkk(2026, 9, 10, 9);
      const rows = ['BR-003', 'BR-001', 'BR-002'].map((code, i) =>
        request({ id: `r${i}`, code, approvedAt: at }),
      );
      const ids = synthesiseAuditEvents(sources({ requests: rows })).map(
        (e) => e.id,
      );
      expect(ids).toEqual(['APV-BR-003', 'APV-BR-002', 'APV-BR-001']);
      expect(
        synthesiseAuditEvents(sources({ requests: [...rows].reverse() })).map(
          (e) => e.id,
        ),
      ).toEqual(ids);
    });
  });

  describe('reserved-department fold for a non-SUPER_ADMIN (P2 D-20, AC-A10)', () => {
    const reservedActor = actor({
      department: { name: 'System Developer', isSystemReserved: true },
      personnelRole: { name: 'System Developer', isSystemReserved: true },
    });
    const src = (maySeeReserved: boolean) =>
      sources({
        maySeeReserved,
        actors: new Map([['a1', reservedActor]]),
        requests: [request({ departmentId: 9 })],
      });

    it('hides the reserved department and title from an ADMIN, in the actor and the target', () => {
      const e = one(src(false));
      expect(e.actor?.department).toBeNull();
      expect(e.actor?.position).toBeNull();
      expect(e.target.detail).toBe('หอประชุม · ไม่ระบุกลุ่ม/ฝ่าย');
      expect(JSON.stringify(e)).not.toContain('System Developer');
    });

    it('shows it to a SUPER_ADMIN', () => {
      const e = one(src(true));
      expect(e.actor?.department).toBe('System Developer');
      expect(e.target.detail).toBe('หอประชุม · System Developer');
    });

    it('also folds a reserved department in an announcement audience and a staff target', () => {
      const e = synthesiseAuditEvents(
        sources({
          announcements: [
            {
              id: 'n1',
              title: 't',
              sentAt: bkk(2026, 9, 20),
              sentCount: 1,
              audience: AnnouncementAudience.DEPARTMENT,
              deletedAt: null,
              department: { name: 'System Developer', isSystemReserved: true },
            },
          ],
        }),
      );
      expect(e[0].target.detail).toBe('ผู้รับ ไม่ระบุกลุ่ม/ฝ่าย');
    });
  });

  it('no event ever carries a requester or LINE identity field', () => {
    const e = synthesiseAuditEvents(
      sources({ requests: [request()], cancelSlots: [slotRow()] }),
    );
    const dump = JSON.stringify(e);
    expect(dump).not.toMatch(
      /requesterName|contactPhone|lineUserId|passwordHash|email/,
    );
    expect(dump).not.toMatch(/U[0-9a-f]{32}/);
  });
});

describe('auditKpisOf', () => {
  const events = () =>
    synthesiseAuditEvents(
      sources({
        actors: new Map([
          ['a1', actor()],
          ['a2', actor({ id: 'a2', firstName: 'ก', lastName: 'ต้น' })],
        ]),
        requests: [
          request({ id: 'r1', code: 'BR-1', approvedById: 'a1' }),
          request({ id: 'r2', code: 'BR-2', approvedById: 'a2' }),
          request({
            id: 'r3',
            code: 'BR-3',
            status: BookingStatus.REJECTED,
            rejectReason: 'x',
            approvedAt: null,
            approvedById: null,
            updatedAt: bkk(2026, 9, 12),
          }),
          request({
            id: 'r4',
            code: 'BR-4',
            createdById: 'a1',
            approvedAt: null,
            createdAt: bkk(2026, 9, 11),
          }),
        ],
        cancelSlots: [slotRow()],
      }),
    );

  it('counts the four decision types and leaves resource changes null', () => {
    const k = auditKpisOf(events(), 30);
    expect(k).toMatchObject({
      total: 5,
      days: 30,
      approve: 2,
      reject: 1,
      cancel: 1,
      directBooking: 1,
      resourceChanges: null,
    });
  });

  it('the top actor ties go to the earlier name in Thai collation, never an unknown actor', () => {
    // a1 has 3 events (approve, direct, cancel), a2 has 1: a1 is top by count.
    const k = auditKpisOf(events(), 30);
    expect(k.topActor?.actor.id).toBe('a1');
    expect(k.topActor?.count).toBe(3);
    expect(k.topActor?.percent).toBeCloseTo(60, 8);

    // Force a tie: the earlier Thai name wins.
    const tie = synthesiseAuditEvents(
      sources({
        actors: new Map([
          ['a1', actor({ id: 'a1', firstName: 'ข', lastName: 'ข' })],
          ['a2', actor({ id: 'a2', firstName: 'ก', lastName: 'ก' })],
        ]),
        requests: [
          request({ id: 'r1', code: 'BR-1', approvedById: 'a1' }),
          request({ id: 'r2', code: 'BR-2', approvedById: 'a2' }),
        ],
      }),
    );
    expect(auditKpisOf(tie, 1).topActor?.actor.id).toBe('a2');
  });

  it('unknown actors (null, hard-deleted) are never top; a range with none is null', () => {
    const unknown = synthesiseAuditEvents(
      sources({
        requests: [
          request({ approvedById: null }),
          request({
            id: 'r2',
            code: 'BR-2',
            status: BookingStatus.REJECTED,
            rejectReason: 'x',
            approvedAt: null,
            updatedAt: bkk(2026, 9, 12),
          }),
        ],
      }),
    );
    expect(auditKpisOf(unknown, 5).topActor).toBeNull();
    expect(auditKpisOf([], 1)).toMatchObject({ total: 0, topActor: null });
  });
});

describe('auditActorOptionsOf', () => {
  it('lists named actors once, Thai-sorted, soft-deleted flagged', () => {
    const events = synthesiseAuditEvents(
      sources({
        actors: new Map([
          [
            'a1',
            actor({
              id: 'a1',
              firstName: 'ข',
              lastName: 'ข',
              deletedAt: new Date(),
            }),
          ],
          ['a2', actor({ id: 'a2', firstName: 'ก', lastName: 'ก' })],
        ]),
        requests: [
          request({ id: 'r1', code: 'BR-1', approvedById: 'a1' }),
          request({ id: 'r2', code: 'BR-2', approvedById: 'a1' }),
          request({ id: 'r3', code: 'BR-3', approvedById: 'a2' }),
          request({ id: 'r4', code: 'BR-4', approvedById: null }),
        ],
      }),
    );
    expect(auditActorOptionsOf(events)).toEqual([
      { id: 'a2', name: 'ก ก', isDeleted: false },
      { id: 'a1', name: 'ข ข', isDeleted: true },
    ]);
  });
});

describe('filterAuditEvents', () => {
  const events = synthesiseAuditEvents(
    sources({
      requests: [
        request({ id: 'r1', code: 'BR-100%', approvedById: 'a1' }),
        request({
          id: 'r2',
          code: 'BR-200',
          approvedById: 'a1',
          createdAt: bkk(2026, 9, 1),
        }),
        request({
          id: 'r3',
          code: 'BR-300',
          status: BookingStatus.REJECTED,
          rejectReason: 'ขอสงวนสิทธิ์',
          approvedAt: null,
          updatedAt: bkk(2026, 9, 12),
        }),
      ],
    }),
  );

  it('filters by action and by actor', () => {
    expect(
      filterAuditEvents(events, { action: AuditAction.REJECT }),
    ).toHaveLength(1);
    expect(filterAuditEvents(events, { actorId: 'a1' })).toHaveLength(2);
    expect(filterAuditEvents(events, { actorId: 'nobody' })).toEqual([]);
  });

  it('searches code, note, actor name and the Thai action label; % is literal', () => {
    expect(filterAuditEvents(events, { q: 'br-200' })).toHaveLength(1);
    expect(filterAuditEvents(events, { q: 'สงวนสิทธิ์' })).toHaveLength(1);
    expect(filterAuditEvents(events, { q: 'สมหญิง' })).toHaveLength(2);
    expect(
      filterAuditEvents(events, { q: AUDIT_ACTION_LABEL[AuditAction.REJECT] }),
    ).toHaveLength(1);
    expect(filterAuditEvents(events, { q: '%' })).toHaveLength(1); // only "BR-100%"
    expect(filterAuditEvents(events, { q: '_' })).toHaveLength(0);
  });

  it('knows when a filter narrows the list', () => {
    expect(isAuditFiltered({})).toBe(false);
    expect(isAuditFiltered({ q: '  ' })).toBe(false);
    expect(isAuditFiltered({ q: 'x' })).toBe(true);
    expect(isAuditFiltered({ action: AuditAction.APPROVE })).toBe(true);
    expect(isAuditFiltered({ actorId: 'a' })).toBe(true);
  });
});

describe('actor renderings (AC-A10) and capabilities', () => {
  it('renders each state as the plan says', () => {
    const base = {
      id: 'a',
      role: SystemRole.ADMIN,
      position: null,
      department: null,
    };
    expect(actorDisplayOf(null)).toBe(AUDIT_ACTOR_UNRECORDED);
    expect(
      actorDisplayOf({ ...base, name: 'สมชาย', state: AuditActorState.ACTIVE }),
    ).toBe('สมชาย');
    expect(
      actorDisplayOf({
        ...base,
        name: 'สมชาย',
        state: AuditActorState.SOFT_DELETED,
      }),
    ).toBe('สมชาย (ลบแล้ว)');
    expect(
      actorDisplayOf({
        ...base,
        name: null,
        state: AuditActorState.HARD_DELETED,
      }),
    ).toBe(AUDIT_ACTOR_HARD_DELETED);
  });

  it('offers only the six producible actions, no IP, no venue changes', () => {
    expect(AUDIT_CAPABILITIES).toEqual({
      source: 'SYNTHESIZED',
      actions: [
        'APPROVE',
        'REJECT',
        'CANCEL',
        'DIRECT_BOOKING',
        'ACCOUNT',
        'BROADCAST',
      ],
      recordsIp: false,
      recordsResourceChanges: false,
    });
    expect(AUDIT_CAPABILITIES.actions).not.toContain(AuditAction.VENUE_UPDATE);
  });

  it('has a Thai label for every action, target kind and role', () => {
    for (const a of Object.values(AuditAction))
      expect(AUDIT_ACTION_LABEL[a]).toBeTruthy();
    for (const k of Object.values(AuditTargetKind))
      expect(AUDIT_TARGET_KIND_LABEL[k]).toBeTruthy();
    for (const r of Object.values(SystemRole))
      expect(AUDIT_ROLE_LABEL[r]).toBeTruthy();
    expect(AUDIT_ROLE_LABEL.SUPER_ADMIN).toBe('ผู้ดูแลระบบสูงสุด');
  });
});
