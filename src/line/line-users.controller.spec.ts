import { NotFoundException } from '@nestjs/common';
import { AppAccess } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { LineUsersController } from './line-users.controller';
import { LineUserService } from './line-user.service';
import type { ListLineUsersQueryDto } from './dto/list-line-users-query.dto';

// Authz is exercised end-to-end in the e2e suite; here the controller-level guards are stubbed so
// this unit test focuses purely on the delegation from handler → service.
const ALLOW = { canActivate: () => true };

describe('LineUsersController', () => {
  let controller: LineUsersController;
  const users = {
    findManyPaginated: jest.fn(),
    updateAccess: jest.fn(),
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
    it('passes the id and the DTO `access` to the service and returns the updated row', async () => {
      const dto = { access: AppAccess.ALLOWED };
      const updated = { id: 'lu-1', access: AppAccess.ALLOWED };
      users.updateAccess.mockResolvedValue(updated);

      const result = await controller.updateAccess('lu-1', dto);

      expect(users.updateAccess).toHaveBeenCalledWith(
        'lu-1',
        AppAccess.ALLOWED,
      );
      expect(result).toBe(updated);
    });

    it('propagates a NotFoundException from the service (unknown/soft-deleted id)', async () => {
      users.updateAccess.mockRejectedValue(new NotFoundException());

      await expect(
        controller.updateAccess('gone', { access: AppAccess.BLOCKED }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
