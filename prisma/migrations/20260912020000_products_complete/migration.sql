-- ======================================================================
-- THE CAPABILITIES THE CONSOLES ALREADY HAD SCREENS FOR.
--
-- Seventeen tables and fourteen enums. Every one of them exists because a
-- screen was drawing seed rows where operational data belongs: a channel
-- manager showing 186 reservations from Booking.com, an investor register
-- with KES 340,000,000 committed, a compliance case with a statutory due
-- date. Those are not placeholders a customer can tell apart from the real
-- thing, which is the whole reason for this migration.
--
-- ADDITIVE ONLY. Seventeen CREATE TABLE, fourteen CREATE TYPE, and the
-- indexes and foreign keys that belong to them. No DROP, no DELETE, no
-- TRUNCATE, no column altered, no existing row read or rewritten. Replaying
-- it against the production database adds tables and touches nothing that is
-- already there.
--
-- Money is BigInt minor units throughout, for the reason migration
-- 20260912000000_money_bigint exists: INT4 stops at KES 21,474,836 and a
-- development fund passes that on its first row.
--
-- Percentages are basis points. A yield of 9.2% is 920. Nothing in this
-- schema stores money or rates as a float.
-- ======================================================================

-- CreateEnum
CREATE TYPE "InvestorKind" AS ENUM ('INDIVIDUAL', 'FUND', 'COMPANY', 'TRUST', 'JOINT_VENTURE');

