import {
  BadRequestException,
  Logger,
  PayloadTooLargeException,
  type ArgumentsHost,
} from '@nestjs/common';
import { MulterError } from 'multer';
import { MulterErrorTo400Filter } from './multer-error.filter';

describe('MulterErrorTo400Filter', () => {
  const MSG = 'too big';
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  let warn: jest.SpyInstance<
    void,
    [message: unknown, ...optionalParams: unknown[]]
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('PayloadTooLargeException (multer file size, as Nest transforms it) -> 400 with the size message', () => {
    new MulterErrorTo400Filter(MSG).catch(
      new PayloadTooLargeException('File too large'),
      host,
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      message: MSG,
      error: 'Bad Request',
    });
  });

  it('a raw MulterError LIMIT_FILE_SIZE -> the same too-large 400', () => {
    new MulterErrorTo400Filter(MSG).catch(
      new MulterError('LIMIT_FILE_SIZE'),
      host,
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      message: MSG,
      error: 'Bad Request',
    });
  });

  it('a raw LIMIT_UNEXPECTED_FILE (multer 2.4.0 message, which Nest fails to transform) -> 400 carrying multer’s message, NOT the size message', () => {
    const err = new MulterError('LIMIT_UNEXPECTED_FILE', 'avatar');
    new MulterErrorTo400Filter(MSG).catch(err, host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      new BadRequestException(err.message).getResponse(),
    );
    expect(json).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: MSG }),
    );
  });

  // @types/multer's ErrorCode union predates these codes, hence the cast.
  it.each([
    'LIMIT_FIELD_ARRAY_INDEX',
    'INVALID_FIELD_NAME',
    'STREAM_DESTROYED',
  ])('multer 2.4.0’s new code %s -> 400', (code) => {
    new MulterErrorTo400Filter(MSG).catch(
      new MulterError(code as MulterError['code']),
      host,
    );
    expect(status).toHaveBeenCalledWith(400);
  });

  it('logs the error code only — never the field or file name', () => {
    new MulterErrorTo400Filter(MSG).catch(
      new MulterError('LIMIT_UNEXPECTED_FILE', 'secret-name.png'),
      host,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('code=LIMIT_UNEXPECTED_FILE');
    expect(line).not.toContain('secret-name');
  });
});
