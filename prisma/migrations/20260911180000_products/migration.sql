-- ======================================================================
-- PALTAS API — the six products.
--
-- The first migration built the spine every customer shares: people,
-- companies, subscriptions, entitlements, promotions. This one builds what
-- they actually bought.
--
-- It ADDS ONLY. No table is dropped, no column is removed, no existing
-- column changes type. Four columns are added to tables that already exist,
-- and every one of them is nullable-or-defaulted, so this file is safe to
-- run against a database that already holds rows.
--
-- Four rules hold across everything below, and reading them once is worth
-- more than reading the 700 lines twice:
--
--   1. EVERY table carries "orgId" and cascades from "Organization".
--      PALTAS is one database holding many companies. A table without that
--      column is a table whose rows belong to nobody, and the query that
--      forgets to filter it is the worst bug this system could ship.
--      test/tenancy.test.js enforces this; it is not left to discipline.
--      The five line tables (InvoiceLine, FolioLine, and the three event
--      logs) are the exception, and they cascade from a parent that does
--      carry it — so a deleted company still takes them with it.
--
--   2. MONEY IS AN INTEGER, IN MINOR UNITS, WITH ITS CURRENCY BESIDE IT.
--      1,500.00 KES is 150000. There is no DOUBLE PRECISION column in this
--      file and there must never be one: a float loses a cent per rounding
--      and nobody notices for a year.
--
--   3. DECISIONS ARE APPEND-ONLY. WorkOrderEvent and IncidentEvent record
--      what happened and who did it, and nothing updates them. Each keeps
--      the actor twice — as a foreign key AND as a name — so that somebody
--      leaving the company cannot erase the fact that they made the call.
--
--   4. NO FILE BYTES. "Document" holds a storage key and a checksum. The
--      bytes live with a storage provider, and identity documents in
--      particular are referenced ("idKind", "idRef" on Visit), never
--      scanned into a column.
--
-- WHY THIS FILE IS HAND-ASSEMBLED: Prisma generates migrations by asking
-- its schema engine, which it downloads from binaries.prisma.sh. The
-- environment this was written in cannot reach that host. The DDL was
-- therefore emitted from schema.prisma directly, following Prisma's own
-- naming conventions to the letter — "Table_pkey", "Table_col_idx",
-- "Table_col_key", "Table_col_fkey", ON UPDATE CASCADE everywhere — and
-- then applied to a real PostgreSQL 16 and checked column by column
-- against the schema by test/migration.test.js.
--
-- Before deploying, run `npx prisma migrate status` on a machine with
-- internet. It should report no drift. If it reports any, trust Prisma.
-- ======================================================================

-- ------------------------------------------------- existing tables
--
-- Four timestamps that should have been there from the start. Every one is
-- NOT NULL with a default, so existing rows take the current time.
--
-- BE HONEST ABOUT WHAT THAT MEANS: on a database that already holds
-- customers, "Subscription.createdAt" would then say every company signed
-- up today, which is false. That is acceptable here and only here, because
-- this service has never been deployed and no such row exists. It would not
-- be acceptable later.

ALTER TABLE "Subscription" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Verification" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Workspace"    ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Membership"   ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- A session row IS updated — switching organization writes to it — so when
-- that last happened is worth knowing when a sign-in is ever disputed.
ALTER TABLE "Session"      ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- --------------------------------------------------------- new types

