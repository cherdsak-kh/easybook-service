import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Response } from 'express';
import { MulterError } from 'multer';
import { SUPPORT_FILE_TOO_LARGE_MSG } from './support.constants';

/**
 * Method-scoped filter for `POST /system/support/incident`. The shared `MulterErrorTo400Filter` turns an
 * oversized upload into a 400; this endpoint's contract (AC-B3) is **413**, so it gets its own small
 * filter and the shared one stays untouched for the avatar / venue / feedback routes.
 *
 * `FilesInterceptor` maps multer's `LIMIT_FILE_SIZE` to `PayloadTooLargeException` BEFORE any filter
 * runs (see the note on `MulterErrorTo400Filter`), so `PayloadTooLargeException` is what arrives here;
 * a raw `MulterError` with `LIMIT_FILE_SIZE` is handled the same way as defence in depth.
 *
 * ⚠️ Nest's `transformException()` compares `error.message` with its own constants, so it misses
 * anything multer renames or adds (multer 2.4.0: 'Unexpected file field', `LIMIT_FIELD_ARRAY_INDEX`,
 * `INVALID_FIELD_NAME`, `STREAM_DESTROYED`) and the raw `MulterError` lands here. This filter
 * therefore branches on `error.code` — never on message text: `LIMIT_FILE_SIZE` is the 413, and every
 * OTHER `MulterError` (a part not named `files`, too many files, …) is a plain 400.
 *
 * ⚠️ The handler's own coded 413 (`SUPPORT_ATTACHMENTS_TOO_LARGE`) is a `PayloadTooLargeException` too
 * and is caught here as well, so an exception whose body already carries a `code` is written back
 * UNCHANGED.
 */
@Catch(MulterError, PayloadTooLargeException)
export class SupportUploadErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(SupportUploadErrorFilter.name);

  catch(
    error: MulterError | PayloadTooLargeException,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (error instanceof HttpException) {
      const body = error.getResponse();
      if (typeof body === 'object' && 'code' in body) {
        response.status(error.getStatus()).json(body);
        return;
      }
    }

    if (error instanceof MulterError && error.code !== 'LIMIT_FILE_SIZE') {
      // The filename is attacker-controlled — log the code only, never the name.
      this.logger.warn(
        `Support upload rejected: malformed upload. code=${error.code}`,
      );
      response
        .status(400)
        .json(new BadRequestException(error.message).getResponse());
      return;
    }

    // The filename is attacker-controlled — log the code only, never the name.
    this.logger.warn(
      'Support upload rejected: too large. code=LIMIT_FILE_SIZE',
    );
    response.status(413).json({
      statusCode: 413,
      error: 'Payload Too Large',
      message: SUPPORT_FILE_TOO_LARGE_MSG,
      code: 'SUPPORT_FILE_TOO_LARGE',
    });
  }
}
