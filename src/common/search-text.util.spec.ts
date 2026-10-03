import { matchesSearch, normaliseSearch } from './search-text.util';

describe('search-text.util', () => {
  it('matches case-insensitively as a substring', () => {
    expect(matchesSearch('abc', ['xxABCxx'])).toBe(true);
    expect(matchesSearch('abc', ['xyz', null, undefined])).toBe(false);
  });

  it('treats % and _ as literal characters, never wildcards', () => {
    expect(matchesSearch('%', ['100% sure'])).toBe(true);
    expect(matchesSearch('%', ['no percent here'])).toBe(false);
    expect(matchesSearch('a_c', ['abc'])).toBe(false);
    expect(matchesSearch('a_c', ['a_c'])).toBe(true);
  });

  it('matches an empty needle against everything', () => {
    expect(matchesSearch('   ', ['anything'])).toBe(true);
  });

  it('normalises Thai text (NFC) before comparing', () => {
    expect(normaliseSearch('ก\u0e48')).toBe(normaliseSearch('ก\u0e48'));
    expect(matchesSearch('ห้อง', ['ห้องประชุม'])).toBe(true);
  });
});
