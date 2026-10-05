import type { SystemRole } from '@prisma/client';
import {
  DISCORD_CONTENT_MAX,
  SUPPORT_BOT_USERNAME,
  SUPPORT_CATEGORY_LABEL,
  SUPPORT_PATH_MAX,
  SUPPORT_PHONE_FALLBACK,
  SUPPORT_PHONE_MAX,
  SUPPORT_REPORTER_NAME_MAX,
  SUPPORT_ROLE_LABEL,
  SUPPORT_SEVERITY_EMOJI,
  SUPPORT_SEVERITY_LABEL,
  SUPPORT_SEVERITY_PING,
  type SupportCategory,
  type SupportSeverity,
} from './support.constants';

/**
 * Pure builder for Discord's execute-webhook `payload_json` (revision 2). No Nest, no I/O, so it is
 * unit-tested directly.
 *
 * The message is a Markdown `content` and `embeds` is always `[]`: with no embed, Discord groups every
 * multipart attachment into its native gallery under the message (INC-1147 showed that an embed binds
 * only the first image and floats the rest above it).
 *
 * User text can no longer hide in an embed, so it is sanitised before it is interpolated: CRLF is
 * normalised, a run of three backticks cannot close a fence, `||` cannot break a spoiler, single-line
 * fields cannot span lines. `allowed_mentions` is the real guard against pings (`@everyone` inside a
 * code block never renders, and `parse` is `[]` except for critical).
 *
 * HARD INVARIANT: `content.length <= 2000`. Discord counts characters; a JS string's `length` counts
 * UTF-16 code units, which is always >= the number of code points, so staying under 2000 code units
 * satisfies either counting rule.
 */

export interface SupportPayloadFile {
  /** Server-generated (`screenshot-N.ext`), never the client's `originalname`. */
  filename: string;
}

export interface SupportPayloadInput {
  code: string;
  category: SupportCategory;
  severity: SupportSeverity;
  /** From the SESSION. `diagnostics` is never parsed for it. */
  role: SystemRole;
  /** From the SESSION, never the request body. Blank/absent renders as an em dash. */
  reporterName?: string;
  /** From the SESSION. Blank/absent/null renders as `ไม่ได้ระบุ`. */
  phoneNumber?: string | null;
  path: string;
  description: string;
  diagnostics?: string;
  timestamp: Date;
  files: SupportPayloadFile[];
}

export interface DiscordPayload {
  username: string;
  content: string;
  tts: boolean;
  flags: number;
  embeds: unknown[];
  components: unknown[];
  allowed_mentions: { parse: string[] };
  attachments: Array<{ id: number; filename: string }>;
}

const EMPTY = '—';
const ELLIPSIS = '…';
const ZWSP = '​';
/** Hangul filler: renders as blank space but is not whitespace, so Discord keeps the separator line. */
const SEPARATOR = 'ㅤ';
const FENCE = '`'.repeat(3);

const THAI_MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
] as const;

/** Truncates to at most `max` UTF-16 units, ending in `…`, never leaving half a surrogate pair. */
export function truncateText(value: string, max: number): string {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  let cut = value.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + ELLIPSIS;
}

/** `\r\n` / `\r` -> `\n` (a browser's FormData sends CRLF), and a run of 3+ backticks can't close a fence. */
function sanitizeBlock(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/`{3,}/g, (run) => run.split('').join(ZWSP));
}

/** For fields rendered as ```value``` on one line: no newline, and no backtick touching the fence. */
function sanitizeInline(value: string): string {
  let out = sanitizeBlock(value).replace(/\n+/g, ' ').trim();
  if (out.startsWith('`')) out = ZWSP + out;
  if (out.endsWith('`')) out += ZWSP;
  return out;
}

