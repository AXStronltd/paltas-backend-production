-- RENT THAT RAISES ITSELF.
--
-- Lease has carried a rent figure from the beginning and nothing said WHEN it
-- was owed, so nothing could raise it: every invoice was typed by hand, for
-- every unit, every month. `rentDay` and `billing` are what a run needs to know
-- to do it instead.
--
-- Both have defaults, so every existing lease becomes "due on the 1st,
-- monthly" — the ordinary case, and the one a landlord would have to state
-- anyway. No existing row changes meaning.
CREATE TYPE "LeaseBilling" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');

ALTER TABLE "Lease" ADD COLUMN "rentDay" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Lease" ADD COLUMN "billing" "LeaseBilling" NOT NULL DEFAULT 'MONTHLY';

-- RENT THAT HAS BEEN RAISED, SO IT IS NEVER RAISED TWICE.
--
-- The scheduler's claim guarantees one RUN per period. It does not guarantee
-- that a run which died half way does not redo the leases it already reached —
-- a different problem, and the only one that is about money.
--
-- The UNIQUE on (orgId, leaseId, periodKey) is what makes charging a lease for
-- October impossible to do twice, whatever happens to the process in the
-- middle of it.
--
-- A table of its own rather than a column on Invoice: a lease's invoices are
-- not all rent, so a period on Invoice would either collide with manually
-- raised ones or need a partial index Prisma cannot describe — and a guarantee
-- the schema cannot state is not a guarantee.
CREATE TABLE "RentCharge" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "invoiceId" TEXT,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "dueOn" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RentCharge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RentCharge_orgId_leaseId_periodKey_key"
    ON "RentCharge"("orgId", "leaseId", "periodKey");
CREATE INDEX "RentCharge_orgId_periodKey_idx" ON "RentCharge"("orgId", "periodKey");
CREATE INDEX "RentCharge_orgId_leaseId_idx" ON "RentCharge"("orgId", "leaseId");

ALTER TABLE "RentCharge" ADD CONSTRAINT "RentCharge_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RentCharge" ADD CONSTRAINT "RentCharge_leaseId_fkey"
    FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SetNull, not Cascade: voiding or losing the invoice must not delete the
-- record that the month was charged, or the month could be raised again.
ALTER TABLE "RentCharge" ADD CONSTRAINT "RentCharge_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- MAY PALTAS RAISE THIS COMPANY'S RENT BY ITSELF?
--
-- OFF until somebody says otherwise, and that default is the whole point.
-- Every company using PALTAS today invoices rent by hand. Switching a rent run
-- on for all of them at once would raise THIS month again for every tenant
-- whose invoice was already typed — PALTAS cannot see what was billed outside
-- it, so it must not assume nothing was.
ALTER TABLE "Organization" ADD COLUMN "autoRent" BOOLEAN NOT NULL DEFAULT false;
