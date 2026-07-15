# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`easybook-service` is the standalone **NestJS** backend for EasyBook. It serves a versioned
REST contract under `/api/v1` and publishes an OpenAPI spec at `/docs-json`, which is the
source of truth the separate frontend repo (`easybook-app`, React/Vite/LIFF) generates its
types from. Runs on port 3300; frontend runs separately (default `http://localhost:2200`).

Stack: NestJS 11 · TypeScript · Prisma 7 + PostgreSQL (via `@prisma/adapter-pg`) · Swagger
(`@nestjs/swagger`) · LINE Messaging API (`@line/bot-sdk`).

## Commands

```bash
npm install
cp .env.example .env              # fill DATABASE_URL, LINE_* etc.
npm run prisma:generate           # regenerate the Prisma client after schema changes
npm run prisma:migrate            # apply/create migrations (prisma migrate dev)
npm run start:dev                 # watch mode, http://localhost:3300
npm run build                     # nest build
npm run lint                      # eslint --fix over src/apps/libs/test
npm run format                    # prettier --write over src and test
```

Tests:
```bash
npm test                          # unit tests (jest, rootDir: src, *.spec.ts)
npm test -- health.controller     # run a single spec by name/path filter
npm run test:watch
npm run test:cov
npm run test:e2e                  # e2e tests (test/*.e2e-spec.ts, separate jest config)
```

Other:
```bash
npm run prisma:studio             # inspect the DB
npm run line:setup-richmenu       # create/upload the two LINE rich menus (needs LINE_CHANNEL_ACCESS_TOKEN)
npm run auth:seed-superadmin      # create the first SUPER_ADMIN (idempotent; --force to override)
```

Redis must be running for anything session-backed. There is still no `docker-compose.yml` — see
the DOCKER-1 backlog item.

## Architecture

**Module wiring** (`src/app.module.ts`): `ConfigModule` (global, `validate: validateEnv`) →
`PrismaModule` (global) → `RedisModule` (global) → `CsrfModule` (global) → `ThrottlerModule`
(registered `global: true` so `LoginThrottleGuard` can resolve it) → `HealthModule` → `LineModule`
→ `AuthModule` → `SystemUsersModule`. Domain modules (Resource, Booking, etc.) don't exist yet —
they are added as their own future tasks; don't assume they're stubbed out anywhere.

**API surface**: the global prefix is `API_BASE_PATH` (`src/common/api.constants.ts` = `/api/v1`).
Controllers are mounted under that automatically via `main.ts`; don't hardcode `/api/v1` in
controller `@Controller()` paths.

**Prisma / DB access** (`src/prisma/`): `PrismaService` extends `PrismaClient` directly and is
provided by a `@Global()` `PrismaModule`, so any feature module injects `PrismaService` without
importing `PrismaModule`. Prisma 7 specifics:
- The connection URL for the CLI/Migrate lives in `prisma.config.ts` (reads `DATABASE_URL`).
- The runtime client connects via a driver adapter (`@prisma/adapter-pg`), constructed in
  `PrismaService`'s constructor — not the classic `datasource url` string.
- `$connect()` is fire-and-forget on `onModuleInit`: a DB outage never blocks app boot. Actual
  readiness is surfaced only via `GET /health`'s DB probe (2s time-boxed `SELECT 1`), not by
  throwing at startup. Keep this pattern when adding services that depend on external resources.

**LINE integration** (`src/line/`) is the most involved module:
- `LineController` (`POST /line/webhook`) is `@ApiExcludeController()` — intentionally outside
  the public REST/OpenAPI contract — and guarded by `LineSignatureGuard`, which HMAC-verifies
  the `x-line-signature` header against the *raw* request body. This requires
  `rawBody: true` on `NestFactory.create` (set in `main.ts`) so the exact bytes survive JSON
  parsing; don't remove that option or the guard breaks.
- `LineWebhookService.handleEvents` fans out webhook events and handles each independently —
  one event's failure is logged, never thrown, since LINE retries the whole webhook delivery on
  a non-2xx/exception response. Follow this pattern for new event types.
