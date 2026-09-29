import { AUTO_REJECTED_REASON } from './bookings.constants';

/**
 * Reports Phase 1 (design §1.5, R-2 mitigation).
 *
 * `ReportsService` recognises an auto-rejection ONLY by an exact string match against
 * `AUTO_REJECTED_REASON` (`reports.service.ts`'s fold of `BookingStatus.REJECTED` rows) — there is
 * no `BookingRequest.rejectKind` column (Hub 2 backlog item). If this literal is EVER edited without
 * a backfill, every historical auto-rejection silently reclassifies as a manual reject in Reports
 * Hub 1 (the `autoRejected` count) and Hub 2's future unmet-demand analysis.
 *
 * 🔴 EDITING THIS STRING SILENTLY RE-CLASSIFIES EVERY HISTORICAL AUTO-REJECTION AS MANUAL IN
 * REPORTS HUB 1/2. Add `BookingRequest.rejectKind` with a backfill FIRST, then update both this
 * pinned value and the callers together.
 */
describe('AUTO_REJECTED_REASON (R-2 pin)', () => {
  it('is pinned to its exact literal value', () => {
    expect(AUTO_REJECTED_REASON).toBe(
      'ช่วงเวลาที่ขอถูกจัดสรรให้การจองอื่นแล้ว จึงไม่สามารถอนุมัติคำขอนี้ได้',
    );
  });

  it('names nobody — no person, department, purpose or winning code (D-C13, AC-BR15)', () => {
    expect(AUTO_REJECTED_REASON).not.toMatch(/BR-\d/);
    expect(AUTO_REJECTED_REASON).not.toMatch(/[A-Za-z]{3,}/);
    expect(AUTO_REJECTED_REASON).not.toMatch(/ชื่อ|ฝ่าย|โดย|คุณ/);
  });
});
