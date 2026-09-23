import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { PrismaService } from '../prisma/prisma.service';
import {
  parseSwaggerSetting,
  SWAGGER_SETTING_KEY,
  SwaggerGateService,
} from './swagger-gate.service';

/** `INTEGRATIONS-API-1` — precedence (plan D-1), persistence, and the 404 the gate answers. */

const config = (value?: string) =>
  ({
    get: jest.fn((key: string, fallback?: string) =>
      key === 'SWAGGER_ENABLED' ? (value ?? fallback) : fallback,
    ),
  }) as unknown as ConfigService;

const prismaWith = (row: { value: string } | null) => ({
  appSetting: {
    findUnique: jest.fn().mockResolvedValue(row),
    upsert: jest.fn().mockResolvedValue({}),
  },
});

const gate = async (env: string | undefined, row: { value: string } | null) => {
  const prisma = prismaWith(row);
  const svc = new SwaggerGateService(
    prisma as unknown as PrismaService,
    config(env),
  );
  await svc.onModuleInit();
  return { svc, prisma };
};

describe('parseSwaggerSetting', () => {
  it.each([
    ['true', true],
    [' TRUE ', true],
    ['false', false],
    ['yes', null],
    ['', null],
    [undefined, null],
  ])('%p → %p', (v, want) => expect(parseSwaggerSetting(v)).toBe(want));
});

describe('SwaggerGateService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('unset env, no row → OFF (secure by default)', async () => {
    expect((await gate(undefined, null)).svc.isEnabled()).toBe(false);
  });

  it('SWAGGER_ENABLED=true, no row → ON', async () => {
    expect((await gate('true', null)).svc.isEnabled()).toBe(true);
  });

  it('SWAGGER_ENABLED=false, no row → OFF', async () => {
    expect((await gate('false', null)).svc.isEnabled()).toBe(false);
  });

  it('a stored row wins over the env default, in both directions', async () => {
    expect((await gate('true', { value: 'false' })).svc.isEnabled()).toBe(
      false,
    );
    expect((await gate(undefined, { value: 'true' })).svc.isEnabled()).toBe(
      true,
    );
  });

  it('a malformed row falls back to the env default', async () => {
    expect((await gate('true', { value: 'maybe' })).svc.isEnabled()).toBe(true);
  });

  it('a failed read keeps the env default instead of failing boot', async () => {
    const prisma = prismaWith(null);
    prisma.appSetting.findUnique.mockRejectedValue(new Error('db down'));
    const svc = new SwaggerGateService(
      prisma as unknown as PrismaService,
      config('true'),
    );
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(svc.isEnabled()).toBe(true);
  });

  it('set() persists the row and flips the live flag', async () => {
    const { svc, prisma } = await gate(undefined, null);
    await expect(svc.set(true)).resolves.toBe(true);
    expect(svc.isEnabled()).toBe(true);
    expect(prisma.appSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: SWAGGER_SETTING_KEY },
        update: { value: 'true' },
      }),
    );
  });

  it('set() leaves the flag alone when the write fails', async () => {
    const { svc, prisma } = await gate(undefined, null);
    prisma.appSetting.upsert.mockRejectedValue(new Error('db down'));
    await expect(svc.set(true)).rejects.toThrow('db down');
    expect(svc.isEnabled()).toBe(false);
  });

  describe('middleware()', () => {
    const run = (svc: SwaggerGateService, url = '/docs-json?x=1') => {
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      const next = jest.fn();
      svc.middleware()(
        { method: 'GET', originalUrl: url } as Request,
        res as unknown as Response,
        next as NextFunction,
      );
      return { res, next };
    };

    it("disabled → Nest's own not-found body, query string dropped, next() not called", async () => {
      const { svc } = await gate(undefined, null);
      const { res, next } = run(svc);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        message: 'Cannot GET /docs-json',
        error: 'Not Found',
        statusCode: 404,
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('enabled → next()', async () => {
      const { svc } = await gate('true', null);
      const { res, next } = run(svc);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
