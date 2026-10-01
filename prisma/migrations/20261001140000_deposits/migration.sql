-- ======================================================================
-- MONEY THE COMPANY IS HOLDING, AND DOES NOT OWN.
--
-- A tenancy deposit, its lifecycle, and the movements it is made of. Chart
-- account 2100 "Tenant deposits held" has been in the starting chart from the
-- beginning with nothing posting to it; this is what posts to it.
--
-- NOTHING EXISTING CHANGES MEANING. `Lease.deposit` stays exactly what it was
-- — the figure the agreement asks for — and every lease in production keeps
-- it. Deposit rows are opened deliberately, one tenancy at a time, so this
-- migration gives no company a deposit it did not record.
--
-- `Payment.fromDepositId` is nullable and null for every payment that exists:
-- no payment made before today was funded out of a deposit, and anything
-- counting cash received goes on counting all of them.
-- ======================================================================

CREATE TYPE "DepositStatus" AS ENUM ('DUE', 'PARTIAL', 'HELD', 'DISPUTED', 'SETTLED');
CREATE TYPE "DepositMovementKind" AS ENUM ('RECEIVED', 'DEDUCTED', 'RETURNED');

CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "partyId" TEXT,
    "required" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "heldInId" TEXT,
    "status" "DepositStatus" NOT NULL DEFAULT 'DUE',
    "disputed" BOOLEAN NOT NULL DEFAULT false,
    "disputeReason" TEXT NOT NULL DEFAULT '',
    "disputedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DepositMovement" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "depositId" TEXT NOT NULL,
    "kind" "DepositMovementKind" NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" "PaymentMethod",
    "reference" TEXT NOT NULL DEFAULT '',
    "invoiceId" TEXT,
    "byId" TEXT NOT NULL DEFAULT '',
    "byName" TEXT NOT NULL DEFAULT '',
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "voidReason" TEXT NOT NULL DEFAULT '',
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositMovement_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Payment" ADD COLUMN "fromDepositId" TEXT;

-- One deposit per tenancy, so "what is held against this lease" has one answer.
CREATE UNIQUE INDEX "Deposit_leaseId_key" ON "Deposit"("leaseId");
CREATE UNIQUE INDEX "Deposit_orgId_ref_key" ON "Deposit"("orgId", "ref");
CREATE INDEX "Deposit_orgId_idx" ON "Deposit"("orgId");
CREATE INDEX "Deposit_orgId_status_idx" ON "Deposit"("orgId", "status");

CREATE INDEX "DepositMovement_orgId_depositId_idx" ON "DepositMovement"("orgId", "depositId");
CREATE INDEX "DepositMovement_orgId_at_idx" ON "DepositMovement"("orgId", "at");
CREATE INDEX "DepositMovement_orgId_kind_idx" ON "DepositMovement"("orgId", "kind");

CREATE INDEX "Payment_fromDepositId_idx" ON "Payment"("fromDepositId");

-- Cascade from the company; Restrict on the lease, because a tenancy must not
-- be deleted out from under money still being held against it.
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_heldInId_fkey" FOREIGN KEY ("heldInId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DepositMovement" ADD CONSTRAINT "DepositMovement_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DepositMovement" ADD CONSTRAINT "DepositMovement_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "Deposit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DepositMovement" ADD CONSTRAINT "DepositMovement_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_fromDepositId_fkey" FOREIGN KEY ("fromDepositId") REFERENCES "Deposit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
