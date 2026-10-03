import {
  BadGatewayException,
  InternalServerErrorException,
} from '@nestjs/common';
import { HTTPFetchError } from '@line/bot-sdk';
import { Prisma } from '@prisma/client';
import { LINE_VERIFICATION_UNAVAILABLE } from '../line/guards/line-id-token.guard';
import { LineCallError } from '../line/line-call-error';
import { IMAGE_UPLOAD_FAILED } from '../storage/storage.errors';
import {
  classifyExternal,
  classifyHttp,
  errorCodeOf,
  isDbUnreachable,
} from './incident-classify';
import { IncidentComponent, IncidentSeverity } from './incident.types';

const known = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('boom', {
    code,
    clientVersion: '7.8.0',
  });

const http = (
  error: unknown,
  route: string | null = '/api/v1/x',
  redis = true,
) => classifyHttp(error, route, redis);

const fetchError = (status: number) =>
  new HTTPFetchError(`${status} - x`, {
    status,
    statusText: 'x',
    headers: new Headers(),
    body: '{}',
  });

describe('incident-classify (design §2.5.2)', () => {
  describe('HTTP 5xx (rows 1-9)', () => {
    it('row 1: P2034 is CRITICAL Prisma / DB', () => {
      expect(http(known('P2034'))).toEqual({
        severity: IncidentSeverity.CRITICAL,
        component: IncidentComponent.PRISMA_DB,
      });
    });

    it('row 1: a raw 40P01 deadlock anywhere in the cause chain is CRITICAL Prisma / DB', () => {
      const direct = new Error('deadlock', { cause: { code: '40P01' } });
      expect(http(direct)).toEqual({
        severity: IncidentSeverity.CRITICAL,
        component: IncidentComponent.PRISMA_DB,
      });
    });

    it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024'])(
      'row 2: %s is CRITICAL Prisma / DB (database unreachable)',
      (code) => {
        expect(isDbUnreachable(known(code))).toBe(true);
        expect(http(known(code))).toEqual({
          severity: IncidentSeverity.CRITICAL,
          component: IncidentComponent.PRISMA_DB,
        });
      },
    );

    it('row 2: an initialization error and an ECONNREFUSED cause are unreachable', () => {
      expect(
        isDbUnreachable(
          new Prisma.PrismaClientInitializationError('no db', '7.8.0'),
        ),
      ).toBe(true);
      expect(
        http(new Error('x', { cause: { code: 'ECONNREFUSED' } })).severity,
      ).toBe(IncidentSeverity.CRITICAL);
      expect(isDbUnreachable(new Error('plain'))).toBe(false);
    });

    it('row 3: any other Prisma error is ERROR Prisma / DB', () => {
      expect(http(known('P2002'))).toEqual({
        severity: IncidentSeverity.ERROR,
        component: IncidentComponent.PRISMA_DB,
      });
      expect(
        http(
          new Prisma.PrismaClientValidationError('bad', { clientVersion: '7' }),
        ).component,
      ).toBe(IncidentComponent.PRISMA_DB);
    });

    it('row 4: ioredis errors are ERROR Redis', () => {
      const reply = new Error('ERR boom');
      reply.name = 'ReplyError';
      expect(http(reply).component).toBe(IncidentComponent.REDIS);
      expect(http(new Error('Connection is closed.')).component).toBe(
        IncidentComponent.REDIS,
      );
      expect(
        http(
          new Error(
            "Stream isn't writeable and enableOfflineQueue options is false",
          ),
        ).component,
      ).toBe(IncidentComponent.REDIS);
    });

    it('row 5: a LINE call error, a fetch error and LINE_VERIFICATION_UNAVAILABLE are ERROR LINE OA', () => {
      expect(http(new LineCallError('TRANSIENT', 503)).component).toBe(
        IncidentComponent.LINE_OA,
      );
      expect(http(fetchError(500)).component).toBe(IncidentComponent.LINE_OA);
      expect(
        http(new BadGatewayException(LINE_VERIFICATION_UNAVAILABLE)).component,
      ).toBe(IncidentComponent.LINE_OA);
    });

    it('row 6: an AWS SDK error and IMAGE_UPLOAD_FAILED are ERROR Cloudflare R2', () => {
      const aws = Object.assign(new Error('denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      });
      expect(http(aws).component).toBe(IncidentComponent.CLOUDFLARE_R2);
      expect(http(new BadGatewayException(IMAGE_UPLOAD_FAILED)).component).toBe(
        IncidentComponent.CLOUDFLARE_R2,
      );
    });

    it('row 7: a 5xx under /api/v1/auth/ is ERROR Auth', () => {
      expect(http(new Error('x'), '/api/v1/auth/system/login')).toEqual({
        severity: IncidentSeverity.ERROR,
        component: IncidentComponent.AUTH,
      });
    });

    it('row 8: anything else is ERROR API', () => {
      expect(http(new Error('x'))).toEqual({
        severity: IncidentSeverity.ERROR,
        component: IncidentComponent.API,
      });
      expect(http(new InternalServerErrorException('x'), null).component).toBe(
        IncidentComponent.API,
      );
    });

    it('row 9: no exception (a middleware 5xx) is REDIS when the client is down, else API', () => {
      expect(http(undefined, null, false).component).toBe(
        IncidentComponent.REDIS,
      );
      expect(http(undefined, null, true).component).toBe(IncidentComponent.API);
    });
  });

  describe('external outcomes (rows 10-15)', () => {
    const line = (error?: unknown, extra = {}) =>
      classifyExternal({
        component: IncidentComponent.LINE_OA,
        operation: 'push',
        error,
        ...extra,
      });

    it('row 10: TRANSIENT, RATE_LIMITED and a 401/403 are ERROR', () => {
      expect(line(new LineCallError('TRANSIENT', null))?.severity).toBe(
        IncidentSeverity.ERROR,
      );
      expect(line(new LineCallError('RATE_LIMITED', 429))?.severity).toBe(
        IncidentSeverity.ERROR,
      );
      expect(line(new LineCallError('NOT_CONFIGURED', 401))?.severity).toBe(
        IncidentSeverity.ERROR,
      );
      expect(line(fetchError(500))).toMatchObject({
        severity: IncidentSeverity.ERROR,
        lineErrorKind: 'TRANSIENT',
        status: 500,
      });
    });

    it('row 11: a REJECTED (4xx about one payload) is WARNING', () => {
      expect(line(fetchError(400))?.severity).toBe(IncidentSeverity.WARNING);
    });

    it('row 12: an unconfigured client is NOT recorded, and neither is a 409 on a retry key', () => {
      expect(line(new LineCallError('NOT_CONFIGURED', null))).toBeNull();
      expect(line(fetchError(409))).toBeNull();
    });

    it('row 13: an R2 or Redis failure is ERROR', () => {
      expect(
        classifyExternal({
          component: IncidentComponent.CLOUDFLARE_R2,
          operation: 'putImage',
          error: new Error('x'),
        })?.severity,
      ).toBe(IncidentSeverity.ERROR);
      expect(
        classifyExternal({
          component: IncidentComponent.REDIS,
          operation: 'del',
          error: new Error('x'),
        })?.severity,
      ).toBe(IncidentSeverity.ERROR);
    });

    it('row 15: success after a retry, or over budget, is WARNING; a fast first-try success is nothing', () => {
      expect(line(undefined, { attempts: 2 })?.severity).toBe(
        IncidentSeverity.WARNING,
      );
      expect(
        line(undefined, { latencyMs: 3500, budgetMs: 3000 })?.severity,
      ).toBe(IncidentSeverity.WARNING);
      expect(line(undefined, { latencyMs: 3000, budgetMs: 3000 })).toBeNull();
      expect(
        line(undefined, { attempts: 1, latencyMs: 20, budgetMs: 3000 }),
      ).toBeNull();
    });
  });

  describe('errorCodeOf', () => {
    it('uses a Prisma code, a LINE kind, an AWS name, a status or the class name', () => {
      expect(errorCodeOf(known('P2034'))).toBe('P2034');
      expect(errorCodeOf(new LineCallError('RATE_LIMITED', 429))).toBe(
        'RATE_LIMITED',
      );
      expect(
        errorCodeOf(
          Object.assign(new Error('x'), { name: 'NoSuchKey', $metadata: {} }),
        ),
      ).toBe('NoSuchKey');
      expect(errorCodeOf(new BadGatewayException('x'))).toBe('HTTP_502');
      expect(errorCodeOf(new TypeError('x'))).toBe('TypeError');
      expect(errorCodeOf('weird')).toBe('Error');
    });
  });
});