- `LineService` is a thin wrapper over `@line/bot-sdk`'s `MessagingApiClient` /
  `MessagingApiBlobClient` (reply/push messaging, rich-menu CRUD). Nothing here talks to Prisma.
- `LineUserService` owns the `LineUser` Prisma model: upsert-on-follow (preserves existing
  `access`/`richMenuType` on re-follow), soft-delete-on-unfollow (`deletedAt`, never a hard
  delete), and applying a user's `richMenuType` to their live LINE account.
- Rich menus are matched by **name + pixel size**, not by a stored LINE-side ID
  (`RICH_MENU_SPECS` in `rich-menu.constants.ts`, resolved via `LineService.findRichMenuId`).
  This is deliberate — it stays correct even if a menu is recreated with a new ID. The two
  menus are created/uploaded by `scripts/setup-rich-menu.ts` (run manually via
  `npm run line:setup-richmenu`); the images live in `assets/richmenu/`. If you change a menu's
  name or dimensions in the setup script, update `RICH_MENU_SPECS` to match.
- Manual rich-menu switching (the former standalone `PATCH /line/users/:lineUserId/rich-menu`
  route + its `LineUserController`) was **removed** — it was an unauthenticated access-control
  bypass and a second uncontrolled writer to derived state. The rich menu is now driven from a
  user's `access` via `LineUserService.updateAccess` (`ALLOWED → TYPE_2`, else `TYPE_1`), reusing
  the still-present `setRichMenuType` / `applyRichMenu` internals. See
  `claude_planning/20260714_1742_line_user_registration/`.

**Auth** (`src/auth/`, `src/system-users/`, `src/session/`, `src/csrf/`, `src/redis/`) — the
back-office (`SystemUser`) surface. LINE end-customers (`LineUser`) remain unauthenticated and the
two domains share **no session and no authentication surface**.

- **Wiring order is load-bearing** and lives in one place, `src/app.setup.ts` (`configureApp`,
  called by both `main.ts` and the e2e specs): CORS → global prefix → `cookie-parser` →
  `express-session` → session-store error handler → CSRF → CSRF error handler → `ValidationPipe`.
  `rawBody: true` on `NestFactory.create` must stay, and **`POST /line/webhook` is exempt from both
  the session middleware and CSRF** — it is a server-to-server callback with no cookie, authenticated
  by `LineSignatureGuard`'s HMAC. Break either and the webhook breaks. `GET /health` is also session-
  exempt, so a browser cookie can't make the liveness probe hit Redis.
- **Redis must fail closed.** `express-session` falls back to `MemoryStore` *only when the `store`
  option is absent*, so **never make `store` conditional** — no `redisUp ? store : undefined`, no
  `try/catch` fallback. Do **not** copy `PrismaService`'s fire-and-forget `$connect()` here: for
  Redis that would mean a silent `MemoryStore`. The app still *boots* with Redis down (eager connect
  + `retryStrategy`, no `await`, no throw); `GET /health` then reports `redis: 'down'`, and every
  session-backed or throttled request answers `503`.
- **The CSRF token is the `x-csrf-token` header, never a body field.** `forbidNonWhitelisted: true`
  would reject a `_csrf` body key with `400` before the CSRF middleware ever saw it. `GET`/`HEAD`/
  `OPTIONS` are exempt. Mint one at `GET /auth/system/csrf`; it is stateless and survives login.
- **`isActive` vs `deletedAt` are orthogonal and must both be checked.** `isActive = false` is a
  reversible suspension — the user exists, appears in listings, resolves as a `createdBy`.
  `deletedAt != null` is soft deletion — invisible to every route; the row survives *only* to keep
  the `createdById` audit chain resolvable. A soft-deleted user is usually still `isActive: true`,
  so checking `isActive` alone would authenticate a deleted account holding a live cookie.
  `SessionGuard` therefore `select`s `deletedAt`, checks it, and **strips it** before attaching the
  user to `req.systemUser` (otherwise it leaks straight into `GET /auth/system/me`).
  **Never hard-delete a `SystemUser`** — `DELETE /system-users/:id` is an `update`.
