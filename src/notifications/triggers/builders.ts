import type { AppAccess } from '@prisma/client';
import {
  AdminNotificationCategory as Category,
  AdminNotificationTargetRole as TargetRole,
  AdminNotificationTone as Tone,
} from '@prisma/client';
import {
  bangkokClock,
  describeSlots,
  thaiShortDate,
} from '../../bookings/booking-time-text';
import type { SlotTimes } from '../../bookings/booking-time-text';
import type { CreateAdminNotificationInput } from '../notifications.service';
import { attributionOf, type PersonFacts } from './attribution';
import {
  ACCESS_LABEL,
  FEEDBACK_TYPE_LABEL,
  LINE_KIND_LABEL,
  SETTING_LABEL,
} from './labels';
import { CODE_LIST_MAX, type LineFailureKind } from './triggers.constants';

/** Pure text helpers (design §2.5), all bounded before `create()` ever sees them. */

/** The first {@link CODE_LIST_MAX} codes, plus "และอีก N รายการ" when `total` exceeds that. */
export function codeList(codes: readonly string[], total: number): string {
  const shown = codes.slice(0, CODE_LIST_MAX).join(', ');
  return total > CODE_LIST_MAX
    ? `${shown} และอีก ${total - CODE_LIST_MAX} รายการ`
    : shown;
}

/** `describeSlots(slots)` compressed to the one line every body uses. */
export function when(slots: readonly SlotTimes[]): string {
  const { dateSummary, periodText } = describeSlots(slots);
  return periodText === 'หลายช่วงเวลา'
    ? `${dateSummary} (หลายช่วงเวลา)`
    : `${dateSummary} เวลา ${periodText}`;
}

/** Cuts to `n - 1` chars and appends `…` when over `n`. Applied to every interpolated field. */
export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

const A = (p: PersonFacts | null | undefined, fallback?: string): string =>
  attributionOf(p, fallback);

/** `v0.8.0` never `vv0.8.0`. */
const withV = (x: string): string => (x.startsWith('v') ? x : `v${x}`);

// ── U1 / U2 / U3 — REGISTRATION ────────────────────────────────────────────────────────────────

export function buildU1(
  person: PersonFacts & { phone: string },
): CreateAdminNotificationInput {
  return {
    category: Category.REGISTRATION,
    tone: Tone.AMBER,
    icon: 'user-plus',
    targetRole: TargetRole.ADMIN,
    actionUrl: '/backend/line-users',
    actionLabel: 'ตรวจสอบการลงทะเบียน',
    title: 'มีผู้ลงทะเบียนใหม่รอตรวจสอบ',
    body: `${A(person)} · โทร ${person.phone}`,
  };
}

export function buildU2(person: PersonFacts): CreateAdminNotificationInput {
  return {
    category: Category.REGISTRATION,
    tone: Tone.AMBER,
    icon: 'arrow-path',
    targetRole: TargetRole.ADMIN,
    actionUrl: '/backend/line-users',
    actionLabel: 'ตรวจสอบข้อมูลใหม่',
    title: 'ผู้ใช้ส่งข้อมูลลงทะเบียนใหม่อีกครั้ง',
    body: `${A(person)} · ส่งใหม่หลังแก้ไขตามเหตุผลที่ไม่อนุมัติ`,
  };
}

export function buildU3(p: {
  registration: PersonFacts | null;
  access: AppAccess;
  pendingCount: number;
  pendingCodes: readonly string[];
}): CreateAdminNotificationInput {
  return {
    category: Category.REGISTRATION,
    tone: Tone.SLATE,
    icon: 'user-minus',
    targetRole: TargetRole.SUPER_ADMIN,
    actionUrl: '/backend/line-users',
    actionLabel: 'ดูข้อมูลผู้ใช้',
    title: 'ผู้ใช้เลิกติดตาม LINE OA ขณะมีคำขอค้าง',
    body: `${A(p.registration, 'ผู้ใช้ LINE ที่ยังไม่ลงทะเบียน')} · สถานะเดิม: ${
      ACCESS_LABEL[p.access]
    } · คำขอรอพิจารณา ${p.pendingCount} รายการ: ${codeList(p.pendingCodes, p.pendingCount)}`,
  };
}

// ── B1 / B2 / B3 / B4 / B5 — BOOKING ────────────────────────────────────────────────────────────

export function buildB1(p: {
  code: string;
  venueName: string;
  slots: readonly SlotTimes[];
  requester: PersonFacts | null;
}): CreateAdminNotificationInput {
  return {
    category: Category.BOOKING,
    tone: Tone.SKY,
    icon: 'calendar',
    targetRole: TargetRole.ADMIN,
    code: p.code,
    actionUrl: '/backend/bookings/requests?status=PENDING',
    actionLabel: 'พิจารณาคำขอจอง',
    title: 'คำขอจองใหม่',
    body: `${p.code} · ${p.venueName} · ${when(p.slots)} · ผู้ขอ ${A(p.requester)}`,
  };
}

