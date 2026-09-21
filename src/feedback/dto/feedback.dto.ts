import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FeedbackType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  FEEDBACK_DESCRIPTION_MAX,
  FEEDBACK_PHOTOS_MAX,
  FEEDBACK_PHOTO_URL_MAX,
  FEEDBACK_SUBJECT_MAX,
  FEEDBACK_VENUE_ID_MAX,
} from '../feedback.constants';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * `POST /line-users/feedback` — a LINE end-user reporting a problem or suggesting something.
 *
 * ── 🔴 WHAT IS DELIBERATELY ABSENT, AND WHY THE ABSENCE IS THE CONTROL ──
 * `forbidNonWhitelisted: true` is global, so every field NOT declared here is a `400` before the
 * handler runs. Four are missing on purpose:
 *
 * 1. **`lineUserId`** — the caller's identity is the verified `sub` on `req.lineUserId`
 *    (`LINK-LINE-1`). A body field would be an impersonation route.
 * 2. **`code`** — server-minted. AC-37: the client displays the value it is given and never
 *    generates or guesses one.
 * 3. **`status`** — the triage column is written ONLY by the admin console (`PATCH /feedback/:id`,
 *    ADMIN-FEEDBACK-1); a reporter can never set it. This is the same construction that keeps
 *    `isSystemReserved` unsettable.
 * 4. **`category`** — `D-4`. The prototype removed the category chips on 17 ก.ย. 2569 because
 *    *"การจัดหมวดเป็นงานของเจ้าหน้าที่ฝั่ง admin ไม่ใช่ของคนที่มาแจ้ง"*. Not as a column, not as a
 *    DTO field, not as a UI control.
 *
 * ⚠️ NO `sanitizeThaiText` TRANSFORM ON THE TWO TEXT FIELDS. The sanitiser is applied to columns
 * that are SEARCHED or SORTED (names, option labels). `BookingRequest.purpose` — the closest
 * analogue — is not sanitised either, and rewriting a reporter's own words in a field read by a
 * human rather than matched by a query would be a change nobody asked for.
 */
export class CreateFeedbackDto {
  @ApiProperty({
    enum: FeedbackType,
    enumName: 'FeedbackType',
    description:
      'What this is. `ISSUE` = แจ้งปัญหาการใช้งาน, `FEEDBACK` = ข้อเสนอแนะ. The wire format is the Prisma enum, UPPERCASE, like every other enum in this service; the prototype’s lowercase `issue`/`feedback` keys survive on the client as a field of its own `IS_TYPES` row.',
    example: FeedbackType.ISSUE,
  })
  @IsEnum(FeedbackType)
  type!: FeedbackType;

  /**
   * ⚠️ `@IsOptional()` RATHER THAN `@ValidateIf`, and that is not the usual advice in this repo.
   * `CLAUDE.md`'s warning is about optional NON-nullable fields, where an explicit `null` would
   * reach a `NOT NULL` column. `Feedback.venueId` is nullable and `null` is a MEANINGFUL value
   * here — it is how "ปัญหาทั่วไป / ไม่ระบุสถานที่" is persisted — so absent and `null` must both
   * be accepted and must mean the same thing.
   */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: FEEDBACK_VENUE_ID_MAX,
    description:
      'The venue the report is about. Optional (AC-10): absent **or** an explicit `null` both persist as `ปัญหาทั่วไป / ไม่ระบุสถานที่`. Must be an existing, non-deleted venue — a CLOSED venue is accepted, because a closed room is exactly the kind somebody needs to report a problem about.',
    example: 'clx0v3n0e0000abcd1234efgh',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(FEEDBACK_VENUE_ID_MAX)
  venueId?: string | null;

