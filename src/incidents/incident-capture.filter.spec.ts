import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { IncidentCaptureFilter } from './incident-capture.filter';
import { TRACE_CTX } from './incidents.constants';
import type { TraceContext } from './incident.types';

const hostOf = (
  res: { locals?: unknown },
  type: 'http' | 'ws' | 'rpc' = 'http',
): ArgumentsHost =>
  ({
    getType: () => type,
    switchToHttp: () => ({ getResponse: () => res }),
  }) as unknown as ArgumentsHost;

describe('IncidentCaptureFilter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('delegates to BaseExceptionFilter.catch with the IDENTICAL exception and host', () => {
    const spy = jest
      .spyOn(BaseExceptionFilter.prototype, 'catch')
      .mockImplementation();
    const filter = new IncidentCaptureFilter();
    const exception = new Error('boom');
    const host = hostOf({ locals: {} });
    filter.catch(exception, host);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(exception);
    expect(spy.mock.calls[0][1]).toBe(host);
  });

  it('remembers the exception on the trace context', () => {
    jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation();
    const ctx = { closed: false, drafts: [] } as unknown as TraceContext;
    const exception = new BadRequestException('nope');
    new IncidentCaptureFilter().catch(
      exception,
      hostOf({ locals: { [TRACE_CTX]: ctx } }),
    );
    expect(ctx.error).toBe(exception);
  });

  it('still delegates when res.locals access throws', () => {
    const spy = jest
      .spyOn(BaseExceptionFilter.prototype, 'catch')
      .mockImplementation();
    const res = {
      get locals(): never {
        throw new Error('no locals');
      },
    };
    expect(() =>
      new IncidentCaptureFilter().catch(new Error('x'), hostOf(res)),
    ).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not touch a non-HTTP host but still delegates', () => {
    const spy = jest
      .spyOn(BaseExceptionFilter.prototype, 'catch')
      .mockImplementation();
    const getResponse = jest.fn();
    const host = {
      getType: () => 'ws',
      switchToHttp: () => ({ getResponse }),
    } as unknown as ArgumentsHost;
    new IncidentCaptureFilter().catch(new Error('x'), host);
    expect(getResponse).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
