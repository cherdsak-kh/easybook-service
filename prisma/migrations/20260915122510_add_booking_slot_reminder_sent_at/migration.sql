-- AlterTable
ALTER TABLE "booking_slots" ADD COLUMN     "reminderSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "booking_slots_startAt_idx" ON "booking_slots"("startAt");
