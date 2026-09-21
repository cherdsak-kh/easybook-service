import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { MulterErrorTo400Filter } from '../common/filters/multer-error.filter';
import { LineIdTokenGuard } from '../line/guards/line-id-token.guard';
import type { RequestWithLineUserId } from '../line/line.types';
import {
  CreateFeedbackDto,
  FeedbackPhotoUploadResponseDto,
  FeedbackResponseDto,
} from './dto/feedback.dto';
import { FeedbackPhotoService } from './feedback-photo.service';
import { FeedbackService } from './feedback.service';
import {
  FEEDBACK_PHOTO_MULTER_SIZE_LIMIT,
  FEEDBACK_PHOTO_REQUIRED,
  FEEDBACK_PHOTO_TOO_LARGE,
} from './feedback.constants';

/**
 * `แจ้งปัญหา / ข้อเสนอแนะ` (`CLIENT-ISSUE-1`), route prefix `/api/v1/line-users`.
 *
 * ── WHY IT SHARES A BASE PATH WITH FOUR CONTROLLERS IN TWO OTHER MODULES ──
 * On this surface `line-users` is not a noun, it is a GUARD: this is the fifth controller whose
 * caller proves identity with a LINE ID token rather than an Express session, and grouping by guard
 * is the rule `LineRegistrationController` states. The guard is applied PER METHOD rather than at
 * class level (the `LineBookingsController` style), so a future unauthenticated route on this class
 * has to opt out loudly instead of inheriting an opt-out.
 *
 * ── 🔴 ROUTE ORDER (`SC-6`) ──
 * Literals first, always: `feedback/photos` is declared above `feedback`. The order between THOSE
 * two is not itself load-bearing — Express matches a pattern's full depth, so a 2-segment route can
 * never capture a 3-segment path — but literals-first is the habit that keeps the class correct on
 * the day a parameterised sibling is added.
 *
 * The collision table, which is the part worth keeping (the conclusion alone would not survive a
 * new route being added elsewhere):
 *
 * | This controller | Existing route | Collides? |
 * |---|---|---|
 * | `POST line-users/feedback` (2) | `LineRegistrationController` `GET venues/:id` (3, a GET) | **no** — different method AND depth |
 * | `POST line-users/feedback` (2) | `LineBookingsController` `POST bookings` (2, literal) | **no** — two distinct literals never shadow each other, at any registration order |
 * | `POST line-users/feedback` (2) | admin `LineUsersController` `PATCH :id` (2) | **no** — different method |
 * | `POST line-users/feedback/photos` (3) | `GET venues/:id` (3) · `PATCH :id/registration` (3) | **no** — different method; and `feedback` ≠ `venues` as a first segment |
 *
 * 🔴 THE ROW THAT WOULD BREAK IT: an admin `POST line-users/:id/<anything>` would be a
 * parameterised POST on this family and would shadow `POST line-users/feedback/photos` if its
 * module registered first. None exists today, and `FeedbackModule` registers AFTER `LineModule` and
 * `BookingsModule` in `app.module.ts` — so if one is ever added, this is the table to re-check. The
 * failure is SILENT: a photo upload answering with a LINE user profile.
 *
 * ── CSRF ──
 * ⚠️ BOTH PATHS MUST BE LISTED IN `CSRF_EXEMPT_PATHS`, individually. They are bearer-authenticated
 * and cookieless, so the double-submit cookie they would otherwise be asked for does not exist —
 * and the middleware runs BEFORE the router, so without the entries every submission is a 403 that
 * never reaches `LineIdTokenGuard`. The first entry does NOT cover the second: matching is exact
 * `req.path`. Neither belongs in `CSRF_EXEMPT_PATTERNS`, which exists for parameterised paths only.
 */
@ApiTags('LINE Feedback')
@ApiBearerAuth()
@Controller('line-users')
export class FeedbackController {
  constructor(
    private readonly feedback: FeedbackService,
    private readonly photos: FeedbackPhotoService,
  ) {}

  // ── LITERAL SEGMENTS, DEEPEST FIRST — see the class note on route order. ─────────────────────

