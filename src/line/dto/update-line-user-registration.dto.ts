import { CreateLineUserRegistrationDto } from './create-line-user-registration.dto';

/**
 * The body for `PATCH /line-users/registration` (a PENDING user's self-edit — SC-3.3).
 *
 * A **full re-submit**, not a partial patch: the editable fields are identical to the create DTO,
 * so it `extends` it for DRY while emitting a distinct **named** OpenAPI schema
 * (`UpdateLineUserRegistrationDto`). Same validation applies — required fields, phone regex, option
 * ids validated non-deleted in the service, and no `lineUserId` field (impersonation guard +
 * `forbidNonWhitelisted`).
 */
export class UpdateLineUserRegistrationDto extends CreateLineUserRegistrationDto {}
