-- A DOCUMENT CAN NOW SAY WHOSE IT IS.
--
-- Document carried `about` — free text, and its own comment said "until it
-- needs to be a relation". It needs to be one. Client 360 could not list a
-- client's documents because "this client's files" could only be guessed at by
-- matching a name against that text, and a guess there shows one client's
-- identity document under another client's name on a screen somebody reads to
-- a customer.
--
-- `about` stays. It is still the right column for a subject that is not a
-- person — a property, a project, a permit.
--
-- Nullable, because most documents are about a property rather than somebody.
-- SetNull, because merging or removing a contact must not delete their signed
-- lease. Every existing row keeps exactly the meaning it has.
ALTER TABLE "Document" ADD COLUMN "partyId" TEXT;

ALTER TABLE "Document" ADD CONSTRAINT "Document_partyId_fkey"
    FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Document_orgId_partyId_idx" ON "Document"("orgId", "partyId");
