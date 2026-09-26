-- A tax rate is data with a date on it, not a number typed into a form.
-- InvoiceLine.taxBps goes on holding the RESOLVED rate, so an invoice raised
-- under an old rule keeps reading the same way for as long as it is kept.

CREATE TYPE "TaxKind" AS ENUM ('OUTPUT', 'WITHHOLDING');

CREATE TABLE "TaxRule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "taxCode" TEXT NOT NULL,
    "kind" "TaxKind" NOT NULL DEFAULT 'OUTPUT',
    "rateBp" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "confirmedBy" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaxRule_orgId_idx" ON "TaxRule"("orgId");
CREATE INDEX "TaxRule_orgId_country_taxCode_effectiveFrom_idx"
    ON "TaxRule"("orgId", "country", "taxCode", "effectiveFrom");

-- Cascade, like every other organization-owned table: a company that leaves
-- takes its tax rules with it.
ALTER TABLE "TaxRule" ADD CONSTRAINT "TaxRule_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
