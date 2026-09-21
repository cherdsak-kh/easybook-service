/**
 * `ประกาศและข่าวสาร` — the admin announcements surface (ANNOUNCE-API-1, phase 1: persistence + CRUD).
 *
 * ⚠️ THIS MODULE OWNS ITS OWN STRINGS, rather than importing the feedback module's — the house rule
 * `feedback.constants.ts` and `bookings.constants.ts` state: importing one module's user-facing string
 * into another couples two screens' copy together.
 *
 * Service-thrown errors carry these as ONE string `message` (machine-matchable, like
 * `FEEDBACK_UPDATE_EMPTY`); the ValidationPipe's refusals keep Nest's `string[]`.
 */

// ── LIMITS ───────────────────────────────────────────────────────────────────────────────────────

/**
 * `หัวข้อ` — 1–100 characters AFTER trimming (D-4). Lives in the DTO, never in the column
 * (`Announcement.title` is unbounded `text`): `varchar(n)` counts code points and `@MaxLength` counts
 * UTF-16 units, so a DB cap could 500 a value the DTO accepted.
 */
export const ANNOUNCEMENT_TITLE_MAX = 100;

/** `เนื้อหา` — at most 1000 characters after trimming; `''` is a valid (title-only) draft (D-4). */
export const ANNOUNCEMENT_BODY_MAX = 1000;

/** `q` — the same bound the feedback and booking queues put on their search boxes. */
export const ANNOUNCEMENT_SEARCH_MAX = 100;

/**
 * `departmentId` upper bound — Postgres `int4` max, the type of `Department.id`.
 *
 * ⚠️ NOT COSMETIC: without it, `3000000000` passes `@IsInt()`, reaches `department.findFirst`, and
 * Prisma throws "value out of range for type integer" — a 500 for what is plainly a bad input.
 */
export const ANNOUNCEMENT_DEPARTMENT_ID_MAX = 2_147_483_647;

/**
 * The three page sizes `PaginationBar` offers. Anything else is a 400, NEVER a clamp: the screen
 * prints each row's ordinal from the limit IT sent, so a silent clamp would make every ordinal wrong.
 */
export const ANNOUNCEMENT_PAGE_SIZES = [10, 20, 50] as const;

/**
 * The list's `status` FILTER — lowercase, and deliberately NOT the `AnnouncementStatus` enum.
 *
 * 🔴 PUBLISHED UNDER ITS OWN SWAGGER NAME, `AnnouncementStatusFilter` (design S-3). Registering this
 * under `AnnouncementStatus` would overwrite the `DRAFT|SENT` schema in `/docs-json` — the last
 * registration under a name wins (the `FeedbackUpdateStatus` lesson, C-4).
 */
export const ANNOUNCEMENT_STATUS_FILTERS = ['all', 'sent', 'draft'] as const;

export type AnnouncementStatusFilter =
  (typeof ANNOUNCEMENT_STATUS_FILTERS)[number];

// ── MESSAGES ─────────────────────────────────────────────────────────────────────────────────────

/** 404 for both an unknown and a malformed id — no cuid pipe (the feedback `getDetail` precedent). */
export const ANNOUNCEMENT_NOT_FOUND = 'Announcement not found.';

/**
 * 409 (D-2). A `SENT` row can be neither edited nor deleted. Also the answer when the conditional
 * write (`WHERE status = DRAFT`) matched nothing: the row was a draft a moment ago, and the write did
 * not apply (design S-6).
 */
export const ANNOUNCEMENT_SENT_IMMUTABLE =
  'A sent announcement cannot be edited or deleted.';

/** 400 (D-3). `audience = DEPARTMENT` with no department — sent or (on PATCH) stored. */
export const ANNOUNCEMENT_DEPARTMENT_REQUIRED =
  'departmentId is required when audience is DEPARTMENT.';

/** 400 (D-3). `audience = ALL` with a non-null `departmentId` — forbidden, never silently cleared. */
export const ANNOUNCEMENT_DEPARTMENT_NOT_ALLOWED =
  'departmentId must be null when audience is ALL.';

/**
 * 400 — NOT 404. The department is an INPUT to this write, not the addressed resource (the
 * `FEEDBACK_VENUE_INVALID` rule). ONE message for unknown, soft-deleted, and system-reserved-for-this-
 * actor (design S-5): a distinct answer would be an existence oracle over `departments`.
 */
export const ANNOUNCEMENT_DEPARTMENT_INVALID =
  'The selected department does not exist or is not available.';

/**
 * 400 (design S-2). A PATCH body with every field absent. Thrown by the SERVICE, not a DTO decorator,
 * so it is one machine-readable string — the `FEEDBACK_UPDATE_EMPTY` precedent.
 */
export const ANNOUNCEMENT_UPDATE_EMPTY =
  'Provide at least one field to update.';
