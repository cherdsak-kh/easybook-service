import { createHmac } from 'node:crypto';
import {
  SESSION_HANDLE_LENGTH,
  SESSION_HANDLE_PATTERN,
  deriveHandleKey,
  sessionHandle,
} from './session-handle';

// The very library express-session signs its cookie with. It ships no types, hence the cast.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sign } = require('cookie-signature') as {
  sign: (value: string, secret: string) => string;
};

const SECRET = 'a-test-session-secret-that-is-long-enough-0123456789';
const SID = 'q8Zr1w3Yt0nB5mXk2VhLpC7sJdGaEoUf';

describe('session handle', () => {
  const key = deriveHandleKey(SECRET);

  it('is deterministic for a sid', () => {
    expect(sessionHandle(key, SID)).toBe(sessionHandle(key, SID));
  });

  it('is 22 base64url characters', () => {
    const handle = sessionHandle(key, SID);
    expect(handle).toHaveLength(SESSION_HANDLE_LENGTH);
    expect(handle).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(SESSION_HANDLE_PATTERN.test(handle)).toBe(true);
  });

  it('differs per sid', () => {
    expect(sessionHandle(key, SID)).not.toBe(sessionHandle(key, `${SID}x`));
  });

  it('differs per secret', () => {
    expect(sessionHandle(deriveHandleKey(`${SECRET}-other`), SID)).not.toBe(
      sessionHandle(key, SID),
    );
  });

  it('is not the sid and does not contain it', () => {
    const handle = sessionHandle(key, SID);
    expect(handle).not.toBe(SID);
    expect(handle).not.toContain(SID);
  });

  it('is NOT the cookie signature of the sid under the same secret (F-16: domain separation)', () => {
    // express-session signs the cookie as `s:<sid>.<signature>`, with this exact library.
    const signature = sign(SID, SECRET).split('.').slice(1).join('.');
    const signaturePrefix = signature
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .slice(0, SESSION_HANDLE_LENGTH);

    // The trap is real: a handle built the naive way WOULD be the first 22 chars of the signature...
    const naive = createHmac('sha256', SECRET)
      .update(SID)
      .digest('base64url')
      .slice(0, SESSION_HANDLE_LENGTH);
    expect(naive).toBe(signaturePrefix);

    // ...and the HKDF-separated handle is not.
    expect(sessionHandle(key, SID)).not.toBe(signaturePrefix);
  });

  it("the literal route segment 'others' can never be a handle", () => {
    expect(SESSION_HANDLE_PATTERN.test('others')).toBe(false);
    expect(SESSION_HANDLE_PATTERN.test('A'.repeat(21))).toBe(false);
    expect(SESSION_HANDLE_PATTERN.test('A'.repeat(23))).toBe(false);
    expect(SESSION_HANDLE_PATTERN.test(`${'A'.repeat(21)}.`)).toBe(false);
  });
});
