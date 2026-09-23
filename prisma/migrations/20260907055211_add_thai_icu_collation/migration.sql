-- Pin Thai dictionary ordering to the SCHEMA instead of to the server's locale.
--
-- ============================================================================================
-- WHAT THIS DOES NOT DO, measured on this deployment before writing it
-- ============================================================================================
-- It does NOT repair a broken sort order. It was probed against the live dev database first, and
-- the ordering there is ALREADY correct:
--
--   PostgreSQL 18.4 · datlocprovider = 'c' · datcollate = 'en_US.utf8' · 872 ICU collations
--   27 Thai given names, ordered three ways:
--     ... collate "C"            -> กานต์ ขจร งามตา … อารีย์ ฮาริส เก่ง เอกชัย แก้ว โกมล ใจดี ไกรสร ไอลดา
--     ... (cluster default)      -> กานต์ เก่ง แก้ว โกมล ไกรสร ขจร งามตา จำปา ใจดี …
--     ... collate "th-TH-x-icu"  -> กานต์ เก่ง แก้ว โกมล ไกรสร ขจร งามตา จำปา ใจดี …
--   The last two are byte-identical on all 27 names. `เก่ง` sits at index 1 under both, and at
--   index 23 only under code-point order.
--
-- So the leading-vowel bug (เ แ โ ใ ไ sorting after every consonant) is real, but it belongs to
-- C/POSIX collation, and this cluster does not use it.
--
-- ============================================================================================
-- WHAT IT ACTUALLY BUYS
-- ============================================================================================
-- 1. The correct ordering above is true only by ACCIDENT of `datcollate = en_US.utf8`. A database
--    recreated with C/POSIX — the ordinary `initdb` result when LANG is unset, which is the common
--    case inside a Docker image — reverts silently to the code-point order shown above, and nothing
--    in this schema would contradict it. A column-level COLLATE makes the ordering a property of
--    the column, so it no longer depends on how the cluster happened to be initialised.
-- 2. glibc collations carry no version PostgreSQL can check, so an OS upgrade can change ordering
--    with no warning at all. ICU collations carry `collversion` (153.128.46 here) and PostgreSQL
--    warns when an index was built under a different one.
--
-- ============================================================================================
-- ON THE `CREATE COLLATION`
-- ============================================================================================
-- PostgreSQL 15+ predefines every ICU locale in `pg_catalog`, so on this server the statement below
-- is a NO-OP: `th-TH-x-icu` already exists there — AND a second, out-of-band copy already exists in
-- `public`, created by no migration in this repo. It is kept anyway, for portability: `IF NOT
-- EXISTS` costs one notice on a stock build and is the only thing that makes this file self-
-- contained on a cluster whose predefined set was pruned.
--
-- ⚠️ `search_path` is `"$user", public`, so a `public` copy SHADOWS the `pg_catalog` one and the
-- unqualified `COLLATE "th-TH-x-icu"` below resolves to `public`. Both are provider `icu`, locale
-- `th-TH`, collversion `153.128.46`, so they behave identically — but if Thai ordering ever
-- misbehaves, check WHICH of the two the columns are bound to before blaming ICU.
--
-- ⚠️ ICU collations are DETERMINISTIC unless declared otherwise, so equality stays byte-based:
-- the five UNIQUE indexes rebuilt by the ALTERs below keep exactly the uniqueness semantics they
-- had. This migration changes ORDER, never IDENTITY.
--
-- ============================================================================================
-- ⚠️ THIS FILE IS THE ONLY RECORD OF THE COLLATION. Prisma does not model column collation, so
-- `schema.prisma` still declares plain `String` and `prisma migrate diff` sees nothing here. Do not
-- "clean up" an apparently redundant migration: dropping it silently un-pins all nine columns.
-- ============================================================================================

CREATE COLLATION IF NOT EXISTS "th-TH-x-icu" (provider = icu, locale = 'th-TH');

-- The four admin-curated option tables. Each `name` carries a partial UNIQUE index
-- (`… WHERE "deletedAt" IS NULL`) that the ALTER rebuilds.
ALTER TABLE "departments"     ALTER COLUMN "name" TYPE TEXT COLLATE "th-TH-x-icu";
ALTER TABLE "personnel_roles" ALTER COLUMN "name" TYPE TEXT COLLATE "th-TH-x-icu";
ALTER TABLE "venue_types"     ALTER COLUMN "name" TYPE TEXT COLLATE "th-TH-x-icu";
ALTER TABLE "amenities"       ALTER COLUMN "name" TYPE TEXT COLLATE "th-TH-x-icu";

-- Venues. Two indexes ride on this one: `venues_name_active_key` (partial unique) and
-- `venues_name_idx` (plain).
ALTER TABLE "venues"          ALTER COLUMN "name" TYPE TEXT COLLATE "th-TH-x-icu";

-- The two people tables. Both are sorted `("lastName", "firstName")` by their list endpoints, and
-- both have an index on exactly that pair — which is the reason both halves are collated, not just
-- the one the screen sorts on.
ALTER TABLE "system_users"            ALTER COLUMN "firstName" TYPE TEXT COLLATE "th-TH-x-icu";
ALTER TABLE "system_users"            ALTER COLUMN "lastName"  TYPE TEXT COLLATE "th-TH-x-icu";
ALTER TABLE "line_user_registrations" ALTER COLUMN "firstName" TYPE TEXT COLLATE "th-TH-x-icu";
ALTER TABLE "line_user_registrations" ALTER COLUMN "lastName"  TYPE TEXT COLLATE "th-TH-x-icu";
