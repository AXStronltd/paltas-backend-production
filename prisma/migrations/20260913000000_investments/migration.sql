-- ======================================================================
-- TOKENISED REAL-ESTATE INVESTMENT. ADDITIVE.
--
-- Eight new tables, ten new enums, and exactly TWO changes to existing
-- tables, both nullable columns with SET NULL foreign keys:
--
--   Investor.userId        so a person can see their OWN holdings. An
--                          investor may exist on a register before they ever
--                          have an account, and may never have one.
--   Distribution.offeringId so a distribution can belong to an offering. SET
--                          NULL and not CASCADE: money that has been paid is
--                          a fact, and deleting the offering must not delete
--                          the record of paying it.
--
-- Nothing is dropped, nothing is altered in type, no existing row is read or
-- rewritten, and no existing column changes meaning.
--
-- WHAT PALTAS IS NOT: the property owner, the issuer, the regulated partner
-- or the custodian. OfferingParty names each of those as a separate legal
-- entity, which is the reason that table exists rather than six columns.
--
-- Money is BigInt minor units and rates are basis points, as everywhere else.
-- TokenHolding.units is what a PROVIDER reported, never a figure this service
-- computed — if no provider is connected there are no rows, and an empty
-- holdings screen is the honest answer.
-- ======================================================================

-- CreateEnum
CREATE TYPE "IssuerStatus" AS ENUM ('NOT_APPLIED', 'PENDING', 'APPROVED', 'SUSPENDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "OfferingStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SCHEDULED', 'LIVE', 'FUNDED', 'CLOSED', 'DISTRIBUTING', 'COMPLETED', 'REJECTED', 'CHANGES_REQUESTED');

-- CreateEnum
CREATE TYPE "OfferingStructure" AS ENUM ('SPV_EQUITY', 'DIRECT_CO_OWNERSHIP', 'DEBT_NOTE', 'REIT_UNIT', 'PROFIT_SHARE', 'OTHER');

-- CreateEnum
CREATE TYPE "InvestorEligibility" AS ENUM ('PROFESSIONAL_ONLY', 'ACCREDITED_ONLY', 'RETAIL_PERMITTED', 'BY_INVITATION');

-- CreateEnum
CREATE TYPE "PartyRole" AS ENUM ('PROPERTY_OWNER', 'LEGAL_OWNER', 'ISSUER', 'SPV', 'REGULATED_PARTNER', 'TOKENISATION_PROVIDER', 'CUSTODIAN', 'ADMINISTRATOR', 'VALUER', 'AUDITOR');

-- CreateEnum
CREATE TYPE "OfferingDocRole" AS ENUM ('PROSPECTUS', 'OFFERING_MEMORANDUM', 'SUBSCRIPTION_AGREEMENT', 'TITLE_DEED', 'VALUATION', 'TRUST_DEED', 'SPV_CONSTITUTION', 'REGULATORY_APPROVAL', 'AUDITED_ACCOUNTS', 'RISK_DISCLOSURE', 'OTHER');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AmlStatus" AS ENUM ('NOT_SCREENED', 'CLEAR', 'REVIEW', 'BLOCKED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'COMPLIANCE_HOLD', 'APPROVED', 'AWAITING_PAYMENT', 'SETTLED', 'ALLOCATED', 'CANCELLED', 'REFUSED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "TokenEventKind" AS ENUM ('MINT', 'TRANSFER', 'BURN', 'LOCK', 'UNLOCK', 'DISTRIBUTION_PAID', 'PROVIDER_MESSAGE');

-- AlterTable
ALTER TABLE "Distribution" ADD COLUMN     "offeringId" TEXT;

-- AlterTable
ALTER TABLE "Investor" ADD COLUMN     "userId" TEXT;

