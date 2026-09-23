/**
 * THE one answer to "what version is this service running", shared by both endpoints that say so:
 * the admin `GET /api/v1/system/version` (`SystemController`) and the consumer
 * `GET /api/v1/line-users/version` (`NEEDS_DESIGN.md` §3).
 *
 * 🔴 IT HAS TO BE SHARED, and not for tidiness. The client's `#/version` screen exists to compare
 * its own build-time constant against the API's answer and report whether the two AGREE. If the two
 * endpoints could resolve the version differently, that comparison would be reporting on the
 * resolver rather than on the deploy — an amber "the server is behind" that no deploy can clear.
 *
 * ⚠️ Read at REQUEST time, never captured at module load: a container restarted with a new stamp
 * must report the new one without a code change.
 *
 * ⚠️ EMPTY IS UNSET, and `??` cannot express that. `.env.example` documents these by listing them
 * blank, so a copied `.env` sets each to `''` — a value, which `??` keeps, making the endpoint
 * answer `version: ""` on a box configured exactly the way the docs say to.
 */
const stamp = (v: string | undefined): string | undefined =>
  v && v.trim() ? v.trim() : undefined;

/**
 * `APP_VERSION` (the deploy's stamp) → `npm_package_version` (the dev fallback npm sets for
 * anything launched with `npm run`) → `0.0.0`.
 *
 * ⚠️ The order is load-bearing: a container runs `node dist/main`, npm sets nothing, and the
 * deploy's stamp must always win. The npm fallback exists so a developer box reports the code it is
 * actually running without anyone maintaining a second copy of the number in a `.env` — without it
 * every unstamped box answered `0.0.0` and the version screen showed a permanent amber warning,
 * which is how a warning colour stops being read by the time a real mismatch appears.
 */
export const resolveAppVersion = (): string =>
  stamp(process.env.APP_VERSION) ??
  stamp(process.env.npm_package_version) ??
  '0.0.0';
