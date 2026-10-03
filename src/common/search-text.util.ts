/**
 * In-memory, case-insensitive substring matching for the Hub 5 / Hub 6 toolbars (design §1.2.3).
 *
 * 🔴 NEVER `LIKE`: Prisma's `contains` does not escape `%` / `_`, so a search for `%` would match
 * every row. Matching here is `String.includes` after NFC + Thai-locale lower-casing, so `%` and `_`
 * are literal BY CONSTRUCTION.
 */
export function normaliseSearch(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase('th');
}

/** True when `needle` (already trimmed) occurs in any of the `haystacks`. An empty needle matches all. */
export function matchesSearch(
  needle: string,
  haystacks: ReadonlyArray<string | null | undefined>,
): boolean {
  const n = normaliseSearch(needle.trim());
  if (n.length === 0) return true;
  return haystacks.some(
    (h) => typeof h === 'string' && normaliseSearch(h).includes(n),
  );
}
