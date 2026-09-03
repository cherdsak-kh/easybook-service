import { API_BASE_PATH } from '../common/api.constants';
import { CSRF_EXEMPT_PATHS, isCsrfExempt } from './csrf.service';

/**
 * The CSRF exemption list is a security control, and `CSRF_EXEMPT_PATTERNS` made it a REGEX-matched
 * one. That is the change worth testing: a literal list can only be wrong about routes somebody
 * typed, whereas a pattern can be wrong about routes nobody has ever seen.
 *
 * 🔴 THE FAILURE THIS FILE EXISTS TO CATCH IS SILENT. An over-wide pattern removes CSRF protection
 * from a cookie-session route and nothing anywhere throws — every request keeps working, and works
 * from a foreign origin too.
 */
describe('isCsrfExempt', () => {
  const p = (suffix: string) => `${API_BASE_PATH}${suffix}`;

  it('exempts every literal entry, unchanged', () => {
    for (const path of CSRF_EXEMPT_PATHS) {
      expect(isCsrfExempt(path)).toBe(true);
    }
  });

  it('exempts the two parameterised booking cancellations', () => {
    // The reason the pattern list had to exist: neither of these is a fixed string.
    expect(isCsrfExempt(p('/line-users/bookings/clx_abc123/cancel'))).toBe(
      true,
    );
    expect(isCsrfExempt(p('/line-users/bookings/BR-25690903-001/cancel'))).toBe(
      true,
    );
    expect(
      isCsrfExempt(p('/line-users/bookings/clx_abc/slots/clx_def/cancel')),
    ).toBe(true);
  });

  it('does NOT exempt the cookie-session admin surface', () => {
    // The whole admin surface answers to a cookie. If any of these ever comes back true, the
    // pattern above has been widened and the double-submit token has stopped being required.
    for (const path of [
      p('/auth/system/login'),
      p('/auth/system/password'),
      p('/system-users'),
      p('/system-users/clx_abc/reset-password'),
      p('/venues'),
      p('/venues/clx_abc/close'),
      p('/line-users/clx_abc'),
      p('/line-users/clx_abc/registration'),
    ]) {
      expect(isCsrfExempt(path)).toBe(false);
    }
  });

  it('cannot be widened by a crafted path', () => {
    for (const path of [
      // Not anchored at the end → a route smuggled in behind the exempt one.
      p('/line-users/bookings/clx_abc/cancel/../../system-users'),
      p('/line-users/bookings/clx_abc/cancelx'),
      // Not anchored at the start → an exemption reachable from any prefix.
      `/evil${p('/line-users/bookings/clx_abc/cancel')}`,
      // The id segment must not span a `/`.
      p('/line-users/bookings/a/b/cancel'),
      p('/line-users/bookings/clx_abc/slots/clx_def/ghi/cancel'),
      // A `.` in the pattern would have matched any character here.
      p('/line-usersXbookings/clx_abc/cancel'),
      // The parent path itself is a POST route and is already a literal; the LIST is a GET and is
      // exempt by method, not by path — neither may pick up a cancellation's exemption.
      p('/line-users/bookings/clx_abc'),
    ]) {
      expect(isCsrfExempt(path)).toBe(false);
    }
  });

  it('rejects an over-long id segment rather than matching unbounded input', () => {
    // Bounded on purpose: an exemption that accepts arbitrarily long input is one an attacker gets
    // to choose the shape of.
    expect(
      isCsrfExempt(p(`/line-users/bookings/${'a'.repeat(64)}/cancel`)),
    ).toBe(true);
    expect(
      isCsrfExempt(p(`/line-users/bookings/${'a'.repeat(65)}/cancel`)),
    ).toBe(false);
  });
});
