-- CreateEnum
CREATE TYPE "OrgKind" AS ENUM ('CUSTOMER', 'GOVERNMENT', 'MUNICIPALITY', 'CITY_AUTHORITY', 'COUNTY', 'LAND_AUTHORITY', 'PLANNING_AUTHORITY', 'PROPERTY_REGISTRY', 'TAX_AUTHORITY', 'BUILDING_AUTHORITY', 'OTHER_PUBLIC_AUTHORITY');

-- CreateEnum
CREATE TYPE "AuthorityDataset" AS ENUM ('PROPERTY_IDENTITY', 'LOCATION', 'PARCEL', 'ZONING', 'PLANNING', 'PERMITS', 'INSPECTIONS', 'COMPLIANCE', 'OFFICIAL_DOCUMENTS', 'REGISTRATION', 'TRANSFER_RECORDS', 'TAX_RELEVANT', 'BUILDING_FOOTPRINT');

-- CreateEnum
CREATE TYPE "DataAccessBasis" AS ENUM ('OWNER_CONSENT', 'LEGAL_AUTHORITY', 'REGULATORY_REQUIREMENT', 'PUBLIC_RECORD', 'CONTRACTUAL', 'AUTHORIZED_OPERATIONAL_ACCESS', 'OTHER_CONFIGURED_BASIS');

