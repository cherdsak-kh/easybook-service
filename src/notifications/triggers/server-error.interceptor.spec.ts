import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';
import { firstValueFrom, of, throwError } from 'rxjs';
import {
  serverErrorCode,
  ServerErrorNotificationInterceptor,
  serverErrorStatus,
} from './server-error.interceptor';

describe('serverErrorStatus', () => {
  it.each([404, 422, 429, 413])(
    'an HttpException(%d) is not a 5xx',
    (status) => {
      expect(serverErrorStatus(new HttpException('x', status))).toBeNull();
    },
  );

  it('an HttpException >= 500 returns its status', () => {
    expect(serverErrorStatus(new HttpException('x', 502))).toBe(502);
  });

  it('a MulterError is never a 5xx (D-4)', () => {
    expect(serverErrorStatus(new MulterError('LIMIT_FILE_SIZE'))).toBeNull();
  });

  it('anything else (plain Error, Prisma error) is a 500', () => {
    expect(serverErrorStatus(new Error('boom'))).toBe(500);
    expect(
      serverErrorStatus(
        new Prisma.PrismaClientKnownRequestError('x', {
          code: 'P2034',
          clientVersion: 'x',
        }),
      ),
    ).toBe(500);
  });
});

describe('serverErrorCode', () => {
  it('a Prisma known error gives its code', () => {
    const err = new Prisma.PrismaClientKnownRequestError('x', {
      code: 'P2034',
      clientVersion: 'x',
    });
    expect(serverErrorCode(err)).toBe('P2034');
  });

  it('a string `code` property matching the whitelist pattern is used as-is', () => {
    expect(serverErrorCode({ code: '40P01' })).toBe('40P01');
    expect(serverErrorCode({ code: 'ECONNREFUSED' })).toBe('ECONNREFUSED');
  });

  it('a code that fails the pattern is NOT used verbatim', () => {
    expect(
      serverErrorCode({ code: 'not a code; has spaces and! symbols' }),
    ).not.toBe('not a code; has spaces and! symbols');
  });

  it('an HttpException gives HTTP_<status>', () => {
    expect(serverErrorCode(new HttpException('x', 502))).toBe('HTTP_502');
  });

  it('err.name is used when it matches the whitelist pattern', () => {
    class WeirdError extends Error {}
    expect(serverErrorCode(new WeirdError('x'))).toBe('Error');
    const named = new Error('x');
    named.name = 'ECONNRESET';
    expect(serverErrorCode(named)).toBe('ECONNRESET');
  });

  it('falls back to "Error" for everything else, never leaking free text', () => {
    expect(serverErrorCode('a string')).toBe('Error');
  });
});

describe('ServerErrorNotificationInterceptor', () => {
  let serverError: jest.Mock;
  let triggers: { isEnabled: boolean; serverError: jest.Mock };
  let reflector: { getAllAndOverride: jest.Mock };

  const ctx = (
    over: Partial<{
      type: string;
      route: string | undefined;
      excluded: boolean;
    }> = {},
  ): ExecutionContext =>
    ({
      getType: () => over.type ?? 'http',
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          route: { path: over.route },
        }),
      }),
      getHandler: () => (): void => undefined,
      getClass: () => class VenuesController {},
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    serverError = jest.fn().mockResolvedValue(undefined);
    triggers = { isEnabled: true, serverError };
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
  });

  const interceptor = () =>
    new ServerErrorNotificationInterceptor(
      triggers as never,
      reflector as unknown as Reflector,
    );

  it('a success value passes through unchanged (toBe, not toEqual)', async () => {
    const value = { ok: true };
    const result = await firstValueFrom(
      interceptor().intercept(ctx(), { handle: () => of(value) }),
    );
    expect(result).toBe(value);
    expect(serverError).not.toHaveBeenCalled();
  });

  it('re-emits the IDENTICAL error reference after firing the trigger', async () => {
    const err = new Error('boom');
    await expect(
      firstValueFrom(
        interceptor().intercept(ctx(), { handle: () => throwError(() => err) }),
      ),
    ).rejects.toBe(err);
    expect(serverError).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['404', new NotFoundException()],
    ['422', new UnprocessableEntityException()],
    ['429', new HttpException('rate limited', 429)],
    ['400', new BadRequestException()],
    ['403', new ForbiddenException()],
  ])('a 4xx (%s) never fires the trigger', async (_label, err) => {
    await expect(
      firstValueFrom(
        interceptor().intercept(ctx(), { handle: () => throwError(() => err) }),
      ),
    ).rejects.toBe(err);
    expect(serverError).not.toHaveBeenCalled();
  });

  it('an HttpException(502) fires with status 502', async () => {
    const err = new HttpException('bad gateway', 502);
    await expect(
      firstValueFrom(
        interceptor().intercept(ctx(), { handle: () => throwError(() => err) }),
      ),
    ).rejects.toBe(err);
    expect(serverError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 502 }),
    );
  });

  it('a plain Error fires with status 500', async () => {
    const err = new Error('boom');
    await firstValueFrom(
      interceptor().intercept(ctx(), { handle: () => throwError(() => err) }),
    ).catch(() => undefined);
    expect(serverError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500 }),
    );
  });

  it('a MulterError never fires (D-4)', async () => {
    const err = new MulterError('LIMIT_FILE_SIZE');
    await firstValueFrom(
      interceptor().intercept(ctx(), { handle: () => throwError(() => err) }),
    ).catch(() => undefined);
    expect(serverError).not.toHaveBeenCalled();
  });

  it('a non-HTTP (ws) context never fires', async () => {
    const err = new Error('boom');
    await firstValueFrom(
      interceptor().intercept(ctx({ type: 'ws' }), {
        handle: () => throwError(() => err),
      }),
    ).catch(() => undefined);
    expect(serverError).not.toHaveBeenCalled();
  });

  it('@NoErrorNotification (via Reflector) never fires', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const err = new Error('boom');
    await firstValueFrom(
      interceptor().intercept(ctx(), { handle: () => throwError(() => err) }),
    ).catch(() => undefined);
    expect(serverError).not.toHaveBeenCalled();
  });

  it('disabled triggers never fire', async () => {
    triggers.isEnabled = false;
    const err = new Error('boom');
    await firstValueFrom(
      interceptor().intercept(ctx(), { handle: () => throwError(() => err) }),
    ).catch(() => undefined);
    expect(serverError).not.toHaveBeenCalled();
  });

  it('a trigger that itself rejects still rethrows the original error unchanged', async () => {
    serverError.mockRejectedValue(new Error('trigger broke its contract'));
    const err = new Error('boom');
    await expect(
      firstValueFrom(
        interceptor().intercept(ctx(), { handle: () => throwError(() => err) }),
      ),
    ).rejects.toBe(err);
  });

  it('the route template comes from req.route.path, never req.url', async () => {
    const err = new Error('boom');
    await firstValueFrom(
      interceptor().intercept(ctx({ route: '/api/v1/venues/:id' }), {
        handle: () => throwError(() => err),
      }),
    ).catch(() => undefined);
    expect(serverError).toHaveBeenCalledWith(
      expect.objectContaining({
        routeTemplate: '/api/v1/venues/:id',
        method: 'GET',
      }),
    );
  });
});
