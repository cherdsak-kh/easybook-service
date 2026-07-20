import { AppAccess } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { CreateLineUserRegistrationDto } from './dto/create-line-user-registration.dto';
import { UpdateLineUserRegistrationDto } from './dto/update-line-user-registration.dto';
import { LineIdTokenGuard } from './guards/line-id-token.guard';
import { LineRegistrationController } from './line-registration.controller';
import { LineUserService } from './line-user.service';
import type { RequestWithLineUserId } from './line.types';

// The guard is exercised in its own unit spec; here it is stubbed so this test focuses on the
// handler → service delegation and, crucially, that identity comes from `req.lineUserId` only.
const ALLOW = { canActivate: () => true };

const reqWith = (lineUserId?: string): RequestWithLineUserId =>
  ({ lineUserId }) as RequestWithLineUserId;

const DTO: CreateLineUserRegistrationDto = {
  firstName: 'Somchai',
  lastName: 'Jaidee',
  staffId: '6412345678',
  phone: '081-234-5678',
  departmentId: 1,
  personnelRoleId: 2,
};

describe('LineRegistrationController', () => {
  let controller: LineRegistrationController;
  const users = {
    register: jest.fn(),
    getStatus: jest.fn(),
    getRegistrationOptions: jest.fn(),
    updateRegistration: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LineRegistrationController],
      providers: [{ provide: LineUserService, useValue: users }],
    })
      .overrideGuard(LineIdTokenGuard)
      .useValue(ALLOW)
      .compile();
    controller = module.get<LineRegistrationController>(
      LineRegistrationController,
    );
  });

  describe('GET /line-users/status', () => {
    it('derives the identity from req.lineUserId (never a param) and returns the status view', async () => {
      const status = { access: AppAccess.UNREGISTERED, registration: null };
      users.getStatus.mockResolvedValue(status);

      const result = await controller.getStatus(reqWith('U123'));

      expect(users.getStatus).toHaveBeenCalledWith('U123');
      expect(result).toBe(status);
    });
  });

  describe('GET /line-users/registration/options', () => {
    it('returns the combined option lists (no identity needed)', async () => {
      const options = { departments: [], personnelRoles: [] };
      users.getRegistrationOptions.mockResolvedValue(options);

      const result = await controller.getOptions();

      expect(users.getRegistrationOptions).toHaveBeenCalledWith();
      expect(result).toBe(options);
    });
  });

  describe('POST /line-users/register', () => {
    it('passes the verified sub and the DTO to the service', async () => {
      const status = {
        access: AppAccess.PENDING,
        registration: { id: 'reg-1' },
      };
      users.register.mockResolvedValue(status);

      const result = await controller.register(reqWith('U123'), DTO);

      expect(users.register).toHaveBeenCalledWith('U123', DTO);
      expect(result).toBe(status);
    });
  });

  describe('PATCH /line-users/registration', () => {
    it('passes the verified sub and the edit DTO to the service', async () => {
      const dto: UpdateLineUserRegistrationDto = { ...DTO };
      const status = {
        access: AppAccess.PENDING,
        registration: { id: 'reg-1' },
      };
      users.updateRegistration.mockResolvedValue(status);

      const result = await controller.updateRegistration(reqWith('U123'), dto);

      expect(users.updateRegistration).toHaveBeenCalledWith('U123', dto);
      expect(result).toBe(status);
    });
  });
});