-- CreateEnum
CREATE TYPE "AuthorityRequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'PARTIALLY_APPROVED', 'REFUSED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AuthorityRecordKind" AS ENUM ('PARCEL_REGISTRATION', 'ZONING_DECISION', 'PLANNING_APPROVAL', 'BUILDING_PERMIT', 'OCCUPANCY_APPROVAL', 'INSPECTION', 'COMPLIANCE_NOTICE', 'OFFICIAL_NOTICE', 'RESTRICTION', 'TRANSFER_RECORD', 'VALUATION_ROLL', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.



-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.



-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.



-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "kind" "OrgKind" NOT NULL DEFAULT 'CUSTOMER';

-- CreateTable
CREATE TABLE "Jurisdiction" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "parentId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "path" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Jurisdiction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthorityProfile" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" "OrgKind" NOT NULL,
    "legalName" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "officialRef" TEXT NOT NULL DEFAULT '',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthorityProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthorityMandate" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "jurisdictionId" TEXT NOT NULL,
    "datasets" "AuthorityDataset"[],
    "basis" "DataAccessBasis" NOT NULL DEFAULT 'LEGAL_AUTHORITY',
    "purpose" TEXT NOT NULL DEFAULT '',
    "mayWrite" BOOLEAN NOT NULL DEFAULT false,
    "startsOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsOn" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthorityMandate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Parcel" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "jurisdictionId" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "areaSqm" INTEGER,
    "tenure" TEXT NOT NULL DEFAULT '',
    "zoning" TEXT NOT NULL DEFAULT '',
    "source" "Provenance" NOT NULL DEFAULT 'GOVERNMENT',
    "verification" "VerificationState" NOT NULL DEFAULT 'UNVERIFIED',
    "class" "DataClass" NOT NULL DEFAULT 'AUTHORITY_RESTRICTED',
    "fromParcelIds" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Parcel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyParcel" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyParcel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyAuthorityRecord" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dnaId" TEXT NOT NULL,
    "parcelId" TEXT,
    "jurisdictionId" TEXT,
    "kind" "AuthorityRecordKind" NOT NULL,
    "dataset" "AuthorityDataset" NOT NULL,
    "ref" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "issuedByOrgId" TEXT,
    "issuedByName" TEXT NOT NULL DEFAULT '',
    "issuedOn" TIMESTAMP(3),
    "expiresOn" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT '',
    "documentId" TEXT,
    "source" "Provenance" NOT NULL DEFAULT 'GOVERNMENT',
    "verification" "VerificationState" NOT NULL DEFAULT 'UNVERIFIED',
    "class" "DataClass" NOT NULL DEFAULT 'AUTHORITY_RESTRICTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyAuthorityRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthorityRequest" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dnaId" TEXT,
    "datasets" "AuthorityDataset"[],
    "basis" "DataAccessBasis" NOT NULL,
    "purpose" TEXT NOT NULL,
    "reference" TEXT NOT NULL DEFAULT '',
    "status" "AuthorityRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "grantedDatasets" "AuthorityDataset"[],
    "decidedById" TEXT,
    "decidedByName" TEXT NOT NULL DEFAULT '',
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT NOT NULL DEFAULT '',
    "expiresOn" TIMESTAMP(3),
    "ownerNotified" BOOLEAN NOT NULL DEFAULT false,
    "ownerNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthorityRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Jurisdiction_orgId_parentId_idx" ON "Jurisdiction"("orgId", "parentId");

-- CreateIndex
CREATE INDEX "Jurisdiction_path_idx" ON "Jurisdiction"("path");

-- CreateIndex
CREATE UNIQUE INDEX "Jurisdiction_orgId_path_key" ON "Jurisdiction"("orgId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorityProfile_orgId_key" ON "AuthorityProfile"("orgId");

-- CreateIndex
CREATE INDEX "AuthorityProfile_kind_idx" ON "AuthorityProfile"("kind");

-- CreateIndex
CREATE INDEX "AuthorityMandate_profileId_active_idx" ON "AuthorityMandate"("profileId", "active");

-- CreateIndex
CREATE INDEX "AuthorityMandate_jurisdictionId_idx" ON "AuthorityMandate"("jurisdictionId");

-- CreateIndex
CREATE INDEX "Parcel_orgId_jurisdictionId_idx" ON "Parcel"("orgId", "jurisdictionId");

-- CreateIndex
CREATE INDEX "Parcel_orgId_active_idx" ON "Parcel"("orgId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Parcel_orgId_ref_key" ON "Parcel"("orgId", "ref");

-- CreateIndex
CREATE INDEX "PropertyParcel_orgId_siteId_idx" ON "PropertyParcel"("orgId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyParcel_parcelId_siteId_key" ON "PropertyParcel"("parcelId", "siteId");

-- CreateIndex
CREATE INDEX "PropertyAuthorityRecord_orgId_dnaId_kind_idx" ON "PropertyAuthorityRecord"("orgId", "dnaId", "kind");

-- CreateIndex
CREATE INDEX "PropertyAuthorityRecord_orgId_dataset_idx" ON "PropertyAuthorityRecord"("orgId", "dataset");

-- CreateIndex
CREATE INDEX "PropertyAuthorityRecord_jurisdictionId_idx" ON "PropertyAuthorityRecord"("jurisdictionId");

-- CreateIndex
CREATE INDEX "AuthorityRequest_orgId_status_idx" ON "AuthorityRequest"("orgId", "status");

-- CreateIndex
CREATE INDEX "AuthorityRequest_profileId_status_idx" ON "AuthorityRequest"("profileId", "status");

-- AddForeignKey
ALTER TABLE "Jurisdiction" ADD CONSTRAINT "Jurisdiction_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Jurisdiction" ADD CONSTRAINT "Jurisdiction_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Jurisdiction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityProfile" ADD CONSTRAINT "AuthorityProfile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityMandate" ADD CONSTRAINT "AuthorityMandate_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "AuthorityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityMandate" ADD CONSTRAINT "AuthorityMandate_jurisdictionId_fkey" FOREIGN KEY ("jurisdictionId") REFERENCES "Jurisdiction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Parcel" ADD CONSTRAINT "Parcel_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Parcel" ADD CONSTRAINT "Parcel_jurisdictionId_fkey" FOREIGN KEY ("jurisdictionId") REFERENCES "Jurisdiction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyParcel" ADD CONSTRAINT "PropertyParcel_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyParcel" ADD CONSTRAINT "PropertyParcel_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "Parcel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyParcel" ADD CONSTRAINT "PropertyParcel_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyAuthorityRecord" ADD CONSTRAINT "PropertyAuthorityRecord_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyAuthorityRecord" ADD CONSTRAINT "PropertyAuthorityRecord_dnaId_fkey" FOREIGN KEY ("dnaId") REFERENCES "PropertyDna"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyAuthorityRecord" ADD CONSTRAINT "PropertyAuthorityRecord_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "Parcel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyAuthorityRecord" ADD CONSTRAINT "PropertyAuthorityRecord_jurisdictionId_fkey" FOREIGN KEY ("jurisdictionId") REFERENCES "Jurisdiction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyAuthorityRecord" ADD CONSTRAINT "PropertyAuthorityRecord_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityRequest" ADD CONSTRAINT "AuthorityRequest_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "AuthorityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityRequest" ADD CONSTRAINT "AuthorityRequest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityRequest" ADD CONSTRAINT "AuthorityRequest_dnaId_fkey" FOREIGN KEY ("dnaId") REFERENCES "PropertyDna"("id") ON DELETE SET NULL ON UPDATE CASCADE;
