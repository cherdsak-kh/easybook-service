import { SetMetadata } from '@nestjs/common';

/**
 * C5 exclusion (design §2.7, D-4). Applied at CLASS level to `LineController` (the webhook: LINE
 * retries, and its events are already caught per-event) and `HealthController`.
 *
 * Class metadata rather than a path-string allowlist, so a route rename cannot silently re-include a
 * controller that was meant to stay excluded.
 */
export const NO_ERROR_NOTIFICATION = 'NO_ERROR_NOTIFICATION';

export const NoErrorNotification = (): ClassDecorator & MethodDecorator =>
  SetMetadata(NO_ERROR_NOTIFICATION, true);
