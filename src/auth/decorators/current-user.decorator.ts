import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { AUTHENTICATION_REQUIRED } from '../auth.constants';
import type {
  AuthenticatedSystemUser,
  RequestWithSystemUser,
} from '../auth.types';

/** The `SystemUser` attached by `SessionGuard`. Only valid on `SessionGuard`-protected routes. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedSystemUser => {
    const req = ctx.switchToHttp().getRequest<RequestWithSystemUser>();
    if (!req.systemUser)
      throw new UnauthorizedException(AUTHENTICATION_REQUIRED);
    return req.systemUser;
  },
);
