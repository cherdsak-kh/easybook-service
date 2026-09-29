/**
 * Admin notification DEV seed — run: `npm run notifications:seed` (`NOTIF-API-1`, D-4, optional).
 *
 * Writes the admin-portal prototype's 16 sample notifications (`master_layout_prototype_v2.html`,
 * the `SEED` array of the notifications module) so Phase 2 can develop against the real service
 * before Phase 3 emits anything. Phase 1 has no other writer: without this, the feed is empty.
 *
 * 🔴 REFUSES `NODE_ENV=production` (exit 1). These rows are fiction — invented names, phone numbers
 * and incidents — and a production operator must never see a "LINE token expired" alert that did not
 * happen.
 *
 * ── IDEMPOTENT ──
 * `upsert` by FIXED id, `cseednotif000000000000001` … `…016`. The ids are cuid-SHAPED on purpose
 * (design §8, deviation from the plan's `seed_notif_01…16`): every E-5/E-6 body id must match
 * `^c[a-z0-9]{24}$`, so non-cuid seed ids would make every bulk call from Phase 2 against the seed a
 * 400. They stay recognisable, and distinct from real cuids (a real cuid's timestamp segment is never
 * `seednoti`). A re-run rewrites the same 16 rows and re-stamps `createdAt` relative to NOW, so the
 * `period` filters keep showing something on a long-lived dev DB.
 *
 * ── WHAT IT NEVER WRITES ──
 * Receipt rows. The prototype's `read: true` flags are ONE viewer's state and are not reproduced —
 * every operator sees the seed as unread until they act on it.
 *
 * Every row goes through `normaliseCreateInput`, the same check `NotificationsService.create()`
 * applies (canonical icon names, `/backend/` deep links, CTA pairing, caps) — a seed that could store
 * what `create()` refuses would teach Phase 2 a shape production never produces.
 *
 * Logs counts only — the bodies carry (fictional) names and phone numbers, and the house rule is the
 * same for fiction as for PII.
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  AdminNotificationCategory,
  AdminNotificationTargetRole,
  AdminNotificationTone,
  PrismaClient,
} from '@prisma/client';
import type { AdminNotificationIcon } from '../src/notifications/notifications.constants';
import {
  normaliseCreateInput,
  type CreateAdminNotificationInput,
} from '../src/notifications/notifications.service';

const logger = new Logger('SeedNotifications');

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** `cseednotif` + 15 digits = 25 characters, cuid-shaped. */
const seedId = (n: number): string =>
  `cseednotif${String(n).padStart(15, '0')}`;

/** The prototype's `go` screen labels → portal paths (prototype `ROUTES`, prefixed `/backend/`). */
const GO = {
  registrations: '/backend/line-users',
  requests: '/backend/bookings/requests',
  integrations: '/backend/settings/integrations',
  feedback: '/backend/feedback',
  venues: '/backend/venues',
  errorLog: '/backend/reports/error-log',
  bookingSettings: '/backend/settings/booking',
  version: '/backend/help/version',
} as const;

const { BOOKING, REGISTRATION, FEEDBACK, SYSTEM } = AdminNotificationCategory;
const { SKY, AMBER, ROSE, EMERALD, SLATE } = AdminNotificationTone;
const { ALL, ADMIN, SUPER_ADMIN } = AdminNotificationTargetRole;

interface SeedRow {
  /** Whole calendar days ago — the prototype's `days`, the only thing its period filter reads. */
  days: number;
  input: CreateAdminNotificationInput & { icon: AdminNotificationIcon };
}

/**
 * The prototype's 16 rows, NEWEST FIRST (its array order is the `createdAt DESC` order).
 *
 * Mapping (design §8): `cat` users→REGISTRATION, bookings→BOOKING, feedback→FEEDBACK, system→SYSTEM;
 * `tone` upper-cased; the prototype's short `ico` aliases → canonical names (`warn`→
 * `exclamation-triangle`, `building`→`building-office`, `adjust`→`adjustments-horizontal`, `bug`→
 * `bug-ant`); `sub` → body; `cta`/`go` → actionLabel/actionUrl. `targetRole` follows the spec's
 * use-case table: U3 and C5 → SUPER_ADMIN; the five all-roles cases (B2, B5, F2, C2, C3) → ALL; the
 * rest → ADMIN (`nt-4`, the approval UC-B4 hangs off, is not itself a use case and falls in "the rest").
 */
