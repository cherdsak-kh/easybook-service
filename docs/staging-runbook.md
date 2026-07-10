# Staging deploy — external prerequisites & recovery runbook

Things this repo's CI/CD cannot fix by itself because they live outside it (server config, DNS,
Nginx, GHCR credential provisioning). Verify each before trusting the corresponding correctness
claim made elsewhere (Dockerfile, `main.ts`, `env.validation.ts`).

## Required GitHub Secrets (configure before first deploy)

Every secret referenced anywhere in `.github/workflows/ci.yml` and `.github/workflows/cd.yml`,
derived directly from the workflow files (not guessed). Configure all of these in the repo's
**Settings → Secrets and variables → Actions** before the first deploy — a missing secret resolves
to an empty string at runtime (except `STAGING_SSH_PORT`, which has an explicit `'22'` fallback) and
will fail the corresponding step, usually at SSH connect or GHCR auth.

- [ ] **`GITHUB_TOKEN`** — GHCR login for pushing images. Auto-provided by GitHub Actions; not a
  repo secret you create — listed here only because it appears in the workflow. Used in: **CI**
  (`build-and-push` job, `docker/login-action`).
- [ ] **`STAGING_SSH_HOST`** — hostname/IP of the staging server. Used in: **CD-deploy** (both the
  `appleboy/scp-action` compose-file copy step and the `appleboy/ssh-action` migrate+deploy step).
- [ ] **`STAGING_SSH_PORT`** — custom SSH port for the staging server (not the default 22). Falls
  back to `'22'` via `${{ secrets.STAGING_SSH_PORT || '22' }}` if unset, so setting it is optional
  only if the server actually listens on port 22. Used in: **CD-deploy** (same two steps as
  `STAGING_SSH_HOST`).
- [ ] **`STAGING_SSH_USER`** — SSH username for the staging server. Used in: **CD-deploy** (same two
  steps).
- [ ] **`STAGING_SSH_KEY`** — SSH private key for staging server auth. Used in: **CD-deploy** (same
  two steps).
- [ ] **`INFISICAL_TOKEN`** — Infisical machine-identity token used to resolve staging secrets
  (`DATABASE_URL`, etc.) inside the migrator and app containers at deploy time. Never persisted to
  disk on the server. Used in: **CD-deploy** (migrate+deploy SSH step, passed through to both the
  one-shot migrator container and the app container).
- [ ] **`INFISICAL_PROJECT_ID`** — Infisical project ID paired with `INFISICAL_TOKEN`. Used in:
  **CD-deploy** (same SSH step).
- [ ] **`GHCR_PULL_USER`** — service-account username for the staging server's own persistent
  `docker login ghcr.io` credential (see §3 below). Used in: **CD-deploy** (same SSH step).
- [ ] **`GHCR_PULL_TOKEN`** — GitHub PAT (`read:packages`) paired with `GHCR_PULL_USER`, used by the
  staging server to pull images from GHCR. Rotate per §3 below. Used in: **CD-deploy** (same SSH
  step).

## 1. Nginx `X-Forwarded-For` hygiene (hard prerequisite)

`main.ts` sets `app.set('trust proxy', TRUST_PROXY_HOPS)` with `TRUST_PROXY_HOPS=2`, on the
assumption that the request chain is exactly **Cloudflare → Nginx → app**, and that each hop
appends itself to `X-Forwarded-For` rather than letting the client forge it. That assumption is
**only true if Nginx is configured correctly** — there is no Nginx config in this repo, so this
must be verified on the staging box directly:

