import { createHash } from "node:crypto";
import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { memberProductRole } from "../../../core/access/product-role.js";
import { memberCan, managerGrant } from "../../../core/access/manager-access.js";
import { resolveEntitlement } from "../../../core/subscriptions/entitlement.service.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextFire } from "../../../core/scheduler/cron.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import { propertyRow } from "../shared/records.js";
import { MODULE } from "../shared/access.js";
import { exportCollections } from "./collections-export.js";
export const COLLECTION_REPORT_JOB = "property.collection_reports";
type Input = P.CollectionReportScheduleInput;
type Row = Input & {
  id: string;
  org_id: string;
  property_id: string;
  version: number;
  timezone: string;
  updated_by: string;
  job_status: "active" | "paused" | null;
  next_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_summary: string | null;
};
type Run = {
  id: string;
  schedule_id: string;
  version: number;
  from_date: string;
  to_date: string;
  as_of: string;
  created_at: string;
  trigger: "manual" | "schedule";
  filename: string;
  row_count: number;
  fingerprint: string;
  content: string;
  encoding: "utf8" | "base64";
  content_type: "text/csv" | "text/html" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
};
const metadata = "id,schedule_id,version,from_date,to_date,as_of,created_at,trigger,filename,row_count,fingerprint";
const select = `SELECT r.*,j.status AS job_status,j.next_run_at,j.last_status,rr.error AS last_error,rr.summary AS last_summary FROM pm_collection_report_schedules r LEFT JOIN sched_jobs j ON j.org_id=r.org_id AND j.target_id=r.id AND j.key='${COLLECTION_REPORT_JOB}' LEFT JOIN LATERAL (SELECT error,summary FROM sched_runs WHERE job_id=j.id ORDER BY created_at DESC,id DESC LIMIT 1) rr ON true`;
const dto = (r: Row): P.CollectionReportSchedule => ({
  id: r.id,
  propertyId: r.property_id,
  name: r.name,
  kind: r.kind,
  format: r.format,
  frequency: r.frequency,
  hour: r.hour,
  minute: r.minute,
  status: r.status,
  timezone: r.timezone,
  version: r.version,
  jobStatus: r.job_status,
  nextRunAt: r.next_run_at,
  lastStatus: r.last_status,
  lastError: r.last_error,
  lastSummary: r.last_summary,
});
const runDto = (r: Run) => ({
  id: r.id,
  version: r.version,
  from: r.from_date,
  to: r.to_date,
  asOf: r.as_of,
  createdAt: r.created_at,
  trigger: r.trigger,
  filename: r.filename,
  rowCount: r.row_count,
  fingerprint: r.fingerprint,
});
/** Last COMPLETE local calendar period. Weekly reports cover Monday through Sunday. */
export function collectionReportWindow(frequency: Input["frequency"], today: string) {
  const day = new Date(today + "T00:00:00Z"),
    iso = (d: Date) => d.toISOString().slice(0, 10);
  const start = new Date(day);
  if (frequency === "daily") start.setUTCDate(start.getUTCDate() - 1);
  else if (frequency === "weekly") start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7) - 7);
  else {
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - 1);
  }
  const end = new Date(start);
  if (frequency === "weekly") end.setUTCDate(end.getUTCDate() + 6);
  if (frequency === "monthly") {
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0);
  }
  return { from: iso(start), to: iso(end) };
}
export function reportSchedulesService(d: PmDeps) {
  const { core, ctx } = d,
    db = core.db;
  async function property(t: Db, s: OrgScope, id: string) {
    if (s.propertyIds && !s.propertyIds.includes(id)) throw fail.notFound("Property not found");
    await propertyRow(t, s.orgId, id);
  }
  async function row(t: Db, s: OrgScope, id: string, lock = false) {
    const r = await t.row<Row>(select + ` WHERE r.org_id=$1 AND r.id=$2${lock ? " FOR UPDATE OF r" : ""}`, [
      s.orgId,
      id,
    ]);
    if (!r) throw fail.notFound("Report schedule not found");
    await property(t, s, r.property_id);
    return r;
  }
  async function schedule(t: Db, r: Row) {
    const cron = `${r.minute} ${r.hour} ${r.frequency === "monthly" ? "1" : "*"} * ${r.frequency === "weekly" ? "1" : "*"}`;
    const job = await core.scheduler.ensureJob(t, {
      key: COLLECTION_REPORT_JOB,
      orgId: r.org_id,
      targetId: r.id,
      label: r.name,
      cron,
      timezone: r.timezone,
    });
    await t.run("UPDATE sched_jobs SET status=$2,paused_reason=$3,next_run_at=$4 WHERE id=$1", [
      job.id,
      r.status === "active" ? "active" : "paused",
      r.status === "active" ? null : "Report schedule " + r.status,
      nextFire(cron, ctx.clock.now(), r.timezone)?.toISOString() ?? null,
    ]);
  }
  const currentDate = (timezone: string) => {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(ctx.clock.now());
    return ["year", "month", "day"].map((x) => p.find((a) => a.type === x)?.value).join("-");
  };
  async function generate(s: OrgScope, id: string, trigger: "manual" | "schedule", localDate?: string) {
    const r = await row(db, s, id);
    if (r.status === "archived" || (trigger === "schedule" && r.status !== "active"))
      throw fail.conflict("This report schedule is not active");
    const window = collectionReportWindow(r.frequency, localDate ?? currentDate(r.timezone));
    const existing = await db.row<Run>(
      `SELECT ${metadata} FROM pm_collection_report_runs WHERE schedule_id=$1 AND version=$2 AND from_date=$3 AND to_date=$4`,
      [id, r.version, window.from, window.to],
    );
    if (existing) return runDto(existing);
    const property = await propertyRow(db, s.orgId, r.property_id);
    const report = await exportCollections(
      db,
      s,
      { ...window, propertyId: r.property_id, kind: r.kind, format: r.format, invoiceStatus: "billed" },
      { propertyName: property.name, reportName: r.name },
    );
    const safe = (name: string) =>
      Array.from(name.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-"))
        .slice(0, 45)
        .join("") || "report";
    const filename = `paltas-${safe(property.name)}-${safe(r.name)}-${window.from}-${window.to}.${r.format === "print" ? "html" : r.format}`;
    return db.tx(async (t) => {
      const latest = await row(t, s, id, true);
      if (
        latest.version !== r.version ||
        latest.status === "archived" ||
        (trigger === "schedule" && latest.status !== "active")
      )
        throw fail.conflict("Report schedule changed during preparation. Reopen it before trying again.");
      const saved = await t.row<Run>(
        `INSERT INTO pm_collection_report_runs(id,org_id,property_id,schedule_id,version,from_date,to_date,as_of,trigger,filename,content,encoding,content_type,row_count,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(schedule_id,version,from_date,to_date) DO NOTHING RETURNING *`,
        [
          newId("crr"),
          s.orgId,
          r.property_id,
          id,
          r.version,
          window.from,
          window.to,
          s.today,
          trigger,
          filename,
          report.content,
          report.encoding,
          report.contentType,
          report.rowCount,
          report.fingerprint,
        ],
      );
      const result =
        saved ??
        (await t.row<Run>(
          `SELECT ${metadata} FROM pm_collection_report_runs WHERE schedule_id=$1 AND version=$2 AND from_date=$3 AND to_date=$4`,
          [id, r.version, window.from, window.to],
        ));
      if (!result) throw fail.conflict("Report could not be saved. Try again.");
      if (saved)
        await recordAudit(t, {
          orgId: s.orgId,
          actor: s.actor,
          action: "Collection report prepared",
          target: id,
          after: runDto(saved),
        });
      return runDto(result);
    });
  }
  return {
    async list(s: OrgScope, q: { propertyId: string; limit: number; offset: number }) {
      await property(db, s, q.propertyId);
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const count = await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM pm_collection_report_schedules WHERE org_id=$1 AND property_id=$2",
          [s.orgId, q.propertyId],
        );
        const rows = await t.rows<Row>(
          select + " WHERE r.org_id=$1 AND r.property_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT $3 OFFSET $4",
          [s.orgId, q.propertyId, q.limit, q.offset],
        );
        return { schedules: rows.map(dto), total: count?.n ?? 0, limit: q.limit, offset: q.offset };
      });
    },
    async create(s: OrgScope, b: Input & { propertyId: string; requestKey: string }) {
      return db.tx(async (t) => {
        await property(t, s, b.propertyId);
        await t.run("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["collection-report-schedules:" + s.orgId]);
        const old = await t.row<Row>(
          "SELECT * FROM pm_collection_report_schedules WHERE org_id=$1 AND request_key=$2",
          [s.orgId, b.requestKey],
        );
        if (old) {
          await property(t, s, old.property_id);
          if (
            old.property_id !== b.propertyId ||
            (["name", "kind", "format", "frequency", "hour", "minute", "status"] as const).some((k) => old[k] !== b[k])
          )
            throw fail.conflict("This request key was already used for a different report schedule");
          return dto(await row(t, s, old.id));
        }
        const count = await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM pm_collection_report_schedules WHERE org_id=$1 AND property_id=$2 AND status<>'archived'",
          [s.orgId, b.propertyId],
        );
        if ((count?.n ?? 0) >= 20)
          throw fail.invalid("Archive an unused schedule before adding more than 20 schedules for this property");
        const org = await t.row<{ timezone: string }>("SELECT timezone FROM organisations WHERE id=$1", [s.orgId]);
        const id = newId("crs");
        await t.run(
          "INSERT INTO pm_collection_report_schedules(id,org_id,property_id,name,kind,format,frequency,hour,minute,timezone,status,request_key,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
          [
            id,
            s.orgId,
            b.propertyId,
            b.name,
            b.kind,
            b.format,
            b.frequency,
            b.hour,
            b.minute,
            org?.timezone ?? "UTC",
            b.status,
            b.requestKey,
            s.userId,
          ],
        );
        const r = await row(t, s, id);
        await schedule(t, r);
        const result = dto(await row(t, s, id));
        await recordAudit(t, {
          orgId: s.orgId,
          actor: s.actor,
          action: "Collection report schedule created",
          target: id,
          after: result,
        });
        return result;
      });
    },
    async update(s: OrgScope, id: string, b: Input & { expectedVersion: number; reason: string }) {
      return db.tx(async (t) => {
        await t.run("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["collection-report-schedules:" + s.orgId]);
        const r = await row(t, s, id, true);
        if (r.status === "archived" && b.status !== "archived") {
          const count = await t.row<{ n: number }>(
            "SELECT count(*)::int AS n FROM pm_collection_report_schedules WHERE org_id=$1 AND property_id=$2 AND status<>'archived'",
            [s.orgId, r.property_id],
          );
          if ((count?.n ?? 0) >= 20)
            throw fail.invalid("Archive an unused schedule before restoring more than 20 schedules for this property");
        }
        if (r.version !== b.expectedVersion) throw fail.conflict("This schedule changed. Reopen it before saving.");
        await t.run(
          "UPDATE pm_collection_report_schedules SET name=$3,kind=$4,format=$5,frequency=$6,hour=$7,minute=$8,status=$9,version=version+1,updated_by=$10,timezone=(SELECT timezone FROM organisations WHERE id=$1) WHERE org_id=$1 AND id=$2",
          [s.orgId, id, b.name, b.kind, b.format, b.frequency, b.hour, b.minute, b.status, s.userId],
        );
        await schedule(t, await row(t, s, id));
        const result = dto(await row(t, s, id));
        await recordAudit(t, {
          orgId: s.orgId,
          actor: s.actor,
          action: "Collection report schedule changed",
          target: id,
          detail: b.reason,
          before: dto(r),
          after: result,
        });
        return result;
      });
    },
    generate,
    async runs(s: OrgScope, id: string, q: { limit: number; offset: number }) {
      await row(db, s, id);
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const count = await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM pm_collection_report_runs WHERE org_id=$1 AND schedule_id=$2",
          [s.orgId, id],
        );
        const rows = await t.rows<Run>(
          `SELECT ${metadata} FROM pm_collection_report_runs WHERE org_id=$1 AND schedule_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,
          [s.orgId, id, q.limit, q.offset],
        );
        return { reports: rows.map(runDto), total: count?.n ?? 0, ...q };
      });
    },
    async download(s: OrgScope, id: string) {
      const r = await db.row<Run>("SELECT * FROM pm_collection_report_runs WHERE org_id=$1 AND id=$2", [s.orgId, id]);
      if (!r) throw fail.notFound("Prepared report not found");
      await row(db, s, r.schedule_id);
      if (createHash("sha256").update(Buffer.from(r.content, r.encoding)).digest("hex") !== r.fingerprint)
        throw fail.conflict(
          "Prepared report integrity check failed. Generate a new report and ask your administrator to review the saved file.",
        );
      await recordAudit(db, {
        orgId: s.orgId,
        actor: s.actor,
        action: "Prepared collection report downloaded",
        target: id,
        after: { fingerprint: r.fingerprint },
      });
      return {
        filename: r.filename,
        content: r.content,
        encoding: r.encoding,
        contentType: r.content_type,
        rowCount: r.row_count,
        fingerprint: r.fingerprint,
      };
    },
    async automatic(orgId: string, id: string, localDate: string) {
      const r = await db.row<Row>("SELECT * FROM pm_collection_report_schedules WHERE org_id=$1 AND id=$2", [
        orgId,
        id,
      ]);
      if (!r || r.status !== "active") return { summary: "Report schedule is paused or archived — nothing prepared" };
      const user = await db.row(
        "SELECT u.id FROM users u JOIN organisations o ON o.id=$2 WHERE u.id=$1 AND u.active AND o.suspended_at IS NULL",
        [r.updated_by, orgId],
      );
      const role = user ? await memberProductRole(db, orgId, r.updated_by, "property") : null;
      if (
        !role ||
        !(await memberCan(db, orgId, r.updated_by, role, "property", "property.reports.read")) ||
        !(await memberCan(db, orgId, r.updated_by, role, "property", "property.billing"))
      )
        return { summary: "Report authorisation was revoked — nothing prepared" };
      const grant = role === "main_manager" ? await managerGrant(db, orgId, r.updated_by, "property") : null;
      if (
        role === "main_manager" &&
        (!(await memberCan(db, orgId, r.updated_by, role, "property", "property.tenants.history")) ||
          (grant?.propertyIds && !grant.propertyIds.includes(r.property_id)))
      )
        return { summary: "Property report authorisation was revoked — nothing prepared" };
      const entitlement = await resolveEntitlement(db, ctx.products, ctx.clock.today(), orgId, "property");
      if (!entitlement?.ent.usable || !entitlement.ent.modules[MODULE.finance])
        return { summary: "Property finance subscription is not active — nothing prepared" };
      const s: OrgScope = {
        orgId,
        userId: r.updated_by,
        role,
        product: "property",
        entitlement,
        today: ctx.clock.today(),
        actor: { userId: null, role: "system:scheduler" },
        propertyIds: grant?.propertyIds ?? null,
      };
      const report = await generate(s, id, "schedule", localDate);
      return {
        summary: `Prepared ${report.rowCount} record(s) in ${report.filename}; available in the workspace. No email sent.`,
      };
    },
  };
}
export type ReportSchedulesService = ReturnType<typeof reportSchedulesService>;
