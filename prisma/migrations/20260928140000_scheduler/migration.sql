-- THE SCHEDULER'S ONLY TABLE.
--
-- PALTAS had no scheduler, so rent was invoiced by hand, nothing expired, and
-- an invoice that passed its due date was never marked overdue.
--
-- The one hard question a scheduler raises is what stops the same month's rent
-- being charged twice. The UNIQUE on (job, periodKey) is the answer: a run is
-- claimed by inserting a row BEFORE any work happens, so two processes racing
-- resolve in the database — one wins, the other is refused. That survives a
-- restart, a second instance, and a deploy in the middle of a run, none of
-- which an in-memory lock survives.
--
-- `startedAt` is when the CURRENT attempt began and MOVES when a stale claim is
-- taken over, which is why it cannot double as a creation time and `createdAt`
-- is its own column.
--
-- Additive: one new table and one new enum. Nothing existing is touched.
CREATE TYPE "JobStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "JobStatus" NOT NULL DEFAULT 'RUNNING',
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobRun_job_periodKey_key" ON "JobRun"("job", "periodKey");
CREATE INDEX "JobRun_job_startedAt_idx" ON "JobRun"("job", "startedAt");
CREATE INDEX "JobRun_status_startedAt_idx" ON "JobRun"("status", "startedAt");