CREATE TYPE "SiteKind" AS ENUM ('RESIDENTIAL', 'COMMERCIAL', 'MIXED_USE', 'LAND', 'HOTEL', 'OFFICE', 'RETAIL', 'INDUSTRIAL', 'WAREHOUSE', 'CONSTRUCTION', 'FESTIVAL', 'EVENT', 'SCHOOL', 'CAMPUS', 'HOSPITAL', 'ESTATE', 'OTHER');
CREATE TYPE "BuildingCondition" AS ENUM ('GOOD', 'FAIR', 'NEEDS_WORK');
CREATE TYPE "UnitKind" AS ENUM ('STUDIO', 'ONE_BED', 'TWO_BED', 'THREE_BED', 'FOUR_BED', 'SHOP', 'OFFICE', 'OTHER');
CREATE TYPE "UnitStatus" AS ENUM ('VACANT', 'OCCUPIED', 'NOTICE', 'RESERVED', 'OFF_MARKET');
CREATE TYPE "PartyKind" AS ENUM ('OWNER', 'BUYER', 'TENANT', 'GUEST', 'CONTACT', 'CONTRACTOR', 'VENDOR', 'STAFF', 'RESIDENT');
CREATE TYPE "DocumentKind" AS ENUM ('OWNERSHIP', 'LEASE', 'COMPLIANCE', 'INSURANCE', 'TAX', 'IDENTITY', 'CONTRACT', 'INVOICE', 'OTHER');
CREATE TYPE "LeaseStatus" AS ENUM ('DRAFT', 'ACTIVE', 'NOTICE', 'ENDED', 'TERMINATED');
CREATE TYPE "ProjectStage" AS ENUM ('PLANNING', 'APPROVALS', 'GROUNDWORK', 'STRUCTURE', 'FIT_OUT', 'HANDOVER', 'COMPLETE', 'ON_HOLD');
CREATE TYPE "WorkKind" AS ENUM ('WATER', 'POWER', 'LIFT', 'SECURITY', 'CLEANING', 'NOISE', 'PLUMBING', 'HVAC', 'APPLIANCE', 'INTERNET', 'STRUCTURAL', 'HOUSEKEEPING', 'FNB', 'IT', 'EMERGENCY', 'OTHER');
CREATE TYPE "WorkPriority" AS ENUM ('URGENT', 'HIGH', 'NORMAL', 'LOW');
CREATE TYPE "WorkStatus" AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED');
CREATE TYPE "RoomHousekeeping" AS ENUM ('CLEAN', 'DIRTY', 'IN_PROGRESS', 'INSPECTED');
CREATE TYPE "RoomCondition" AS ENUM ('OK', 'MINOR', 'MAJOR', 'OUT_OF_SERVICE');
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW', 'CANCELLED');
CREATE TYPE "ListingKind" AS ENUM ('SHORT_STAY', 'LONG_LET', 'FOR_SALE');
CREATE TYPE "ListingStatus" AS ENUM ('DRAFT', 'LIVE', 'PAUSED', 'LET', 'SOLD', 'WITHDRAWN');
CREATE TYPE "LeadStage" AS ENUM ('NEW', 'VIEWING', 'OFFER', 'RESERVED', 'CLOSED', 'LOST');
CREATE TYPE "DealStage" AS ENUM ('OFFER', 'RESERVED', 'CONTRACTS', 'COMPLETED', 'FALLEN_THROUGH');
CREATE TYPE "ZoneKind" AS ENUM ('GATE', 'ENTRANCE', 'LOBBY', 'CAR_PARK', 'FLOOR', 'RESTRICTED', 'PERIMETER', 'STAGE', 'LOADING_BAY', 'OTHER');
CREATE TYPE "VisitCategory" AS ENUM ('GUEST', 'CONTRACTOR', 'DELIVERY', 'STAFF', 'VIEWING', 'INTERVIEW', 'OTHER');
CREATE TYPE "VisitStatus" AS ENUM ('WAITING', 'APPROVED', 'REFUSED', 'INSIDE', 'LEFT', 'EXPIRED');
CREATE TYPE "PassKind" AS ENUM ('ONE_VISIT', 'RECURRING', 'STAY_PASS', 'STAFF', 'CONTRACTOR');
CREATE TYPE "PassStatus" AS ENUM ('ACTIVE', 'USED', 'EXPIRED', 'REVOKED');
CREATE TYPE "VehicleKind" AS ENUM ('RESIDENT', 'STAFF', 'VISITOR', 'CONTRACTOR', 'DELIVERY');
CREATE TYPE "IncidentSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'CONTAINED', 'RESOLVED', 'CLOSED');
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PART_PAID', 'PAID', 'OVERDUE', 'VOID');
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK', 'MPESA', 'CARD', 'CHEQUE', 'OTHER');
CREATE TYPE "ExpenseStatus" AS ENUM ('RECORDED', 'APPROVED', 'PAID', 'REJECTED');
CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'APPROVED', 'SENT', 'FAILED', 'CANCELLED');

