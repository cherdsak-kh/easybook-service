import type { messagingApi } from '@line/bot-sdk';

/**
 * `CLIENT-NOTIFY-1` — the booking notification cards: Flex Messages pushed to the LINE user who owns
 * a booking when its status changes (Decisions & Lifecycle) and shortly before a slot starts
 * (Reminders).
 *
 * 🔴 THE DESIGN AUTHORITY IS `docs/prototypes/client-portal/line_notification_rich_cards_spec.md`.
 * Every Thai string, colour and CTA below is copied from it. Change the spec first, then this file.
 *
 * Pure functions, no I/O, no Prisma, no config: the caller supplies the formatted date/period text and
 * `LINE_LIFF_URL`. Same construction and the same palette as `access-card.ts`, whose comments carry
 * the reasoning behind the amber-with-dark-ink rule and the slate surface tokens.
 */

export type DecisionCardStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'AUTO_REJECTED'
  | 'EXPIRED'
  | 'CANCELLED_BY_STAFF'
  | 'CANCELLED_BY_USER'
  | 'SLOT_AVAILABLE';

export interface DecisionCardOptions {
  status: DecisionCardStatus;
  bookingCode: string;
  purpose?: string;
  attendees?: number;
  venueName: string;
  venueLocation?: string;
  dateText: string;
  /**
   * A ONE-LINE summary of `dateText` for the chat-list preview (`altText`) — e.g.
   * `"18 ก.ย. 2569 - 25 ก.ย. 2569 (รวม 5 วัน)"` where `dateText` is a 5-line bulleted list.
   * Built by `describeSlots` (`src/bookings/booking-notifier.ts`), which owns the Thai date format.
   *
   * Optional: when it is absent the altText falls back to a flattened `dateText`, which is correct
   * for a single date and merely terse for many. See {@link toAltText}.
   */
  dateSummary?: string;
  periodText: string;
  /**
   * The operator's reason. Rendered for `REJECTED` and `CANCELLED_BY_STAFF` only.
   * 🔴 IGNORED FOR `AUTO_REJECTED` (`D-C13`), whatever the caller passes.
   */
  reason?: string;
  bookingId?: string;
  venueId?: string;
  liffUrl?: string | null;
}

export interface ReminderCardOptions {
  leadTimeText: '1 ชั่วโมง' | '30 นาที';
  bookingCode: string;
  purpose: string;
  attendees: number;
  venueName: string;
  venueLocation?: string;
  dateText: string;
  periodText: string;
}

/** Spec §1.1: the five status tokens. WARNING carries dark ink; see `access-card.ts` `TONE`. */
const TONE = {
  SUCCESS: { fill: '#047857', ink: '#ffffff' }, // emerald-700
  WARNING: { fill: '#f59e0b', ink: '#0f172a' }, // amber-500 + slate-900
  INFO: { fill: '#0369a1', ink: '#ffffff' }, // sky-700
  ERROR: { fill: '#be123c', ink: '#ffffff' }, // rose-700
  NEUTRAL: { fill: '#334155', ink: '#ffffff' }, // slate-700
} as const;

type Tone = (typeof TONE)[keyof typeof TONE];

/** Spec §1.1: eyebrow at 75% of the headline ink (8-digit hex; Flex text has no opacity). */
const EYEBROW_ALPHA = 'bf';

/** Spec §1.2. */
const INK = '#0f172a'; // slate-900
const INK_SOFT = '#475569'; // slate-600
const SURFACE_SOFT = '#f1f5f9'; // slate-100
const LINE_SOFT = '#e2e8f0'; // slate-200

/**
 * Spec §1.4 `AUTO_REJECTED_REASON` — the ONLY explanation an auto-rejected requester is given.
 *
 * 🔴 `D-C13`: it names no winner and no purpose. The stored `rejectReason` is never read into this
 * card, so a future change to that column's wording cannot leak through a notification either.
 */
export const AUTO_REJECTED_NOTICE = 'ช่วงเวลาดังกล่าวมีผู้ได้รับสิทธิ์แล้ว';

