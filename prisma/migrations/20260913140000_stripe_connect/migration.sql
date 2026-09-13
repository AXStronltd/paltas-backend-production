-- Stripe Connect: a member company's own account, so it can charge its own
-- customers, plus webhook idempotency.
--
-- ADDITIVE except for one new column on Payment (providerRef, defaulted '').
-- No existing column is altered, renamed or dropped and no row is rewritten.
--
-- There is deliberately no chargesEnabled/payoutsEnabled: those are
-- deprecated Stripe v1 fields. Readiness is the Accounts v2 capability
-- status, stored verbatim in cardPaymentsStatus.

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "providerRef" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "ConnectedAccount" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "accountId" TEXT NOT NULL,
    "cardPaymentsStatus" TEXT NOT NULL DEFAULT 'inactive',
    "dashboard" TEXT NOT NULL DEFAULT 'full',
    "requirementsDue" TEXT NOT NULL DEFAULT '',
    "disabledReason" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "defaultCurrency" TEXT NOT NULL DEFAULT '',
    "livemode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "ConnectedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT '',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handled" BOOLEAN NOT NULL DEFAULT false,
    "handledAt" TIMESTAMP(3),
    "error" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedAccount_orgId_key" ON "ConnectedAccount"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedAccount_accountId_key" ON "ConnectedAccount"("accountId");

-- CreateIndex
CREATE INDEX "ConnectedAccount_provider_accountId_idx" ON "ConnectedAccount"("provider", "accountId");

-- CreateIndex
CREATE INDEX "StripeEvent_type_receivedAt_idx" ON "StripeEvent"("type", "receivedAt");

-- AddForeignKey
ALTER TABLE "ConnectedAccount" ADD CONSTRAINT "ConnectedAccount_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