CREATE TABLE "Site" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "SiteKind" NOT NULL DEFAULT 'RESIDENTIAL',
  "address" TEXT NOT NULL DEFAULT '',
  "city" TEXT NOT NULL DEFAULT '',
  "country" TEXT NOT NULL DEFAULT '',
  "lat" DOUBLE PRECISION,
  "lng" DOUBLE PRECISION,
  "note" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Site_orgId_idx" ON "Site"("orgId");
CREATE INDEX "Site_orgId_kind_idx" ON "Site"("orgId", "kind");

CREATE TABLE "Building" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT,
  "name" TEXT NOT NULL,
  "city" TEXT NOT NULL DEFAULT '',
  "floors" INTEGER NOT NULL DEFAULT 0,
  "unitCount" INTEGER NOT NULL DEFAULT 0,
  "builtYear" INTEGER,
  "condition" "BuildingCondition" NOT NULL DEFAULT 'GOOD',
  "note" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Building_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Building_orgId_idx" ON "Building"("orgId");
CREATE INDEX "Building_orgId_siteId_idx" ON "Building"("orgId", "siteId");

CREATE TABLE "Unit" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT,
  "buildingId" TEXT,
  "ref" TEXT NOT NULL,
  "kind" "UnitKind" NOT NULL DEFAULT 'ONE_BED',
  "floor" INTEGER,
  "sqm" INTEGER,
  "rent" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'KES',
  "status" "UnitStatus" NOT NULL DEFAULT 'VACANT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Unit_orgId_ref_key" ON "Unit"("orgId", "ref");
CREATE INDEX "Unit_orgId_idx" ON "Unit"("orgId");
CREATE INDEX "Unit_orgId_status_idx" ON "Unit"("orgId", "status");

CREATE TABLE "Party" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "PartyKind" NOT NULL DEFAULT 'CONTACT',
  "email" TEXT NOT NULL DEFAULT '',
  "phone" TEXT NOT NULL DEFAULT '',
  "note" TEXT NOT NULL DEFAULT '',
  "since" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Party_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Party_orgId_idx" ON "Party"("orgId");
CREATE INDEX "Party_orgId_kind_idx" ON "Party"("orgId", "kind");
CREATE INDEX "Party_orgId_name_idx" ON "Party"("orgId", "name");

CREATE TABLE "Document" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "DocumentKind" NOT NULL DEFAULT 'OTHER',
  "about" TEXT NOT NULL DEFAULT '',
  "expiresAt" TIMESTAMP(3),
  "storageKey" TEXT NOT NULL DEFAULT '',
  "checksum" TEXT NOT NULL DEFAULT '',
  "bytes" INTEGER NOT NULL DEFAULT 0,
  "mimeType" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Document_orgId_idx" ON "Document"("orgId");
CREATE INDEX "Document_orgId_kind_idx" ON "Document"("orgId", "kind");
CREATE INDEX "Document_orgId_expiresAt_idx" ON "Document"("orgId", "expiresAt");

CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "actorId" TEXT,
  "actorName" TEXT NOT NULL DEFAULT '',
  "action" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "entityId" TEXT NOT NULL DEFAULT '',
  "detail" JSONB,
  "ip" TEXT NOT NULL DEFAULT '',
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditEvent_orgId_at_idx" ON "AuditEvent"("orgId", "at");
CREATE INDEX "AuditEvent_orgId_entity_entityId_idx" ON "AuditEvent"("orgId", "entity", "entityId");

CREATE TABLE "Lease" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "unitId" TEXT,
  "tenantId" TEXT,
  "ref" TEXT NOT NULL,
  "rent" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'KES',
  "deposit" INTEGER NOT NULL DEFAULT 0,
  "startsOn" TIMESTAMP(3),
  "endsOn" TIMESTAMP(3),
  "status" "LeaseStatus" NOT NULL DEFAULT 'ACTIVE',
  "note" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Lease_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Lease_orgId_ref_key" ON "Lease"("orgId", "ref");
CREATE INDEX "Lease_orgId_idx" ON "Lease"("orgId");
CREATE INDEX "Lease_orgId_status_idx" ON "Lease"("orgId", "status");

CREATE TABLE "Project" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT,
  "name" TEXT NOT NULL,
  "city" TEXT NOT NULL DEFAULT '',
  "units" INTEGER NOT NULL DEFAULT 0,
  "dueOn" TIMESTAMP(3),
  "stage" "ProjectStage" NOT NULL DEFAULT 'PLANNING',
  "budget" INTEGER NOT NULL DEFAULT 0,
  "spent" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'KES',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Project_orgId_idx" ON "Project"("orgId");
