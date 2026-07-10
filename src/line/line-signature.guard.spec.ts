import { createHmac } from 'node:crypto';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LineSignatureGuard } from './line-signature.guard';

const SECRET = 'test-channel-secret';

function sign(body: string): string {
  return createHmac('SHA256', SECRET).update(body).digest('base64');
}

function contextFor(rawBody?: Buffer, signature?: string): ExecutionContext {
  const req = {
    rawBody,
    header: (name: string) =>
      name.toLowerCase() === 'x-line-signature' ? signature : undefined,
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('LineSignatureGuard', () => {
  const guard = new LineSignatureGuard({
    get: () => SECRET,
  } as unknown as ConfigService);

  it('allows a request with a valid signature', () => {
    const body = '{"events":[]}';
    const ctx = contextFor(Buffer.from(body), sign(body));
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects a request with an invalid signature', () => {
    const ctx = contextFor(
      Buffer.from('{"events":[]}'),
      'not-a-valid-signature',
    );
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects a request with no signature header', () => {
    const ctx = contextFor(Buffer.from('{"events":[]}'), undefined);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
