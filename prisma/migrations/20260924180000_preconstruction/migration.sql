-- CreateEnum
CREATE TYPE "AcquisitionStatus" AS ENUM ('IDENTIFIED', 'APPRAISING', 'OFFERED', 'UNDER_NEGOTIATION', 'AGREED', 'DUE_DILIGENCE', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "DiligenceStatus" AS ENUM ('PENDING', 'CLEAR', 'ISSUE', 'WAIVED');

-- CreateEnum
CREATE TYPE "FeasibilityStatus" AS ENUM ('DRAFT', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "DrawingStatus" AS ENUM ('DRAFT', 'ISSUED_FOR_COMMENT', 'ISSUED_FOR_CONSTRUCTION', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "PermitStatus" AS ENUM ('NOT_STARTED', 'PREPARING', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REFUSED', 'WITHDRAWN', 'EXPIRED');

-- CreateTable
CREATE TABLE "Acquisition" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "projectId" TEXT,
    "parcelId" TEXT,
    "title" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "areaSqm" INTEGER,
    "tenure" TEXT NOT NULL DEFAULT '',
    "sellerId" TEXT,
    "sellerName" TEXT NOT NULL DEFAULT '',
    "askingPrice" BIGINT NOT NULL DEFAULT 0,
    "offeredPrice" BIGINT NOT NULL DEFAULT 0,
    "agreedPrice" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "status" "AcquisitionStatus" NOT NULL DEFAULT 'IDENTIFIED',
    "offeredOn" TIMESTAMP(3),
    "agreedOn" TIMESTAMP(3),
    "targetOn" TIMESTAMP(3),
    "completedOn" TIMESTAMP(3),
    "abandonedReason" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Acquisition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiligenceItem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "acquisitionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "status" "DiligenceStatus" NOT NULL DEFAULT 'PENDING',
    "finding" TEXT NOT NULL DEFAULT '',
    "waivedBy" TEXT NOT NULL DEFAULT '',
    "waivedReason" TEXT NOT NULL DEFAULT '',
    "checkedBy" TEXT NOT NULL DEFAULT '',
    "checkedOn" TIMESTAMP(3),
    "dueOn" TIMESTAMP(3),
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiligenceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feasibility" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "projectId" TEXT,
    "acquisitionId" TEXT,
    "title" TEXT NOT NULL,
    "assumptions" TEXT NOT NULL DEFAULT '',
    "status" "FeasibilityStatus" NOT NULL DEFAULT 'DRAFT',
    "landCost" BIGINT NOT NULL DEFAULT 0,
    "buildCost" BIGINT NOT NULL DEFAULT 0,
    "professional" BIGINT NOT NULL DEFAULT 0,
    "financeCost" BIGINT NOT NULL DEFAULT 0,
    "otherCost" BIGINT NOT NULL DEFAULT 0,
    "grossValue" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "targetMarginBps" INTEGER NOT NULL DEFAULT 0,
    "decidedBy" TEXT NOT NULL DEFAULT '',
    "decidedOn" TIMESTAMP(3),
    "decidedNote" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feasibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Drawing" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "projectId" TEXT,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "discipline" TEXT NOT NULL DEFAULT '',
    "revision" TEXT NOT NULL DEFAULT 'A',
    "scale" TEXT NOT NULL DEFAULT '',
    "status" "DrawingStatus" NOT NULL DEFAULT 'DRAFT',
    "issuedOn" TIMESTAMP(3),
    "issuedBy" TEXT NOT NULL DEFAULT '',
    "documentId" TEXT,
    "previousId" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Drawing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permit" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT '',
    "authority" TEXT NOT NULL DEFAULT '',
    "reference" TEXT NOT NULL DEFAULT '',
    "status" "PermitStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "submittedOn" TIMESTAMP(3),
    "decidedOn" TIMESTAMP(3),
    "expiresOn" TIMESTAMP(3),
    "conditions" TEXT NOT NULL DEFAULT '',
    "refusedReason" TEXT NOT NULL DEFAULT '',
    "fee" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "blocking" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Permit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermitEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "permitId" TEXT NOT NULL,
    "status" "PermitStatus" NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "byName" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermitEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Acquisition_orgId_idx" ON "Acquisition"("orgId");

-- CreateIndex
CREATE INDEX "Acquisition_orgId_status_idx" ON "Acquisition"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Acquisition_orgId_ref_key" ON "Acquisition"("orgId", "ref");

-- CreateIndex
CREATE INDEX "DiligenceItem_orgId_idx" ON "DiligenceItem"("orgId");

-- CreateIndex
CREATE INDEX "DiligenceItem_acquisitionId_idx" ON "DiligenceItem"("acquisitionId");

-- CreateIndex
CREATE INDEX "Feasibility_orgId_idx" ON "Feasibility"("orgId");

-- CreateIndex
CREATE INDEX "Feasibility_orgId_status_idx" ON "Feasibility"("orgId", "status");

-- CreateIndex
CREATE INDEX "Feasibility_orgId_projectId_idx" ON "Feasibility"("orgId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Feasibility_orgId_ref_key" ON "Feasibility"("orgId", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "Drawing_previousId_key" ON "Drawing"("previousId");

-- CreateIndex
CREATE INDEX "Drawing_orgId_idx" ON "Drawing"("orgId");

-- CreateIndex
CREATE INDEX "Drawing_orgId_status_idx" ON "Drawing"("orgId", "status");

-- CreateIndex
CREATE INDEX "Drawing_orgId_projectId_number_idx" ON "Drawing"("orgId", "projectId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Drawing_orgId_ref_key" ON "Drawing"("orgId", "ref");

-- CreateIndex
CREATE INDEX "Permit_orgId_idx" ON "Permit"("orgId");

-- CreateIndex
CREATE INDEX "Permit_orgId_status_idx" ON "Permit"("orgId", "status");

-- CreateIndex
CREATE INDEX "Permit_orgId_expiresOn_idx" ON "Permit"("orgId", "expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "Permit_orgId_ref_key" ON "Permit"("orgId", "ref");

-- CreateIndex
CREATE INDEX "PermitEvent_orgId_idx" ON "PermitEvent"("orgId");

-- CreateIndex
CREATE INDEX "PermitEvent_permitId_idx" ON "PermitEvent"("permitId");

-- AddForeignKey
ALTER TABLE "Acquisition" ADD CONSTRAINT "Acquisition_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Acquisition" ADD CONSTRAINT "Acquisition_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Acquisition" ADD CONSTRAINT "Acquisition_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "Parcel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Acquisition" ADD CONSTRAINT "Acquisition_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiligenceItem" ADD CONSTRAINT "DiligenceItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiligenceItem" ADD CONSTRAINT "DiligenceItem_acquisitionId_fkey" FOREIGN KEY ("acquisitionId") REFERENCES "Acquisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feasibility" ADD CONSTRAINT "Feasibility_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feasibility" ADD CONSTRAINT "Feasibility_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feasibility" ADD CONSTRAINT "Feasibility_acquisitionId_fkey" FOREIGN KEY ("acquisitionId") REFERENCES "Acquisition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Drawing" ADD CONSTRAINT "Drawing_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Drawing" ADD CONSTRAINT "Drawing_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Drawing" ADD CONSTRAINT "Drawing_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Drawing" ADD CONSTRAINT "Drawing_previousId_fkey" FOREIGN KEY ("previousId") REFERENCES "Drawing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Permit" ADD CONSTRAINT "Permit_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Permit" ADD CONSTRAINT "Permit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermitEvent" ADD CONSTRAINT "PermitEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermitEvent" ADD CONSTRAINT "PermitEvent_permitId_fkey" FOREIGN KEY ("permitId") REFERENCES "Permit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