  @ApiProperty({
    maxLength: FEEDBACK_SUBJECT_MAX,
    description:
      'หัวข้อ — one line the triaging staff member reads first. Required, 1–100 characters after trimming.',
    example: 'แอร์ห้องประชุม 1 ไม่เย็น',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(FEEDBACK_SUBJECT_MAX)
  subject!: string;

  /**
   * ⚠️ TRIM FIRST, THEN COUNT — E-9, and the client must do the same or the two boundaries disagree
   * at exactly 500/501. Over-length text is REFUSED, never truncated: the textarea carries no
   * `maxlength` (AC-12) precisely so a pasted paragraph is not silently cut, and the client
   * disables its submit button instead (AC-14).
   */
  @ApiProperty({
    maxLength: FEEDBACK_DESCRIPTION_MAX,
    description:
      'รายละเอียด. Required, 1–500 characters **after trimming** — exactly 500 is valid and 501 is not (E-9). Never truncated server-side.',
    example: 'แอร์ตัวที่อยู่ฝั่งหน้าต่างไม่ทำงานมา 3 วันแล้วครับ',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(FEEDBACK_DESCRIPTION_MAX)
  description!: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: FEEDBACK_PHOTOS_MAX,
    description:
      'URLs returned by `POST /line-users/feedback/photos`, in the order the reporter attached them. Absent and `[]` both mean none. 🔴 Every entry must be an object THIS deployment minted under its `feedback/` prefix — a foreign URL is a 400, never a stored link.',
    example: [
      'https://cdn.example.org/feedback/0123456789abcdef0123456789abcdef.jpg',
    ],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FEEDBACK_PHOTOS_MAX)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(FEEDBACK_PHOTO_URL_MAX, { each: true })
  photos?: string[];
}

/**
 * The 201 body — what the success `<dialog>` renders.
 *
 * ⚠️ `venueName` IS INCLUDED EVEN THOUGH THE CLIENT HAS IT IN ITS OWN `<select>`, because AC-28
 * resets the form BEFORE the dialog opens. Without it the client would have to keep a parallel
 * snapshot of state it has just cleared — precisely the kind of duplicate record that goes stale.
 * The dialog then renders what was PERSISTED, not what was typed.
 *
 * ⚠️ `status` AND `lineUserId` ARE EXCLUDED. The former has no consumer on the client — triage is
 * staff-only and the reporter never reads a status (ADMIN-FEEDBACK-1, plan §2 Out); the latter
 * would tell the sender something they already know while putting an identifier into a response
 * body for no reason (plan §8). The `U…` sub appears in no response body at all.
 */
export class FeedbackResponseDto {
  @ApiProperty({ example: 'clx0v3n0e0000abcd1234efgh' })
  id!: string;

  @ApiProperty({
    description:
      'The human-readable reference. 🔴 AC-37 — the dialog prints THIS value; the client never generates or guesses a code.',
    example: 'ISS-25690920-001',
  })
  code!: string;

  @ApiProperty({ enum: FeedbackType, enumName: 'FeedbackType' })
  type!: FeedbackType;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null for a general report (`ปัญหาทั่วไป / ไม่ระบุสถานที่`).',
    example: 'clx0v3n0e0000abcd1234efgh',
  })
  venueId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The venue’s name as it was resolved at submit time. Null when `venueId` is null.',
    example: 'ห้องประชุม 1',
  })
  venueName!: string | null;

  @ApiProperty({ example: 'แอร์ห้องประชุม 1 ไม่เย็น' })
  subject!: string;

  @ApiProperty({
    example: 'แอร์ตัวที่อยู่ฝั่งหน้าต่างไม่ทำงานมา 3 วันแล้วครับ',
  })
  description!: string;

  @ApiProperty({
    type: [String],
    description: 'As stored, in attachment order. Empty when none were sent.',
    example: [
      'https://cdn.example.org/feedback/0123456789abcdef0123456789abcdef.jpg',
    ],
  })
  photos!: string[];

  @ApiProperty({ format: 'date-time', example: '2026-09-20T13:05:00.000Z' })
  createdAt!: string;
}

/** `POST /line-users/feedback/photos` — the object exists in the bucket; no row references it yet. */
export class FeedbackPhotoUploadResponseDto {
  @ApiProperty({
    description:
      'The durable https URL of the stored object. Hold it client-side and send it in `photos[]` on the submit call; there is no discard endpoint (an abandoned object is bounded and collectable later).',
    example:
      'https://cdn.example.org/feedback/0123456789abcdef0123456789abcdef.jpg',
  })
  url!: string;
}