-- CreateEnum
CREATE TYPE "InvestorStatus" AS ENUM ('PROSPECT', 'ACTIVE', 'EXITED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "DistributionStatus" AS ENUM ('DECLARED', 'APPROVED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CapitalCallStatus" AS ENUM ('DRAFT', 'OUTSTANDING', 'PART_PAID', 'PAID', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChannelStatus" AS ENUM ('DISCONNECTED', 'LIVE', 'PAUSED', 'ERROR');

-- CreateEnum
CREATE TYPE "GroupBookingStatus" AS ENUM ('ENQUIRY', 'HELD', 'CONFIRMED', 'ARRIVED', 'DEPARTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CameraStatus" AS ENUM ('ONLINE', 'OFFLINE', 'DEGRADED', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "GuardTaskStatus" AS ENUM ('DUE', 'DONE', 'MISSED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "EmergencyStatus" AS ENUM ('READY', 'REVIEW_DUE', 'GAP');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "OpsTaskStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ModerationSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ModerationStatus" AS ENUM ('WAITING', 'UPHELD', 'DISMISSED', 'REMOVED');

-- CreateEnum
CREATE TYPE "ComplianceStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'CLOSED', 'ESCALATED');

-- CreateTable
CREATE TABLE "Investor" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "InvestorKind" NOT NULL DEFAULT 'INDIVIDUAL',
    "units" INTEGER NOT NULL DEFAULT 0,
    "committed" BIGINT NOT NULL DEFAULT 0,
    "paid" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "yieldBps" INTEGER NOT NULL DEFAULT 0,
    "since" TIMESTAMP(3),
    "status" "InvestorStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Investor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Distribution" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "investorId" TEXT,
    "period" TEXT NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "status" "DistributionStatus" NOT NULL DEFAULT 'DECLARED',
    "paidOn" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Distribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapitalCall" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "investorId" TEXT,
    "projectId" TEXT,
    "ref" TEXT NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "dueOn" TIMESTAMP(3),
    "status" "CapitalCallStatus" NOT NULL DEFAULT 'OUTSTANDING',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapitalCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mark" TEXT NOT NULL DEFAULT '',
    "status" "ChannelStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "mapped" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "commissionBps" INTEGER NOT NULL DEFAULT 0,
    "lastSyncAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateRule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "whenText" TEXT NOT NULL DEFAULT '',
    "moveBps" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupBooking" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "partyId" TEXT,
    "ref" TEXT NOT NULL,
    "orgName" TEXT NOT NULL DEFAULT '',
    "event" TEXT NOT NULL DEFAULT '',
    "rooms" INTEGER NOT NULL DEFAULT 0,
    "nights" INTEGER NOT NULL DEFAULT 1,
    "fromOn" TIMESTAMP(3),
    "value" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "paid" BIGINT NOT NULL DEFAULT 0,
    "status" "GroupBookingStatus" NOT NULL DEFAULT 'ENQUIRY',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NightAuditTask" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "runOn" TIMESTAMP(3) NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" TIMESTAMP(3),
    "doneBy" TEXT NOT NULL DEFAULT '',
    "seq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NightAuditTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Camera" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "siteId" TEXT,
    "name" TEXT NOT NULL,
    "place" TEXT NOT NULL DEFAULT '',
    "status" "CameraStatus" NOT NULL DEFAULT 'ONLINE',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Camera_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuardTask" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "siteId" TEXT,
    "shiftId" TEXT,
    "title" TEXT NOT NULL,
    "dueAt" TEXT NOT NULL DEFAULT '',
    "status" "GuardTaskStatus" NOT NULL DEFAULT 'DUE',
    "note" TEXT NOT NULL DEFAULT '',
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuardTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyPlan" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "siteId" TEXT,
    "kind" TEXT NOT NULL,
    "where" TEXT NOT NULL DEFAULT '',
    "procedure" TEXT NOT NULL DEFAULT '',
    "drillNote" TEXT NOT NULL DEFAULT '',
    "lastDrill" TIMESTAMP(3),
    "status" "EmergencyStatus" NOT NULL DEFAULT 'READY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmergencyPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "partyId" TEXT,
    "withName" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "lastText" TEXT NOT NULL DEFAULT '',
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unread" INTEGER NOT NULL DEFAULT 0,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL DEFAULT 'IN',
    "authorName" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsTask" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "unitId" TEXT,
    "title" TEXT NOT NULL,
    "assignee" TEXT NOT NULL DEFAULT '',
    "dueAt" TIMESTAMP(3),
    "status" "OpsTaskStatus" NOT NULL DEFAULT 'SCHEDULED',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "unitId" TEXT,
    "label" TEXT NOT NULL,
    "base" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "weekendBps" INTEGER NOT NULL DEFAULT 0,
    "monthlyBps" INTEGER NOT NULL DEFAULT 0,
    "minNights" INTEGER NOT NULL DEFAULT 1,
    "auto" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationItem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "listingId" TEXT,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "severity" "ModerationSeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "ModerationStatus" NOT NULL DEFAULT 'WAITING',
    "decidedBy" TEXT NOT NULL DEFAULT '',
    "decidedAt" TIMESTAMP(3),
    "decidedWhy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModerationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceCase" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "detail" TEXT NOT NULL DEFAULT '',
    "dueOn" TIMESTAMP(3),
    "status" "ComplianceStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedWhy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "limitText" TEXT NOT NULL DEFAULT '',
    "propertyCap" INTEGER,
    "includes" TEXT NOT NULL DEFAULT '',
    "seq" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Investor_orgId_idx" ON "Investor"("orgId");

-- CreateIndex
CREATE INDEX "Investor_orgId_name_idx" ON "Investor"("orgId", "name");

-- CreateIndex
CREATE INDEX "Distribution_orgId_idx" ON "Distribution"("orgId");

-- CreateIndex
CREATE INDEX "Distribution_orgId_investorId_idx" ON "Distribution"("orgId", "investorId");

-- CreateIndex
CREATE INDEX "CapitalCall_orgId_idx" ON "CapitalCall"("orgId");

-- CreateIndex
CREATE INDEX "CapitalCall_orgId_investorId_idx" ON "CapitalCall"("orgId", "investorId");

-- CreateIndex
CREATE UNIQUE INDEX "CapitalCall_orgId_ref_key" ON "CapitalCall"("orgId", "ref");

-- CreateIndex
CREATE INDEX "Channel_orgId_idx" ON "Channel"("orgId");

-- CreateIndex
CREATE INDEX "RateRule_orgId_idx" ON "RateRule"("orgId");

-- CreateIndex
CREATE INDEX "GroupBooking_orgId_idx" ON "GroupBooking"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupBooking_orgId_ref_key" ON "GroupBooking"("orgId", "ref");

-- CreateIndex
CREATE INDEX "NightAuditTask_orgId_idx" ON "NightAuditTask"("orgId");

-- CreateIndex
CREATE INDEX "NightAuditTask_orgId_runOn_idx" ON "NightAuditTask"("orgId", "runOn");

-- CreateIndex
CREATE INDEX "Camera_orgId_idx" ON "Camera"("orgId");

-- CreateIndex
CREATE INDEX "GuardTask_orgId_idx" ON "GuardTask"("orgId");

-- CreateIndex
CREATE INDEX "GuardTask_orgId_shiftId_idx" ON "GuardTask"("orgId", "shiftId");

-- CreateIndex
CREATE INDEX "EmergencyPlan_orgId_idx" ON "EmergencyPlan"("orgId");

-- CreateIndex
CREATE INDEX "Conversation_orgId_idx" ON "Conversation"("orgId");

-- CreateIndex
CREATE INDEX "Conversation_orgId_lastAt_idx" ON "Conversation"("orgId", "lastAt");

-- CreateIndex
CREATE INDEX "Message_orgId_idx" ON "Message"("orgId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "OpsTask_orgId_idx" ON "OpsTask"("orgId");

-- CreateIndex
CREATE INDEX "PricingRule_orgId_idx" ON "PricingRule"("orgId");

-- CreateIndex
CREATE INDEX "ModerationItem_orgId_idx" ON "ModerationItem"("orgId");

-- CreateIndex
CREATE INDEX "ModerationItem_status_createdAt_idx" ON "ModerationItem"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ComplianceCase_orgId_idx" ON "ComplianceCase"("orgId");

-- CreateIndex
CREATE INDEX "ComplianceCase_status_dueOn_idx" ON "ComplianceCase"("status", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceCase_ref_key" ON "ComplianceCase"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- AddForeignKey
ALTER TABLE "Investor" ADD CONSTRAINT "Investor_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Distribution" ADD CONSTRAINT "Distribution_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Distribution" ADD CONSTRAINT "Distribution_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "Investor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapitalCall" ADD CONSTRAINT "CapitalCall_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapitalCall" ADD CONSTRAINT "CapitalCall_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "Investor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapitalCall" ADD CONSTRAINT "CapitalCall_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateRule" ADD CONSTRAINT "RateRule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBooking" ADD CONSTRAINT "GroupBooking_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBooking" ADD CONSTRAINT "GroupBooking_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NightAuditTask" ADD CONSTRAINT "NightAuditTask_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Camera" ADD CONSTRAINT "Camera_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Camera" ADD CONSTRAINT "Camera_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardTask" ADD CONSTRAINT "GuardTask_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardTask" ADD CONSTRAINT "GuardTask_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardTask" ADD CONSTRAINT "GuardTask_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "GuardShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyPlan" ADD CONSTRAINT "EmergencyPlan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyPlan" ADD CONSTRAINT "EmergencyPlan_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsTask" ADD CONSTRAINT "OpsTask_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsTask" ADD CONSTRAINT "OpsTask_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationItem" ADD CONSTRAINT "ModerationItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationItem" ADD CONSTRAINT "ModerationItem_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceCase" ADD CONSTRAINT "ComplianceCase_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

