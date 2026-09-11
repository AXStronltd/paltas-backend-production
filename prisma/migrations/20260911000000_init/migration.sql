-- ======================================================================
-- PALTAS API — the first migration.
--
-- Written out in full rather than generated, so it can be read before it is
-- run. `prisma migrate deploy` applies exactly this file and records it in
-- `_prisma_migrations`; nothing here is inferred at runtime.
--
-- It creates a schema from nothing. It alters no existing table, and it is
-- meant for a database this service owns — see render.yaml for why that
-- matters.
-- ======================================================================

-- ------------------------------------------------------------- enums

CREATE TYPE "Product" AS ENUM (
  'PROPERTY_MANAGEMENT', 'AGENT_HOST', 'HOTEL_MANAGEMENT',
  'SECURITY_MANAGEMENT', 'GUEST_PORTAL', 'PLATFORM'
);

CREATE TYPE "SubscriptionStatus" AS ENUM (
  'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'
);

CREATE TYPE "VerificationStatus" AS ENUM (
  'NOT_STARTED', 'PENDING', 'ADDITIONAL_INFORMATION_REQUIRED', 'REJECTED', 'COMPLETE'
);

CREATE TYPE "Role" AS ENUM (
  'OWNER', 'MANAGER', 'OPERATIONS', 'HOST', 'LEASING', 'PROMO_CONTRIBUTOR',
  'FINANCE', 'RECEPTIONIST', 'SECURITY_MANAGER', 'GM', 'FRONT_DESK',
  'HOUSEKEEPING', 'ENGINEERING', 'FNB', 'GUEST', 'GUARD',
  'MARKETING', 'COMPLIANCE', 'PUBLISHER'
);

CREATE TYPE "EntitlementStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ENDED');

CREATE TYPE "OrgStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

CREATE TYPE "PromotionStatus" AS ENUM (
  'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'RESUBMITTED',
  'MARKETING_APPROVED', 'FINAL_APPROVED', 'SCHEDULED', 'PUBLISHED',
  'PAUSED', 'EXPIRED', 'REJECTED'
);

-- ------------------------------------------------------------ people

