-- THE CRM LINKS THAT WERE MISSING.
--
-- PALTAS already had the entities: Party with nine kinds, Lead, Deal, Viewing,
-- Offer, Reservation, Contract, Meeting, Task, Campaign, Message — all as
-- registry resources, org-scoped and audited. What it did not have were the
-- four things that turn a set of records into a relationship system.
--
-- 1. A LEAD COULD NOT BECOME A CLIENT. Lead had no partyId, so a lead that
--    converted left no path to the contact record — and the offer, reservation,
--    invoice and payment that followed belonged to somebody the pipeline could
--    not name.
--
-- 2. A LEAD COULD NOT BE CONTACTED. No email, no phone. A lead nobody can
--    telephone is a note.
--
-- 3. NOTHING WAS ASSIGNED TO ANYBODY. No owner on a client, a lead or an
--    opportunity, so "how are my agent's accounts doing" was a question the
--    data could not answer.
--
-- 4. THERE WAS NO NEXT ACTION. No follow-up date anywhere in the schema, so a
--    follow-up was something somebody had to remember and nothing could put an
--    overdue one in front of them.
--
-- Every column is additive and defaulted or nullable. No existing row changes
-- meaning.
ALTER TABLE "Party" ADD COLUMN "assignedToId" TEXT;
ALTER TABLE "Party" ADD COLUMN "source" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Party" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Party" ADD COLUMN "tags" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Party" ADD COLUMN "city" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Party" ADD COLUMN "country" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Party" ADD COLUMN "nextFollowUpOn" TIMESTAMP(3);

ALTER TABLE "Lead" ADD COLUMN "email" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Lead" ADD COLUMN "phone" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Lead" ADD COLUMN "partyId" TEXT;
ALTER TABLE "Lead" ADD COLUMN "assignedToId" TEXT;
ALTER TABLE "Lead" ADD COLUMN "priority" "WorkPriority" NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "Lead" ADD COLUMN "nextFollowUpOn" TIMESTAMP(3);

ALTER TABLE "Deal" ADD COLUMN "unitId" TEXT;
ALTER TABLE "Deal" ADD COLUMN "assignedToId" TEXT;

-- The stages a pipeline actually has. Adding a value to an enum cannot
-- invalidate a row that already holds one of the old ones.
ALTER TYPE "LeadStage" ADD VALUE IF NOT EXISTS 'CONTACTED' BEFORE 'VIEWING';
ALTER TYPE "LeadStage" ADD VALUE IF NOT EXISTS 'QUALIFIED' BEFORE 'VIEWING';
ALTER TYPE "LeadStage" ADD VALUE IF NOT EXISTS 'NEGOTIATION' BEFORE 'RESERVED';

-- SetNull throughout: a member of staff leaving must not delete the clients
-- they looked after, and merging a contact must not delete the record of where
-- an enquiry came from.
ALTER TABLE "Party" ADD CONSTRAINT "Party_assignedToId_fkey"
    FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_partyId_fkey"
    FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assignedToId_fkey"
    FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_unitId_fkey"
    FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_assignedToId_fkey"
    FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Party_orgId_assignedToId_idx" ON "Party"("orgId", "assignedToId");
CREATE INDEX "Party_orgId_nextFollowUpOn_idx" ON "Party"("orgId", "nextFollowUpOn");
CREATE INDEX "Lead_orgId_assignedToId_idx" ON "Lead"("orgId", "assignedToId");
CREATE INDEX "Lead_orgId_nextFollowUpOn_idx" ON "Lead"("orgId", "nextFollowUpOn");
CREATE INDEX "Lead_orgId_partyId_idx" ON "Lead"("orgId", "partyId");
