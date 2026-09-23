/**
 * Venue type seed — run: `npm run venue-types:seed`
 *
 * Seeds the `VenueType` table: the five starting categories AND the reserved tombstone row
 * `ไม่พบประเภทสถานที่`, where a deleted category's venues are re-pointed.
 *
 * A SEED SCRIPT, NOT A MIGRATION (project convention: migrations are DDL-only; seeds are idempotent
 * scripts like `create-super-admin.ts`). Safe to re-run.
 *
 * ── WHY THIS SCRIPT MAY WRITE `isSystemReserved` WHEN `seed-options.ts` MAY NOT (`Q16`) ──────────
 * The rule that file encodes is not "seed scripts must not write the flag" — it is **exactly one
 * writer of the flag PER TABLE**, so that the row can be resolved by name from both ends without two
 * creators racing to make a second one. For `Department` and `PersonnelRole` that writer is
 * `scripts/create-super-admin.ts`: it has to file the System Developer under a ตำแหน่ง and a
 * กลุ่ม/ฝ่าย anyway, so it owns their reserved rows and `seed-options.ts` must stay out.
 *
 * `VenueType` has no such writer — the root account needs no venue category — so this script becomes
 * that one writer, and may therefore seed both the ordinary rows and the reserved one. Nothing in
 * `seed-options.ts` changes, and its "never writes `isSystemReserved`" line stays literally true.
 *
 * The two rejected homes, for the record: `create-super-admin.ts` is about a credential, so putting
 * venue categories in it would mean "run the SUPER_ADMIN bootstrap before you can delete a room
 * type", which reads as a bug to whoever hits it; and seeding inside the migration would break the
 * DDL-only convention that three design logs state and that neither existing migration violates.
 *
 * ⚠️ UNTIL THIS RUNS, `DELETE /venue-types/:id` ANSWERS 500 `VENUE_TYPE_TOMBSTONE_ROW_MISSING`.
 * That is the designed failure — loud, honest, and it moves no data. It is also exactly the state
 * `/departments` is in on a database where `auth:create-superadmin` has never run, so this adds one
 * line to the post-migrate runbook rather than a new class of failure.
 *
 * Idempotent: a partial-unique `name` index means an `upsert`-on-name is not expressible, so for
 * each name we `findFirst({ name, deletedAt: null })` and `create` only if absent. Existing rows
 * (active or soft-deleted) are never touched — including a tombstone whose flag somebody cleared by
 * hand, which this script deliberately does NOT repair: silently re-flagging a row an operator can
 * see and edit would hide the tampering rather than surface it.
 *
 * Logs counts only — this table holds no PII.
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  STARTING_VENUE_TYPE_NAMES,
  TOMBSTONE_VENUE_TYPE_NAME,
} from '../src/venue-types/venue-types.constants';

const logger = new Logger('SeedVenueTypes');

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    // ── The reserved row, first ──────────────────────────────────────────────
    // ⚠️ THE NAME IS IMPORTED, NEVER RETYPED. `VenueTypesService.softDelete` resolves this row by
    // name; a second literal here means editing the constant later leaves the service hunting for a
    // row this script never created, and the only symptom is a 500 on delete.
    //
    // The probe matches the service's exactly — name + active + reserved. Probing by name ALONE
    // would let an ordinary operator-created row called `ไม่พบประเภทสถานที่` satisfy this check, and
    // the real tombstone would never be created.
    const existingTombstone = await prisma.venueType.findFirst({
      where: {
        name: TOMBSTONE_VENUE_TYPE_NAME,
        deletedAt: null,
        isSystemReserved: true,
      },
      select: { id: true },
    });
    let tombstoneCreated = false;
    if (!existingTombstone) {
      await prisma.venueType.create({
        data: { name: TOMBSTONE_VENUE_TYPE_NAME, isSystemReserved: true },
      });
      tombstoneCreated = true;
    }

    // ── The five ordinary categories ─────────────────────────────────────────
    let created = 0;
    for (const name of STARTING_VENUE_TYPE_NAMES) {
      // `deletedAt: null` matches the partial-unique index: a soft-deleted name is reusable, so only
      // an ACTIVE row of the same name is a reason to skip.
      const existing = await prisma.venueType.findFirst({
        where: { name, deletedAt: null },
        select: { id: true },
      });
      if (existing) continue;
      await prisma.venueType.create({ data: { name } });
      created += 1;
    }

    logger.log(
      `Seeded venue types. tombstoneCreated=${String(tombstoneCreated)} ` +
        `categoriesCreated=${created}/${STARTING_VENUE_TYPE_NAMES.length} ` +
        `(existing rows left untouched).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  logger.error(
    `Seed failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
