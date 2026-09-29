import { Logger } from '@nestjs/common';
import { isDowngrade, VersionAnnouncer } from './version-announcer';

describe('isDowngrade', () => {
  it('a numerically smaller next version is a downgrade', () => {
    expect(isDowngrade('0.8.0', '0.7.0')).toBe(true);
    expect(isDowngrade('v0.8.0', 'v0.7.9')).toBe(true);
  });

  it('an upgrade or an equal version is never a downgrade', () => {
    expect(isDowngrade('0.7.0', '0.8.0')).toBe(false);
    expect(isDowngrade('0.8.0', '0.8.0')).toBe(false);
  });

  it('a non-numeric stamp on either side counts as changed, never as a downgrade', () => {
    expect(isDowngrade('abc123', '0.1.0')).toBe(false);
    expect(isDowngrade('0.8.0', 'deadbeef')).toBe(false);
  });

  it('compares segment by segment, not lexically', () => {
    expect(isDowngrade('0.9.0', '0.10.0')).toBe(false); // 10 > 9 numerically
  });
});

describe('VersionAnnouncer', () => {
  let appSetting: {
    findUnique: jest.Mock;
    createMany: jest.Mock;
    updateMany: jest.Mock;
  };
  let versionChanged: jest.Mock;
  let prisma: { appSetting: typeof appSetting };
  let triggers: { versionChanged: jest.Mock };
  let warn: jest.SpyInstance;

  const build = (httpAdapter: unknown = {}) =>
    new VersionAnnouncer(
      prisma as never,
      triggers as never,
      { httpAdapter } as never,
    );

  beforeEach(() => {
    appSetting = {
      findUnique: jest.fn(),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    prisma = { appSetting };
    versionChanged = jest.fn().mockResolvedValue(undefined);
    triggers = { versionChanged };
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => warn.mockRestore());

  it('no HTTP adapter (a CLI context) → no read, no write, no trigger', async () => {
    await build(null).announce('0.8.0');
    expect(appSetting.findUnique).not.toHaveBeenCalled();
    expect(versionChanged).not.toHaveBeenCalled();
  });

  it('current === "0.0.0" (unstamped box) → skipped', async () => {
    await build().announce('0.0.0');
    expect(appSetting.findUnique).not.toHaveBeenCalled();
    expect(versionChanged).not.toHaveBeenCalled();
  });

  it('a fresh DB (no stored row) records silently — no trigger', async () => {
    appSetting.findUnique.mockResolvedValue(null);
    await build().announce('0.8.0');
    expect(appSetting.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            key: 'system.last_announced_version',
            value: '0.8.0',
          }),
        ],
        skipDuplicates: true,
      }),
    );
    expect(versionChanged).not.toHaveBeenCalled();
  });

  it('the same version → no write, no trigger', async () => {
    appSetting.findUnique.mockResolvedValue({ value: '0.8.0' });
    await build().announce('0.8.0');
    expect(appSetting.updateMany).not.toHaveBeenCalled();
    expect(versionChanged).not.toHaveBeenCalled();
  });

  it('a swap count of 0 (another instance won the race) → no trigger', async () => {
    appSetting.findUnique.mockResolvedValue({ value: '0.7.0' });
    appSetting.updateMany.mockResolvedValue({ count: 0 });
    await build().announce('0.8.0');
    expect(versionChanged).not.toHaveBeenCalled();
  });

  it('an upgrade swaps AND triggers, with previous/current', async () => {
    appSetting.findUnique.mockResolvedValue({ value: '0.7.0' });
    await build().announce('0.8.0');
    expect(appSetting.updateMany).toHaveBeenCalledWith({
      where: { key: 'system.last_announced_version', value: '0.7.0' },
      data: { value: '0.8.0' },
    });
    expect(versionChanged).toHaveBeenCalledWith({
      previous: '0.7.0',
      current: '0.8.0',
    });
  });

  it('a downgrade swaps the stored value but does NOT trigger', async () => {
    appSetting.findUnique.mockResolvedValue({ value: '0.8.0' });
    await build().announce('0.7.0');
    expect(appSetting.updateMany).toHaveBeenCalled();
    expect(versionChanged).not.toHaveBeenCalled();
  });

  it('a non-numeric stamp change still triggers (not treated as a downgrade)', async () => {
    appSetting.findUnique.mockResolvedValue({ value: 'abc123' });
    await build().announce('def456');
    expect(versionChanged).toHaveBeenCalledWith({
      previous: 'abc123',
      current: 'def456',
    });
  });

  it('a read that throws is swallowed — announce() never rejects', async () => {
    appSetting.findUnique.mockRejectedValue(new Error('DB down'));
    await expect(build().announce('0.8.0')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(versionChanged).not.toHaveBeenCalled();
  });

  it('onApplicationBootstrap fires-and-forgets (non-blocking)', () => {
    appSetting.findUnique.mockResolvedValue({ value: '0.8.0' });
    const announcer = build();
    expect(() => announcer.onApplicationBootstrap()).not.toThrow();
  });
});
