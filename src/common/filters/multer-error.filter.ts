import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Response } from 'express';
import { MulterError } from 'multer';

/**
 * Turns an oversized upload into the **400** the acceptance criteria demand, instead of the **413**
 * the stack produces by default.
 *
 * **This filter is load-bearing, and the mechanism is subtler than it looks.** The design says
 * "catch `MulterError` and rethrow `BadRequestException`" — but by the time any filter runs, there
 * is usually no `MulterError` left to catch: `@nestjs/platform-express`'s `FileInterceptor` pipes
 * multer's error through its own `transformException()` FIRST, which maps `LIMIT_FILE_SIZE` to
 * `PayloadTooLargeException` (413). A `@Catch(MulterError)` filter therefore never fires for that
 * case and the AC fails SILENTLY — the upload is still rejected, so nothing looks broken, but the
 * status is wrong. The e2e specs assert 400 explicitly for exactly this reason.
 *
 * ⚠️ `transformException()` decides by comparing `error.message` with its own constants, so it
 * silently misses anything multer renames or adds (multer 2.4.0 reworded `LIMIT_UNEXPECTED_FILE` to
 * 'Unexpected file field' and added `LIMIT_FIELD_ARRAY_INDEX`, `INVALID_FIELD_NAME`,
 * `STREAM_DESTROYED`). Those reach this filter as a RAW `MulterError`, so this filter branches on
 * `error.code` — never on message text — and:
 *  - `PayloadTooLargeException` / `LIMIT_FILE_SIZE` -> the "too large" 400 with the caller's message;
 *  - every OTHER `MulterError` (a part not named `file`, a second file, a bad field name, …) -> a
 *    plain 400 carrying multer's own message, which is client input only (never a filename).
 *
 * ⚠️ MOVED HERE FROM `src/auth/filters/` AND GIVEN A CONSTRUCTOR ARGUMENT (VENUE-1, 2026-08-25). It
 * has several callers now — the 2 MB avatar, the 5 MB venue photo and the feedback photo — and the
 * message quotes the size, so a shared hard-coded string would tell an uploader the wrong number.
 * Because the argument is not injectable, every call site must pass an INSTANCE
 * (`new MulterErrorTo400Filter(MSG)`); handing `@UseFilters` the class would make Nest try to resolve
 * a `string` provider and fail at boot.
 */
@Catch(MulterError, PayloadTooLargeException)
export class MulterErrorTo400Filter implements ExceptionFilter {
  private readonly logger = new Logger(MulterErrorTo400Filter.name);

  constructor(private readonly message: string) {}

  catch(
    error: MulterError | PayloadTooLargeException,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (error instanceof MulterError && error.code !== 'LIMIT_FILE_SIZE') {
      // The filename is attacker-controlled — log the code only, never the name.
      this.logger.warn(`Upload rejected: malformed upload. code=${error.code}`);
      response
        .status(400)
        .json(new BadRequestException(error.message).getResponse());
      return;
    }

    // The filename is attacker-controlled — log the code only, never the name.
    this.logger.warn('Upload rejected: too large. code=LIMIT_FILE_SIZE');

    response.status(400).json({
      statusCode: 400,
      message: this.message,
      error: 'Bad Request',
    });
  }
}
