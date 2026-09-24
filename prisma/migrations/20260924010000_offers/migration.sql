-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'SENT', 'VIEWED', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "offerId" TEXT;

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "buyerId" TEXT,
    "projectId" TEXT,
    "unitId" TEXT,
    "price" BIGINT NOT NULL DEFAULT 0,
    "discount" BIGINT NOT NULL DEFAULT 0,
    "deposit" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "paymentPlan" TEXT NOT NULL DEFAULT '',
    "terms" TEXT NOT NULL DEFAULT '',
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "validUntil" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "declineReason" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Offer_orgId_idx" ON "Offer"("orgId");

-- CreateIndex
CREATE INDEX "Offer_orgId_status_idx" ON "Offer"("orgId", "status");

-- CreateIndex
CREATE INDEX "Offer_orgId_unitId_idx" ON "Offer"("orgId", "unitId");

-- CreateIndex
CREATE INDEX "Offer_orgId_buyerId_idx" ON "Offer"("orgId", "buyerId");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_orgId_ref_key" ON "Offer"("orgId", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "Contract_offerId_key" ON "Contract"("offerId");

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

