import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, MaxLength, ValidateIf } from 'class-validator';
import {
  FEEDBACK_NOTE_MAX,
  FEEDBACK_UPDATE_STATUSES,
  type FeedbackUpdateStatus,
} from '../feedback.constants';

/**
 * Blank → `undefined`, so a note of spaces is exactly "absent" (AC-15). Non-strings pass through
 * untouched so `@IsString` can refuse them.
 */
const trimToUndefined = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * `PATCH /feedback/:id` — one staff save: a status change, an internal note, or both (D-1).
 *
 * ── 🔴 `@ValidateIf`, NOT `@IsOptional` ──
 * `@IsOptional()` skips validation for `null` as well as `undefined`, so `{"status": null}` would
 * read as "absent" instead of being refused. `@ValidateIf((_o, v) => v !== undefined)` accepts
 * absence and refuses `null` — the `admin-booking-write.dto.ts` rule.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──
 * `authorId` (the author is the SESSION user, AC-19), `feedbackId`, `createdAt`: `forbidNonWhitelisted`
 * 400s each. And there is NO "at least one field" decorator (design C-3): a D-1(a) refusal must be one
 * machine-readable string, and a decorator cannot see that a whitespace note became "absent" — the
 * service throws `FEEDBACK_UPDATE_EMPTY` instead.
 */
export class UpdateFeedbackDto {
  @ApiPropertyOptional({
    enum: FEEDBACK_UPDATE_STATUSES,
    // 🔴 NOT 'FeedbackStatus' (design C-4): a 3-value subset registered under the shared name would
    // overwrite the 4-value schema every other DTO references.
    enumName: 'FeedbackUpdateStatus',
    description:
      'Target status. Any state may move to any of these three (no transition policy). `DISMISSED` is refused (400). Absent = keep the current status (a note-only save).',
  })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsIn([...FEEDBACK_UPDATE_STATUSES])
  status?: FeedbackUpdateStatus;

  /** ⚠️ TRIM FIRST, THEN COUNT (E-9): exactly 500 after trimming is valid, 501 is a 400. */
  @ApiPropertyOptional({
    maxLength: FEEDBACK_NOTE_MAX,
    description:
      'Internal note — staff-only, never sent to the reporter. Trimmed; blank = absent; at most 500 characters after trimming.',
    example: 'ประสานช่างแอร์แล้ว นัดเข้าตรวจวันพรุ่งนี้ 10:00 น.',
  })
  @Transform(trimToUndefined)
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsString()
  @MaxLength(FEEDBACK_NOTE_MAX)
  note?: string;
}
