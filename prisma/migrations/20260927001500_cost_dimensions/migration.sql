-- The two development dimensions, which is what makes a cost code mean
-- anything. JournalLine already carried site, building, unit, lease and party
-- — "which property, which letting, whose". These answer "which development,
-- and what kind of cost", so "what did the foundations come to" becomes a
-- query rather than an afternoon with a spreadsheet.
--
-- Without this the CostCode table added in the previous migration was a table
-- nothing posted to.

ALTER TABLE "Expense" ADD COLUMN "costCodeId" TEXT;
ALTER TABLE "Expense" ADD COLUMN "projectId" TEXT;
ALTER TABLE "JournalLine" ADD COLUMN "projectId" TEXT;
ALTER TABLE "JournalLine" ADD COLUMN "costCodeId" TEXT;

-- Analysis indexes: these columns exist to be grouped by.
CREATE INDEX "JournalLine_orgId_projectId_idx" ON "JournalLine"("orgId", "projectId");
CREATE INDEX "JournalLine_orgId_costCodeId_idx" ON "JournalLine"("orgId", "costCodeId");
CREATE INDEX "Expense_costCodeId_idx" ON "Expense"("costCodeId");
CREATE INDEX "Expense_projectId_idx" ON "Expense"("projectId");

-- SET NULL throughout. Withdrawing a cost code or closing a project must never
-- delete a posted journal line: the entry has to go on balancing, and a ledger
-- that loses rows when a reference is tidied up is not a ledger.
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_costCodeId_fkey"
    FOREIGN KEY ("costCodeId") REFERENCES "CostCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_costCodeId_fkey"
    FOREIGN KEY ("costCodeId") REFERENCES "CostCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
