import { SystemRole } from '@prisma/client';
import { AuditAction, AuditTargetKind } from './dto/audit.dto';

/**
 * Thai labels for the Hub 5 CSV and the toolbar search. The backend copy of the frontend's
 * `labels.ts` maps (`ROLE_LABEL`, the prototype's `TYPES` / `KINDS`); `audit-labels.spec.ts` pins them.
 */

export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  [AuditAction.APPROVE]: 'อนุมัติคำขอจอง',
  [AuditAction.REJECT]: 'ปฏิเสธคำขอจอง',
  [AuditAction.CANCEL]: 'ยกเลิกคำขอจอง',
  [AuditAction.DIRECT_BOOKING]: 'สร้างการจองแทน',
  [AuditAction.VENUE_UPDATE]: 'แก้ไขข้อมูลสถานที่',
  [AuditAction.ACCOUNT]: 'จัดการบัญชีผู้ใช้',
  [AuditAction.BROADCAST]: 'ส่งประกาศข่าวสาร',
};

export const AUDIT_TARGET_KIND_LABEL: Record<AuditTargetKind, string> = {
  [AuditTargetKind.BOOKING_REQUEST]: 'คำขอจองสถานที่',
  [AuditTargetKind.VENUE]: 'สถานที่',
  [AuditTargetKind.LINE_USER]: 'ผู้ใช้ LINE',
  [AuditTargetKind.STAFF_ACCOUNT]: 'บัญชีเจ้าหน้าที่',
  [AuditTargetKind.ANNOUNCEMENT]: 'ประกาศ',
};

export const AUDIT_ROLE_LABEL: Record<SystemRole, string> = {
  [SystemRole.SUPER_ADMIN]: 'ผู้ดูแลระบบสูงสุด',
  [SystemRole.ADMIN]: 'เจ้าหน้าที่ดูแลระบบ',
  [SystemRole.VIEWER]: 'ผู้ดูข้อมูล',
};

/** The actor renderings of AC-A10. */
export const AUDIT_ACTOR_UNRECORDED = 'ไม่ได้บันทึกผู้กระทำ';
export const AUDIT_ACTOR_HARD_DELETED = 'ไม่ทราบผู้กระทำ (บัญชีถูกลบ)';
export const AUDIT_SOFT_DELETED_SUFFIX = ' (ลบแล้ว)';
export const AUDIT_NO_DEPARTMENT = 'ไม่ระบุกลุ่ม/ฝ่าย';
