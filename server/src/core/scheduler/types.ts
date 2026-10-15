/*
 * What a scheduled job is, for the core and for products.
 *
 * A product registers DEFINITIONS (what to run for a key) through its ProductModule (`scheduledJobs`). The
 * SCHEDULES are rows in sched_jobs: platform jobs are created at start-up from their default cron; organisation jobs
 * (a hotel's night audit at the property's audit time, monthly rent invoicing) are created by the product with
 * core.scheduler.ensureJob(...), e.g. when a property is set up or its audit time changes.
 */
import type { Db } from "../../db/database.js";

export interface JobRunContext {
  runId: string;
  jobId: string;
  key: string;
  orgId: string | null;
  /** What the job is about inside the organisation (e.g. a hotel property id), as given to ensureJob. */
  targetId: string | null;
  /**
   * The period this run is for: the scheduled wall-clock time in the job's zone ("2026-10-11T02:00"), or
   * "manual:<moment>" for a run started by PALTAS staff. A period succeeds at most once (sched_runs is unique on
   * job + period), so a handler that also keys its own records on the period is idempotent across retries.
   */
  period: string;
  /** The scheduled moment (UTC ISO) and its calendar date in the job's time zone. */
  scheduledFor: string;
  localDate: string;
  timezone: string;
  trigger: "schedule" | "manual";
  attempt: number;
  /** Database access (each handler runs its own transactions; nothing is wrapped around it). */
  db: Db;
}

export interface JobOutcome {
  /** One line kept with the run, e.g. "Night audit for 2026-10-11 completed". */
  summary: string;
}

export interface ScheduledJobDefinition {
  /** Stable key, "<product or platform>.<job>", e.g. "hotel.night_audit". */
  key: string;
  label: string;
  /** platform: one schedule for the whole server. org: schedules per organisation (and target), made by the product. */
  scope: "platform" | "org";
  /** Platform jobs: the schedule created at start-up (staff can change it later). */
  defaultCron?: string;
  run(job: JobRunContext): Promise<JobOutcome>;
}
