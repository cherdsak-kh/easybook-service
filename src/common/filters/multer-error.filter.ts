import {
  ArgumentsHost,
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
 * is no `MulterError` left to catch: `@nestjs/platform-express`'s `FileInterceptor` pipes multer's
 * error through its own `transformException()` FIRST, which maps `LIMIT_FILE_SIZE` to
 * `PayloadTooLargeException` (413). A `@Catch(MulterError)` filter therefore never fires and the AC
 * fails SILENTLY — the upload is still rejected, so nothing looks broken, but the status is wrong.
 * The e2e specs assert 400 explicitly for exactly this reason.
 *
 * `MulterError` is kept in the `@Catch` list as defence in depth, in case a future Nest version stops
 * transforming, or a raw multer error ever reaches here by another path.
 *
 * Everything else multer raises (`LIMIT_UNEXPECTED_FILE` — a part named anything but `file`, or a
 * second file past `limits.files: 1`) Nest ALREADY maps to a `BadRequestException`, which is the
 * correct status, so this filter deliberately leaves those alone.
 *
 * ⚠️ MOVED HERE FROM `src/auth/filters/` AND GIVEN A CONSTRUCTOR ARGUMENT (VENUE-1, 2026-08-25). It
 * has two callers now — the 2 MB avatar and the 5 MB venue photo — and the message quotes the size,
 * so a shared hard-coded string would tell a venue uploader the wrong number. Because the argument is
 * not injectable, both call sites must pass an INSTANCE (`new MulterErrorTo400Filter(MSG)`); handing
 * `@UseFilters` the class would make Nest try to resolve a `string` provider and fail at boot.
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

    // The filename is attacker-controlled — log the code only, never the name.
    this.logger.warn(
      `Upload rejected: too large. code=${
        error instanceof MulterError ? error.code : 'LIMIT_FILE_SIZE'
      }`,
    );

    response.status(400).json({
      statusCode: 400,
      message: this.message,
      error: 'Bad Request',
    });
  }
}
