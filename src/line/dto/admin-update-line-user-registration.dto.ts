import { CreateLineUserRegistrationDto } from './create-line-user-registration.dto';

/**
 * The body for the admin `PATCH /line-users/:id/registration` — a FULL re-submit of the six editable
 * registration fields by an `ADMIN`/`SUPER_ADMIN`.
 *
 * It `extends` `CreateLineUserRegistrationDto` so the validation shape is reused verbatim (required
 * fields, phone regex, non-empty names, `@Type(() => Number) @IsInt()`-coerced option ids) while
 * emitting its OWN named OpenAPI schema (`AdminUpdateLineUserRegistrationDto`) — the admin surface and
 * the LIFF self-edit surface (`UpdateLineUserRegistrationDto`) stay independently versionable even
 * though they carry identical fields today.
 *
 * There is deliberately **no `lineUserId` field** (the inherited chain has none): the 1:1 identity key
 * is strictly immutable, and the global `forbidNonWhitelisted: true` pipe answers `400` on any attempt
 * to send it. No code path writes it. This DTO is **NOT** PENDING-restricted — the service edits any
 * user that has a registration, regardless of `access`.
 */
export class AdminUpdateLineUserRegistrationDto extends CreateLineUserRegistrationDto {}
