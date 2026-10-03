import { BookingStatus } from '@prisma/client';
import { AUTO_REJECTED_REASON } from '../bookings/bookings.constants';
import { HOUR_MS } from './report-calendar';
import {
  ReportCancellerKind,
  ReportPurposeCategory,
  ReportSlaBucket,
} from './dto/reports-operations-response.dto';
import {
  buildRegistry,
  departmentBucketOf,
  foldDepartments,
  foldPurposes,
  purposeCategoryOf,
  slaOf,
} from './report-operations';

describe('report-operations (design §2.3, checklist item 6)', () => {
  describe('purposeCategoryOf (§2.3.3, AC-O9)', () => {
    it.each([
      ['อบรมเชิงปฏิบัติการพัฒนาบุคลากร', ReportPurposeCategory.TRAINING],
      ['ประชุมฝ่ายวิชาการประจำเดือน', ReportPurposeCategory.MEETING],
      ['ซ้อมกีฬาสีประจำปี', ReportPurposeCategory.STUDENT_ACTIVITY],
      ['สอนชดเชยวิชาคณิตศาสตร์', ReportPurposeCategory.TEACHING],
      ['งานอื่น ๆ ที่ไม่เข้าพวก', ReportPurposeCategory.OTHER],
    ])('%s -> %s', (text, expected) => {
      expect(purposeCategoryOf(text)).toBe(expected);
    });

    it('precedence: อบรมและประชุมฝ่าย -> TRAINING (rule 1 before rule 2)', () => {
      expect(purposeCategoryOf('อบรมและประชุมฝ่าย')).toBe(
        ReportPurposeCategory.TRAINING,
      );
    });

    it('ประชุมเชิงปฏิบัติการ PLC -> TRAINING', () => {
      expect(purposeCategoryOf('ประชุมเชิงปฏิบัติการ PLC')).toBe(
        ReportPurposeCategory.TRAINING,
      );
    });

    it.each([
      ['ซ่อมแซมโรงเรียน', ReportPurposeCategory.OTHER],
      ['ตรวจสอบระบบเสียง', ReportPurposeCategory.OTHER],
      ['จัดงานที่หอประชุม', ReportPurposeCategory.OTHER],
    ])('scrub phrase: %s -> %s', (text, expected) => {
      expect(purposeCategoryOf(text)).toBe(expected);
    });

    it('เเข่งขันกีฬาสี (double SARA E) -> STUDENT_ACTIVITY', () => {
      expect(purposeCategoryOf('เเข่งขันกีฬาสี')).toBe(
        ReportPurposeCategory.STUDENT_ACTIVITY,
      );
    });

    it('Workshop (case-insensitive) -> TRAINING', () => {
      expect(purposeCategoryOf('Workshop registration')).toBe(
        ReportPurposeCategory.TRAINING,
      );
    });

    it("'' and '   ' -> OTHER", () => {
      expect(purposeCategoryOf('')).toBe(ReportPurposeCategory.OTHER);
      expect(purposeCategoryOf('   ')).toBe(ReportPurposeCategory.OTHER);
      expect(purposeCategoryOf(null)).toBe(ReportPurposeCategory.OTHER);
    });
  });

  describe('foldPurposes', () => {
    it('always returns 5 rows, OTHER last, Σ requests = total', () => {
      const requests = [
        { category: ReportPurposeCategory.TEACHING },
        { category: ReportPurposeCategory.TEACHING },
        { category: ReportPurposeCategory.MEETING },
        { category: ReportPurposeCategory.OTHER },
      ];
      const heldMs = new Map<ReportPurposeCategory, number>([
        [ReportPurposeCategory.TEACHING, 2 * HOUR_MS],
        [ReportPurposeCategory.MEETING, HOUR_MS],
      ]);
      const rows = foldPurposes(requests, heldMs);
      expect(rows).toHaveLength(5);
      expect(rows[rows.length - 1].category).toBe(ReportPurposeCategory.OTHER);
      const totalRequests = rows.reduce((s, r) => s + r.requests, 0);
      expect(totalRequests).toBe(4);
    });
  });

  describe('slaOf (§2.3.4, AC-O10/O11)', () => {
    const day = (n: number) => new Date(2026, 0, n, 0, 0, 0);

    it('partitions the AC-O10 fixture exhaustively', () => {
      const rows = [
        // LIFF approved 3h after creation.
        {
          createdById: null,
          approvedAt: new Date(day(1).getTime() + 3 * HOUR_MS),
          status: BookingStatus.APPROVED,
          rejectReason: null,
          createdAt: day(1),
          updatedAt: day(1),
        },
        // LIFF rejected manually, 30h turnaround.
        {
          createdById: null,
          approvedAt: null,
          status: BookingStatus.REJECTED,
          rejectReason: 'ไม่เหมาะสม',
          createdAt: day(2),
          updatedAt: new Date(day(2).getTime() + 30 * HOUR_MS),
        },
        // Auto-rejected.
        {
          createdById: null,
          approvedAt: null,
          status: BookingStatus.REJECTED,
          rejectReason: AUTO_REJECTED_REASON,
          createdAt: day(3),
          updatedAt: day(3),
        },
        // Staff direct booking.
        {
          createdById: 'staff-1',
          approvedAt: day(4),
          status: BookingStatus.APPROVED,
          rejectReason: null,
          createdAt: day(4),
          updatedAt: day(4),
        },
        // Approved then cancelled (still counted, approvedAt kept).
        {
          createdById: null,
          approvedAt: new Date(day(5).getTime() + HOUR_MS),
          status: BookingStatus.CANCELLED,
          rejectReason: null,
          createdAt: day(5),
          updatedAt: new Date(day(5).getTime() + 2 * HOUR_MS),
        },
        // Cancelled before decision.
        {
          createdById: null,
          approvedAt: null,
          status: BookingStatus.CANCELLED,
          rejectReason: null,
          createdAt: day(6),
          updatedAt: day(6),
        },
        // Expired.
        {
          createdById: null,
          approvedAt: null,
          status: BookingStatus.EXPIRED,
          rejectReason: null,
          createdAt: day(7),
          updatedAt: day(7),
        },
      ];
      const sla = slaOf(rows);
      expect(sla.decided).toBe(3); // LIFF approved, LIFF rejected, approved-then-cancelled
      expect(sla.decidedApproved).toBe(2);
      expect(sla.decidedRejected).toBe(1);
      expect(sla.excluded).toEqual({
        autoRejected: 1,
        withdrawn: 1,
        staffCreated: 1,
        expired: 1,
        pending: 0,
      });
      expect(
        sla.decided +
          sla.excluded.autoRejected +
          sla.excluded.withdrawn +
          sla.excluded.staffCreated +
          sla.excluded.expired +
          sla.excluded.pending,
      ).toBe(rows.length);
      expect(sla.averageHours).toBeCloseTo((3 + 30 + 1) / 3, 8);
    });

    it('exactly 24h is WITHIN sla and falls in bucket FROM_12H_TO_24H', () => {
      const created = day(1);
      const rows = [
        {
          createdById: null,
          approvedAt: new Date(created.getTime() + 24 * HOUR_MS),
          status: BookingStatus.APPROVED,
          rejectReason: null,
          createdAt: created,
          updatedAt: created,
        },
      ];
      const sla = slaOf(rows);
      expect(sla.withinSla).toBe(1);
      expect(sla.withinSlaPercent).toBe(100);
      const bucket = sla.buckets.find(
        (b) => b.bucket === ReportSlaBucket.FROM_12H_TO_24H,
      );
      expect(bucket?.count).toBe(1);
      const overBucket = sla.buckets.find(
        (b) => b.bucket === ReportSlaBucket.OVER_24H,
      );
      expect(overBucket?.count).toBe(0);
    });

    it('an empty population returns nulls, not NaN', () => {
      const sla = slaOf([]);
      expect(sla.decided).toBe(0);
      expect(sla.averageHours).toBeNull();
      expect(sla.medianHours).toBeNull();
      expect(sla.withinSlaPercent).toBeNull();
      expect(sla.buckets.every((b) => b.percent === 0)).toBe(true);
    });
  });

  describe('buildRegistry (§2.3.5, AC-O12)', () => {
    const start = new Date('2026-01-05T03:00:00.000Z'); // 10:00 Bangkok
    const leadMs = 30 * 60_000;
    const baseRow = (
      overrides: Partial<{
        code: string;
        approvedAt: Date | null;
        slots: {
          startAt: Date;
          endAt: Date;
          isCancelled: boolean;
          cancelledAt: Date | null;
          cancelledByRole: string | null;
          cancelReason: string | null;
        }[];
      }>,
    ) => ({
      code: 'BR-1',
      venueId: 'v1',
      approvedAt: start,
      slots: [],
      ...overrides,
    });

    it('cancelled 10 min before start -> a row, "ก่อนเริ่ม 10 นาที" (not after start)', () => {
      const rows = buildRegistry(
        [
          baseRow({
            slots: [
              {
                startAt: start,
                endAt: new Date(start.getTime() + HOUR_MS),
                isCancelled: true,
                cancelledAt: new Date(start.getTime() - 10 * 60_000),
                cancelledByRole: 'ADMIN',
                cancelReason: 'ทดสอบ',
              },
            ],
          }),
        ],
        leadMs,
        () => null,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].cancelledAfterStart).toBe(false);
      expect(rows[0].minutes).toBe(10);
      expect(rows[0].canceller).toBe(ReportCancellerKind.STAFF);
    });

    it('cancelled 31 min before start -> no row', () => {
      const rows = buildRegistry(
        [
          baseRow({
            slots: [
              {
                startAt: start,
                endAt: new Date(start.getTime() + HOUR_MS),
                isCancelled: true,
                cancelledAt: new Date(start.getTime() - 31 * 60_000),
                cancelledByRole: 'ADMIN',
                cancelReason: null,
              },
            ],
          }),
        ],
        leadMs,
        () => null,
      );
      expect(rows).toHaveLength(0);
    });

    it('cancelled 15 min after start -> a row, cancelledAfterStart true', () => {
      const rows = buildRegistry(
        [
          baseRow({
            slots: [
              {
                startAt: start,
                endAt: new Date(start.getTime() + HOUR_MS),
                isCancelled: true,
                cancelledAt: new Date(start.getTime() + 15 * 60_000),
                cancelledByRole: 'LINE_USER',
                cancelReason: null,
              },
            ],
          }),
        ],
        leadMs,
        () => null,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].cancelledAfterStart).toBe(true);
      expect(rows[0].minutes).toBe(15);
      expect(rows[0].canceller).toBe(ReportCancellerKind.REQUESTER);
    });

    it('cancelledAt null -> no row', () => {
      const rows = buildRegistry(
        [
          baseRow({
            slots: [
              {
                startAt: start,
                endAt: new Date(start.getTime() + HOUR_MS),
                isCancelled: true,
                cancelledAt: null,
                cancelledByRole: null,
                cancelReason: null,
              },
            ],
          }),
        ],
        leadMs,
        () => null,
      );
      expect(rows).toHaveLength(0);
    });

    it('a request never approved -> no row', () => {
      const rows = buildRegistry(
        [
          baseRow({
            approvedAt: null,
            slots: [
              {
                startAt: start,
                endAt: new Date(start.getTime() + HOUR_MS),
                isCancelled: true,
                cancelledAt: new Date(start.getTime() - 10 * 60_000),
                cancelledByRole: 'ADMIN',
                cancelReason: null,
              },
            ],
          }),
        ],
        leadMs,
        () => null,
      );
      expect(rows).toHaveLength(0);
    });

    it('a multi-slot request with 2 late slots -> lateSlotCount 2', () => {
      const rows = buildRegistry(
        [
          baseRow({
            slots: [
              {
                startAt: start,
                endAt: new Date(start.getTime() + HOUR_MS),
                isCancelled: true,
                cancelledAt: new Date(start.getTime() - 5 * 60_000),
                cancelledByRole: 'ADMIN',
                cancelReason: null,
              },
              {
                startAt: new Date(start.getTime() + 24 * HOUR_MS),
                endAt: new Date(start.getTime() + 25 * HOUR_MS),
                isCancelled: true,
                cancelledAt: new Date(
                  start.getTime() + 24 * HOUR_MS - 5 * 60_000,
                ),
                cancelledByRole: 'ADMIN',
                cancelReason: null,
              },
            ],
          }),
        ],
        leadMs,
        () => null,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].lateSlotCount).toBe(2);
    });
  });

  describe('departmentBucketOf / foldDepartments (D-20, AC-O7)', () => {
    const byId = new Map<number, { isSystemReserved: boolean }>([
      [1, { isSystemReserved: false }],
      [9, { isSystemReserved: true }],
    ]);

    it('folds a reserved department into null for a non-SUPER_ADMIN actor', () => {
      expect(departmentBucketOf(9, byId, false)).toBeNull();
      expect(departmentBucketOf(9, byId, true)).toBe(9);
      expect(departmentBucketOf(1, byId, false)).toBe(1);
      expect(departmentBucketOf(null, byId, true)).toBeNull();
      expect(departmentBucketOf(999, byId, true)).toBeNull(); // unresolvable
    });

    it('a reserved department gets its own row for SUPER_ADMIN, folds for ADMIN', () => {
      const departments = [
        {
          id: 1,
          name: 'ฝ่ายวิชาการ',
          deletedAt: null,
          isSystemReserved: false,
        },
        {
          id: 9,
          name: 'System Developer',
          deletedAt: null,
          isSystemReserved: true,
        },
      ];
      const asAdmin = foldDepartments(
        departments,
        [
          { bucket: 1, status: BookingStatus.APPROVED, isLate: false },
          { bucket: null, status: BookingStatus.APPROVED, isLate: false }, // reserved dept's request, already folded
        ],
        new Map([
          [1, HOUR_MS],
          [null, HOUR_MS],
        ]),
        false,
      );
      expect(JSON.stringify(asAdmin)).not.toContain('System Developer');
      expect(JSON.stringify(asAdmin)).not.toContain('"departmentId":9');
      const nullRow = asAdmin.find((r) => r.departmentId === null);
      expect(nullRow?.requests).toBe(1);
      expect(nullRow?.heldHours).toBe(1);

      const asSuper = foldDepartments(
        departments,
        [{ bucket: 9, status: BookingStatus.APPROVED, isLate: false }],
        new Map([[9, HOUR_MS]]),
        true,
      );
      expect(asSuper.some((r) => r.departmentId === 9)).toBe(true);
    });

    it('a deleted department appears only with activity', () => {
      const departments = [
        {
          id: 2,
          name: 'ฝ่ายเก่า',
          deletedAt: new Date(),
          isSystemReserved: false,
        },
      ];
      const withoutActivity = foldDepartments(
        departments,
        [],
        new Map(),
        false,
      );
      expect(withoutActivity).toHaveLength(0);

      const withActivity = foldDepartments(
        departments,
        [{ bucket: 2, status: BookingStatus.APPROVED, isLate: false }],
        new Map(),
        false,
      );
      expect(withActivity).toHaveLength(1);
      expect(withActivity[0].isDeleted).toBe(true);
    });

    it('the null (ไม่ระบุ) row is always last', () => {
      const departments = [
        { id: 1, name: 'ก', deletedAt: null, isSystemReserved: false },
        { id: 2, name: 'ข', deletedAt: null, isSystemReserved: false },
      ];
      const rows = foldDepartments(
        departments,
        [
          { bucket: null, status: BookingStatus.APPROVED, isLate: false },
          { bucket: 2, status: BookingStatus.APPROVED, isLate: false },
        ],
        new Map([
          [null, 100 * HOUR_MS],
          [2, HOUR_MS],
        ]), // null bucket has MORE hours than dept 2
        false,
      );
      expect(rows[rows.length - 1].departmentId).toBeNull();
    });

    it('a zero-activity non-deleted department is listed with zeros', () => {
      const departments = [
        { id: 5, name: 'ว่างเปล่า', deletedAt: null, isSystemReserved: false },
      ];
      const rows = foldDepartments(departments, [], new Map(), false);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        requests: 0,
        heldHours: 0,
        approvalPercent: null,
      });
    });
  });
});
