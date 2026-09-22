import { lineRetryKey, uuidV5 } from './line-retry-key';

const UUID_V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const U1 = `U${'1'.repeat(32)}`;
const U2 = `U${'2'.repeat(32)}`;
const U3 = `U${'3'.repeat(32)}`;
const SEED = 'clx_announcement|2026-09-22T08:05:00.000Z';

describe('uuidV5', () => {
  it('matches the RFC 4122 known-answer vector (DNS namespace, "python.org")', () => {
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org')).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    );
  });
});

describe('lineRetryKey (D-B, AC-2)', () => {
  it('is a version-5 UUID, the format LINE requires for X-Line-Retry-Key', () => {
    expect(lineRetryKey(SEED, [U1, U2])).toMatch(UUID_V5);
  });

  it('is deterministic for the same seed and members', () => {
    expect(lineRetryKey(SEED, [U1, U2])).toBe(lineRetryKey(SEED, [U1, U2]));
  });

  it('ignores member order (sorted for hashing only)', () => {
    expect(lineRetryKey(SEED, [U2, U1, U3])).toBe(
      lineRetryKey(SEED, [U3, U1, U2]),
    );
  });

  it('does not mutate the chunk it hashes', () => {
    const chunk = [U2, U1];
    lineRetryKey(SEED, chunk);
    expect(chunk).toEqual([U2, U1]);
  });

  it('differs when the announcement id changes', () => {
    expect(lineRetryKey('a|2026-09-22T08:05:00.000Z', [U1])).not.toBe(
      lineRetryKey('b|2026-09-22T08:05:00.000Z', [U1]),
    );
  });

  it('differs when updatedAt changes (an edit mints new keys)', () => {
    expect(lineRetryKey('a|2026-09-22T08:05:00.000Z', [U1])).not.toBe(
      lineRetryKey('a|2026-09-22T08:05:00.001Z', [U1]),
    );
  });

  it('differs when one member changes', () => {
    expect(lineRetryKey(SEED, [U1, U2])).not.toBe(lineRetryKey(SEED, [U1, U3]));
  });
});
