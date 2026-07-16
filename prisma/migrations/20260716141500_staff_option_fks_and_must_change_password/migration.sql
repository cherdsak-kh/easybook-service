-- Staff Management: replace SystemUser's free-text `position`/`department` with required FKs into
-- the admin-curated `personnel_roles` / `departments` option tables, and add `mustChangePassword`.
--
-- HAND-AUTHORED, fix-forward. Prisma's auto-generated SQL for this delta is a drop-and-add:
--   ALTER TABLE "system_users" DROP COLUMN "department", DROP COLUMN "position",
--     ADD COLUMN "departmentId" INTEGER NOT NULL, ADD COLUMN "personnelRoleId" INTEGER NOT NULL;
-- which destroys every free-text value (AC-B2) and cannot even execute on a populated table (a
-- NOT NULL add with no default). The body below is the design's recipe
-- (claude_planning/20260716_1342_staff_management/02_design_log.md §2), in order.
--
-- 20260715140000_init is NOT edited. The two PARTIAL unique indexes on departments/personnel_roles
-- (`WHERE "deletedAt" IS NULL`) live there in raw SQL and are deliberately untouched here.
--
-- norm(x) below is btrim(regexp_replace(x, '\s+', ' ', 'g')) — trim, collapse internal whitespace.

-- 1. mustChangePassword: add with the model default, then BACKFILL EVERY EXISTING ROW TO false.
--    AC-B6 lives on this line. Without the UPDATE, the seeded super admin is bricked behind a
--    screen demanding a temp password that nobody was ever issued.
ALTER TABLE "system_users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT true;
UPDATE "system_users" SET "mustChangePassword" = false;

-- 2. FK columns, NULLABLE for now (a NOT NULL add with no default would fail on a populated table).
ALTER TABLE "system_users" ADD COLUMN "departmentId" INTEGER;
ALTER TABLE "system_users" ADD COLUMN "personnelRoleId" INTEGER;

-- 3. Auto-create an option per DISTINCT existing value (PO decision 2).
--    * DISTINCT ON (lower(norm)) dedupes case variants ("IT" / "it") into ONE option, picking a
--      deterministic casing (ORDER BY lower(norm), norm).
--    * NOT EXISTS (case-insensitive, active-only) reuses an option that already exists rather than
--      duplicating it — required, because the partial unique index on active names is
--      case-SENSITIVE and would happily accept "IT" alongside "it", producing junk options.
--    * norm <> '' skips empty/whitespace values; they get the fallback in step 4.
INSERT INTO "departments" ("name", "createdAt", "updatedAt")
SELECT DISTINCT ON (lower(n.norm)) n.norm, now(), now()
FROM (SELECT btrim(regexp_replace("department", '\s+', ' ', 'g')) AS norm FROM "system_users") n
WHERE n.norm <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "departments" d
    WHERE lower(d."name") = lower(n.norm) AND d."deletedAt" IS NULL
  )
ORDER BY lower(n.norm), n.norm;

INSERT INTO "personnel_roles" ("name", "createdAt", "updatedAt")
SELECT DISTINCT ON (lower(n.norm)) n.norm, now(), now()
FROM (SELECT btrim(regexp_replace("position", '\s+', ' ', 'g')) AS norm FROM "system_users") n
WHERE n.norm <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "personnel_roles" p
    WHERE lower(p."name") = lower(n.norm) AND p."deletedAt" IS NULL
  )
ORDER BY lower(n.norm), n.norm;

-- 4. Fallback option for empty/whitespace values, created ONLY if such a row exists.
INSERT INTO "departments" ("name", "createdAt", "updatedAt")
SELECT 'Unspecified', now(), now()
WHERE EXISTS (
    SELECT 1 FROM "system_users"
    WHERE btrim(regexp_replace("department", '\s+', ' ', 'g')) = ''
  )
  AND NOT EXISTS (
    SELECT 1 FROM "departments" WHERE lower("name") = 'unspecified' AND "deletedAt" IS NULL
  );

INSERT INTO "personnel_roles" ("name", "createdAt", "updatedAt")
SELECT 'Unspecified', now(), now()
WHERE EXISTS (
    SELECT 1 FROM "system_users"
    WHERE btrim(regexp_replace("position", '\s+', ' ', 'g')) = ''
  )
  AND NOT EXISTS (
    SELECT 1 FROM "personnel_roles" WHERE lower("name") = 'unspecified' AND "deletedAt" IS NULL
  );

-- 5. Link every staff row to its option (case-insensitive match on the normalised value).
UPDATE "system_users" u SET "departmentId" = d."id"
FROM "departments" d
WHERE d."deletedAt" IS NULL
  AND lower(d."name") = lower(NULLIF(btrim(regexp_replace(u."department", '\s+', ' ', 'g')), ''));

UPDATE "system_users" u SET "departmentId" = d."id"
FROM "departments" d
WHERE u."departmentId" IS NULL AND d."deletedAt" IS NULL AND d."name" = 'Unspecified';

UPDATE "system_users" u SET "personnelRoleId" = p."id"
FROM "personnel_roles" p
WHERE p."deletedAt" IS NULL
  AND lower(p."name") = lower(NULLIF(btrim(regexp_replace(u."position", '\s+', ' ', 'g')), ''));

UPDATE "system_users" u SET "personnelRoleId" = p."id"
FROM "personnel_roles" p
WHERE u."personnelRoleId" IS NULL AND p."deletedAt" IS NULL AND p."name" = 'Unspecified';

-- 6. HARD GUARD. If anything is still NULL the migration ABORTS and the CD job fails loudly,
--    leaving the running app untouched (migration-safety-policy §3). Never SET NOT NULL on faith.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "system_users" WHERE "departmentId" IS NULL OR "personnelRoleId" IS NULL)
  THEN RAISE EXCEPTION 'Backfill incomplete: system_users rows lack departmentId/personnelRoleId';
  END IF;
END $$;

-- 7. Constrain. Names MUST match Prisma's conventions or the next `migrate dev` reports drift.
--    Verified against `prisma migrate diff --from-config-datasource --to-schema --script`.
ALTER TABLE "system_users" ALTER COLUMN "departmentId" SET NOT NULL;
ALTER TABLE "system_users" ALTER COLUMN "personnelRoleId" SET NOT NULL;
CREATE INDEX "system_users_departmentId_idx" ON "system_users"("departmentId");
CREATE INDEX "system_users_personnelRoleId_idx" ON "system_users"("personnelRoleId");
ALTER TABLE "system_users" ADD CONSTRAINT "system_users_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "system_users" ADD CONSTRAINT "system_users_personnelRoleId_fkey"
  FOREIGN KEY ("personnelRoleId") REFERENCES "personnel_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 8. Only now drop the source columns.
ALTER TABLE "system_users" DROP COLUMN "department";
ALTER TABLE "system_users" DROP COLUMN "position";