CREATE TABLE "User" (
  "id"        TEXT NOT NULL,
  "email"     TEXT NOT NULL,
  "name"      TEXT NOT NULL DEFAULT '',
  "phone"     TEXT NOT NULL DEFAULT '',
  "googleSub" TEXT,
  "picture"   TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");
CREATE INDEX "User_googleSub_idx" ON "User"("googleSub");

CREATE TABLE "Session" (
  "id"        TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "orgId"     TEXT,
  "userAgent" TEXT NOT NULL DEFAULT '',
  "ip"        TEXT NOT NULL DEFAULT '',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- ----------------------------------------------------------- company

CREATE TABLE "Organization" (
  "id"        TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "country"   TEXT NOT NULL DEFAULT 'ke',
  "city"      TEXT NOT NULL DEFAULT '',
  "size"      TEXT NOT NULL DEFAULT '',
  "status"    "OrgStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Subscription" (
  "id"        TEXT NOT NULL,
  "orgId"     TEXT NOT NULL,
  "status"    "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
  "plan"      TEXT NOT NULL DEFAULT '',
  "planKey"   TEXT NOT NULL DEFAULT '',
  "trialDays" INTEGER NOT NULL DEFAULT 30,
  "seats"     INTEGER NOT NULL DEFAULT 1,
  "trialEnds" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subscription_orgId_key" ON "Subscription"("orgId");

CREATE TABLE "Entitlement" (
  "id"      TEXT NOT NULL,
  "orgId"   TEXT NOT NULL,
  "product" "Product" NOT NULL,
  "status"  "EntitlementStatus" NOT NULL DEFAULT 'ACTIVE',
  "since"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

-- One entitlement per product per company, enforced by the database rather
-- than by remembering to check. An account listed twice for one product sent
-- that customer to a door offering the same console twice.
CREATE UNIQUE INDEX "Entitlement_orgId_product_key" ON "Entitlement"("orgId", "product");

CREATE TABLE "Membership" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "orgId"     TEXT NOT NULL,
  "role"      "Role" NOT NULL DEFAULT 'OWNER',
  "scope"     JSONB NOT NULL DEFAULT '{"all": true}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Membership_userId_orgId_key" ON "Membership"("userId", "orgId");
CREATE INDEX "Membership_orgId_idx" ON "Membership"("orgId");

CREATE TABLE "Verification" (
  "id"        TEXT NOT NULL,
  "orgId"     TEXT NOT NULL,
  "status"    "VerificationStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "documents" JSONB NOT NULL DEFAULT '[]',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Verification_orgId_key" ON "Verification"("orgId");

CREATE TABLE "Workspace" (
  "id"        TEXT NOT NULL,
  "orgId"     TEXT NOT NULL,
  "status"    TEXT NOT NULL DEFAULT 'ACTIVE',
  "preferred" TEXT NOT NULL DEFAULT '',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Workspace_orgId_key" ON "Workspace"("orgId");

-- -------------------------------------------------------- promotions

CREATE TABLE "Promotion" (
  "id"             TEXT NOT NULL,
  "ref"            TEXT NOT NULL,
  "orgId"          TEXT NOT NULL,
  "title"          TEXT NOT NULL DEFAULT '',
  "headline"       TEXT NOT NULL DEFAULT '',
  "subtitle"       TEXT NOT NULL DEFAULT '',
  "description"    TEXT NOT NULL DEFAULT '',
  "type"           TEXT NOT NULL DEFAULT '',
  "offer"          TEXT NOT NULL DEFAULT '',
  "startDate"      TIMESTAMP(3),
  "endDate"        TIMESTAMP(3),
  "destination"    TEXT NOT NULL DEFAULT '',
  "ctaLabel"       TEXT NOT NULL DEFAULT '',
  "ctaDestination" TEXT NOT NULL DEFAULT '',
  "terms"          TEXT NOT NULL DEFAULT '',
  "image"          TEXT NOT NULL DEFAULT '',
  "imageMeta"      JSONB,
  "placement"      TEXT NOT NULL DEFAULT 'discover',
  "audience"       TEXT NOT NULL DEFAULT 'all',
  "language"       TEXT NOT NULL DEFAULT 'en',
  "priority"       INTEGER NOT NULL DEFAULT 50,
  "status"         "PromotionStatus" NOT NULL DEFAULT 'DRAFT',
  "aiDrafted"      BOOLEAN NOT NULL DEFAULT false,
  "createdById"    TEXT NOT NULL,
  "reviewedBy"     TEXT NOT NULL DEFAULT '',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Promotion_ref_key" ON "Promotion"("ref");

-- The index GET /promotions/public actually uses. It is the only query an
-- anonymous visitor can cause, so it is the one that has to stay fast.
CREATE INDEX "Promotion_status_startDate_endDate_idx"
  ON "Promotion"("status", "startDate", "endDate");
CREATE INDEX "Promotion_orgId_status_idx" ON "Promotion"("orgId", "status");

CREATE TABLE "PromotionEvent" (
  "id"          TEXT NOT NULL,
  "promotionId" TEXT NOT NULL,
  "what"        TEXT NOT NULL,
  "why"         TEXT NOT NULL DEFAULT '',
  "status"      "PromotionStatus" NOT NULL,
  "byId"        TEXT,
  "byName"      TEXT NOT NULL DEFAULT '',
  "at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PromotionEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PromotionEvent_promotionId_at_idx" ON "PromotionEvent"("promotionId", "at");

CREATE TABLE "Counter" (
  "name"  TEXT NOT NULL,
  "value" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "Counter_pkey" PRIMARY KEY ("name")
);

-- ------------------------------------------------------ foreign keys

ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Membership" ADD CONSTRAINT "Membership_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Verification" ADD CONSTRAINT "Verification_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not CASCADE. Deleting a person must not silently delete the
-- promotions they wrote for a company that is still trading.
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PromotionEvent" ADD CONSTRAINT "PromotionEvent_promotionId_fkey"
  FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, and `byName` is kept as text alongside. A reviewer who later
-- leaves the company must not erase the fact that they made the decision.
ALTER TABLE "PromotionEvent" ADD CONSTRAINT "PromotionEvent_byId_fkey"
  FOREIGN KEY ("byId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
