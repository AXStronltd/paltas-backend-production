-- ======================================================================
-- Session.orgId becomes a real foreign key.
--
-- It was a bare string: "which organization this browser is acting for",
-- with nothing stopping it pointing at an organization that had been
-- deleted, or one the person had been removed from.
--
-- Neither was a data leak — sessionView() re-derives the organization from
-- the person's memberships on every read, so a stale pointer grants
-- nothing. But a dangling reference is a bug waiting for the first person
-- who trusts the column, and this schema is about to grow a great deal.
--
-- SET NULL, not CASCADE. Deleting a company must not delete the sessions
-- of people who also belong to other companies — it should drop the
-- pointer and leave them signed in.
-- ======================================================================

-- Any row already pointing at an organization that has gone.
UPDATE "Session" s
   SET "orgId" = NULL
 WHERE s."orgId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "Organization" o WHERE o."id" = s."orgId");

ALTER TABLE "Session" ADD CONSTRAINT "Session_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Session_orgId_idx" ON "Session"("orgId");
