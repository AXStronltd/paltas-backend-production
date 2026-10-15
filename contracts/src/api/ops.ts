// Platform operations: readiness, the scheduler, organisation suspension, data export, catalogue price changes with
// a second person's approval, and audit search. Everything except readiness is PALTAS staff only (auth "staff");
// changes need the super_admin staff role. A client account (an owner, an organisation administrator) never reaches
// any of it.
import { z } from "zod";
import { Currency, IsoDate, IsoDateTime, Reason } from "../common.js";
import { endpoint } from "../endpoint.js";
import { AuditEntry } from "./organisations.js";

// ---------------------------------------------------------------- readiness

export const ready = endpoint({
  id: "ops.ready",
  method: "GET",
  path: "/api/v1/ready",
  auth: "public",
  summary:
    "Ready to serve: the database answers and every migration is applied (503 otherwise). /health checks the process and the database only.",
  response: z.object({
    ready: z.literal(true),
    database: z.literal("up"),
    migrations: z.object({ applied: z.number().int(), pending: z.array(z.string()) }),
  }),
});

// ---------------------------------------------------------------- scheduler

export const JobStatus = z.enum(["active", "paused"]);
export const RunStatus = z.enum(["queued", "running", "succeeded", "failed", "skipped"]);

export const ScheduledJob = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  orgId: z.string().nullable(),
  targetId: z.string().nullable(),
  cron: z.string(),
  timezone: z.string(),
  status: JobStatus,
  pausedReason: z.string().nullable(),
  nextRunAt: IsoDateTime.nullable(),
  lastRunAt: IsoDateTime.nullable(),
  lastStatus: z.string().nullable(),
  /** False when no running product registers a handler for this key (its runs fail until one does). */
  handlerRegistered: z.boolean(),
});
export type ScheduledJob = z.infer<typeof ScheduledJob>;

export const JobRun = z.object({
  id: z.string(),
  jobId: z.string(),
  period: z.string(),
  trigger: z.enum(["schedule", "manual"]),
  status: RunStatus,
  dueAt: IsoDateTime,
  scheduledFor: IsoDateTime,
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  requestedBy: z.string().nullable(),
});
export type JobRun = z.infer<typeof JobRun>;

/** Five fields: minute hour day-of-month month day-of-week ("*", lists, ranges and steps). */
export const Cron = z
  .string()
  .trim()
  .regex(/^(\S+\s+){4}\S+$/, "Use five fields: minute hour day-of-month month day-of-week");

const JobParams = z.object({ jobId: z.string().min(1) });

export const listJobs = endpoint({
  id: "ops.scheduler.jobs",
  method: "GET",
  path: "/api/v1/admin/scheduler/jobs",
  auth: "staff",
  summary: "Every scheduled job (platform and per organisation), and the job types the running products handle",
  query: z.object({ orgId: z.string().optional(), key: z.string().optional() }),
  response: z.object({
    jobs: z.array(ScheduledJob),
    handlers: z.array(z.object({ key: z.string(), label: z.string(), scope: z.enum(["platform", "org"]) })),
  }),
});

export const listRuns = endpoint({
  id: "ops.scheduler.runs",
  method: "GET",
  path: "/api/v1/admin/scheduler/jobs/:jobId/runs",
  auth: "staff",
  summary: "Run history of one job, newest first",
  params: JobParams,
  query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }),
  response: z.object({ job: ScheduledJob, runs: z.array(JobRun) }),
});

export const pauseJob = endpoint({
  id: "ops.scheduler.pause",
  method: "POST",
  path: "/api/v1/admin/scheduler/jobs/:jobId/pause",
  auth: "staff",
  summary: "Pause a job: no new periods are queued and queued runs wait. Audited with the reason.",
  params: JobParams,
  body: z.object({ reason: Reason }),
  response: ScheduledJob,
});

export const resumeJob = endpoint({
  id: "ops.scheduler.resume",
  method: "POST",
  path: "/api/v1/admin/scheduler/jobs/:jobId/resume",
  auth: "staff",
  summary: "Resume a paused job from its next scheduled time (missed periods are not replayed)",
  params: JobParams,
  body: z.object({ reason: Reason }),
  response: ScheduledJob,
});

export const runJobNow = endpoint({
  id: "ops.scheduler.runNow",
  method: "POST",
  path: "/api/v1/admin/scheduler/jobs/:jobId/run",
  auth: "staff",
  summary: "Queue one extra run now (also for a paused job). Audited with the reason.",
  params: JobParams,
  body: z.object({ reason: Reason }),
  response: JobRun,
  status: 201,
});

export const rescheduleJob = endpoint({
  id: "ops.scheduler.reschedule",
  method: "PUT",
  path: "/api/v1/admin/scheduler/jobs/:jobId/schedule",
  auth: "staff",
  summary: "Change when a job runs (cron and time zone)",
  params: JobParams,
  body: z.object({ cron: Cron, timezone: z.string().min(1).max(64), reason: Reason }),
  response: ScheduledJob,
});

// ---------------------------------------------------------------- organisation suspension

const OrgParams = z.object({ orgId: z.string().min(1) });

export const Suspension = z.object({
  id: z.string(),
  action: z.enum(["suspend", "reactivate"]),
  reason: z.string(),
  byUserId: z.string(),
  at: IsoDateTime,
});

export const suspendOrg = endpoint({
  id: "ops.orgs.suspend",
  method: "POST",
  path: "/api/v1/admin/orgs/:orgId/suspend",
  auth: "staff",
  summary:
    "Suspend a whole organisation: its members can no longer open it (records are kept; payments still arrive). Audited.",
  params: OrgParams,
  body: z.object({ reason: Reason }),
  response: z.object({ orgId: z.string(), suspended: z.literal(true), since: IsoDateTime }),
});

