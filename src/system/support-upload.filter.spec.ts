import {
  BadRequestException,
  Logger,
  PayloadTooLargeException,
  type ArgumentsHost,
} from '@nestjs/common';
import { MulterError } from 'multer';
import { SupportUploadErrorFilter } from './support-upload.filter';

describe('SupportUploadErrorFilter', () => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('a bare PayloadTooLargeException (multer file size) -> 413 SUPPORT_FILE_TOO_LARGE', () => {
    new SupportUploadErrorFilter().catch(
      new PayloadTooLargeException('File too large'),
      host,
    );
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({
      statusCode: 413,
      error: 'Payload Too Large',
      message: 'ไฟล์ภาพแต่ละไฟล์ต้องมีขนาดไม่เกิน 5 MB',
      code: 'SUPPORT_FILE_TOO_LARGE',
    });
  });

  it('a raw MulterError is treated the same way', () => {
    new SupportUploadErrorFilter().catch(
      new MulterError('LIMIT_FILE_SIZE'),
      host,
    );
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SUPPORT_FILE_TOO_LARGE' }),
    );
  });

  it('an already-coded 413 from the handler is written back UNCHANGED', () => {
    const coded = new PayloadTooLargeException({
      statusCode: 413,
      error: 'Payload Too Large',
      message: 'รวมกันใหญ่เกินไป',
      code: 'SUPPORT_ATTACHMENTS_TOO_LARGE',
    });
    new SupportUploadErrorFilter().catch(coded, host);
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({
      statusCode: 413,
      error: 'Payload Too Large',
      message: 'รวมกันใหญ่เกินไป',
      code: 'SUPPORT_ATTACHMENTS_TOO_LARGE',
    });
  });

  it('does not catch an unrelated BadRequestException (decorator metadata)', () => {
    const caught = Reflect.getMetadata(
      '__filterCatchExceptions__',
      SupportUploadErrorFilter,
    ) as unknown[];
    expect(caught).toContain(PayloadTooLargeException);
    expect(caught).toContain(MulterError);
    expect(caught).not.toContain(BadRequestException);
  });
});
