import { SystemRole } from '@prisma/client';

/**
 * Constants for `POST /system/support/incident` — the Discord incident relay (design §2.2 / §2.9).
 * `support-*` naming on purpose: `src/incidents/` is the unrelated Hub 6 error-log pipeline.
 */

export const SUPPORT_CATEGORIES = [
  'web',
  'line',
  'booking',
  'access',
  'other',
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_SEVERITIES = ['normal', 'urgent', 'critical'] as const;
export type SupportSeverity = (typeof SUPPORT_SEVERITIES)[number];

export const SUPPORT_PATH_MAX = 200;
/** Counted AFTER trim. Refused, never truncated, on input. */
export const SUPPORT_DESCRIPTION_MAX = 1000;
/** Input cap; the message builder truncates further to fit Discord's 2000-char `content`. */
export const SUPPORT_DIAGNOSTICS_MAX = 2000;
export const SUPPORT_FILES_MAX = 3;
export const SUPPORT_FILE_MAX_BYTES = 5 * 1024 * 1024;
/**
 * What multer is handed: the INCLUSIVE maximum. multer >= 2.4.0 adds busboy's `+ 1` internally, so a
 * file of exactly 5 MiB is accepted and 5 MiB + 1 is rejected. Do NOT add `+ 1` here.
 */
export const SUPPORT_FILE_MULTER_SIZE_LIMIT = SUPPORT_FILE_MAX_BYTES;
/** Total of all file bytes: 10 MiB (Discord's unboosted default) minus 0.5 MiB for JSON + framing. */
export const SUPPORT_DISCORD_UPLOAD_BUDGET_BYTES = 9.5 * 1024 * 1024;
export const SUPPORT_RELAY_TIMEOUT_MS = 10_000;
export const SUPPORT_RATE_LIMIT = 5;
export const SUPPORT_RATE_WINDOW_SECONDS = 600;
/** First code is INC-1001 (the prototype shows INC-104x). */
export const SUPPORT_CODE_OFFSET = 1000;
export const SUPPORT_BOT_USERNAME = 'EasyBook Incident Bot';
/** Discord's hard limit on a message's `content`. */
export const DISCORD_CONTENT_MAX = 2000;
/** Shown when the session user has no phone number on file. */
export const SUPPORT_PHONE_FALLBACK = 'ไม่ได้ระบุ';
/** Defensive caps on session-sourced strings so the fixed part of the message stays bounded. */
export const SUPPORT_REPORTER_NAME_MAX = 100;
export const SUPPORT_PHONE_MAX = 40;

/** The env var NAME. Its value is a credential and must never be logged, thrown or documented. */
export const SUPPORT_WEBHOOK_ENV = 'DISCORD_SUPPORT_WEBHOOK_URL';

export const SUPPORT_CATEGORY_LABEL: Record<SupportCategory, string> = {
  web: 'บั๊กหน้าเว็บ',
  line: 'การเชื่อมต่อ LINE',
  booking: 'การจองและปฏิทิน',
  access: 'สิทธิ์การใช้งาน',
  other: 'อื่นๆ',
};

export const SUPPORT_SEVERITY_LABEL: Record<SupportSeverity, string> = {
  normal: 'ปกติ',
  urgent: 'เร่งด่วน',
  critical: 'วิกฤต',
};

/** Mirrors `easybook-app/src/admin-portal/labels.ts` `ROLE_LABEL`. */
export const SUPPORT_ROLE_LABEL: Record<SystemRole, string> = {
  [SystemRole.SUPER_ADMIN]: 'ผู้ดูแลระบบสูงสุด',
  [SystemRole.ADMIN]: 'เจ้าหน้าที่ดูแลระบบ',
  [SystemRole.VIEWER]: 'ผู้ดูข้อมูล',
};

/** The emoji at the end of the message heading (revision 2: Markdown `content`, no embed). */
export const SUPPORT_SEVERITY_EMOJI: Record<SupportSeverity, string> = {
  normal: '🔵',
  urgent: '🟡',
  critical: '🔴',
};

export interface SupportSeverityPing {
  /** First line of `content`, without the trailing newline. Empty = no ping line. */
  line: string;
  /** `allowed_mentions.parse` — `everyone` ONLY for critical (it is what enables `@here`). */
  parse: Array<'everyone'>;
}

export const SUPPORT_SEVERITY_PING: Record<
  SupportSeverity,
  SupportSeverityPing
> = {
  normal: { line: '', parse: [] },
  // `@Tech Support` is plain text and pings nobody (SUPPORT-ROLE-PING-1).
  urgent: { line: '@Tech Support', parse: [] },
  critical: { line: '@here', parse: ['everyone'] },
};

export const SUPPORT_ERROR_CODES = [
  'SUPPORT_NOT_CONFIGURED',
  'SUPPORT_RELAY_FAILED',
  'SUPPORT_RATE_LIMITED',
  'SUPPORT_FILE_TYPE_UNSUPPORTED',
  'SUPPORT_FILE_TOO_LARGE',
  'SUPPORT_ATTACHMENTS_TOO_LARGE',
] as const;
export type SupportErrorCode = (typeof SUPPORT_ERROR_CODES)[number];

export const SUPPORT_NOT_CONFIGURED_MSG =
  'ระบบแจ้งปัญหายังไม่พร้อมใช้งาน กรุณาติดต่อทีมพัฒนาผ่าน Discord';
export const SUPPORT_RELAY_FAILED_MSG =
  'ส่งแจ้งปัญหาถึงทีมพัฒนาไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หรือติดต่อทีมพัฒนาผ่าน Discord';
export const SUPPORT_RATE_LIMITED_MSG =
  'ส่งแจ้งปัญหาบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่';
export const SUPPORT_FILE_TYPE_MSG =
  'ไฟล์แนบต้องเป็นภาพ PNG, JPG หรือ WEBP เท่านั้น';
export const SUPPORT_FILE_TOO_LARGE_MSG =
  'ไฟล์ภาพแต่ละไฟล์ต้องมีขนาดไม่เกิน 5 MB';
export const SUPPORT_ATTACHMENTS_TOO_LARGE_MSG =
  'ภาพหน้าจอรวมกันมีขนาดใหญ่เกินกว่าที่ส่งถึงทีมพัฒนาได้ กรุณาลดจำนวนหรือขนาดภาพแล้วลองใหม่';