export function buildB2(p: {
  code: string;
  venueName: string;
  slots: readonly SlotTimes[];
  requester: PersonFacts | null;
  /** `true` when only one slot of an APPROVED booking was cancelled (the per-slot cancel route). */
  slotOnly: boolean;
}): CreateAdminNotificationInput {
  const body = p.slotOnly
    ? `${p.code} · ${p.venueName} · ยกเลิกเฉพาะ ${when(p.slots)} · ยกเลิกโดย ${A(p.requester)}`
    : `${p.code} · ${p.venueName} · ${when(p.slots)} · ยกเลิกโดย ${A(p.requester)}`;
  return {
    category: Category.BOOKING,
    tone: Tone.SLATE,
    icon: 'x-circle',
    targetRole: TargetRole.ALL,
    code: p.code,
    actionUrl: '/backend/bookings/requests',
    actionLabel: 'ดูรายการคำขอ',
    title: 'ผู้ขอยกเลิกคำขอจอง',
    body,
  };
}

export function buildB3(p: {
  count: number;
  codes: readonly string[];
  /** Only used when `count === 1`. */
  single?: { venueName: string; startAt: Date };
}): CreateAdminNotificationInput {
  const body =
    p.count === 1 && p.single
      ? `${p.codes[0]} · ${p.single.venueName} · เริ่ม ${thaiShortDate(p.single.startAt)} เวลา ${bangkokClock(
          p.single.startAt,
        )} น. · หมดอายุก่อนได้รับการพิจารณา`
      : `หมดอายุ ${p.count} รายการ: ${codeList(p.codes, p.count)}`;
  return {
    category: Category.BOOKING,
    tone: Tone.AMBER,
    icon: 'clock',
    targetRole: TargetRole.ADMIN,
    code: p.count === 1 ? (p.codes[0] ?? null) : null,
    actionUrl: '/backend/bookings/requests?status=EXPIRED',
    actionLabel: 'ตรวจสอบคำขอหมดอายุ',
    title: 'คำขอจองหมดอายุโดยไม่ได้พิจารณา',
    body,
  };
}

export function buildB4(p: {
  approvedCode: string;
  venueName: string;
  loserCodes: readonly string[];
  actorText: string;
}): CreateAdminNotificationInput {
  return {
    category: Category.BOOKING,
    tone: Tone.ROSE,
    icon: 'queue-list',
    targetRole: TargetRole.ADMIN,
    code: p.approvedCode,
    actionUrl: '/backend/bookings/requests',
    actionLabel: 'ดูรายการที่ถูกปฏิเสธ',
    title: `ปฏิเสธคำขอที่ทับซ้อนอัตโนมัติ ${p.loserCodes.length} รายการ`,
    body: `อนุมัติ ${p.approvedCode} · ${p.venueName} · ปฏิเสธอัตโนมัติ: ${codeList(
      p.loserCodes,
      p.loserCodes.length,
    )} · ดำเนินการโดย ${p.actorText}`,
  };
}

export function buildB5(p: {
  code: string;
  venueName: string;
  slots: readonly SlotTimes[];
  actorText: string;
}): CreateAdminNotificationInput {
  return {
    category: Category.BOOKING,
    tone: Tone.EMERALD,
    icon: 'check',
    targetRole: TargetRole.ALL,
    code: p.code,
    actionUrl: '/backend/bookings/calendar',
    actionLabel: 'ดูปฏิทินการจอง',
    title: 'เจ้าหน้าที่จองสถานที่โดยตรง',
    body: `${p.code} · ${p.venueName} · ${when(p.slots)} · ทำรายการโดย ${p.actorText}`,
  };
}

// ── F1 / F2 — FEEDBACK ──────────────────────────────────────────────────────────────────────────

export function buildF1(p: {
  code: string;
  subject: string;
  reporter: PersonFacts | null;
}): CreateAdminNotificationInput {
  return {
    category: Category.FEEDBACK,
    tone: Tone.SKY,
    icon: 'chat-bubble',
    targetRole: TargetRole.ADMIN,
    code: p.code,
    actionUrl: '/backend/feedback',
    actionLabel: 'เปิดดูข้อเสนอแนะ',
    title: 'ข้อเสนอแนะใหม่',
    body: `${clip(p.subject, 120)} · ประเภท: ${FEEDBACK_TYPE_LABEL.FEEDBACK} · แจ้งโดย ${A(p.reporter)}`,
  };
}

