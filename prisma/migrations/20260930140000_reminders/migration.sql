-- REMINDERS THAT DO NOT REPEAT THEMSELVES.
--
-- The scheduler's (job, periodKey) claim makes a run happen once a day. That
-- is not enough for a reminder: a lease expiring in three weeks is still
-- expiring tomorrow, so a daily job with no memory tells the same tenant the
-- same thing every morning until they leave. People stop reading a system that
-- does that, and then they miss the one that mattered.
--
-- So the memory is a row, and the unique key is the whole design: one reminder
-- per company, per kind, per record, PER MILESTONE. A lease gets one warning at
-- sixty days and another at seven; neither repeats however often the job runs
-- or however many instances run it.
CREATE TABLE "Reminder" (
    "id"          TEXT NOT NULL,
    "orgId"       TEXT NOT NULL,
    "kind"        TEXT NOT NULL,
    -- Deliberately not a foreign key: one table cannot point at nine others,
    -- and a reminder about a since-deleted record is still a fact about what
    -- was sent. subjectType says which table to look in.
    "subjectType" TEXT NOT NULL,
    "subjectId"   TEXT NOT NULL,
    "milestone"   TEXT NOT NULL,
    "dispatchId"  TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- THE GUARANTEE. Not a check in the job — two instances sweeping at once both
-- try to insert, and the constraint lets exactly one through.
CREATE UNIQUE INDEX "Reminder_orgId_kind_subjectId_milestone_key"
    ON "Reminder"("orgId", "kind", "subjectId", "milestone");

CREATE INDEX "Reminder_orgId_createdAt_idx" ON "Reminder"("orgId", "createdAt");
CREATE INDEX "Reminder_orgId_kind_idx"    ON "Reminder"("orgId", "kind");

ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, not Cascade: deleting a message must not erase the record that the
-- company was reminded, which is the thing that stops it being reminded again.
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_dispatchId_fkey"
    FOREIGN KEY ("dispatchId") REFERENCES "Dispatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