export const reactivateOrg = endpoint({
  id: "ops.orgs.reactivate",
  method: "POST",
  path: "/api/v1/admin/orgs/:orgId/reactivate",
  auth: "staff",
  summary: "Lift an organisation's suspension. Audited.",
  params: OrgParams,
  body: z.object({ reason: Reason }),
  response: z.object({ orgId: z.string(), suspended: z.literal(false) }),
});

export const listSuspensions = endpoint({
  id: "ops.orgs.suspensions",
  method: "GET",
  path: "/api/v1/admin/orgs/:orgId/suspensions",
  auth: "staff",
  summary: "Whether an organisation is suspended, and every suspension and reactivation",
  params: OrgParams,
  response: z.object({
    suspended: z.boolean(),
    reason: z.string().nullable(),
    since: IsoDateTime.nullable(),
    history: z.array(Suspension),
  }),
});

// ---------------------------------------------------------------- data export (subject access, offboarding)

export const ORG_EXPORT_FORMAT = "paltas-org-export/1";

export const exportOrg = endpoint({
  id: "ops.orgs.export",
  method: "GET",
  path: "/api/v1/admin/orgs/:orgId/export",
  auth: "staff",
  summary:
    "Every record of one organisation as one JSON document, streamed (no passwords, sessions, secrets or file bytes). Audited with the reason.",
  params: OrgParams,
  query: z.object({ reason: Reason }),
  response: z.object({
    format: z.literal(ORG_EXPORT_FORMAT),
    exportedAt: IsoDateTime,
    organisation: z.record(z.string(), z.unknown()),
    members: z.array(
      z.object({ userId: z.string(), email: z.string(), name: z.string(), role: z.string(), status: z.string() }),
    ),
    tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  }),
});

// ---------------------------------------------------------------- catalogue price changes

export const PriceChangeStatus = z.enum(["pending", "applied", "rejected"]);
export const PriceChangeTarget = z.enum(["plan", "module"]);

export const PriceChange = z.object({
  id: z.string(),
  target: PriceChangeTarget,
  targetId: z.string(),
  before: z.record(z.string(), z.unknown()),
  proposed: z.record(z.string(), z.unknown()),
  applied: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string(),
  status: PriceChangeStatus,
  requestedBy: z.string(),
  requestedAt: IsoDateTime,
  decidedBy: z.string().nullable(),
  decidedAt: IsoDateTime.nullable(),
  decisionNote: z.string().nullable(),
});
export type PriceChange = z.infer<typeof PriceChange>;

const NullableMinor = z.number().int().positive().nullable();

export const requestPriceChange = endpoint({
  id: "ops.prices.request",
  method: "POST",
  path: "/api/v1/admin/price-changes",
  auth: "staff",
  summary:
    "Ask for a price change on a plan (base / additional building) or a module. It applies only when ANOTHER Super Admin approves it.",
  body: z.discriminatedUnion("target", [
    z.object({
      target: z.literal("plan"),
      targetId: z.string().min(1),
      baseMinor: NullableMinor.optional(),
      extraBuildingMinor: NullableMinor.optional(),
      currency: Currency,
      reason: Reason,
    }),
    z.object({
      target: z.literal("module"),
      targetId: z.string().min(1),
      priceMinor: NullableMinor,
      currency: Currency,
      reason: Reason,
    }),
  ]),
  response: PriceChange,
  status: 201,
});

export const listPriceChanges = endpoint({
  id: "ops.prices.list",
  method: "GET",
  path: "/api/v1/admin/price-changes",
  auth: "staff",
  summary: "Price change requests and their history, newest first",
  query: z.object({ status: PriceChangeStatus.optional(), targetId: z.string().optional() }),
  response: z.object({ changes: z.array(PriceChange) }),
});

const ChangeParams = z.object({ changeId: z.string().min(1) });

export const approvePriceChange = endpoint({
  id: "ops.prices.approve",
  method: "POST",
  path: "/api/v1/admin/price-changes/:changeId/approve",
  auth: "staff",
  summary: "Approve and apply a price change (not by the person who asked). Issued invoices are never rewritten.",
  params: ChangeParams,
  body: z.object({ note: z.string().trim().max(500).optional() }),
  response: PriceChange,
});

export const rejectPriceChange = endpoint({
  id: "ops.prices.reject",
  method: "POST",
  path: "/api/v1/admin/price-changes/:changeId/reject",
  auth: "staff",
  summary: "Reject a price change (not by the person who asked)",
  params: ChangeParams,
  body: z.object({ reason: Reason }),
  response: PriceChange,
});

// ---------------------------------------------------------------- audit search

export const auditSearch = endpoint({
  id: "ops.audit.search",
  method: "GET",
  path: "/api/v1/admin/audit/search",
  auth: "staff",
  summary: "Search the platform audit trail by organisation, person, action, target, words and date range",
  query: z.object({
    orgId: z.string().optional(),
    actorUserId: z.string().optional(),
    /** Exact action, e.g. "Organisation suspended". */
    action: z.string().optional(),
    target: z.string().optional(),
    /** Words found in the action, target or detail (case-insensitive). */
    q: z.string().trim().min(2).max(100).optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    /** Continue after this entry id (from nextBefore). */
    before: z.string().regex(/^\d+$/).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  response: z.object({
    entries: z.array(AuditEntry.extend({ orgId: z.string().nullable() })),
    nextBefore: z.string().nullable(),
  }),
});
