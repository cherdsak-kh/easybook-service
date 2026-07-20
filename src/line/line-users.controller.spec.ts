import { NotFoundException } from '@nestjs/common';
import { AppAccess, SystemRole } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import type { AuthenticatedSystemUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { LineUsersController } from './line-users.controller';
import { LineUserService } from './line-user.service';
import type { ListLineUsersQueryDto } from './dto/list-line-users-query.dto';

// A minimal authenticated actor — only `role` is read by the handler (forwarded to the service).
const actor = (role: SystemRole): AuthenticatedSystemUser =>
  ({ id: 'su-1', role }) as AuthenticatedSystemUser;

// Authz is exercised end-to-end in the e2e suite; here the controller-level guards are stubbed so
// this unit test focuses purely on the delegation from handler → service.
const ALLOW = { canActivate: () => true };

describe('LineUsersController', () => {
  let controller: LineUsersController;
  const users = {
    findManyPaginated: jest.fn(),
    updateAccess: jest.fn(),
    updateRegistrationByAdmin: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LineUsersController],
      providers: [{ provide: LineUserService, useValue: users }],
    })
      .overrideGuard(SessionGuard)
      .useValue(ALLOW)
      .overrideGuard(RolesGuard)
      .useValue(ALLOW)
      .compile();
    controller = module.get<LineUsersController>(LineUsersController);
  });

  describe('GET /line-users', () => {
    it('delegates the query straight through to the service and returns its envelope', async () => {
      const query: ListLineUsersQueryDto = {
        page: 2,
        limit: 10,
        search: 'ali',
        access: AppAccess.BLOCKED,
      };
      const envelope = {
        data: [],
        meta: { page: 2, limit: 10, total: 0, totalPages: 0 },
      };
      users.findManyPaginated.mockResolvedValue(envelope);

      const result = await controller.list(query);

      expect(users.findManyPaginated).toHaveBeenCalledWith(query);
      expect(result).toBe(envelope);
    });
  });

  describe('PATCH /line-users/:id', () => {
    it('passes the id, the DTO `access`, and the actor role to the service and returns the updated row', async () => {
      const dto = { access: AppAccess.ALLOWED };
      const updated = { id: 'lu-1', access: AppAccess.ALLOWED };
      users.updateAccess.mockResolvedValue(updated);

      const result = await controller.updateAccess(
        'lu-1',
        dto,
        actor(SystemRole.ADMIN),
      );

      // The actor's session role (not any body field) governs the transition matrix in the service.
      expect(users.updateAccess).toHaveBeenCalledWith(
        'lu-1',
        AppAccess.ALLOWED,
        SystemRole.ADMIN,
      );
      expect(result).toBe(updated);
    });

    it('forwards SUPER_ADMIN as the role', async () => {
      users.updateAccess.mockResolvedValue({ id: 'lu-1' });
      await controller.updateAccess(
        'lu-1',
        { access: AppAccess.UNREGISTERED },
        actor(SystemRole.SUPER_ADMIN),
      );
      expect(users.updateAccess).toHaveBeenCalledWith(
        'lu-1',
        AppAccess.UNREGISTERED,
        SystemRole.SUPER_ADMIN,
      );
    });

    it('propagates a NotFoundException from the service (unknown/soft-deleted id)', async () => {
      users.updateAccess.mockRejectedValue(new NotFoundException());

      await expect(
        controller.updateAccess(
          'gone',
          { access: AppAccess.BLOCKED },
          actor(SystemRole.ADMIN),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('PATCH /line-users/:id/registration', () => {
    const dto = {
      firstName: 'Somchai',
      lastName: 'Jaidee',
      staffId: '6412345678',
      phone: '081-234-5678',
      departmentId: 1,
      personnelRoleId: 2,
    };

    it('passes the id, the DTO, and the actor role to the service and returns the updated row', async () => {
      const updated = { id: 'lu-1', access: AppAccess.ALLOWED };
      users.updateRegistrationByAdmin.mockResolvedValue(updated);

      const result = await controller.updateRegistrationByAdmin(
        'lu-1',
        dto,
        actor(SystemRole.ADMIN),
      );

      // The actor's session role (not any body field) is forwarded to the service.
      expect(users.updateRegistrationByAdmin).toHaveBeenCalledWith(
        'lu-1',
        dto,
        SystemRole.ADMIN,
      );
      expect(result).toBe(updated);
    });

    it('forwards SUPER_ADMIN as the role', async () => {
      users.updateRegistrationByAdmin.mockResolvedValue({ id: 'lu-1' });
      await controller.updateRegistrationByAdmin(
        'lu-1',
        dto,
        actor(SystemRole.SUPER_ADMIN),
      );
      expect(users.updateRegistrationByAdmin).toHaveBeenCalledWith(
        'lu-1',
        dto,
        SystemRole.SUPER_ADMIN,
      );
    });

    it('propagates a NotFoundException from the service (no registration / unknown / soft-deleted)', async () => {
      users.updateRegistrationByAdmin.mockRejectedValue(
        new NotFoundException(),
      );
      await expect(
        controller.updateRegistrationByAdmin(
          'gone',
          dto,
          actor(SystemRole.ADMIN),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
