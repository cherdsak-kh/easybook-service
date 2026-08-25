-- CreateTable
CREATE TABLE "venues" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "venueTypeId" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "location" TEXT,
    "description" TEXT,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "closedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_photos" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_amenities" (
    "venueId" TEXT NOT NULL,
    "amenityId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_amenities_pkey" PRIMARY KEY ("venueId","amenityId")
);

-- CreateIndex
CREATE INDEX "venues_deletedAt_idx" ON "venues"("deletedAt");

-- CreateIndex
CREATE INDEX "venues_venueTypeId_idx" ON "venues"("venueTypeId");

-- CreateIndex
CREATE INDEX "venues_isOpen_idx" ON "venues"("isOpen");

-- CreateIndex
CREATE INDEX "venues_name_idx" ON "venues"("name");

-- CreateIndex
CREATE INDEX "venue_photos_venueId_position_idx" ON "venue_photos"("venueId", "position");

-- CreateIndex
CREATE INDEX "venue_amenities_amenityId_idx" ON "venue_amenities"("amenityId");

-- AddForeignKey
ALTER TABLE "venues" ADD CONSTRAINT "venues_venueTypeId_fkey" FOREIGN KEY ("venueTypeId") REFERENCES "venue_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_photos" ADD CONSTRAINT "venue_photos_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_amenities" ADD CONSTRAINT "venue_amenities_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_amenities" ADD CONSTRAINT "venue_amenities_amenityId_fkey" FOREIGN KEY ("amenityId") REFERENCES "amenities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── HAND-WRITTEN: PARTIAL unique index on the ACTIVE name ────────────────────
-- The fourth member of the family started in the init migration
-- (`departments_name_active_key`, `personnel_roles_name_active_key`) and continued
-- in 20260825062518 (`venue_types_name_active_key`, `amenities_name_active_key`).
-- Prisma cannot generate it — the PSL has no WHERE clause on an index — so a plain
-- `@unique` would span soft-deleted rows and burn a venue name forever. Retiring
-- `โรงยิม 2` must leave that name free for the room that replaces it.
--
-- `VenuesService.create`/`update` catch Prisma's P2002 from exactly this index and
-- map it to 409 VENUE_NAME_TAKEN. Drop the index and the 409 silently becomes a
-- duplicate row.
CREATE UNIQUE INDEX "venues_name_active_key" ON "venues"("name") WHERE "deletedAt" IS NULL;

-- ⚠️ NO INSERT IN THIS FILE EITHER, and for a second reason on top of the DDL-only
-- convention: the nine real venues of the school are OPERATOR DATA, not fixtures.
-- Seeding invented capacities, locations and amenity ticks is the mistake the
-- ประเภทสถานที่ list already had to undo once — the screen works perfectly either
-- way, so nothing catches it. `venue_types` is seeded (`npm run venue-types:seed`)
-- because a required FK into an empty table means no venue can be created at all;
-- `venues` and `amenities` have no such floor and start at zero rows.
