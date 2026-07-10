# syntax=docker/dockerfile:1.7
#
# Multi-stage build for easybook-service (NestJS, port 3300).
#
# Targets:
#   deps      - full dependency install (build tooling + prisma CLI), never shipped
#   build     - compiles TypeScript, generates the Prisma client, prunes devDependencies
#   infisical - fetches + checksum-verifies the standalone Infisical CLI binary ONCE; both
#               `migrator` and `runtime` below `COPY --from=infisical` it rather than each
#               re-downloading/re-installing it. Never shipped/tagged itself.
#   migrator  - standalone one-shot image: `prisma migrate deploy` only. Ships the `prisma`
#               CLI (a devDependency) on purpose because the `runtime` target below deliberately
#               does NOT. Built/pushed as its own tag (see .github/workflows/ci.yml) and run via
#               `docker run --rm --network easybook-network ...` from the CD workflow, BEFORE the
#               app container is (re)started. See docs/migration-safety-policy.md.
#   runtime   - the image that actually serves traffic. Minimal: compiled dist/ + pruned
#               production node_modules + the Infisical CLI. No devDependencies, no test files,
#               no source .ts, no secrets baked in at build time.
#
# Secrets: NOTHING is baked into any layer here. The runtime and migrator entrypoints both run
# under `infisical run --`, which resolves the actual secrets (DATABASE_URL, SESSION_SECRET,
# REDIS_URL, etc.) from Infisical at container-START time using INFISICAL_TOKEN, which is
# injected purely as a runtime env var by the CD workflow / compose file — never written to a
# Dockerfile, never present in `docker history`.

# ---------------------------------------------------------------------------
# deps
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
# QA cycle-2 F1 fix: `prisma generate` now also runs AFTER `npm prune --omit=dev`, not only
# before it. Previously the order was `prisma generate && npm run build && npm prune --omit=dev`
# — the prune ran LAST and could treat the generated `node_modules/.prisma` client artifacts as
# extraneous and delete them, crashing the `runtime` container at boot ("@prisma/client did not
# initialize yet") and timing out the CD health gate.
#
# The first `prisma generate` (using the locally installed devDependency CLI) still has to run
# BEFORE `npm run build`, because `tsc`/`nest build` type-checks against the generated client
# types — there is no `postinstall` hook in package.json, so skipping this would break
# compilation, not just runtime. `npm prune --omit=dev` then removes devDependencies, including
# the `prisma` CLI package itself, and may strip the generated `.prisma` client artifacts along
# with it. A second `prisma generate` runs LAST, after the prune, via `npx` pinned to the exact
# version already used to build @prisma/client (read from package.json — the prune does not
# remove the `@prisma/client` runtime dependency itself, only its generated internals) — this
# regenerates the client directly into the already-pruned `node_modules`, so it is the final
# write and nothing afterward can remove it again.
RUN npx prisma generate \
    && npm run build \
    && npm prune --omit=dev \
    && PRISMA_VERSION=$(node -p "require('./package.json').devDependencies.prisma") \
    && npx --yes prisma@${PRISMA_VERSION} generate