const ROWS: readonly SeedRow[] = [
  {
    days: 0, // nt-1, UC-U1
    input: {
      category: REGISTRATION,
      tone: AMBER,
      icon: 'user-plus',
      targetRole: ADMIN,
      title: 'ผู้ใช้ลงทะเบียนใหม่ 2 ราย รออนุมัติ',
      body: 'เชิดศักดิ์ คำไล้ · ครูชำนาญการ · กลุ่มสาระการเรียนรู้ภาษาไทย · 089-441-2207 และอีก 1 ราย',
      actionLabel: 'ตรวจสอบข้อมูล',
      actionUrl: GO.registrations,
    },
  },
  {
    days: 0, // nt-2, UC-B1
    input: {
      category: BOOKING,
      tone: SKY,
      icon: 'calendar',
      targetRole: ADMIN,
      code: 'RQ-2569-0184',
      title: 'คำขอจองห้องประชุมใหม่ 1 รายการ',
      body: 'RQ-2569-0184 · สมชาย ใจดี · ครูชำนาญการ · ฝ่ายวิชาการ · ห้องประชุมใหญ่ · 12 ส.ค. 2569 เวลา 09:00–12:00',
      actionLabel: 'ดูคำขอจอง',
      actionUrl: GO.requests,
    },
  },
  {
    days: 0, // nt-3, UC-C1
    input: {
      category: SYSTEM,
      tone: ROSE,
      icon: 'link-slash',
      targetRole: ADMIN,
      title: 'เชื่อมต่อ LINE Messaging API ไม่สำเร็จ',
      body: 'Channel access token หมดอายุ · ส่งข้อความล้มเหลว 4 ครั้ง ล่าสุด 12 ส.ค. 2569 08:45 · ระบบจะลองใหม่อัตโนมัติภายใน 5 นาที',
      actionLabel: 'ไปที่หน้าตั้งค่า',
      actionUrl: GO.integrations,
    },
  },
  {
    days: 1, // nt-4, the approval UC-B4 hangs off
    input: {
      category: BOOKING,
      tone: EMERALD,
      icon: 'check',
      targetRole: ADMIN,
      code: 'RQ-2569-0180',
      title: 'อนุมัติคำขอจองสนามกีฬาแล้ว',
      body: 'RQ-2569-0180 · สนามกีฬากลาง · 15 ส.ค. 2569 เวลา 13:00–16:00 · ดำเนินการโดย สมชาย ใจดี · ครูชำนาญการ · ฝ่ายวิชาการ',
      actionLabel: 'ดูคำขอจอง',
      actionUrl: GO.requests,
    },
  },
  {
    days: 2, // nt-5, UC-B2
    input: {
      category: BOOKING,
      tone: SLATE,
      icon: 'x-circle',
      targetRole: ALL,
      code: 'RQ-2569-0171',
      title: 'ผู้จองยกเลิกคำขอ 1 รายการ',
      body: 'RQ-2569-0171 · ห้องโสตทัศนศึกษา · 10 ส.ค. 2569 เวลา 13:00–15:00 · เหตุผล: เลื่อนกิจกรรมออกไปก่อน · ช่วงเวลานี้ว่างให้จัดสรรคิวอื่นแล้ว',
      actionLabel: 'ดูคำขอจอง',
      actionUrl: GO.requests,
    },
  },
  {
    days: 2, // nt-6, UC-F2
    input: {
      category: FEEDBACK,
      tone: ROSE,
      icon: 'exclamation-triangle',
      targetRole: ALL,
      title: 'แจ้งปัญหาเร่งด่วนระหว่างใช้งานจริง',
      body: 'ห้องประชุมเล็ก 2 · เครื่องปรับอากาศไม่ทำงาน · แจ้งโดย มานพ เกิดผล · ผู้ช่วยผู้อำนวยการ · ฝ่ายวิชาการ · ติดต่อ 081-445-9920',
      actionLabel: 'ดูเรื่องที่แจ้ง',
      actionUrl: GO.feedback,
    },
  },
  {
    days: 2, // nt-7, UC-B5
    input: {
      category: BOOKING,
      tone: EMERALD,
      icon: 'check',
      targetRole: ALL,
      code: 'RQ-2569-0182',
      title: 'เจ้าหน้าที่บันทึกการจองแทน 1 รายการ',
      body: 'RQ-2569-0182 · หอประชุม · 18 ส.ค. 2569 เวลา 08:30–12:00 · ทำรายการโดย ศิริพร ทองใบ · เจ้าหน้าที่ · ฝ่ายกิจการนักศึกษา',
      actionLabel: 'ดูคำขอจอง',
      actionUrl: GO.requests,
    },
  },
  {
    days: 3, // nt-8, UC-U2
    input: {
      category: REGISTRATION,
      tone: AMBER,
      icon: 'arrow-path',
      targetRole: ADMIN,
      title: 'ผู้ใช้ส่งข้อมูลรอบแก้ไขกลับมาแล้ว',
      body: 'ธนวัฒน์ ศรีบุญ · เจ้าหน้าที่ · ฝ่ายบริหารงานทั่วไป · แก้ไขตามเหตุผลที่ส่งคืนเมื่อ 7 ส.ค. 2569 (เบอร์ติดต่อไม่ถูกต้อง)',
      actionLabel: 'ตรวจสอบข้อมูล',
      actionUrl: GO.registrations,
    },
  },
  {
    days: 3, // nt-9, UC-C3
    input: {
      category: SYSTEM,
      tone: AMBER,
      icon: 'building-office',
      targetRole: ALL,
      title: 'ปิดสถานที่ชั่วคราวฉุกเฉิน',
      body: 'โรงยิม 1 · เหตุผล: ซ่อมระบบไฟฟ้า ปิดถึง 20 ส.ค. 2569 · ดำเนินการโดย ธนกร แสงจันทร์ · เจ้าหน้าที่ · ฝ่ายอาคารสถานที่',
      actionLabel: 'ดูสถานที่',
      actionUrl: GO.venues,
    },
  },
  {
    days: 4, // nt-10, UC-B4
    input: {
      category: BOOKING,
      tone: ROSE,
      icon: 'queue-list',
      targetRole: ADMIN,
      code: 'RQ-2569-0175',
      title: 'ระบบปฏิเสธคำขอที่เวลาชนกันอัตโนมัติ 3 รายการ',
      body: 'หลังอนุมัติ RQ-2569-0175 · ปฏิเสธ RQ-2569-0176, RQ-2569-0178, RQ-2569-0179 · ห้องประชุมใหญ่ · 14 ส.ค. 2569 เวลา 09:00–12:00',
      actionLabel: 'ดูคำขอจอง',
      actionUrl: GO.requests,
    },
  },
  {
    days: 4, // nt-11, UC-F1
    input: {
      category: FEEDBACK,
      tone: SKY,
      icon: 'chat-bubble',
      targetRole: ADMIN,
      title: 'ได้รับข้อเสนอแนะใหม่ 1 เรื่อง',
      body: 'อารีย์ สุขใจ · เจ้าหน้าที่ · ฝ่ายวิชาการ · หัวข้อ: อยากให้เปิดจองช่วงเย็นหลัง 16:30 · หมวด: ข้อเสนอแนะการใช้งาน',
      actionLabel: 'ดูเรื่องที่แจ้ง',
      actionUrl: GO.feedback,
    },
  },
  {
    days: 5, // nt-12, UC-B3
    input: {
      category: BOOKING,
      tone: AMBER,
      icon: 'clock',
      targetRole: ADMIN,
      code: 'RQ-2569-0166',
      title: 'คำขอหมดอายุอัตโนมัติ 1 รายการ',
      body: 'RQ-2569-0166 · สนามกีฬากลาง · เลยเวลาเริ่ม 7 ส.ค. 2569 เวลา 13:00 โดยยังไม่มีการพิจารณา · ตรวจสอบคอขวดในการอนุมัติ',
      actionLabel: 'ดูคำขอจอง',
      actionUrl: GO.requests,
    },
  },
  {
    days: 5, // nt-13, UC-C5
    input: {
      category: SYSTEM,
      tone: ROSE,
      icon: 'bug-ant',
      targetRole: SUPER_ADMIN,
      code: 'ERR-500-0142',
      title: 'พบข้อผิดพลาดร้ายแรงของระบบ',
      body: 'ERR-500-0142 · BookingService · Database deadlock ขณะยืนยันคำขอจองพร้อมกัน 2 รายการ',
      actionLabel: 'ดูบันทึกข้อผิดพลาด',
      actionUrl: GO.errorLog,
    },
  },
  {
    days: 6, // nt-14, UC-U3
    input: {
      category: REGISTRATION,
      tone: SLATE,
      icon: 'user-minus',
      targetRole: SUPER_ADMIN,
      title: 'ผู้ใช้ยกเลิกการติดตาม LINE OA',
      body: 'สุมาลี พงษ์เจริญ · ครูชำนาญการพิเศษ · กลุ่มสาระการเรียนรู้คณิตศาสตร์ · สิทธิ์เดิม: อนุมัติแล้ว · ยังมีคำขอจองค้างอยู่ 1 รายการ',
      actionLabel: 'ดูข้อมูลผู้ใช้',
      actionUrl: GO.registrations,
    },
  },
  {
    days: 15, // nt-15, UC-C4
    input: {
      category: SYSTEM,
      tone: SLATE,
      icon: 'adjustments-horizontal',
      targetRole: ADMIN,
      title: 'แก้ไขการตั้งค่าระบบการจอง',
      body: 'เกณฑ์เวลายกเลิกการจองล่วงหน้า 30 นาที → 60 นาที · แก้ไขโดย เชิดศักดิ์ คำไล้ · ผู้ดูแลระบบ · ฝ่ายเทคโนโลยีสารสนเทศ',
      actionLabel: 'ไปที่หน้าตั้งค่า',
      actionUrl: GO.bookingSettings,
    },
  },
  {
    days: 68, // nt-16, UC-C2
    input: {
      category: SYSTEM,
      tone: EMERALD,
      icon: 'sparkles',
      targetRole: ALL,
      title: 'อัปเดตระบบเป็นเวอร์ชัน v0.7.0',
      body: 'เพิ่มหน้าจัดการคำขอจองและตัวกรองสถานที่ · แก้ไขการแจ้งเตือนซ้ำเมื่ออนุมัติต่อเนื่อง · รีเฟรชหน้าจอเพื่อใช้งานฟีเจอร์ใหม่',
      actionLabel: 'ดูรายละเอียดเวอร์ชัน',
      actionUrl: GO.version,
    },
  },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    logger.error(
      'Refusing to seed sample notifications with NODE_ENV=production.',
    );
    process.exit(1);
  }

  // Validate EVERY row before writing ANY — a bad row must not leave half a seed behind.
  const rows = ROWS.map((row, index) => ({
    id: seedId(index + 1),
    days: row.days,
    index,
    data: normaliseCreateInput(row.input),
  }));

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const now = Date.now();
    let created = 0;
    for (const row of rows) {
      // `days` whole days back, minus one minute per position: rows sharing a `days` keep the
      // prototype's newest-first order instead of tying and falling back to `id DESC` (reversed).
      const createdAt = new Date(
        now - row.days * DAY_MS - row.index * MINUTE_MS,
      );
      const existed = await prisma.adminNotification.findUnique({
        where: { id: row.id },
        select: { id: true },
      });
      await prisma.adminNotification.upsert({
        where: { id: row.id },
        create: { id: row.id, ...row.data, createdAt },
        update: { ...row.data, createdAt },
      });
      if (!existed) created += 1;
    }
    logger.log(
      `Seeded admin notifications. created=${created} refreshed=${rows.length - created} total=${rows.length} (receipts untouched).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  logger.error(
    `Seeding admin notifications failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