-- CreateTable
CREATE TABLE "IssuerProfile" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "status" "IssuerStatus" NOT NULL DEFAULT 'NOT_APPLIED',
    "regulator" TEXT NOT NULL DEFAULT '',
    "licenceRef" TEXT NOT NULL DEFAULT '',
    "jurisdictions" TEXT NOT NULL DEFAULT '',
    "legalName" TEXT NOT NULL DEFAULT '',
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssuerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offering" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "siteId" TEXT,
    "unitId" TEXT,
    "ref" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "structure" "OfferingStructure" NOT NULL DEFAULT 'SPV_EQUITY',
    "targetRaise" BIGINT NOT NULL DEFAULT 0,
    "raised" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "tokenUnits" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" BIGINT NOT NULL DEFAULT 0,
    "minInvestment" BIGINT NOT NULL DEFAULT 0,
    "minUnits" INTEGER NOT NULL DEFAULT 1,
    "eligibility" "InvestorEligibility" NOT NULL DEFAULT 'PROFESSIONAL_ONLY',
    "jurisdictions" TEXT NOT NULL DEFAULT '',
    "distributionRule" TEXT NOT NULL DEFAULT '',
    "targetYieldBps" INTEGER NOT NULL DEFAULT 0,
    "status" "OfferingStatus" NOT NULL DEFAULT 'DRAFT',
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "opensOn" TIMESTAMP(3),
    "closesOn" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "liveAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "decisionNote" TEXT NOT NULL DEFAULT '',
    "decidedBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offering_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferingParty" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "role" "PartyRole" NOT NULL,
    "legalName" TEXT NOT NULL,
    "registration" TEXT NOT NULL DEFAULT '',
    "jurisdiction" TEXT NOT NULL DEFAULT '',
    "regulator" TEXT NOT NULL DEFAULT '',
    "contact" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferingParty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferingDocument" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "role" "OfferingDocRole" NOT NULL DEFAULT 'OTHER',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferingDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestorProfile" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "investorId" TEXT NOT NULL,
    "kyc" "KycStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "aml" "AmlStatus" NOT NULL DEFAULT 'NOT_SCREENED',
    "kycProvider" TEXT NOT NULL DEFAULT '',
    "kycRef" TEXT NOT NULL DEFAULT '',
    "amlProvider" TEXT NOT NULL DEFAULT '',
    "amlRef" TEXT NOT NULL DEFAULT '',
    "screenedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "jurisdiction" TEXT NOT NULL DEFAULT '',
    "classifiedAs" "InvestorEligibility" NOT NULL DEFAULT 'PROFESSIONAL_ONLY',
    "blockedReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestmentOrder" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "investorId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 0,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "invoiceId" TEXT,
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "allocatedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "refusedWhy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestmentOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenHolding" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "investorId" TEXT NOT NULL,
    "orderId" TEXT,
    "units" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT NOT NULL DEFAULT '',
    "providerRef" TEXT NOT NULL DEFAULT '',
    "custodian" TEXT NOT NULL DEFAULT '',
    "custodianRef" TEXT NOT NULL DEFAULT '',
    "chain" TEXT NOT NULL DEFAULT '',
    "contractRef" TEXT NOT NULL DEFAULT '',
    "walletRef" TEXT NOT NULL DEFAULT '',
    "asAt" TIMESTAMP(3),
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenHolding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "kind" "TokenEventKind" NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT NOT NULL DEFAULT '',
    "externalRef" TEXT NOT NULL,
    "txRef" TEXT NOT NULL DEFAULT '',
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IssuerProfile_orgId_key" ON "IssuerProfile"("orgId");

-- CreateIndex
CREATE INDEX "IssuerProfile_status_idx" ON "IssuerProfile"("status");

-- CreateIndex
CREATE INDEX "Offering_orgId_idx" ON "Offering"("orgId");

-- CreateIndex
CREATE INDEX "Offering_orgId_status_idx" ON "Offering"("orgId", "status");

-- CreateIndex
CREATE INDEX "Offering_status_sandbox_idx" ON "Offering"("status", "sandbox");

