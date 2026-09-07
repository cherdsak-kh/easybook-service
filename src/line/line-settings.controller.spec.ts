import { Test, TestingModule } from '@nestjs/testing';
import { UpdateLineUserSettingsDto } from './dto/line-user-settings.dto';
import { LineIdTokenGuard } from './guards/line-id-token.guard';
import { LineSettingsController } from './line-settings.controller';
import { LineUserService } from './line-user.service';
import type { RequestWithLineUserId } from './line.types';

// The guard has its own unit spec; here it is stubbed so this test focuses on handler → service
// delegation and, crucially, that identity comes from `req.lineUserId` and nowhere else.
const ALLOW = { canActivate: () => true };

const reqWith = (lineUserId?: string): RequestWithLineUserId =>
  ({ lineUserId }) as RequestWithLineUserId;

describe('LineSettingsController', () => {
  let controller: LineSettingsController;
  const users = {
    getSettings: jest.fn(),
    patchSettings: jest.fn(),
    getClientVersion: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LineSettingsController],
      providers: [{ provide: LineUserService, useValue: users }],
    })
      .overrideGuard(LineIdTokenGuard)
      .useValue(ALLOW)
      .compile();
    controller = module.get<LineSettingsController>(LineSettingsController);
  });

  describe('GET /line-users/settings', () => {
    it('derives the identity from req.lineUserId (never a param) and returns the settings', async () => {
      const settings = {
        theme: 'system',
        notifications: {
          announcements: true,
          decisions: true,
          reminders: true,
        },
        updatedAt: null,
      };
      users.getSettings.mockResolvedValue(settings);

      const result = await controller.getSettings(reqWith('U123'));

      expect(users.getSettings).toHaveBeenCalledWith('U123');
      expect(result).toBe(settings);
    });

    it('cannot read another user’s settings — the sub is the ONLY argument that reaches the service', async () => {
      // There is no `:id` on this route and no body on a GET, so the only value a client controls
      // is the token. Two different subs must produce two different service calls, and nothing on
      // the request object may leak into either.
      users.getSettings.mockResolvedValue({});
      const req = reqWith('U-A');
      (req as unknown as Record<string, unknown>).query = {
        lineUserId: 'U-B',
      };
      (req as unknown as Record<string, unknown>).params = { id: 'U-B' };

      await controller.getSettings(req);

      expect(users.getSettings).toHaveBeenCalledTimes(1);
      expect(users.getSettings).toHaveBeenCalledWith('U-A');
    });
  });

  describe('PATCH /line-users/settings', () => {
    it('passes the verified sub and the DTO to the service', async () => {
      const dto: UpdateLineUserSettingsDto = {
        notifications: { decisions: false },
      };
      const settings = {
        theme: 'system',
        notifications: {
          announcements: true,
          decisions: false,
          reminders: true,
        },
        updatedAt: new Date('2026-09-07T12:51:05.000Z'),
      };
      users.patchSettings.mockResolvedValue(settings);

      const result = await controller.patchSettings(reqWith('U123'), dto);

      expect(users.patchSettings).toHaveBeenCalledWith('U123', dto);
      expect(result).toBe(settings);
    });

    it('cannot patch another user’s settings — a body-borne id never reaches the service', async () => {
      // `forbidNonWhitelisted` already 400s a `lineUserId` key before this handler runs; this pins
      // the second half — even if one arrived, the handler passes the verified sub, not the body.
      users.patchSettings.mockResolvedValue({});
      const smuggled = {
        lineUserId: 'U-B',
        notifications: { reminders: false },
      } as unknown as UpdateLineUserSettingsDto;

      await controller.patchSettings(reqWith('U-A'), smuggled);

      expect(users.patchSettings).toHaveBeenCalledWith('U-A', smuggled);
      const [sub] = users.patchSettings.mock.calls[0] as [string, unknown];
      expect(sub).toBe('U-A');
    });

    it('lets a service rejection propagate rather than translating it', async () => {
      const boom = new Error('db down');
      users.patchSettings.mockRejectedValue(boom);

      await expect(controller.patchSettings(reqWith('U123'), {})).rejects.toBe(
        boom,
      );
    });
  });

  describe('GET /line-users/version', () => {
    it('returns the service’s version payload and is identity-free', () => {
      // The token proves the caller may SEE the version; it does not scope WHAT they see. This
      // handler is handed no request object at all, so it cannot reach `req.lineUserId` by accident.
      const payload = { version: '0.14.0', status: 'ok' };
      users.getClientVersion.mockReturnValue(payload);

      const result = controller.getVersion();

      expect(users.getClientVersion).toHaveBeenCalledWith();
      expect(result).toBe(payload);
    });
  });
});