# ---------------------------------------------------------------------------
# infisical (shared; NOT the app image — just a fetch stage COPY'd from below)
# ---------------------------------------------------------------------------
# The `apk add infisical` package repo (artifacts-cli.infisical.com) started 404/403-ing
# ("unable to select packages: infisical (no such package)"), breaking `build-and-push`. Fixed
# by installing the official standalone binary directly from Infisical's GitHub Releases
# (github.com/Infisical/cli — NOTE this is a separate repo from github.com/Infisical/infisical,
# whose own releases don't carry CLI binary assets) instead of the apk repo.
#
# Deliberately NOT the `curl ... install.sh | bash` one-liner published in Infisical's docs:
# that script lives on a mutable branch — an unpinned, unverified supply-chain dependency for
# the exact binary that fetches our production secrets — and it assumes `bash` (Alpine ships
# busybox `ash`, not `bash`) and working apk resolution (the very thing that's broken).
#
# Instead: download the version-PINNED release tarball, verify it against Infisical's
# published `checksums.txt` for that release (fails the build on mismatch), extract, and
# install to /usr/local/bin — all in one RUN layer so the tarball/checksum file never persist
# in an image layer. curl + ca-certificates are only ever installed in THIS throwaway stage;
# they never reach `migrator` or `runtime`. The binary itself is statically linked (verified:
# `file` reports "statically linked", no glibc dependency), so it runs unmodified on musl/Alpine.
FROM alpine:3.20 AS infisical
# Pinned 2026-07-10 against github.com/Infisical/cli release v0.43.104 (latest at the time of
# this fix). Confirmed to exist via the GitHub Releases API and verified end-to-end: downloaded
# cli_0.43.104_linux_amd64.tar.gz, matched its sha256 against the release's checksums.txt, and
# extracted a valid statically-linked linux/amd64 ELF binary. Bump this ARG (and re-verify the
# checksum) to upgrade.
ARG INFISICAL_VERSION=0.43.104
WORKDIR /tmp
RUN apk add --no-cache curl ca-certificates \
    && curl -fsSLO "https://github.com/Infisical/cli/releases/download/v${INFISICAL_VERSION}/cli_${INFISICAL_VERSION}_linux_amd64.tar.gz" \
    && curl -fsSLO "https://github.com/Infisical/cli/releases/download/v${INFISICAL_VERSION}/checksums.txt" \
    && grep " cli_${INFISICAL_VERSION}_linux_amd64.tar.gz\$" checksums.txt > cli.sha256 \
    && sha256sum -c cli.sha256 \
    && tar xzf "cli_${INFISICAL_VERSION}_linux_amd64.tar.gz" infisical \
    && mv infisical /usr/local/bin/infisical \
    && chmod +x /usr/local/bin/infisical \
    && rm -rf /tmp/*

# ---------------------------------------------------------------------------
# migrator (one-shot; NOT the app image)
# ---------------------------------------------------------------------------
FROM deps AS migrator
WORKDIR /app
COPY prisma ./prisma
COPY prisma.config.ts ./

# Infisical CLI binary, built + checksum-verified once in the `infisical` stage above and
# copied in here (no re-download, no apk, no curl/bash in this image). `infisical run --`
# resolves DATABASE_URL at container-start time; that URL MUST resolve `postgres-sv` on the
# `easybook-network` Docker network (this container is started with --network easybook-network
# by the CD workflow), never `localhost` — see docs/migration-safety-policy.md.
COPY --from=infisical /usr/local/bin/infisical /usr/local/bin/infisical

ENTRYPOINT ["infisical", "run", "--"]
CMD ["npx", "prisma", "migrate", "deploy"]

# ---------------------------------------------------------------------------
# runtime (the app image)
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Infisical CLI binary, copied in from the shared `infisical` stage above (same
# checksum-verified binary as `migrator`). No curl/bash/apk step, no transient tooling to
# clean up, no token present at build time — INFISICAL_TOKEN only arrives via
# `docker run -e INFISICAL_TOKEN=...` / compose `environment:` at container runtime.
COPY --from=infisical /usr/local/bin/infisical /usr/local/bin/infisical

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node
EXPOSE 3300

# Health-GATED deploy support (see docs/migration-safety-policy.md — this is a brief-cutover
# health gate, deliberately NOT called "zero-downtime": there is exactly one replica, so the
# old container is stopped before the new one is confirmed healthy). Route matches the global
# API prefix (src/common/api.constants.ts -> API_BASE_PATH = '/api/v1') plus HealthController's
# `@Controller('health')` -> GET /api/v1/health, which returns 200 only when Postgres AND Redis
# are both reachable. busybox `wget` ships with the alpine base already, so no extra package.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD wget -qO- http://localhost:3300/api/v1/health || exit 1

# `infisical run --` resolves secrets (DATABASE_URL, SESSION_SECRET, CSRF_SECRET, REDIS_URL,
# LINE_*) at process start via INFISICAL_TOKEN; nothing is read from a baked-in .env.
CMD ["infisical", "run", "--", "node", "dist/main.js"]