  @Post('feedback/photos')
  @HttpCode(200)
  @UseGuards(LineIdTokenGuard)
  // memoryStorage: the object is <= 5 MiB and goes straight to R2; nothing should ever hit local
  // disk. `limits.fileSize` aborts the stream AT the limit, so an oversized upload is never fully
  // buffered. `limits.files: 1` rejects multi-part floods.
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      // `FEEDBACK_PHOTO_MAX_BYTES + 1` — busboy's limit is EXCLUSIVE. See the constant's doc
      // comment; passing 5 MiB here would reject a file of exactly 5 MiB.
      limits: { fileSize: FEEDBACK_PHOTO_MULTER_SIZE_LIMIT, files: 1 },
    }),
  )
  // An INSTANCE carrying THIS endpoint's size message — the filter takes a constructor argument, so
  // handing `@UseFilters` the class would make Nest try to resolve a `string` provider at boot.
  @UseFilters(new MulterErrorTo400Filter(FEEDBACK_PHOTO_TOO_LARGE))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'JPEG or PNG. Max 5 MB.',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'Upload one feedback photo and get its URL back.',
    description:
      'Multipart, one part named `file`. The client uploads each photo AS IT IS PICKED and sends the returned URLs in `photos[]` on the submit call — there is no photo body on that call and no discard endpoint. The declared MIME is a first filter only: the real control is a MAGIC-BYTE sniff, and both the stored ContentType and the key extension come from the SNIFFED type, never from the filename. 🔴 JPEG and PNG only — webp is refused here even though the shared sniffer recognises it. Oversize is a **400**, not a 413. No CSRF token: this route is bearer-authenticated and cookieless.',
  })
  @ApiOkResponse({
    description: 'Stored.',
    type: FeedbackPhotoUploadResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'No file, wrong field name, a second file, larger than 5 MB, or an unsupported/mismatched image type (a `.jpg`-named PDF lands here).',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid/expired/wrong-aud LINE ID token.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'The caller’s access is not ALLOWED (UNREGISTERED / PENDING / REJECTED / BLOCKED — one message for all four).',
    type: ErrorResponseDto,
  })
  @ApiInternalServerErrorResponse({
    description:
      'A deploy defect, never a client error: `LINE_LOGIN_CHANNEL_ID` unset, or R2 not configured on this deployment.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description:
      'LINE verification unreachable, or the object store rejected the upload / was unreachable. Retryable.',
    type: ErrorResponseDto,
  })
  uploadPhoto(
    @Req() req: RequestWithLineUserId,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<FeedbackPhotoUploadResponseDto> {
    if (!file) throw new BadRequestException(FEEDBACK_PHOTO_REQUIRED);
    return this.photos.upload(req.lineUserId as string, file);
  }

  @Post('feedback')
  @UseGuards(LineIdTokenGuard)
  @HttpCode(201)
  @ApiOperation({
    summary: 'Submit a facility issue or a suggestion.',
    description:
      'Creates one write-once `Feedback` row and answers with its human-readable `code` (`ISS-25690920-001` / `FDB-25690920-001`), which is the value the success dialog prints — the client never generates or guesses one. The caller must be `ALLOWED`. There is no `lineUserId` body field: the identity is the verified `sub`, resolved server-side to the cuid FK. `venueId` is optional — absent or `null` both persist as `ปัญหาทั่วไป / ไม่ระบุสถานที่`, and a CLOSED venue is accepted. There is deliberately no `category` field (`D-4`) and no status lifecycle in this cycle.',
  })
  @ApiCreatedResponse({
    description: 'Submitted, with its human-readable reference `code`.',
    type: FeedbackResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'An unknown extra key, a missing/blank or over-long `subject` (100) or `description` (500, counted after trimming), more than 3 photos, a venue that does not exist or has been deleted, or a photo URL this deployment did not mint.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid/expired/wrong-aud LINE ID token.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'The caller’s access is not ALLOWED (UNREGISTERED / PENDING / REJECTED / BLOCKED — one message for all four).',
    type: ErrorResponseDto,
  })
  @ApiInternalServerErrorResponse({
    description:
      '`LINE_LOGIN_CHANNEL_ID` unset — a deploy defect, never a client error.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'LINE verification endpoint unreachable (retryable).',
    type: ErrorResponseDto,
  })
  create(
    @Req() req: RequestWithLineUserId,
    @Body() dto: CreateFeedbackDto,
  ): Promise<FeedbackResponseDto> {
    return this.feedback.create(req.lineUserId as string, dto);
  }
}