- **The email burn + restore contract.** `email` carries a plain `@unique` that spans soft-deleted
  rows, so a deleted user's address is burned forever: re-creating it is `409`. That is deliberate —
  it is exactly what makes `POST /system-users/:id/restore` safe (nobody can have claimed the
  address meanwhile, so restore can never collide). Restore the row; do not re-create it.
- **Authorization lives in exactly one file**, `src/system-users/system-users.policy.ts`, called
  inside the service's write transaction. `RolesGuard` stays coarse (role only) — it runs before
  `ValidationPipe` and outside the transaction, so it cannot see the DTO or the target row. Do not
  duplicate the matrix into a guard.
- **`SystemUser.lineUserId` footgun:** it is a **cuid** (`LineUser.id`), *not* the LINE-side `U…`
  identifier — which is what `LineUser.lineUserId` holds. Same field name, two models, different
  values. `prisma.systemUser.findUnique({ where: { lineUserId: event.source.userId } })` type-checks
  and returns `null` forever. The FK is a notification address ("reachable at"), never an identity
  ("is"); no route may authenticate a `SystemUser` via their LINE account.
- No session-revocation machinery exists, or may be added: `SessionGuard` re-reads the user from the
  DB on every authenticated request, so deletion, suspension and demotion all take effect on the
  victim's *next* request.

**Validation & docs**: global `ValidationPipe` uses `whitelist: true` + `forbidNonWhitelisted:
true` — DTOs are the strict transport-boundary contract, unknown/extra fields are rejected. This is
also the only enforcement needed for "PATCH cannot set `password`/`email`/`lineUserId`": those
fields simply don't exist on `UpdateSystemUserDto`. Note that `useDefineForClassFields` is effective
(`target: ES2023`), so `'role' in dto` is *always* true — test presence with `dto.role !== undefined`,
and use `@ValidateIf((_o, v) => v !== undefined)` (not `@IsOptional()`) on optional non-nullable
fields, or an explicit `null` reaches a `NOT NULL` column. Swagger is wired in `main.ts` and can be
disabled via `SWAGGER_ENABLED=false`; controllers not meant for the public contract (like the LINE
webhook) should use `@ApiExcludeController()`.

**Environment** (see `.env.example`): `PORT` (3300), `CORS_ORIGIN` (defaults to the Vite dev
server), `SWAGGER_ENABLED`, `DATABASE_URL`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`,
`REDIS_URL`, `SESSION_SECRET`, `CSRF_SECRET` (must differ from `SESSION_SECRET`),
`SESSION_COOKIE_NAME` / `_SECURE` / `_SAMESITE`, `SESSION_TTL_SECONDS`, and the `SEED_SUPER_ADMIN_*`
vars used only by the seed script. `src/config/env.validation.ts` fails the boot on a misconfigured
secret — that is a deploy defect, unlike an unreachable Redis, which is a runtime condition that
degrades to `503`. Backend and frontend are separate origins by design; with cookie sessions and
`credentials: true`, the `CORS_ORIGIN` allowlist is a security control and must never become `*`.

## Conventions

- Prettier: single quotes, trailing commas everywhere (`.prettierrc`). ESLint extends
  `typescript-eslint` recommended-type-checked + prettier; `no-explicit-any` is off,
  `no-floating-promises`/`no-unsafe-argument` are warnings, not errors.
- Unit specs sit next to their source file (`*.spec.ts`, e.g. `line-signature.guard.spec.ts`),
  run under the root `jest` config (`rootDir: src`). E2E specs live in `test/*.e2e-spec.ts`
  under their own config (`test/jest-e2e.json`), which pins `maxWorkers: 1` — they share one
  Postgres and one Redis, and would otherwise clobber each other's rate-limit counters.
- E2E specs need a live Postgres **and** Redis. They boot the app via `test/e2e-app.ts`, which calls
  the same `configureApp()` as `main.ts`, and they clean up their own rows (all fixture emails are
  prefixed `e2e-`).