/**
 * LIFF deep-link PATHS the CTAs open, appended to `LINE_LIFF_URL`.
 *
 * 🔴 PATHS, NEVER HASH ROUTES. `easybook-app` runs an HTML5 `BrowserRouter`: a `#/booking/:id` link
 * reaches the SPA as its root path and the router lands on `/home`. LIFF forwards the path after
 * `https://liff.line.me/{liffId}` onto the LIFF app's endpoint URL, so that endpoint must be the SPA
 * root (see `.env.example`).
 *
 * ⚠️ DEVIATION FROM THE SPEC, ON PURPOSE: the spec writes `#/venues/:venueId` and
 * `#/booking/new?venueId=:id`, but `easybook-app`'s `ClientRoutes.tsx` serves neither. Its venue
 * detail (where a new request starts) is `/venue/:id`. A dead deep link would open the app on its
 * not-found screen, so the real routes are used here. Recorded in `03_implement_log.md`.
 */
const bookingRoute = (o: DecisionCardOptions): string | null =>
  o.bookingId ? `/booking/${encodeURIComponent(o.bookingId)}` : null;
const venueRoute = (o: DecisionCardOptions): string | null =>
  o.venueId ? `/venue/${encodeURIComponent(o.venueId)}` : null;
const venuesRoute = (): string => '/venues';

/**
 * LINE's hard limit on a Flex message's `altText`. A longer value is not truncated by LINE — the
 * whole push is rejected with HTTP 400 and the user silently receives NO card.
 */
export const ALT_TEXT_MAX_CHARS = 400;

const ELLIPSIS = '…';

/**
 * 🔴 THE ONE CHOKE POINT EVERY `altText` IN THIS FILE GOES THROUGH. Both builders return
 * `altText: toAltText(…)`, so no field added to a template later can breach either rule:
 *
 * 1. **One line.** `altText` is the chat-list preview and the notification banner. `dateText` is a
 *    bulleted, newline-separated list for a multi-day booking (`describeSlots`) — right in the
 *    bubble, wrong in a preview. Bullets and every run of whitespace collapse to a single space.
 * 2. **At most {@link ALT_TEXT_MAX_CHARS} characters**, ellipsis included. This is a defensive
 *    backstop, not the design: callers pass `dateSummary`, so a real card lands far under the cap
 *    (a 60-date booking is ~150 characters). It exists so an unbounded venue name or a future field
 *    degrades the preview instead of dropping the whole notification.
 */
