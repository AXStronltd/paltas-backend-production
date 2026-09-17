-- AlterTable
ALTER TABLE "Visit" ADD COLUMN     "zoneId" TEXT;

-- CreateIndex
CREATE INDEX "Visit_orgId_zoneId_arrivedAt_idx" ON "Visit"("orgId", "zoneId", "arrivedAt");

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
