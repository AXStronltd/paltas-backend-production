-- CreateEnum
CREATE TYPE "DataClass" AS ENUM ('PUBLIC', 'INTERNAL', 'RESTRICTED', 'CONFIDENTIAL', 'OWNER_ONLY', 'LEGAL_RESTRICTED', 'SECURITY_RESTRICTED');

-- CreateEnum
CREATE TYPE "PropertyRelation" AS ENUM ('OWNER', 'CO_OWNER', 'EXECUTOR', 'ADMINISTRATOR', 'TRUSTEE', 'LEGAL_REPRESENTATIVE', 'FAMILY_REPRESENTATIVE', 'BENEFICIARY', 'MANAGER', 'DEVELOPER', 'OPERATOR');

-- CreateEnum
CREATE TYPE "Provenance" AS ENUM ('OWNER_SUPPLIED', 'MANAGER_SUPPLIED', 'VERIFIED', 'AI_SCAN', 'IMPORTED_PMS', 'PENDING');

-- CreateEnum
CREATE TYPE "VerificationState" AS ENUM ('UNVERIFIED', 'SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SuccessionStatus" AS ENUM ('DRAFT', 'INITIATED', 'DOCUMENTS_REQUIRED', 'UNDER_REVIEW', 'VERIFICATION_PENDING', 'APPROVED', 'COMPLETED', 'REJECTED', 'CANCELLED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "TimelineKind" AS ENUM ('PROPERTY_CREATED', 'DEVELOPER_ADDED', 'CONSTRUCTION_STARTED', 'CONSTRUCTION_COMPLETED', 'INSPECTION_COMPLETED', 'PROPERTY_VERIFIED', 'UNIT_CREATED', 'UNIT_LISTED', 'LEASE_STARTED', 'LEASE_ENDED', 'MAINTENANCE_COMPLETED', 'ASSET_INSTALLED', 'ASSET_REPLACED', 'RENOVATION_COMPLETED', 'MANAGER_CHANGED', 'OPERATOR_CHANGED', 'OWNERSHIP_RECORDED', 'SUCCESSION_INITIATED', 'SUCCESSION_COMPLETED', 'PROPERTY_SOLD', 'REDEVELOPMENT_STARTED', 'SCAN_RECORDED', 'DOCUMENT_ADDED', 'NOTE');

-- CreateTable
CREATE TABLE "PropertyDna" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "verification" "VerificationState" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT NOT NULL DEFAULT '',
    "verifiedNote" TEXT NOT NULL DEFAULT '',
    "publicProfile" BOOLEAN NOT NULL DEFAULT false,
    "publicSummary" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyDna_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyTimelineEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dnaId" TEXT NOT NULL,
    "kind" "TimelineKind" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "entity" TEXT NOT NULL DEFAULT '',
    "entityId" TEXT NOT NULL DEFAULT '',
    "actorId" TEXT,
    "actorName" TEXT NOT NULL DEFAULT '',
    "source" "Provenance" NOT NULL DEFAULT 'MANAGER_SUPPLIED',
    "verification" "VerificationState" NOT NULL DEFAULT 'UNVERIFIED',
    "class" "DataClass" NOT NULL DEFAULT 'INTERNAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyTimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyRelationship" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dnaId" TEXT NOT NULL,
    "userId" TEXT,
    "partyId" TEXT,
    "name" TEXT NOT NULL DEFAULT '',
    "relation" "PropertyRelation" NOT NULL,
    "clearance" "DataClass" NOT NULL DEFAULT 'RESTRICTED',
    "startedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedOn" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyOwnershipRecord" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dnaId" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "holderKind" TEXT NOT NULL DEFAULT 'INDIVIDUAL',
    "shareBp" INTEGER,
    "fromOn" TIMESTAMP(3),
    "toOn" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "basis" TEXT NOT NULL DEFAULT '',
    "source" "Provenance" NOT NULL DEFAULT 'OWNER_SUPPLIED',
    "verification" "VerificationState" NOT NULL DEFAULT 'UNVERIFIED',
    "class" "DataClass" NOT NULL DEFAULT 'OWNER_ONLY',
    "supersededById" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyOwnershipRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyHeritageRecord" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dnaId" TEXT NOT NULL,
    "year" INTEGER,
    "on" TIMESTAMP(3),
    "title" TEXT NOT NULL,
    "story" TEXT NOT NULL DEFAULT '',
    "family" TEXT NOT NULL DEFAULT '',
    "class" "DataClass" NOT NULL DEFAULT 'OWNER_ONLY',
    "publicOk" BOOLEAN NOT NULL DEFAULT false,
    "source" "Provenance" NOT NULL DEFAULT 'OWNER_SUPPLIED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyHeritageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuccessionCase" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dnaId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "status" "SuccessionStatus" NOT NULL DEFAULT 'DRAFT',
    "jurisdiction" TEXT NOT NULL DEFAULT '',
    "openedById" TEXT,
    "openedName" TEXT NOT NULL DEFAULT '',
    "representative" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "class" "DataClass" NOT NULL DEFAULT 'LEGAL_RESTRICTED',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuccessionCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuccessionBeneficiary" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relation" "PropertyRelation" NOT NULL DEFAULT 'BENEFICIARY',
    "shareBp" INTEGER,
    "contact" TEXT NOT NULL DEFAULT '',
    "userId" TEXT,
    "verification" "VerificationState" NOT NULL DEFAULT 'UNVERIFIED',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuccessionBeneficiary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuccessionStep" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "from" "SuccessionStatus",
    "to" "SuccessionStatus" NOT NULL,
    "why" TEXT NOT NULL DEFAULT '',
    "actorId" TEXT,
    "actorName" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuccessionStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyScan" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dnaId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PHOTO',
    "storageKey" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "uploadedById" TEXT,
    "uploadedName" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "class" "DataClass" NOT NULL DEFAULT 'RESTRICTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyScanFinding" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "confidence" INTEGER,
    "source" "Provenance" NOT NULL DEFAULT 'AI_SCAN',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedBy" TEXT NOT NULL DEFAULT '',
    "verifiedAt" TIMESTAMP(3),
    "rejected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyScanFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PropertyDna_siteId_key" ON "PropertyDna"("siteId");

-- CreateIndex
CREATE INDEX "PropertyDna_orgId_idx" ON "PropertyDna"("orgId");

-- CreateIndex
CREATE INDEX "PropertyDna_orgId_verification_idx" ON "PropertyDna"("orgId", "verification");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyDna_orgId_ref_key" ON "PropertyDna"("orgId", "ref");

-- CreateIndex
CREATE INDEX "PropertyTimelineEvent_orgId_dnaId_at_idx" ON "PropertyTimelineEvent"("orgId", "dnaId", "at");

-- CreateIndex
CREATE INDEX "PropertyTimelineEvent_orgId_kind_idx" ON "PropertyTimelineEvent"("orgId", "kind");

-- CreateIndex
CREATE INDEX "PropertyRelationship_orgId_dnaId_active_idx" ON "PropertyRelationship"("orgId", "dnaId", "active");

-- CreateIndex
CREATE INDEX "PropertyRelationship_orgId_userId_idx" ON "PropertyRelationship"("orgId", "userId");

-- CreateIndex
CREATE INDEX "PropertyOwnershipRecord_orgId_dnaId_active_idx" ON "PropertyOwnershipRecord"("orgId", "dnaId", "active");

-- CreateIndex
CREATE INDEX "PropertyHeritageRecord_orgId_dnaId_idx" ON "PropertyHeritageRecord"("orgId", "dnaId");

-- CreateIndex
CREATE INDEX "SuccessionCase_orgId_dnaId_status_idx" ON "SuccessionCase"("orgId", "dnaId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SuccessionCase_orgId_ref_key" ON "SuccessionCase"("orgId", "ref");

-- CreateIndex
CREATE INDEX "SuccessionBeneficiary_orgId_caseId_idx" ON "SuccessionBeneficiary"("orgId", "caseId");

-- CreateIndex
CREATE INDEX "SuccessionStep_orgId_caseId_at_idx" ON "SuccessionStep"("orgId", "caseId", "at");

-- CreateIndex
CREATE INDEX "PropertyScan_orgId_dnaId_idx" ON "PropertyScan"("orgId", "dnaId");

-- CreateIndex
CREATE INDEX "PropertyScanFinding_orgId_scanId_verified_idx" ON "PropertyScanFinding"("orgId", "scanId", "verified");

-- AddForeignKey
ALTER TABLE "PropertyDna" ADD CONSTRAINT "PropertyDna_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyDna" ADD CONSTRAINT "PropertyDna_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyTimelineEvent" ADD CONSTRAINT "PropertyTimelineEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyTimelineEvent" ADD CONSTRAINT "PropertyTimelineEvent_dnaId_fkey" FOREIGN KEY ("dnaId") REFERENCES "PropertyDna"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyTimelineEvent" ADD CONSTRAINT "PropertyTimelineEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyRelationship" ADD CONSTRAINT "PropertyRelationship_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyRelationship" ADD CONSTRAINT "PropertyRelationship_dnaId_fkey" FOREIGN KEY ("dnaId") REFERENCES "PropertyDna"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyRelationship" ADD CONSTRAINT "PropertyRelationship_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyRelationship" ADD CONSTRAINT "PropertyRelationship_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyOwnershipRecord" ADD CONSTRAINT "PropertyOwnershipRecord_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyOwnershipRecord" ADD CONSTRAINT "PropertyOwnershipRecord_dnaId_fkey" FOREIGN KEY ("dnaId") REFERENCES "PropertyDna"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyHeritageRecord" ADD CONSTRAINT "PropertyHeritageRecord_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyHeritageRecord" ADD CONSTRAINT "PropertyHeritageRecord_dnaId_fkey" FOREIGN KEY ("dnaId") REFERENCES "PropertyDna"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuccessionCase" ADD CONSTRAINT "SuccessionCase_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuccessionCase" ADD CONSTRAINT "SuccessionCase_dnaId_fkey" FOREIGN KEY ("dnaId") REFERENCES "PropertyDna"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuccessionCase" ADD CONSTRAINT "SuccessionCase_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuccessionBeneficiary" ADD CONSTRAINT "SuccessionBeneficiary_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuccessionBeneficiary" ADD CONSTRAINT "SuccessionBeneficiary_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "SuccessionCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuccessionBeneficiary" ADD CONSTRAINT "SuccessionBeneficiary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuccessionStep" ADD CONSTRAINT "SuccessionStep_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuccessionStep" ADD CONSTRAINT "SuccessionStep_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "SuccessionCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuccessionStep" ADD CONSTRAINT "SuccessionStep_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyScan" ADD CONSTRAINT "PropertyScan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyScan" ADD CONSTRAINT "PropertyScan_dnaId_fkey" FOREIGN KEY ("dnaId") REFERENCES "PropertyDna"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyScan" ADD CONSTRAINT "PropertyScan_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyScanFinding" ADD CONSTRAINT "PropertyScanFinding_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyScanFinding" ADD CONSTRAINT "PropertyScanFinding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "PropertyScan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
