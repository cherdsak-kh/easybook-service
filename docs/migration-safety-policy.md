# Migration safety policy (additive-only, fix-forward)

This is a hard rule for every future change to `prisma/schema.prisma`, binding on `architect` and
`backend-dev`, not just on this CI/CD setup.

## The rule

1. **Every migration must be backward-compatible with the previous release.** The app version
   currently running (or about to be redeployed if a rollback is attempted) must keep working
   against the schema *after* the new migration is applied. In practice this means:
   - Adding a column: nullable or `DEFAULT`-ed, never `NOT NULL` with no default on an existing
     table with rows.
   - Renaming/dropping a column or table: split into an *expand* migration (add the new
     shape, dual-write/dual-read in app code) and a *contract* migration (drop the old shape) in a
     **later**, separate release — never as one migration in the same deploy that also stops
     writing the old column.
   - Changing a column's type: same expand/contract split.
2. **A bad migration is fixed with a NEW forward migration, never by redeploying an old
   SHA-tagged image.** Redeploying an older container image does **not** undo a `prisma migrate
   deploy` that already ran — the database keeps whatever schema the bad migration left it in. If
   the old image's code assumes the pre-migration schema, redeploying it makes things *worse*
   (code and schema now mismatch), not better. The only correct fix-forward path is: write a new
   migration that corrects the schema/data, `prisma migrate deploy` it, and only then deploy the
   corrected application code.
3. **Migrations run as a standalone, gated step, before the app container is touched.** See
   `.github/workflows/cd.yml`: a one-shot `migrator` container runs `prisma migrate deploy` and
   the app deploy step (`docker-compose up -d`) only executes if that container exits `0`. If the
   migration container exits non-zero, the workflow fails loudly and the previously-running app
   container is left exactly as it was (untouched) — see the recovery runbook in
   `docs/staging-runbook.md`.

## Why this matters here specifically

This deployment is a **single replica, health-gated cutover** (see the Dockerfile's `HEALTHCHECK`
and the CD workflow's post-deploy poll loop) — not a zero-downtime, multi-replica rollout. There is
no second instance still running the old code that could keep serving traffic if the new schema
breaks something, and there is no automated schema rollback. Getting the forward-only discipline
right is therefore the *only* safety net; there is no infrastructure-level one under it.

## Network requirement for the migration container

The one-shot migration container is started with `--network easybook-network` (the same external
network the app container and the pre-existing `postgres-sv`/`redis-sv` containers share). Its
Infisical-resolved `DATABASE_URL` **must** point at the `postgres-sv` Docker DNS name on that
network (e.g. `postgresql://user:pass@postgres-sv:5432/dbname`), **never** `localhost` —
`localhost` inside the migration container resolves to the container itself, which has no
Postgres listening on it, and the migration will fail to connect. This is set inside Infisical
(the staging environment's `DATABASE_URL` secret), not in any file in this repo — flagging it here
so a future secret-rotation doesn't silently reintroduce `localhost` for a "just testing" edit.
