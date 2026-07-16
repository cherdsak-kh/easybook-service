import { R2_VARS, validateEnv } from './env.validation';

/** The minimum that already satisfies the pre-existing rules, so only R2 is under test. */
const BASE = { REDIS_URL: 'redis://localhost:6379/0' };

const R2_OK = {
  R2_ACCOUNT_ID: 'abc123def456abc123def456abc12345',
  R2_ACCESS_KEY_ID: 'ak-1234567890',
  R2_SECRET_ACCESS_KEY: 'sk-abcdefghijklmnop',
  R2_BUCKET: 'easybook-dev',
  R2_PUBLIC_BASE_URL: 'https://pub-abc123.r2.dev',
};

const expectError = (env: Record<string, unknown>, match: RegExp) =>
  expect(() => validateEnv(env)).toThrow(match);

describe('validateEnv — Cloudflare R2 (AC-B14)', () => {
  it('exports exactly the five documented vars — no R2_REGION, no R2_ENDPOINT', () => {
    expect([...R2_VARS]).toEqual([
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
      'R2_PUBLIC_BASE_URL',
    ]);
  });

  it('boots with NO R2 config at all in dev/test — a developer need not provision a bucket', () => {
    expect(() => validateEnv({ ...BASE })).not.toThrow();
  });

  it('boots with all five set', () => {
    expect(() => validateEnv({ ...BASE, ...R2_OK })).not.toThrow();
  });

  // ─────────────────── all-or-nothing (every environment) ───────────────────

  it.each(R2_VARS)(
    'fails boot when only %s is set — a half-configured bucket must not boot',
    (name) => {
      expectError({ ...BASE, [name]: R2_OK[name] }, /partially configured/i);
    },
  );

  it.each(R2_VARS)('fails boot when %s is the ONLY one missing', (name) => {
    const env: Record<string, unknown> = { ...BASE, ...R2_OK };
    delete env[name];
    expectError(env, new RegExp(`partially configured[\\s\\S]*${name}`, 'i'));
  });

  // ─────────────────── production-required ───────────────────

  it.each(R2_VARS)('requires %s in production', (name) => {
    const env: Record<string, unknown> = {
      ...BASE,
      ...R2_OK,
      NODE_ENV: 'production',
      SESSION_SECRET: 'a'.repeat(32),
      CSRF_SECRET: 'b'.repeat(32),
      SESSION_COOKIE_SECURE: 'true',
      CORS_ORIGIN: 'https://admin.example.com',
      LINE_LOGIN_CHANNEL_ID: '1234567890',
    };
    delete env[name];
    expectError(env, new RegExp(`${name} is required in production`));
  });

  // ─────────────────── format checks (any environment) ───────────────────

  it.each([
    ['a space', 'has space'],
    ['too short', 'abc'],
    ['illegal punctuation', 'abc123$%^&*()!!'],
  ])('rejects an R2_ACCOUNT_ID with %s', (_label, value) => {
    expectError({ ...BASE, ...R2_OK, R2_ACCOUNT_ID: value }, /R2_ACCOUNT_ID/);
  });

  it.each([
    ['uppercase', 'EasyBook-Dev'],
    ['an underscore', 'easybook_dev'],
    ['too short', 'ab'],
    ['a leading hyphen', '-easybook'],
  ])('rejects an R2_BUCKET with %s', (_label, value) => {
    expectError({ ...BASE, ...R2_OK, R2_BUCKET: value }, /R2_BUCKET/);
  });

  it('AC-B15 — rejects a NON-https R2_PUBLIC_BASE_URL at BOOT, making https a boot-time guarantee', () => {
    expectError(
      { ...BASE, ...R2_OK, R2_PUBLIC_BASE_URL: 'http://pub-abc123.r2.dev' },
      /R2_PUBLIC_BASE_URL must use https/,
    );
  });

  it.each([
    ['is not a URL', 'not a url at all'],
    ['is protocol-relative', '//pub-abc123.r2.dev'],
  ])('rejects an R2_PUBLIC_BASE_URL that %s', (_label, value) => {
    expectError(
      { ...BASE, ...R2_OK, R2_PUBLIC_BASE_URL: value },
      /R2_PUBLIC_BASE_URL/,
    );
  });

  it('rejects a trailing slash — the key is joined with "/" and would double it', () => {
    expectError(
      { ...BASE, ...R2_OK, R2_PUBLIC_BASE_URL: 'https://pub-abc123.r2.dev/' },
      /trailing slash/,
    );
  });

  it.each([
    ['a query string', 'https://pub-abc123.r2.dev?x=1'],
    ['a hash', 'https://pub-abc123.r2.dev#x'],
  ])('rejects an R2_PUBLIC_BASE_URL carrying %s', (_label, value) => {
    expectError(
      { ...BASE, ...R2_OK, R2_PUBLIC_BASE_URL: value },
      /query string or hash/,
    );
  });

  it('accepts a custom https domain as the public base', () => {
    expect(() =>
      validateEnv({
        ...BASE,
        ...R2_OK,
        R2_PUBLIC_BASE_URL: 'https://cdn.easybook.example.com',
      }),
    ).not.toThrow();
  });

  it('never echoes a secret value in the error message', () => {
    const secret = 'super-secret-key-material-do-not-leak';
    try {
      validateEnv({
        ...BASE,
        R2_SECRET_ACCESS_KEY: secret,
        R2_ACCESS_KEY_ID: secret,
      });
      throw new Error('expected validateEnv to throw');
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
});