/** The spoiler fields: inline rules, plus `||` can never appear (it would close the spoiler). */
function sanitizeSpoiler(value: string): string {
  return sanitizeInline(value).replace(/\|(?=\|)/g, `|${ZWSP}`);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Asia/Bangkok is UTC+7 with no DST: shift explicitly and read UTC getters, independent of machine TZ. */
function bangkokParts(at: Date): {
  day: number;
  month: string;
  buddhistYear: number;
  hh: string;
  mm: string;
} {
  const shifted = new Date(at.getTime() + 7 * 60 * 60 * 1000);
  return {
    day: shifted.getUTCDate(),
    month: THAI_MONTHS[shifted.getUTCMonth()],
    buddhistYear: shifted.getUTCFullYear() + 543,
    hh: pad2(shifted.getUTCHours()),
    mm: pad2(shifted.getUTCMinutes()),
  };
}

const inlineBlock = (value: string): string => `${FENCE}${value}${FENCE}`;
const multilineBlock = (body: string): string =>
  // The `\n` after the opening fence matters: Discord reads the first token after ``` as a language tag
  // and hides it when the block spans lines.
  `${FENCE}\n${body}\n${FENCE}`;

export function buildDiscordPayload(
  input: SupportPayloadInput,
): DiscordPayload {
  const ping = SUPPORT_SEVERITY_PING[input.severity];
  const when = bangkokParts(input.timestamp);

  const reporterName = truncateText(
    sanitizeSpoiler(input.reporterName ?? '') || EMPTY,
    SUPPORT_REPORTER_NAME_MAX,
  );
  const phone = truncateText(
    sanitizeSpoiler(input.phoneNumber ?? '') || SUPPORT_PHONE_FALLBACK,
    SUPPORT_PHONE_MAX,
  );
  const path = truncateText(
    sanitizeInline(input.path) || EMPTY,
    SUPPORT_PATH_MAX,
  );
  const description = sanitizeBlock(input.description).trim();
  const diagnostics = sanitizeBlock(input.diagnostics ?? '').trim() || EMPTY;

  // `bodies` is the only part that varies in length; everything else is fixed and built first.
  const assemble = (descBody: string, diagBody: string): string =>
    [
      ...(ping.line ? [ping.line] : []),
      `# รายการปัญหาจากระบบ ที่ ${input.code}/${when.buddhistYear} ${SUPPORT_SEVERITY_EMOJI[input.severity]}`,
      `> วันที่ ${when.day} ${when.month} ${when.buddhistYear}  เวลา ${when.hh}.${when.mm} น.`,
      SEPARATOR,
      '**ผู้แจ้ง:**',
      `||${inlineBlock(`${reporterName}  (${SUPPORT_ROLE_LABEL[input.role]})`)}||`,
      '**เบอร์โทรศัพท์:**',
      `||${inlineBlock(phone)}||`,
      SEPARATOR,
      '**ประเภท:**',
      inlineBlock(SUPPORT_CATEGORY_LABEL[input.category]),
      '**ระดับ:**',
      inlineBlock(SUPPORT_SEVERITY_LABEL[input.severity]),
      '**หน้าที่พบปัญหา:**',
      inlineBlock(path),
      '**รายละเอียด:**',
      multilineBlock(descBody),
      '**ข้อมูลเวอร์ชันระบบ:**',
      multilineBlock(diagBody),
    ].join('\n');

  // Fit the two variable bodies into what is left. Description has priority and diagnostics shrinks
  // first, but one unit is always kept back for diagnostics so its block is never empty.
  const remaining = DISCORD_CONTENT_MAX - assemble('', '').length;
  const descBudget = Math.max(0, Math.min(description.length, remaining - 1));
  const descBody = truncateText(description, descBudget);
  const diagBody = truncateText(diagnostics, remaining - descBody.length);

  return {
    username: SUPPORT_BOT_USERNAME,
    content: assemble(descBody, diagBody),
    tts: false,
    flags: 0,
    embeds: [],
    components: [],
    allowed_mentions: { parse: [...ping.parse] },
    attachments: input.files.map((f, id) => ({ id, filename: f.filename })),
  };
}