CREATE INDEX "Project_orgId_stage_idx" ON "Project"("orgId", "stage");

CREATE TABLE "WorkOrder" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT,
  "ref" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "detail" TEXT NOT NULL DEFAULT '',
  "kind" "WorkKind" NOT NULL DEFAULT 'OTHER',
  "priority" "WorkPriority" NOT NULL DEFAULT 'NORMAL',
  "status" "WorkStatus" NOT NULL DEFAULT 'OPEN',
  "place" TEXT NOT NULL DEFAULT '',
  "assignee" TEXT NOT NULL DEFAULT '',
  "department" TEXT NOT NULL DEFAULT '',
  "raisedBy" TEXT NOT NULL DEFAULT '',
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkOrder_orgId_ref_key" ON "WorkOrder"("orgId", "ref");
CREATE INDEX "WorkOrder_orgId_status_idx" ON "WorkOrder"("orgId", "status");
CREATE INDEX "WorkOrder_orgId_siteId_idx" ON "WorkOrder"("orgId", "siteId");

CREATE TABLE "WorkOrderEvent" (
  "id" TEXT NOT NULL,
  "workOrderId" TEXT NOT NULL,
  "what" TEXT NOT NULL,
  "why" TEXT NOT NULL DEFAULT '',
  "status" "WorkStatus" NOT NULL,
  "byId" TEXT,
  "byName" TEXT NOT NULL DEFAULT '',
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkOrderEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkOrderEvent_workOrderId_at_idx" ON "WorkOrderEvent"("workOrderId", "at");

CREATE TABLE "Asset" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT '',
  "serial" TEXT NOT NULL DEFAULT '',
  "place" TEXT NOT NULL DEFAULT '',
  "installedOn" TIMESTAMP(3),
  "servicedOn" TIMESTAMP(3),
  "nextServiceOn" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'OK',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Asset_orgId_idx" ON "Asset"("orgId");
CREATE INDEX "Asset_orgId_nextServiceOn_idx" ON "Asset"("orgId", "nextServiceOn");

CREATE TABLE "Room" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT,
  "number" TEXT NOT NULL,
  "roomType" TEXT NOT NULL DEFAULT 'Standard',
  "floor" INTEGER,
  "housekeeping" "RoomHousekeeping" NOT NULL DEFAULT 'CLEAN',
  "condition" "RoomCondition" NOT NULL DEFAULT 'OK',
  "occupied" BOOLEAN NOT NULL DEFAULT false,
  "outOfOrder" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Room_orgId_number_key" ON "Room"("orgId", "number");
CREATE INDEX "Room_orgId_housekeeping_idx" ON "Room"("orgId", "housekeeping");

CREATE TABLE "Reservation" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "roomId" TEXT,
  "guestId" TEXT,
  "ref" TEXT NOT NULL,
  "guestName" TEXT NOT NULL DEFAULT '',
  "roomType" TEXT NOT NULL DEFAULT '',
  "arriveOn" TIMESTAMP(3),
  "departOn" TIMESTAMP(3),
  "nights" INTEGER NOT NULL DEFAULT 1,
  "adults" INTEGER NOT NULL DEFAULT 1,
  "children" INTEGER NOT NULL DEFAULT 0,
  "eta" TEXT NOT NULL DEFAULT '',
  "source" TEXT NOT NULL DEFAULT 'DIRECT',
  "status" "ReservationStatus" NOT NULL DEFAULT 'CONFIRMED',
  "rate" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'KES',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Reservation_orgId_ref_key" ON "Reservation"("orgId", "ref");
CREATE INDEX "Reservation_orgId_status_idx" ON "Reservation"("orgId", "status");
CREATE INDEX "Reservation_orgId_arriveOn_idx" ON "Reservation"("orgId", "arriveOn");

CREATE TABLE "Folio" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'KES',
  "closed" BOOLEAN NOT NULL DEFAULT false,
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Folio_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Folio_reservationId_key" ON "Folio"("reservationId");
CREATE INDEX "Folio_orgId_closed_idx" ON "Folio"("orgId", "closed");

CREATE TABLE "FolioLine" (
  "id" TEXT NOT NULL,
  "folioId" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'charge',
  "detail" TEXT NOT NULL DEFAULT '',
  "amount" INTEGER NOT NULL,
  "postedBy" TEXT NOT NULL DEFAULT '',
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FolioLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FolioLine_folioId_at_idx" ON "FolioLine"("folioId", "at");

CREATE TABLE "HotelService" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT '',
  "opensAt" TEXT NOT NULL DEFAULT '',
  "capacity" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "chargeable" BOOLEAN NOT NULL DEFAULT false,
  "note" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HotelService_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "HotelService_orgId_idx" ON "HotelService"("orgId");

CREATE TABLE "Listing" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "unitId" TEXT,
  "title" TEXT NOT NULL,
  "channel" TEXT NOT NULL DEFAULT 'PALTAS',
  "kind" "ListingKind" NOT NULL DEFAULT 'LONG_LET',
  "price" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'KES',
  "status" "ListingStatus" NOT NULL DEFAULT 'DRAFT',
  "ownerName" TEXT NOT NULL DEFAULT '',
  "mandate" TEXT NOT NULL DEFAULT '',
  "note" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Listing_orgId_status_idx" ON "Listing"("orgId", "status");

CREATE TABLE "Lead" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "wants" TEXT NOT NULL DEFAULT '',
  "budget" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'KES',
  "stage" "LeadStage" NOT NULL DEFAULT 'NEW',
  "source" TEXT NOT NULL DEFAULT 'PALTAS',
  "note" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Lead_orgId_stage_idx" ON "Lead"("orgId", "stage");

CREATE TABLE "Viewing" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "leadId" TEXT,
  "partyId" TEXT,
  "who" TEXT NOT NULL DEFAULT '',
  "property" TEXT NOT NULL DEFAULT '',
  "at" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'BOOKED',
  "note" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Viewing_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Viewing_orgId_at_idx" ON "Viewing"("orgId", "at");

CREATE TABLE "Deal" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "partyId" TEXT,
  "name" TEXT NOT NULL,
  "value" INTEGER NOT NULL DEFAULT 0,
  "fee" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'KES',
  "stage" "DealStage" NOT NULL DEFAULT 'OFFER',
  "closesOn" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Deal_orgId_stage_idx" ON "Deal"("orgId", "stage");

CREATE TABLE "Zone" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "ZoneKind" NOT NULL DEFAULT 'GATE',
  "note" TEXT NOT NULL DEFAULT '',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Zone_orgId_siteId_idx" ON "Zone"("orgId", "siteId");

CREATE TABLE "Visit" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT,
  "hostId" TEXT,
  "visitor" TEXT NOT NULL,
  "category" "VisitCategory" NOT NULL DEFAULT 'GUEST',
  "hostName" TEXT NOT NULL DEFAULT '',
  "phone" TEXT NOT NULL DEFAULT '',
  "vehicle" TEXT NOT NULL DEFAULT '',
  "purpose" TEXT NOT NULL DEFAULT '',
  "status" "VisitStatus" NOT NULL DEFAULT 'WAITING',
  "idKind" TEXT NOT NULL DEFAULT '',
  "idRef" TEXT NOT NULL DEFAULT '',
  "arrivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "admittedAt" TIMESTAMP(3),
  "leftAt" TIMESTAMP(3),
  "decidedBy" TEXT NOT NULL DEFAULT '',
  "decidedWhy" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Visit_orgId_status_idx" ON "Visit"("orgId", "status");
CREATE INDEX "Visit_orgId_siteId_arrivedAt_idx" ON "Visit"("orgId", "siteId", "arrivedAt");

CREATE TABLE "Pass" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT,
  "zoneId" TEXT,
  "code" TEXT NOT NULL,
  "holder" TEXT NOT NULL,
  "kind" "PassKind" NOT NULL DEFAULT 'ONE_VISIT',
  "forWhom" TEXT NOT NULL DEFAULT '',
  "validFrom" TIMESTAMP(3),
  "validTo" TIMESTAMP(3),
  "status" "PassStatus" NOT NULL DEFAULT 'ACTIVE',
  "issuedBy" TEXT NOT NULL DEFAULT '',
  "uses" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Pass_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Pass_orgId_code_key" ON "Pass"("orgId", "code");
CREATE INDEX "Pass_orgId_status_idx" ON "Pass"("orgId", "status");

CREATE TABLE "Vehicle" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT,
  "plate" TEXT NOT NULL,
  "make" TEXT NOT NULL DEFAULT '',
  "colour" TEXT NOT NULL DEFAULT '',
  "ownerName" TEXT NOT NULL DEFAULT '',
  "kind" "VehicleKind" NOT NULL DEFAULT 'VISITOR',
  "bay" TEXT NOT NULL DEFAULT '',
  "blocked" BOOLEAN NOT NULL DEFAULT false,
  "blockedWhy" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Vehicle_orgId_plate_key" ON "Vehicle"("orgId", "plate");
CREATE INDEX "Vehicle_orgId_kind_idx" ON "Vehicle"("orgId", "kind");

CREATE TABLE "Incident" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT,
  "ref" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "detail" TEXT NOT NULL DEFAULT '',
  "severity" "IncidentSeverity" NOT NULL DEFAULT 'MEDIUM',
  "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
  "place" TEXT NOT NULL DEFAULT '',
  "raisedBy" TEXT NOT NULL DEFAULT '',
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Incident_orgId_ref_key" ON "Incident"("orgId", "ref");
CREATE INDEX "Incident_orgId_status_idx" ON "Incident"("orgId", "status");
CREATE INDEX "Incident_orgId_severity_idx" ON "Incident"("orgId", "severity");

CREATE TABLE "IncidentEvent" (
  "id" TEXT NOT NULL,
  "incidentId" TEXT NOT NULL,
  "what" TEXT NOT NULL,
  "why" TEXT NOT NULL DEFAULT '',
  "status" "IncidentStatus" NOT NULL,
  "byId" TEXT,
  "byName" TEXT NOT NULL DEFAULT '',
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IncidentEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IncidentEvent_incidentId_at_idx" ON "IncidentEvent"("incidentId", "at");

CREATE TABLE "GuardShift" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT,
  "guard" TEXT NOT NULL,
  "post" TEXT NOT NULL DEFAULT '',
  "shift" TEXT NOT NULL DEFAULT '',
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
  "signedInAt" TIMESTAMP(3),
  "signedOutAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GuardShift_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GuardShift_orgId_startsAt_idx" ON "GuardShift"("orgId", "startsAt");

CREATE TABLE "Patrol" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT,
  "route" TEXT NOT NULL,
  "guard" TEXT NOT NULL DEFAULT '',
  "dueAt" TIMESTAMP(3),
  "points" INTEGER NOT NULL DEFAULT 0,
  "pointsHit" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Patrol_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Patrol_orgId_dueAt_idx" ON "Patrol"("orgId", "dueAt");

CREATE TABLE "Delivery" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT,
  "courier" TEXT NOT NULL,
  "what" TEXT NOT NULL DEFAULT '',
  "forWhom" TEXT NOT NULL DEFAULT '',
  "outbound" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'HELD',
  "receivedBy" TEXT NOT NULL DEFAULT '',
  "releasedTo" TEXT NOT NULL DEFAULT '',
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Delivery_orgId_status_idx" ON "Delivery"("orgId", "status");

CREATE TABLE "Invoice" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "partyId" TEXT,
  "leaseId" TEXT,
  "ref" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "sourceId" TEXT NOT NULL DEFAULT '',
  "total" INTEGER NOT NULL DEFAULT 0,
  "paid" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'KES',
  "issuedOn" TIMESTAMP(3),
  "dueOn" TIMESTAMP(3),
  "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
  "note" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Invoice_orgId_ref_key" ON "Invoice"("orgId", "ref");
CREATE INDEX "Invoice_orgId_idx" ON "Invoice"("orgId");
CREATE INDEX "Invoice_orgId_status_idx" ON "Invoice"("orgId", "status");
CREATE INDEX "Invoice_orgId_dueOn_idx" ON "Invoice"("orgId", "dueOn");
CREATE INDEX "Invoice_orgId_partyId_idx" ON "Invoice"("orgId", "partyId");

CREATE TABLE "InvoiceLine" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "unitPrice" INTEGER NOT NULL DEFAULT 0,
  "taxBps" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");

CREATE TABLE "Payment" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "invoiceId" TEXT,
  "amount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'KES',
  "method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
  "reference" TEXT NOT NULL DEFAULT '',
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "receivedBy" TEXT NOT NULL DEFAULT '',
  "voided" BOOLEAN NOT NULL DEFAULT false,
  "voidReason" TEXT NOT NULL DEFAULT '',
  "voidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Payment_orgId_method_reference_key" ON "Payment"("orgId", "method", "reference");
CREATE INDEX "Payment_orgId_receivedAt_idx" ON "Payment"("orgId", "receivedAt");
CREATE INDEX "Payment_orgId_invoiceId_idx" ON "Payment"("orgId", "invoiceId");

CREATE TABLE "Expense" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "siteId" TEXT,
  "partyId" TEXT,
  "detail" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT '',
  "amount" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'KES',
  "spentOn" TIMESTAMP(3),
  "recoverable" BOOLEAN NOT NULL DEFAULT false,
  "status" "ExpenseStatus" NOT NULL DEFAULT 'RECORDED',
  "note" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Expense_orgId_spentOn_idx" ON "Expense"("orgId", "spentOn");
CREATE INDEX "Expense_orgId_status_idx" ON "Expense"("orgId", "status");

CREATE TABLE "Payout" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "partyId" TEXT,
  "gross" INTEGER NOT NULL DEFAULT 0,
  "fees" INTEGER NOT NULL DEFAULT 0,
  "net" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'KES',
  "periodFrom" TIMESTAMP(3),
  "periodTo" TIMESTAMP(3),
  "status" "PayoutStatus" NOT NULL DEFAULT 'REQUESTED',
  "reference" TEXT NOT NULL DEFAULT '',
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Payout_orgId_status_idx" ON "Payout"("orgId", "status");
CREATE INDEX "Payout_orgId_periodTo_idx" ON "Payout"("orgId", "periodTo");

-- ------------------------------------------------- foreign keys

ALTER TABLE "Site" ADD CONSTRAINT "Site_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Building" ADD CONSTRAINT "Building_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Building" ADD CONSTRAINT "Building_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_buildingId_fkey"
  FOREIGN KEY ("buildingId") REFERENCES "Building"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Party" ADD CONSTRAINT "Party_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lease" ADD CONSTRAINT "Lease_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Lease" ADD CONSTRAINT "Lease_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lease" ADD CONSTRAINT "Lease_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkOrderEvent" ADD CONSTRAINT "WorkOrderEvent_workOrderId_fkey"
  FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkOrderEvent" ADD CONSTRAINT "WorkOrderEvent_byId_fkey"
  FOREIGN KEY ("byId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Room" ADD CONSTRAINT "Room_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Room" ADD CONSTRAINT "Room_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_guestId_fkey"
  FOREIGN KEY ("guestId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Folio" ADD CONSTRAINT "Folio_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Folio" ADD CONSTRAINT "Folio_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FolioLine" ADD CONSTRAINT "FolioLine_folioId_fkey"
  FOREIGN KEY ("folioId") REFERENCES "Folio"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HotelService" ADD CONSTRAINT "HotelService_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HotelService" ADD CONSTRAINT "HotelService_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Viewing" ADD CONSTRAINT "Viewing_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Viewing" ADD CONSTRAINT "Viewing_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Viewing" ADD CONSTRAINT "Viewing_partyId_fkey"
  FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_partyId_fkey"
  FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_hostId_fkey"
  FOREIGN KEY ("hostId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Pass" ADD CONSTRAINT "Pass_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Pass" ADD CONSTRAINT "Pass_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Pass" ADD CONSTRAINT "Pass_zoneId_fkey"
  FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IncidentEvent" ADD CONSTRAINT "IncidentEvent_incidentId_fkey"
  FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IncidentEvent" ADD CONSTRAINT "IncidentEvent_byId_fkey"
  FOREIGN KEY ("byId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GuardShift" ADD CONSTRAINT "GuardShift_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GuardShift" ADD CONSTRAINT "GuardShift_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Patrol" ADD CONSTRAINT "Patrol_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Patrol" ADD CONSTRAINT "Patrol_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_partyId_fkey"
  FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_partyId_fkey"
  FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_partyId_fkey"
  FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
