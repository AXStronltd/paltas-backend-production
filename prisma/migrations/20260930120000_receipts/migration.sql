-- PROOF THAT MONEY WAS RECEIVED.
--
-- The product's payment history offers "download receipt" and "send receipt".
-- Neither had anything behind it: the only thing called a receipt in this
-- service was a GOODS receipt in procurement, which is a delivery.
--
-- A receipt is not a view of a Payment. A payment is the company's own record
-- and may be corrected; a receipt is a document somebody outside the company
-- is holding, and what it said when they got it must still be what it says.
-- So every printed field is COPIED here at issue and nothing edits one after.
--
-- `basis` exists because confirmation is not one test. Payment deliberately
-- has no status enum — its own comment says a card payment is confirmed by the
-- processor and a cash receipt by the person who took it, while reconciledAt
-- answers whether anybody has seen the money on a statement. A receipt that
-- implied the strongest of those regardless would be evidence of nothing, so
-- it records which one it actually stands on.
CREATE TYPE "ReceiptBasis" AS ENUM ('BANK_RECONCILED', 'PROVIDER_CONFIRMED', 'TAKEN_IN_PERSON');

CREATE TABLE "Receipt" (
    "id"           TEXT NOT NULL,
    "orgId"        TEXT NOT NULL,
    "ref"          TEXT NOT NULL,
    "paymentId"    TEXT NOT NULL,

    "amount"       BIGINT NOT NULL,
    "currency"     TEXT NOT NULL,
    "method"       "PaymentMethod" NOT NULL,
    "reference"    TEXT NOT NULL DEFAULT '',
    "paidOn"       TIMESTAMP(3) NOT NULL,
    "payerName"    TEXT NOT NULL DEFAULT '',
    "partyId"      TEXT,
    "invoiceRef"   TEXT NOT NULL DEFAULT '',
    "invoiceId"    TEXT,

    "basis"        "ReceiptBasis" NOT NULL,

    "issuedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById"   TEXT NOT NULL DEFAULT '',
    "issuedByName" TEXT NOT NULL DEFAULT '',

    "voided"       BOOLEAN NOT NULL DEFAULT false,
    "voidReason"   TEXT NOT NULL DEFAULT '',
    "voidedAt"     TIMESTAMP(3),

    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- ONE RECEIPT PER PAYMENT, FOREVER.
--
-- The constraint, not a check in the route. Pressing the button twice must not
-- produce two documents with different numbers for the same money, and two
-- requests arriving together must not either.
CREATE UNIQUE INDEX "Receipt_paymentId_key" ON "Receipt"("paymentId");

-- Numbering is per company, so one customer's volume never shows in another's.
CREATE UNIQUE INDEX "Receipt_orgId_ref_key" ON "Receipt"("orgId", "ref");

CREATE INDEX "Receipt_orgId_issuedAt_idx" ON "Receipt"("orgId", "issuedAt");
CREATE INDEX "Receipt_orgId_partyId_idx"  ON "Receipt"("orgId", "partyId");

ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not CASCADE. Deleting the payment behind a receipt somebody is
-- holding would leave them with a document this company cannot explain.
-- Payments are voided rather than deleted, so this makes that the only path.
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
