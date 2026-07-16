import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Response } from 'express';
import { MulterError } from 'multer';
import { AVATAR_TOO_LARGE } from '../../storage/storage.errors';

/**
 * Turns an oversized avatar upload into the **400** AC-B13 demands, instead of the **413** the
 * stack produces by default.
 *
 * **This filter is load-bearing, and the mechanism is subtler than it looks.** The design says
 * "catch `MulterError` and rethrow `BadRequestException`" — but by the time any filter runs, there
 * is no `MulterError` left to catch: `@nestjs/platform-express`'s `FileInterceptor` pipes multer's
 * error through its own `transformException()` FIRST, which maps `LIMIT_FILE_SIZE` to
 * `PayloadTooLargeException` (413). A `@Catch(MulterError)` filter therefore never fires and the AC
 * fails SILENTLY — the upload is still rejected, so nothing looks broken, but the status is wrong.
 * The e2e spec asserts 400 explicitly for exactly this reason.
 *
 * `MulterError` is kept in the `@Catch` list as defence in depth, in case a future Nest version
 * stops transforming, or a raw multer error ever reaches here by another path.
 *
 * Everything else multer raises (`LIMIT_UNEXPECTED_FILE` — a part named anything but `file`, or a
 * second file past `limits.files: 1`) Nest ALREADY maps to a `BadRequestException`, which is the
 * correct status, so this filter deliberately leaves those alone.
 */
@Catch(MulterError, PayloadTooLargeException)
export class MulterErrorTo400Filter implements ExceptionFilter {
  private readonly logger = new Logger(MulterErrorTo400Filter.name);

  catch(
    error: MulterError | PayloadTooLargeException,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<Response>();

    // The filename is attacker-controlled — log the code/type only, never the name.
    this.logger.warn(
      `Avatar upload rejected: too large. code=${
        error instanceof MulterError ? error.code : 'LIMIT_FILE_SIZE'
      }`,
    );

    response.status(400).json({
      statusCode: 400,
      message: AVATAR_TOO_LARGE,
      error: 'Bad Request',
    });
  }
}
