-- Reconciliation: comparing what the ledger believes against what the bank holds.
--
-- A payment is still recorded and booked the moment it is taken; nothing here
-- gates that. What this adds is the answer to the two questions the service
-- could not answer at all: money in the bank nobody has claimed, and payments
-- on the books that never turned up.

CREATE TYPE "BankAccountKind" AS ENUM ('BANK', 'MOBILE_MONEY', 'CARD_PROCESSOR');

CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "BankAccountKind" NOT NULL DEFAULT 'BANK',
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "externalRef" TEXT NOT NULL DEFAULT '',
    "ledgerAccountId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "valueOn" TIMESTAMP(3) NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "reference" TEXT NOT NULL DEFAULT '',
    "refNorm" TEXT NOT NULL DEFAULT '',
    "payerName" TEXT NOT NULL DEFAULT '',
    "matchedPaymentId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "matchedBy" TEXT NOT NULL DEFAULT '',
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Payment" ADD COLUMN "reconciledAt" TIMESTAMP(3);

CREATE INDEX "BankAccount_orgId_idx" ON "BankAccount"("orgId");
CREATE INDEX "BankAccount_orgId_active_idx" ON "BankAccount"("orgId", "active");
CREATE INDEX "BankTransaction_orgId_idx" ON "BankTransaction"("orgId");
CREATE INDEX "BankTransaction_orgId_bankAccountId_matchedPaymentId_idx"
    ON "BankTransaction"("orgId", "bankAccountId", "matchedPaymentId");
CREATE INDEX "BankTransaction_orgId_bankAccountId_valueOn_amount_refNorm_idx"
    ON "BankTransaction"("orgId", "bankAccountId", "valueOn", "amount", "refNorm");

-- ONE BANK LINE PROVES AT MOST ONE PAYMENT. The constraint is the guard, so it
-- holds even if a handler forgets to check — which is the point of putting it
-- in the database rather than in a function.
CREATE UNIQUE INDEX "BankTransaction_matchedPaymentId_key" ON "BankTransaction"("matchedPaymentId");

ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_ledgerAccountId_fkey"
    FOREIGN KEY ("ledgerAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_bankAccountId_fkey"
    FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, not CASCADE: voiding or deleting a payment must not destroy the
-- bank's own record of the money arriving.
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_matchedPaymentId_fkey"
    FOREIGN KEY ("matchedPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
