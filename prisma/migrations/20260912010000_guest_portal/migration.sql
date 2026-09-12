-- ======================================================================
-- THE GUEST PORTAL.
--
-- Two things, and the first is the one that mattered.
--
-- 1. Party.userId — THE BRIDGE.
--
-- A Party is a record a COMPANY keeps: a tenant, an owner, a guest. A User is
-- somebody who signs in. Nothing connected them, and that is precisely why the
-- guest portal's nine screens had no backend: a guest holds no membership, so
-- the session could say who had signed in and not which guest they were.
--
-- Nullable, and usually null. Most parties never sign in. ON DELETE SET NULL
-- because the company's record of a person outlives their login — deleting an
-- account must not delete a tenant.
--
-- 2. GuestRequest — what a guest asked for.
--
-- One table for the four things the portal allows: order a service, book the
-- airport transfer, report a problem, ask a question. Same shape, so one table
-- with a `kind` rather than four that drift apart.
--
-- NOT a WorkOrder, and that is a security decision rather than a modelling
-- preference. A work order is the company's internal job queue. A guest who
-- could read it could find out what else is broken in the building, and which
-- rooms are empty.
--
-- Additive only: one nullable column, one table, two enums. Nothing is
-- altered, nothing is dropped, and no existing row is read or rewritten.
-- ======================================================================

-- ---------------------------------------------------------------- enums
CREATE TYPE "GuestRequestKind"   AS ENUM ('SERVICE', 'TRANSFER', 'ISSUE', 'QUESTION');
CREATE TYPE "GuestRequestStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'DONE', 'DECLINED', 'CANCELLED');

-- ------------------------------------------------------------ the bridge
ALTER TABLE "Party" ADD COLUMN "userId" TEXT;

ALTER TABLE "Party"
  ADD CONSTRAINT "Party_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The guest portal's first query on every request is "which parties am I?".
CREATE INDEX "Party_userId_idx" ON "Party"("userId");

-- ---------------------------------------------------------- the requests
CREATE TABLE "GuestRequest" (
  "id"            TEXT NOT NULL,
  "orgId"         TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "partyId"       TEXT,
  "kind"          "GuestRequestKind" NOT NULL,
  "detail"        TEXT NOT NULL DEFAULT '',
  "note"          TEXT NOT NULL DEFAULT '',
  "status"        "GuestRequestStatus" NOT NULL DEFAULT 'OPEN',
  "response"      TEXT NOT NULL DEFAULT '',
  "resolvedAt"    TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GuestRequest_pkey" PRIMARY KEY ("id")
);

-- Cascade from the organization and the stay: a deleted company takes its
-- guests' requests with it, and so does a deleted reservation. SetNull on the
-- party, for the same reason as the bridge above.
ALTER TABLE "GuestRequest"
  ADD CONSTRAINT "GuestRequest_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GuestRequest"
  ADD CONSTRAINT "GuestRequest_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GuestRequest"
  ADD CONSTRAINT "GuestRequest_partyId_fkey"
  FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "GuestRequest_orgId_status_idx"   ON "GuestRequest"("orgId", "status");
CREATE INDEX "GuestRequest_reservationId_idx"  ON "GuestRequest"("reservationId");
CREATE INDEX "GuestRequest_partyId_idx"        ON "GuestRequest"("partyId");
