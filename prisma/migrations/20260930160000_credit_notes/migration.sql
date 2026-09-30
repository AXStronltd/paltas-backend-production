-- MONEY SOMEBODY NO LONGER OWES.
--
-- Not a negative invoice, and not a payment. An invoice states what was
-- billed; a payment states what arrived; a credit note says the billed amount
-- was wrong, or waived — and it is the only one of the three where nothing
-- moves.
--
-- Kept apart from both because each answers a question somebody eventually
-- asks out loud: what did we bill, what did we collect, and what did we give
-- away. A negative invoice line would have destroyed the first, and folding
-- it into `paid` would have destroyed the second — the collections screen
-- would report cash that never arrived, and a rent roll would show a month
-- collected that was in fact written off.
CREATE TABLE "CreditNote" (
    "id"           TEXT NOT NULL,
    "orgId"        TEXT NOT NULL,
    "ref"          TEXT NOT NULL,
    "invoiceId"    TEXT NOT NULL,
    "partyId"      TEXT,
    "currency"     TEXT NOT NULL,
    -- Gross, minor units, always positive. The direction is the table's name,
    -- not a sign: a negative credit note is a concept nobody has.
    "amount"       BIGINT NOT NULL,
    -- The tax inside `amount`, stated rather than inferred. A credit against a
    -- taxed invoice has to give the tax back too, and guessing the split is
    -- how a VAT return stops agreeing with the ledger.
    "taxBps"       INTEGER NOT NULL DEFAULT 0,
    "reason"       TEXT NOT NULL,
    "issuedOn"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById"   TEXT NOT NULL DEFAULT '',
    "issuedByName" TEXT NOT NULL DEFAULT '',
    "voided"       BOOLEAN NOT NULL DEFAULT false,
    "voidReason"   TEXT NOT NULL DEFAULT '',
    "voidedAt"     TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreditNote_orgId_ref_key"   ON "CreditNote"("orgId", "ref");
CREATE INDEX "CreditNote_orgId_invoiceId_idx"    ON "CreditNote"("orgId", "invoiceId");
CREATE INDEX "CreditNote_orgId_issuedOn_idx"     ON "CreditNote"("orgId", "issuedOn");

ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT: the invoice a credit note reduces must not vanish beneath it.
-- Invoices are voided rather than deleted, so this makes that the only path.
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_partyId_fkey"
    FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- WHAT WAS CREDITED, BESIDE WHAT WAS PAID.
--
-- Owed becomes total − paid − credited. Defaulting to 0 leaves every existing
-- invoice saying exactly what it says today, which is the point: nothing has
-- been credited yet, and a migration must not decide otherwise.
ALTER TABLE "Invoice" ADD COLUMN "credited" BIGINT NOT NULL DEFAULT 0;