export function toAltText(raw: string): string {
  const flat = raw.replace(/[•\s]+/g, ' ').trim();
  if (flat.length <= ALT_TEXT_MAX_CHARS) return flat;

  const cut = flat.slice(0, ALT_TEXT_MAX_CHARS - ELLIPSIS.length);
  // Never leave half a surrogate pair behind (an emoji in a venue name).
  const whole = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${whole.trimEnd()}${ELLIPSIS}`;
}

interface DecisionCopy {
  tone: Tone;
  eyebrow: string;
  headline: string;
  intro: string;
  /** `null` = no booking box (SLOT_AVAILABLE shows the venue box only). */
  codeLabel: 'รหัสคำขอ' | 'รหัสการจอง' | null;
  /** Present only where an operator-typed reason is shown. */
  reasonLabel?: string;
  footnote?: string;
  cta: {
    label: string;
    color: string;
    route: (o: DecisionCardOptions) => string | null;
  };
  altText: (o: DecisionCardOptions, when: string) => string;
}

const DECISION_COPY: Record<DecisionCardStatus, DecisionCopy> = {
  // Use Case 1.1
  PENDING: {
    tone: TONE.WARNING,
    eyebrow: 'สถานะคำขอจองสถานที่',
    headline: 'ยื่นคำขอสำเร็จ (รอการพิจารณา)',
    intro:
      'ระบบได้รับคำขอจองสถานที่ของคุณเรียบร้อยแล้ว เจ้าหน้าที่จะดำเนินการตรวจสอบและแจ้งผลให้ทราบอีกครั้ง',
    codeLabel: 'รหัสคำขอ',
    cta: { label: 'ดูรายละเอียดคำขอจอง', color: INK, route: bookingRoute },
    altText: (o, when) =>
      `ยื่นคำขอจองสำเร็จ: ${o.venueName} วันที่ ${when} (รหัส ${o.bookingCode}) อยู่ระหว่างรอพิจารณา`,
  },
  // Use Case 1.2
  APPROVED: {
    tone: TONE.SUCCESS,
    eyebrow: 'ผลการพิจารณาคำขอจอง',
    headline: 'อนุมัติคำขอแล้ว',
    intro: 'คำขอจองสถานที่ของคุณได้รับการอนุมัติเรียบร้อยแล้ว',
    codeLabel: 'รหัสการจอง',
    cta: {
      label: 'ดูรายละเอียดคำขอจอง',
      color: TONE.SUCCESS.fill,
      route: bookingRoute,
    },
    altText: (o, when) =>
      `อนุมัติคำขอจอง: ${o.venueName} วันที่ ${when} (รหัส ${o.bookingCode})`,
  },
  // Use Case 1.3
  REJECTED: {
    tone: TONE.ERROR,
    eyebrow: 'ผลการพิจารณาคำขอจอง',
    headline: 'คำขอไม่ได้รับอนุมัติ',
    intro: 'ขออภัย คำขอจองสถานที่ของคุณไม่ผ่านการอนุมัติ',
    codeLabel: 'รหัสคำขอ',
    reasonLabel: 'เหตุผลประกอบ',
    cta: { label: 'เลือกจองช่วงเวลาอื่น', color: INK, route: venueRoute },
    altText: (o, when) =>
      `คำขอจองไม่ผ่านการอนุมัติ: ${o.venueName} วันที่ ${when}`,
  },
  // Use Case 1.4 — 🔴 D-C13: no `reasonLabel`, so `reason` is never rendered.
  AUTO_REJECTED: {
    tone: TONE.INFO,
    eyebrow: 'แจ้งเตือนสถานะช่วงเวลา',
    headline: AUTO_REJECTED_NOTICE,
    intro:
      'ขออภัย ช่วงเวลาที่คุณส่งคำขอมีผู้ได้รับอนุมัติสิทธิ์การใช้งานแล้ว ระบบจึงทำการยกเลิกคำขอของคุณโดยอัตโนมัติ',
    codeLabel: 'รหัสคำขอ',
    footnote: 'คุณสามารถเลือกดูตารางและยื่นคำขอในช่วงเวลาอื่นได้ทันที',
    cta: {
      label: 'ค้นหาช่วงเวลาอื่นที่ว่าง',
      color: TONE.INFO.fill,
      route: venueRoute,
    },
    altText: (o, when) =>
      `ช่วงเวลา ${when} ${o.venueName} มีผู้ได้รับสิทธิ์แล้ว ระบบจึงยกเลิกคำขอของคุณ`,
  },
  // Use Case 1.5
  EXPIRED: {
    tone: TONE.NEUTRAL,
    eyebrow: 'ผลการพิจารณาคำขอจอง',
    headline: 'หมดเวลาพิจารณา',
    intro:
      'คำขอจองสถานที่ของคุณหมดอายุโดยอัตโนมัติ เนื่องจากเลยกำหนดเวลาเริ่มต้นใช้งานโดยยังไม่ได้รับการพิจารณา',
    codeLabel: 'รหัสคำขอ',
    footnote: 'หากยังต้องการใช้งานสถานที่ กรุณายื่นคำขอใหม่อีกครั้ง',
    cta: {
      label: 'เลือกจองช่วงเวลาอื่น',
      color: TONE.NEUTRAL.fill,
      route: venueRoute,
    },
    altText: (o, when) =>
      `คำขอจองหมดเวลาพิจารณา: ${o.venueName} วันที่ ${when} (รหัส ${o.bookingCode})`,
  },
  // Use Case 1.6
  CANCELLED_BY_STAFF: {
    tone: TONE.ERROR,
    eyebrow: 'แจ้งเตือนการยกเลิกการจอง',
    headline: 'การจองของคุณถูกยกเลิกโดยเจ้าหน้าที่',
    intro:
      'ขออภัย รายการจองสถานที่ของคุณที่ได้รับการอนุมัติแล้วจำเป็นต้องถูกยกเลิกเนื่องจากเหตุจำเป็น',
    codeLabel: 'รหัสการจอง',
    reasonLabel: 'เหตุผลการยกเลิก',
    cta: { label: 'ดูรายละเอียดคำขอจอง', color: INK, route: bookingRoute },
    altText: (o, when) =>
      `การจองของคุณถูกยกเลิก: ${o.venueName} วันที่ ${when} โดยเจ้าหน้าที่`,
  },
  // Use Case 1.7
  CANCELLED_BY_USER: {
    tone: TONE.NEUTRAL,
    eyebrow: 'แจ้งเตือนการยกเลิกการจอง',
    headline: 'ยกเลิกรายการจองสำเร็จแล้ว',
    intro:
      'คุณได้ทำการยกเลิกรายการจองสถานที่เรียบร้อยแล้ว ระบบได้ทำการคืนช่วงเวลาดังกล่าวให้ผู้อื่นสามารถจองได้แล้ว',
    codeLabel: 'รหัสคำขอ',
    cta: {
      label: 'ค้นหาสถานที่เพื่อจองใหม่',
      color: TONE.NEUTRAL.fill,
      route: venuesRoute,
    },
    altText: (o, when) =>
      `ยกเลิกการจองสำเร็จ: ${o.venueName} วันที่ ${when} (รหัส ${o.bookingCode})`,
  },
  // Use Case 1.8
  SLOT_AVAILABLE: {
    tone: TONE.SUCCESS,
    eyebrow: 'แจ้งเตือนสล็อตว่าง',
    headline: 'ช่วงเวลานี้เปิดให้จองอีกครั้ง',
    intro:
      'ช่วงเวลาที่คุณเคยให้ความสนใจเปิดว่างแล้วในขณะนี้ หากยังต้องการใช้งาน สามารถส่งคำขอจองใหม่ได้ทันที',
    codeLabel: null,
    cta: {
      label: 'ส่งคำขอจองทันที',
      color: TONE.SUCCESS.fill,
      route: venueRoute,
    },
    altText: (o, when) =>
      `ช่วงเวลา ${when} ${o.venueName} เปิดให้จองได้อีกครั้ง`,
  },
};

const text = (
  content: string,
  extra: Partial<messagingApi.FlexText> = {},
): messagingApi.FlexText => ({
  type: 'text',
  text: content,
  wrap: true,
  ...extra,
});

/** A label/value line. LINE rejects an empty `text`, so callers drop rows with no value. */
const row = (label: string, value: string): messagingApi.FlexBox => ({
  type: 'box',
  layout: 'baseline',
  spacing: 'sm',
  contents: [
    text(label, { size: 'sm', color: INK_SOFT, flex: 3 }),
    text(value, { size: 'sm', color: INK, flex: 7 }),
  ],
});

const present = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** Spec §1.3: the grey data box (`SURFACE_SOFT`). */
const section = (
  title: string,
  rows: messagingApi.FlexBox[],
): messagingApi.FlexBox => ({
  type: 'box',
  layout: 'vertical',
  backgroundColor: SURFACE_SOFT,
  cornerRadius: '8px',
  paddingAll: '12px',
  margin: 'lg',
  spacing: 'sm',
  contents: [
    text(title, { size: 'xs', color: INK_SOFT, weight: 'bold' }),
    ...rows,
  ],
});

/** Box 1 — ข้อมูลการจอง. */
const bookingSection = (
  codeLabel: string,
  o: { bookingCode: string; purpose?: string; attendees?: number },
): messagingApi.FlexBox => {
  const rows = [row(codeLabel, o.bookingCode)];
  if (present(o.purpose)) rows.push(row('วัตถุประสงค์', o.purpose));
  if (typeof o.attendees === 'number') {
    rows.push(row('ผู้เข้าร่วม', `${o.attendees} คน`));
  }
  return section('ข้อมูลการจอง', rows);
};

/** Box 2 — ข้อมูลสถานที่. */
const venueSection = (
  dateLabel: string,
  o: {
    venueName: string;
    venueLocation?: string;
    dateText: string;
    periodText: string;
  },
): messagingApi.FlexBox => {
  const rows = [row('สถานที่', o.venueName)];
  if (present(o.venueLocation)) rows.push(row('อาคาร/พิกัด', o.venueLocation));
  rows.push(row(dateLabel, o.dateText), row('ช่วงเวลา', o.periodText));
  return section('ข้อมูลสถานที่', rows);
};

const header = (
  tone: Tone,
  eyebrow: string,
  headline: string,
): messagingApi.FlexBox => ({
  type: 'box',
  layout: 'vertical',
  backgroundColor: tone.fill,
  paddingAll: '16px',
  spacing: 'xs',
  contents: [
    text(eyebrow, { size: 'xs', color: tone.ink + EYEBROW_ALPHA }),
    text(headline, { size: 'lg', weight: 'bold', color: tone.ink }),
  ],
});

/**
 * Build the Decisions & Lifecycle card (spec §2).
 *
 * Fail-soft CTA (spec §1.5): the footer exists only when `liffUrl` is set AND the route it needs can
 * be resolved (a booking route without `bookingId`, a venue route without `venueId`).
 */
export function buildDecisionCard(
  options: DecisionCardOptions,
): messagingApi.FlexMessage {
  const copy = DECISION_COPY[options.status];
  // 🔴 THE PREVIEW TAKES `dateSummary`, THE BUBBLE TAKES `dateText`. `when` feeds the altText
  // templates only; the `วันที่ใช้งาน` row below still renders the full bulleted list.
  const when = `${options.dateSummary ?? options.dateText} ${options.periodText}`;

  const body: messagingApi.FlexComponent[] = [
    text(copy.intro, { size: 'sm', color: INK, lineSpacing: '6px' }),
  ];
  if (copy.codeLabel) body.push(bookingSection(copy.codeLabel, options));
  body.push(venueSection('วันที่ใช้งาน', options));

  // 🔴 Gated on the COPY, never on the status string alone: AUTO_REJECTED has no `reasonLabel`, so a
  // reason passed in by mistake still cannot reach the card (D-C13).
  if (copy.reasonLabel && present(options.reason)) {
    body.push({
      type: 'box',
      layout: 'vertical',
      borderColor: LINE_SOFT,
      borderWidth: '1px',
      cornerRadius: '8px',
      paddingAll: '12px',
      margin: 'lg',
      spacing: 'sm',
      contents: [
        text('เหตุผลจากเจ้าหน้าที่', {
          size: 'xs',
          color: INK_SOFT,
          weight: 'bold',
        }),
        text(copy.reasonLabel, { size: 'xs', color: INK_SOFT }),
        text(options.reason, { size: 'sm', color: INK, lineSpacing: '6px' }),
      ],
    });
  }

  if (copy.footnote) {
    body.push(
      text(copy.footnote, { size: 'sm', color: INK_SOFT, margin: 'lg' }),
    );
  }

  const bubble: messagingApi.FlexBubble = {
    type: 'bubble',
    header: header(copy.tone, copy.eyebrow, copy.headline),
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      contents: body,
    },
  };

  const route = copy.cta.route(options);
  if (options.liffUrl && route) {
    bubble.footer = {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      paddingTop: 'none',
      contents: [
        {
          type: 'button',
          style: 'primary',
          height: 'sm',
          color: copy.cta.color,
          action: {
            type: 'uri',
            label: copy.cta.label,
            // One trailing `/` on the base is dropped, so `…/abc/` + `/booking/x` never yields `//`.
            uri: options.liffUrl.replace(/\/$/, '') + route,
          },
        },
      ],
    };
  }

  return {
    type: 'flex',
    altText: toAltText(copy.altText(options, when)),
    contents: bubble,
  };
}