```nginx
server {
    listen 443 ssl;
    server_name staging.example.com;  # replace

    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;

        # REQUIRED: appends the real client IP to any inbound X-Forwarded-For instead of
        # overwriting it, so Express sees an accurate 2-hop chain (Cloudflare, Nginx) and
        # TRUST_PROXY_HOPS=2 resolves the correct left-most (genuine client) address.
        # Using `proxy_set_header X-Forwarded-For $remote_addr;` instead would DROP whatever
        # Cloudflare sent and break this.
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Additionally: Cloudflare's own edge IP is what Nginx sees as `$remote_addr`, and Cloudflare also
sends a `CF-Connecting-IP` header with the true client IP. If Cloudflare is in front of this Nginx,
either:
- restrict `listen` to Cloudflare's published IP ranges (so nothing can bypass Cloudflare and
  spoof `X-Forwarded-For` directly at Nginx), **or**
- have Nginx set `X-Forwarded-For` from `$http_cf_connecting_ip` instead of `$remote_addr`
  ancestry, if Cloudflare's proxy chain isn't otherwise trusted.

**This must be verified on the staging box before relying on `TRUST_PROXY_HOPS=2` /
`main.ts`'s trust-proxy comment for anything security-sensitive (the per-IP login rate
limiter).** Flagging it here rather than silently assuming it's already correct.

## 2. `SWAGGER_ENABLED` in staging

`SWAGGER_ENABLED` is opt-out (defaults to `true` — see `env.validation.ts` / `main.ts`). Staging
sits behind Cloudflare + Nginx with **no auth in front of `/docs`**, so the public OpenAPI surface
must be explicitly turned off there:

```
SWAGGER_ENABLED=false
```

Set this in the `staging` environment inside Infisical (not in this repo — there is no
`.env.production`/`.env.staging` committed with real values). Documented as a placeholder note in
`.env.staging.example`.

## 3. GHCR server-side auth (pull credential)

The staging server pulls images from `ghcr.io` on every deploy and needs its **own** persistent
`docker login ghcr.io` credential (a GitHub PAT scoped to `read:packages`, or a fine-grained token
with the equivalent). This is separate from the CI workflow's `GITHUB_TOKEN` (which is ephemeral,
scoped to the Actions run, and cannot be used from the server).

**Provisioning:**
1. Create a GitHub PAT (classic, `read:packages` scope; or fine-grained, `packages: read` on the
   `easybook-service` repo) owned by a service account, not a personal account.
2. Store it as a GitHub Actions secret (e.g. `GHCR_PULL_TOKEN`) for the `cd.yml` workflow to pass
   over SSH, which runs `docker login ghcr.io -u <service-account> -p "$GHCR_PULL_TOKEN"` on the
   server before each `docker pull`.

**Rotation:** GitHub PATs expire (or should be set to expire and be rotated manually/periodically).
**A stale/expired token silently breaks every future deploy** — `docker login` and
`docker pull` will fail on the server, `cd.yml`'s SSH step will exit non-zero (propagated, see
`docs/migration-safety-policy.md`'s "recovery" section below), so the failure is loud in CI, but
the *symptom* (auth failure) can look unrelated to "token expired" at a glance. When a deploy fails
at the `docker pull` / `docker login` step with an auth error, rotating `GHCR_PULL_TOKEN` is the
first thing to check.

## 4. Recovery runbook — partial-failure states

The CD workflow (`cd.yml`) is written so every SSH/SCP step propagates its exit code (no `|| true`,
no swallowed errors), so a failure anywhere fails the whole workflow loudly rather than leaving a
green checkmark on a broken deploy. Possible states the server can be left in, and how to check/fix:

| Failure point | Server state | How to check | Fix-forward |
|---|---|---|---|
| SCP of `docker-compose.staging.yml` fails | Old compose file (or none) on disk; old app container still running untouched | `ssh` in, `cat docker-compose.staging.yml` | Re-run the workflow; nothing was touched yet. |
| `docker login` (GHCR) fails | Old app container still running untouched | See §3 above | Rotate `GHCR_PULL_TOKEN`, re-run. |
| `docker pull` of the migrator image fails | Old app container still running untouched | Check network/GHCR status, retry | Re-run once the pull succeeds. |
| Migration container exits non-zero | **Schema may be PARTIALLY migrated** (Postgres DDL inside one migration file is transactional per-migration by default, but a multi-migration batch can leave earlier ones applied and a later one failed) — app **not yet redeployed**, old app container still running against the OLD schema it expects | `docker run --rm --network easybook-network <migrator image> npx prisma migrate status` (or inspect `_prisma_migrations` table directly) | Never redeploy an old image to "roll back" (see `docs/migration-safety-policy.md`). Write a new forward migration that completes/corrects the schema, re-run the migrate step, THEN re-run the app deploy step. |
| `docker-compose up -d` fails | Schema is migrated; app container may be stopped/absent — **possible downtime window** | `docker ps`, `docker-compose -f docker-compose.staging.yml ps` | Fix whatever `up -d` reported (image pull, resource limit, port conflict) and re-run `up -d`; the migration step does not need to re-run since it already succeeded and is idempotent to re-invoke anyway (`prisma migrate deploy` is a no-op on an up-to-date schema). |
| Post-deploy `/api/v1/health` poll times out | New app container is up but not passing readiness (DB/Redis unreachable, boot error) — traffic may be flowing to an unready container if nothing else gates it | `docker logs easybook-service`, hit `curl -s localhost:3300/api/v1/health` on the server directly | Check `docker logs` for the actual boot/readiness error (commonly: Infisical token/project misconfigured, or Postgres/Redis network issue) before assuming code regression. |

## 5. Image retention / disk hygiene

- **Server-side:** `cd.yml`'s deploy step ends with `docker image prune -f --filter "label!=keep"`
  scoped to dangling images only (safe — never removes an image with a running container attached,
  and does not touch the just-deployed or previous tag since both are referenced by a container or
  a `docker pull`-ed, non-dangling tag). It intentionally does **not** run `docker image prune -a`,
  which would happily delete the immediate rollback candidate.
- **GHCR-side:** GHCR has no automatic retention by default; images accumulate one per commit to
  `master` forever unless pruned. Recommended approach (not yet automated in this repo — flagging
  as a follow-up, not silently skipping it): a scheduled workflow using
  `actions/delete-package-versions` (or the `ghcr.io` package settings UI) to keep the last **N**
  (e.g. 20) SHA-tagged versions per image name (`easybook-service` and
  `easybook-service`-`migrator` tags), excluding any tag currently referenced by
  `docker-compose.staging.yml` on the server. Left for a follow-up `devops` task once there is
  real deploy volume to justify it — premature to build now (anti-over-engineering guardrail).