-- CreateIndex
CREATE UNIQUE INDEX "Offering_orgId_ref_key" ON "Offering"("orgId", "ref");

-- CreateIndex
CREATE INDEX "OfferingParty_offeringId_idx" ON "OfferingParty"("offeringId");

-- CreateIndex
CREATE UNIQUE INDEX "OfferingParty_offeringId_role_legalName_key" ON "OfferingParty"("offeringId", "role", "legalName");

-- CreateIndex
CREATE INDEX "OfferingDocument_offeringId_idx" ON "OfferingDocument"("offeringId");

-- CreateIndex
CREATE UNIQUE INDEX "OfferingDocument_offeringId_documentId_key" ON "OfferingDocument"("offeringId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "InvestorProfile_investorId_key" ON "InvestorProfile"("investorId");

-- CreateIndex
CREATE INDEX "InvestorProfile_orgId_idx" ON "InvestorProfile"("orgId");

-- CreateIndex
CREATE INDEX "InvestorProfile_orgId_kyc_idx" ON "InvestorProfile"("orgId", "kyc");

-- CreateIndex
CREATE INDEX "InvestmentOrder_orgId_idx" ON "InvestmentOrder"("orgId");

-- CreateIndex
CREATE INDEX "InvestmentOrder_offeringId_status_idx" ON "InvestmentOrder"("offeringId", "status");

-- CreateIndex
CREATE INDEX "InvestmentOrder_investorId_idx" ON "InvestmentOrder"("investorId");

-- CreateIndex
CREATE UNIQUE INDEX "InvestmentOrder_orgId_ref_key" ON "InvestmentOrder"("orgId", "ref");

-- CreateIndex
CREATE INDEX "TokenHolding_orgId_idx" ON "TokenHolding"("orgId");

-- CreateIndex
CREATE INDEX "TokenHolding_investorId_idx" ON "TokenHolding"("investorId");

-- CreateIndex
CREATE UNIQUE INDEX "TokenHolding_offeringId_investorId_providerRef_key" ON "TokenHolding"("offeringId", "investorId", "providerRef");

-- CreateIndex
CREATE INDEX "TokenEvent_orgId_idx" ON "TokenEvent"("orgId");

-- CreateIndex
CREATE INDEX "TokenEvent_offeringId_at_idx" ON "TokenEvent"("offeringId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "TokenEvent_provider_externalRef_key" ON "TokenEvent"("provider", "externalRef");

-- AddForeignKey
ALTER TABLE "Investor" ADD CONSTRAINT "Investor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Distribution" ADD CONSTRAINT "Distribution_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Offering"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuerProfile" ADD CONSTRAINT "IssuerProfile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offering" ADD CONSTRAINT "Offering_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offering" ADD CONSTRAINT "Offering_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offering" ADD CONSTRAINT "Offering_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offering" ADD CONSTRAINT "Offering_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferingParty" ADD CONSTRAINT "OfferingParty_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferingDocument" ADD CONSTRAINT "OfferingDocument_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferingDocument" ADD CONSTRAINT "OfferingDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestorProfile" ADD CONSTRAINT "InvestorProfile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestorProfile" ADD CONSTRAINT "InvestorProfile_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "Investor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentOrder" ADD CONSTRAINT "InvestmentOrder_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentOrder" ADD CONSTRAINT "InvestmentOrder_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentOrder" ADD CONSTRAINT "InvestmentOrder_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "Investor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentOrder" ADD CONSTRAINT "InvestmentOrder_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenHolding" ADD CONSTRAINT "TokenHolding_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenHolding" ADD CONSTRAINT "TokenHolding_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenHolding" ADD CONSTRAINT "TokenHolding_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "Investor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenHolding" ADD CONSTRAINT "TokenHolding_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "InvestmentOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenEvent" ADD CONSTRAINT "TokenEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenEvent" ADD CONSTRAINT "TokenEvent_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

