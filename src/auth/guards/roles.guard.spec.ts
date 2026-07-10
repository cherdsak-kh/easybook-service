import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SystemRole } from '@prisma/client';
import type {
  AuthenticatedSystemUser,
  RequestWithSystemUser,
} from '../auth.types';
import { RolesGuard } from './roles.guard';

const userWithRole = (role: SystemRole): AuthenticatedSystemUser =>
  ({ id: 'user-1', role }) as AuthenticatedSystemUser;

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;
  const getAllAndOverride = jest.fn();

  const contextFor = (req: RequestWithSystemUser): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    jest.clearAllMocks();
    reflector = { getAllAndOverride } as unknown as Reflector;
    guard = new RolesGuard(reflector);
  });

  it('allows a route with no @Roles metadata', () => {
    getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(contextFor({} as RequestWithSystemUser))).toBe(
      true,
    );
  });

  it('allows a route whose @Roles list is empty', () => {
    getAllAndOverride.mockReturnValue([]);
    expect(guard.canActivate(contextFor({} as RequestWithSystemUser))).toBe(
      true,
    );
  });

  it('reads the role from req.systemUser — the fresh DB read — not from the session (AC-28, AC-59)', () => {
    getAllAndOverride.mockReturnValue([SystemRole.SUPER_ADMIN]);
    const req = {
      systemUser: userWithRole(SystemRole.SUPER_ADMIN),
      session: { role: SystemRole.STAFF },
    } as unknown as RequestWithSystemUser;

    expect(guard.canActivate(contextFor(req))).toBe(true);
  });

  it.each([
    [SystemRole.SUPER_ADMIN, [SystemRole.SUPER_ADMIN], true],
    [SystemRole.ADMIN, [SystemRole.SUPER_ADMIN], false],
    [SystemRole.STAFF, [SystemRole.SUPER_ADMIN], false],
    [SystemRole.SUPER_ADMIN, [SystemRole.SUPER_ADMIN, SystemRole.ADMIN], true],
    [SystemRole.ADMIN, [SystemRole.SUPER_ADMIN, SystemRole.ADMIN], true],
    [SystemRole.STAFF, [SystemRole.SUPER_ADMIN, SystemRole.ADMIN], false],
  ])(
    'actor %s against @Roles(%s) → allowed=%s',
    (actorRole, required, allowed) => {
      getAllAndOverride.mockReturnValue(required);
      const req = {
        systemUser: userWithRole(actorRole),
      } as RequestWithSystemUser;

      if (allowed) {
        expect(guard.canActivate(contextFor(req))).toBe(true);
      } else {
        expect(() => guard.canActivate(contextFor(req))).toThrow(
          ForbiddenException,
        );
      }
    },
  );

  it('throws 403 when SessionGuard attached no user (defensive; SessionGuard runs first)', () => {
    getAllAndOverride.mockReturnValue([SystemRole.ADMIN]);
    expect(() =>
      guard.canActivate(contextFor({} as RequestWithSystemUser)),
    ).toThrow(ForbiddenException);
  });
});
