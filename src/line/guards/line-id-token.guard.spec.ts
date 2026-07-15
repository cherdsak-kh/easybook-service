import {
  BadGatewayException,
  ExecutionContext,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RequestWithLineUserId } from '../line.types';
import { LineIdTokenGuard } from './line-id-token.guard';

const CHANNEL_ID = '1234567890';
const SUB = 'U0123456789abcdef0123456789abcdef';

const configFor = (channelId: string | undefined): ConfigService =>
  ({
    get: (_key: string, def?: string) => channelId ?? def,
  }) as unknown as ConfigService;

const contextFor = (
  authorization?: string,
): { ctx: ExecutionContext; req: RequestWithLineUserId } => {
  const req = {
    headers: { authorization },
  } as unknown as RequestWithLineUserId;
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
};

/** A minimal `fetch` Response stand-in. */
const mockResponse = (
  status: number,
  body: unknown,
  { jsonThrows = false }: { jsonThrows?: boolean } = {},
): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: jsonThrows
      ? () => Promise.reject(new Error('not JSON'))
      : () => Promise.resolve(body),
  }) as unknown as Response;

const futureExp = () => Math.floor(Date.now() / 1000) + 3600;
const validPayload = () => ({
  iss: 'https://access.line.me',
  sub: SUB,
  aud: CHANNEL_ID,
  exp: futureExp(),
});

describe('LineIdTokenGuard', () => {
  let fetchSpy: jest.SpyInstance;

  const makeGuard = () => new LineIdTokenGuard(configFor(CHANNEL_ID));

  beforeEach(() => {
    // Default to a rejection so a test that forgets to stub `fetch` fails fast instead of hitting
    // the real LINE endpoint; every network-reaching test overrides this.
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('fetch not stubbed'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('accepts a valid token and attaches the verified sub to req.lineUserId', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200, validPayload()));
    const { ctx, req } = contextFor(`Bearer ${SUB}-token`);

    await expect(makeGuard().canActivate(ctx)).resolves.toBe(true);
    expect(req.lineUserId).toBe(SUB);

    // Token is sent form-encoded via POST, never in the URL.
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.line.me/oauth2/v2.1/verify');
    expect(init.method).toBe('POST');
    expect(url).not.toContain('id_token');
  });

  it('401s a missing Authorization header without calling LINE', async () => {
    const { ctx } = contextFor(undefined);
    await expect(makeGuard().canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('401s a malformed (non-Bearer) header without calling LINE', async () => {
    const { ctx } = contextFor('Basic abc123');
    await expect(makeGuard().canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('401s an empty bearer token', async () => {
    const { ctx } = contextFor('Bearer   ');
    await expect(makeGuard().canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('401s when LINE returns 400 (invalid/expired/wrong token)', async () => {
    fetchSpy.mockResolvedValue(mockResponse(400, { error: 'invalid_request' }));
    const { ctx } = contextFor('Bearer bad-token');
    await expect(makeGuard().canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('401s a token whose aud is another channel', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse(200, { ...validPayload(), aud: '9999999999' }),
    );
    const { ctx } = contextFor('Bearer wrong-aud');
    await expect(makeGuard().canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('401s a token with a wrong issuer', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse(200, { ...validPayload(), iss: 'https://evil.example' }),
    );
    const { ctx } = contextFor('Bearer wrong-iss');
    await expect(makeGuard().canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('401s an expired token even if LINE returned 200', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse(200, {
        ...validPayload(),
        exp: Math.floor(Date.now() / 1000) - 10,
      }),
    );
    const { ctx } = contextFor('Bearer expired');
    await expect(makeGuard().canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('502s (not 401) when LINE is unreachable', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const { ctx } = contextFor('Bearer any');
    await expect(makeGuard().canActivate(ctx)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('502s when LINE returns a 5xx', async () => {
    fetchSpy.mockResolvedValue(mockResponse(503, 'unavailable'));
    const { ctx } = contextFor('Bearer any');
    await expect(makeGuard().canActivate(ctx)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('502s when LINE returns 200 with a non-JSON body', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200, null, { jsonThrows: true }));
    const { ctx } = contextFor('Bearer any');
    await expect(makeGuard().canActivate(ctx)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('500s (config defect) when LINE_LOGIN_CHANNEL_ID is unset — never a 401', async () => {
    const guard = new LineIdTokenGuard(configFor(undefined));
    const { ctx } = contextFor('Bearer any');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