export function buildF2(p: {
  code: string;
  subject: string;
  venueName: string | null;
  reporter: PersonFacts | null;
}): CreateAdminNotificationInput {
  return {
    category: Category.FEEDBACK,
    tone: Tone.ROSE,
    icon: 'exclamation-triangle',
    targetRole: TargetRole.ALL,
    code: p.code,
    actionUrl: '/backend/feedback',
    actionLabel: 'ตรวจสอบเหตุด่วน',
    title: 'แจ้งปัญหาการใช้งานสถานที่',
    body: `${clip(p.venueName ?? 'ไม่ระบุสถานที่', 120)} · ${clip(p.subject, 120)} · แจ้งโดย ${A(p.reporter)}`,
  };
}

// ── C1 … C5 — SYSTEM ────────────────────────────────────────────────────────────────────────────

export function buildC1(p: {
  operation: 'push' | 'multicast';
  kind: LineFailureKind;
  status: number | null;
  at: Date;
}): CreateAdminNotificationInput {
  const opText =
    p.operation === 'push'
      ? 'การส่งรายบุคคล (push)'
      : 'การส่งแบบกลุ่ม (multicast)';
  return {
    category: Category.SYSTEM,
    tone: Tone.ROSE,
    icon: 'link-slash',
    targetRole: TargetRole.ADMIN,
    actionUrl: '/backend/settings/integrations',
    actionLabel: 'ตรวจสอบการเชื่อมต่อ',
    title: 'ส่งข้อความ LINE ไม่สำเร็จ',
    body: `${LINE_KIND_LABEL[p.kind]} · HTTP ${p.status ?? '-'} · ${opText} · ${thaiShortDate(
      p.at,
    )} ${bangkokClock(p.at)} น. · ไม่แจ้งซ้ำภายใน 60 นาที`,
  };
}

export function buildC2(p: {
  previous: string;
  current: string;
}): CreateAdminNotificationInput {
  const vOld = withV(p.previous);
  const vNew = withV(p.current);
  return {
    category: Category.SYSTEM,
    tone: Tone.EMERALD,
    icon: 'sparkles',
    targetRole: TargetRole.ALL,
    code: vNew,
    actionUrl: '/backend/help/version',
    actionLabel: 'ดูบันทึกการเปลี่ยนแปลง',
    title: `อัปเดตระบบเป็นเวอร์ชัน ${vNew}`,
    body: `${vOld} → ${vNew} · รีเฟรชหน้าจอเพื่อใช้งานฟีเจอร์ใหม่`,
  };
}

export function buildC3(p: {
  venueName: string;
  reason: string;
  actorText: string;
}): CreateAdminNotificationInput {
  const venue = clip(p.venueName, 120);
  return {
    category: Category.SYSTEM,
    tone: Tone.AMBER,
    icon: 'building-office',
    targetRole: TargetRole.ALL,
    actionUrl: '/backend/venues',
    actionLabel: 'ดูข้อมูลสถานที่',
    title: `ปิดสถานที่ชั่วคราว: ${venue}`,
    body: `${venue} · เหตุผล: ${clip(p.reason, 200)} · ดำเนินการโดย ${p.actorText}`,
  };
}

export function buildC4(p: {
  key: string;
  oldValue: string | null;
  newValue: string;
  actorText: string;
}): CreateAdminNotificationInput {
  const label = SETTING_LABEL[p.key] ?? p.key;
  const oldText = p.oldValue === null ? '-' : clip(p.oldValue, 100);
  const newText = clip(p.newValue, 100);
  return {
    category: Category.SYSTEM,
    tone: Tone.SLATE,
    icon: 'adjustments-horizontal',
    targetRole: TargetRole.ADMIN,
    code: p.key,
    actionUrl: '/backend/settings/booking',
    actionLabel: 'ดูการตั้งค่าระบบ',
    title: 'มีการเปลี่ยนการตั้งค่าระบบ',
    body: `${label}: ${oldText} → ${newText} · ดำเนินการโดย ${p.actorText}`,
  };
}

export function buildC5(p: {
  status: number;
  errorCode: string;
  handler: string;
  method: string;
  routeTemplate: string | null;
}): CreateAdminNotificationInput {
  return {
    category: Category.SYSTEM,
    tone: Tone.ROSE,
    icon: 'bug-ant',
    targetRole: TargetRole.SUPER_ADMIN,
    code: p.errorCode,
    actionUrl: '/backend/reports/error-log',
    actionLabel: 'ตรวจสอบบันทึกข้อผิดพลาด',
    title: `เกิดข้อผิดพลาดของระบบ (${p.status})`,
    body: `${p.errorCode} · ${p.handler} · ${p.method} ${p.routeTemplate ?? '-'} · ไม่แจ้งซ้ำภายใน 15 นาที`,
  };
}
