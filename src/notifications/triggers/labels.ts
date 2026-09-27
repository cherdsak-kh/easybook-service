import { AppAccess, FeedbackType } from '@prisma/client';
import { CANCEL_LEAD_MINUTES_KEY } from '../../bookings/bookings.constants';
import type { LineFailureKind } from './triggers.constants';

/** U3's "สถานะเดิม" — the access the user held right before the unfollow. */
export const ACCESS_LABEL: Record<AppAccess, string> = {
  UNREGISTERED: 'ยังไม่ลงทะเบียน',
  PENDING: 'รอตรวจสอบ',
  ALLOWED: 'อนุมัติแล้ว',
  REJECTED: 'ไม่อนุมัติ',
  BLOCKED: 'ถูกระงับ',
};

/** F1/F2's "ประเภท:". */
export const FEEDBACK_TYPE_LABEL: Record<FeedbackType, string> = {
  ISSUE: 'แจ้งปัญหา',
  FEEDBACK: 'ข้อเสนอแนะ',
};

/** C1's LINE-failure kind, in Thai. `REJECTED`/`ALREADY_ACCEPTED` never reach this map (filtered). */
export const LINE_KIND_LABEL: Record<LineFailureKind, string> = {
  NOT_CONFIGURED: 'ยังไม่ได้ตั้งค่าหรือโทเคนไม่ถูกต้อง',
  RATE_LIMITED: 'เกินโควตาหรืออัตราการส่งข้อความ',
  TRANSIENT: 'LINE ไม่ตอบสนองชั่วคราว',
};

/** C4's setting-key labels — only the allowlisted keys need one. */
export const SETTING_LABEL: Record<string, string> = {
  [CANCEL_LEAD_MINUTES_KEY]: 'ระยะเวลาขั้นต่ำก่อนยกเลิกการจอง (นาที)',
};