/**
 * Build the pre-usage reminder card (spec §3, Use Case 2.1).
 *
 * Pure informational: NO footer and NO button, ever. There is deliberately no `liffUrl` parameter.
 */
export function buildReminderCard(
  options: ReminderCardOptions,
): messagingApi.FlexMessage {
  const bubble: messagingApi.FlexBubble = {
    type: 'bubble',
    header: header(
      TONE.WARNING,
      'เตือนความจำการใช้งาน',
      'ใกล้ถึงเวลาเข้าใช้งานแล้ว',
    ),
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      contents: [
        text(
          `รายการจองสถานที่ของคุณใกล้จะเริ่มต้นในอีก ${options.leadTimeText}`,
          { size: 'sm', color: INK, lineSpacing: '6px' },
        ),
        bookingSection('รหัสการจอง', options),
        venueSection('วันที่', options),
        text('เมื่อถึงเวลาตามกำหนด คุณสามารถเข้าใช้งานสถานที่ได้ทันที', {
          size: 'sm',
          color: INK_SOFT,
          margin: 'lg',
        }),
      ],
    },
  };

  return {
    type: 'flex',
    altText: toAltText(
      `เตือนความจำ: ใกล้ถึงเวลาเข้าใช้สถานที่ ${options.venueName} เวลา ${options.periodText}`,
    ),
    contents: bubble,
  };
}
