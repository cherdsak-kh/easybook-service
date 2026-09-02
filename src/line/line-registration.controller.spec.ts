import { AppAccess } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { VENUE_NOT_FOUND } from '../venues/venues.constants';
import { CreateLineUserRegistrationDto } from './dto/create-line-user-registration.dto';
import { UpdateLineUserRegistrationDto } from './dto/update-line-user-registration.dto';
import { VenuesService } from '../venues/venues.service';
import type { ListVenuesQueryDto } from '../venues/dto/venue.dto';
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
  // The consumer venue reads delegate to the SAME service the admin controller uses; only the guard
  // in front differs. Mocked here for the same reason `users` is — this spec proves delegation, and
  // the service's own behaviour has its own spec.
  const venues = {
    list: jest.fn(),
    findById: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LineRegistrationController],
      providers: [
        { provide: LineUserService, useValue: users },
        { provide: VenuesService, useValue: venues },
      ],
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

      expect(users.getStatus).toHaveBeenCalledWith('U123', undefined);
      expect(result).toBe(status);
    });

    it('passes the ID token’s display claims through so a LINE rename reaches the DB', async () => {
      // LINE has no "profile changed" webhook, so this call — already authenticated against a
      // freshly verified token — is one of only two places a rename can be noticed. It must not
      // change the RESPONSE, only what the service writes on the side.
      const status = { access: AppAccess.UNREGISTERED, registration: null };
      users.getStatus.mockResolvedValue(status);
      const req = reqWith('U123');
      req.lineProfile = { displayName: 'Alicia', pictureUrl: 'https://l/1' };

      const result = await controller.getStatus(req);

      expect(users.getStatus).toHaveBeenCalledWith('U123', {
        displayName: 'Alicia',
        pictureUrl: 'https://l/1',
      });
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

  describe('GET /line-users/venues', () => {
    it('passes the query through to VenuesService.list and returns the list', async () => {
      const query: ListVenuesQueryDto = {
        q: 'หอประชุม',
        venueTypeId: 4,
        status: 'open',
      };
      const rows = [{ id: 'v1' }, { id: 'v2' }];
      venues.list.mockResolvedValue(rows);

      const result = await controller.listVenues(query);

      expect(venues.list).toHaveBeenCalledWith(query);
      expect(result).toBe(rows);
    });

    it('is identity-free: the catalogue is the same for every caller', async () => {
      // The token proves the caller may SEE the catalogue; it does not scope WHAT they see. This
      // handler is handed no request object at all — it cannot reach `req.lineUserId` even by
      // accident — so the only thing that reaches the service is the query.
      venues.list.mockResolvedValue([]);

      await controller.listVenues({});

      expect(venues.list).toHaveBeenCalledTimes(1);
      expect(venues.list).toHaveBeenCalledWith({});
    });

    it('returns closed venues untouched — the screen renders closedReason as an alert', async () => {
      // A closed venue stays VISIBLE to end users and accepts no new booking requests. Filtering it
      // out here would make it indistinguishable from a deleted one, and the detail screen would
      // have nothing to explain the absence with.
      const closed = [
        { id: 'v1', isOpen: false, closedReason: 'ปิดปรับปรุงพื้นสนาม' },
      ];
      venues.list.mockResolvedValue(closed);

      const result = await controller.listVenues({});

      expect(result).toBe(closed);
    });
  });

  describe('GET /line-users/venues/:id', () => {
    it('passes the id through to VenuesService.findById and returns the venue', async () => {
      const venue = { id: 'v1', name: 'หอประชุมวารณ' };
      venues.findById.mockResolvedValue(venue);

      const result = await controller.getVenue('v1');

      expect(venues.findById).toHaveBeenCalledWith('v1');
      expect(result).toBe(venue);
    });

    it('lets the service’s 404 propagate rather than translating it', async () => {
      // An unknown id and a soft-deleted one are the same 404 by contract. A controller-side
      // try/catch here would be the obvious place to accidentally make those two distinguishable.
      const notFound = new NotFoundException(VENUE_NOT_FOUND);
      venues.findById.mockRejectedValue(notFound);

      await expect(controller.getVenue('nope')).rejects.toBe(notFound);
      expect(venues.findById).toHaveBeenCalledWith('nope');
    });
  });
});
