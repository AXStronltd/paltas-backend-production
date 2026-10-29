import { createHash } from "node:crypto";
import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { ApiError, fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import { financeTransaction } from "../shared/finance-transaction.js";
import { issueInvoice, type NewInvoiceLine } from "../shared/money.js";
import * as R from "../shared/records.js";
import { addDays, addMonths, lastDay } from "../shared/util.js";
import { rentLine, type BillingOp } from "./billing.service.js";

export const FLEXIBLE_RENT_JOB = "property.flexible_rent";
export interface ScheduleRow {
  id: string;
  org_id: string;
  lease_id: string;
  property_id: string;
  cadence: P.RentSchedule["cadence"];
  every_days: number | null;
  starts_on: string;
  anchor_date: string;
  next_date: string;
  due_days: number;
  status: P.RentSchedule["status"];
  version: number;
  last_error: string | null;
}
const out = (r: ScheduleRow): P.RentSchedule => ({
  id: r.id,
  leaseId: r.lease_id,
  propertyId: r.property_id,
  cadence: r.cadence,
  everyDays: r.every_days,
  startsOn: r.starts_on,
  anchorDate: r.anchor_date,
  nextDate: r.next_date,
  dueDays: r.due_days,
  status: r.status,
  version: r.version,
  lastError: r.last_error,
});

/** Month cadences retain the anchor day (31 Jan -> 28 Feb -> 31 Mar), not the clamped previous day. */
export function nextRentBoundary(
  anchor: string,
  from: string,
  cadence: ScheduleRow["cadence"],
  days: number | null,
): string {
  if (cadence === "weekly" || cadence === "custom_days")
    return addDays(from, cadence === "weekly" ? 7 : (days as number));
  const size = cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12;
  const months =
    (Number(from.slice(0, 4)) - Number(anchor.slice(0, 4))) * 12 +
    Number(from.slice(5, 7)) -
    Number(anchor.slice(5, 7));
  const m = addMonths(anchor.slice(0, 7) + "-01", (Math.floor(months / size) + 1) * size).slice(0, 7);
  const day = Math.min(Number(anchor.slice(8)), Number(lastDay(m).slice(8)));
  const next = m + "-" + String(day).padStart(2, "0");
  if (next <= from || next.length !== 10) throw fail.invalid("The schedule exceeds the supported calendar");
  return next;
}

/** Allocate each month's rounded cumulative rent to intervals. Partitioning a month never adds rounding drift. */
export async function intervalRent(t: Db, l: R.LeaseRow, from: string, through: string) {
  if (from < l.start_date || through < from || (l.end_date && through > l.end_date))
    throw fail.invalid("Rent interval is outside the lease");
  let month = from.slice(0, 7),
    amount = 0;
  const parts: Record<string, unknown>[] = [];
  for (let guard = 0; month <= through.slice(0, 7); guard++) {
    if (guard > 12) throw fail.invalid("Rent intervals cannot exceed one year");
    const first = month + "-01",
      end = lastDay(month),
      lo = from > first ? from : first,
      hi = through < end ? through : end;
    const upper = await rentLine(t, { ...l, end_date: hi }, month, true);
    const before = addDays(lo, -1);
    const lower =
      before >= first && before >= l.start_date ? await rentLine(t, { ...l, end_date: before }, month, true) : null;
    const value = upper.line.amountMinor - (lower?.line.amountMinor ?? 0);
    amount += value;
    parts.push({
      from: lo,
      through: hi,
      amountMinor: value,
      cumulativeThrough: upper.line.pricingSnapshot,
      cumulativeBefore: lower?.line.pricingSnapshot ?? null,
    });
    month = addMonths(first, 1).slice(0, 7);
  }
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw fail.invalid("This interval produces less than one minor currency unit; choose a longer billing interval");
  const description = `Rent ${from} to ${through}`;
  const snapshot = { method: "calendar_month_cumulative_difference", from, through, months: parts };
  const line: NewInvoiceLine = {
    code: "RENT",
    description,
    quantity: 1,
    rateMinor: amount,
    amountMinor: amount,
    payee: "owner",
    feeApplies: true,
    vatApplies: false,
    pricingSnapshot: snapshot,
  };
  return { amount, line, snapshot, description };
}

export function rentSchedulesService(d: PmDeps) {
  const { core } = d,
    db = core.db;
  const read = async (t: Db, orgId: string, leaseId: string) =>
    t.row<ScheduleRow>("SELECT * FROM pm_rent_schedules WHERE org_id=$1 AND lease_id=$2", [orgId, leaseId]);
  async function requireSchedule(t: Db, orgId: string, leaseId: string) {
    const row = await read(t, orgId, leaseId);
    if (!row) throw fail.notFound("Rent schedule");
    return row;
  }
  async function requireLease(t: Db, s: BillingOp, id: string) {
    const l = await R.leaseRow(t, s.orgId, id, true);
    if (l.status !== "active")
      throw fail.conflict("Rent schedules require an active lease; ended or cancelled leases cannot generate rent");
    return l;
  }
  async function quote(t: Db, s: BillingOp, l: R.LeaseRow, r: ScheduleRow) {
    const next = nextRentBoundary(r.anchor_date, r.next_date, r.cadence, r.every_days);
    const through = l.end_date && l.end_date < next ? l.end_date : addDays(next, -1);
    if (r.next_date > through) throw fail.conflict("This lease has no unbilled days remaining");
    const agreement = await R.agreementForUnit(t, s.orgId, l.unit_id, r.next_date);
    if (!agreement || (agreement.end_date && agreement.end_date < through))
      throw fail.conflict(
        "Management authority must cover the complete rent interval; review the agreement before billing",
      );
    const endAuthority = await R.agreementForUnit(t, s.orgId, l.unit_id, through);
    if (!endAuthority || endAuthority.id !== agreement.id)
      throw fail.conflict(
        "Management authority changes within this rent interval. Use a shorter interval or complete an authorised agreement correction first",
      );
    const overlap = await t.row<{ id: string }>(
      `SELECT id FROM pm_invoices WHERE org_id=$1 AND lease_id=$2 AND kind='rent'
      AND COALESCE(rent_from,(period || '-01')::date)<=$4::date
      AND COALESCE(rent_through,((period || '-01')::date+interval '1 month - 1 day')::date)>=$3::date LIMIT 1`,
      [s.orgId, l.id, r.next_date, through],
    );
    if (overlap)
      throw fail.conflict(
        "A rent invoice already covers part of this interval. Review existing invoices before changing the schedule",
      );
    const q = await intervalRent(t, l, r.next_date, through);
    const nextDate = through === l.end_date ? addDays(through, 1) : next;
    const preview = {
      from: r.next_date,
      through,
      nextDate,
      amountMinor: q.amount,
      dueDate: addDays(r.next_date > s.today ? r.next_date : s.today, r.due_days),
      due: r.next_date <= s.today,
      description: q.description,
      calculation: q.snapshot,
      version: r.version,
    };
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          s.orgId,
          l.id,
          r,
          preview,
          { id: agreement.id, owner: agreement.owner_id, fee: agreement.fee_bp, end: agreement.end_date },
        ]),
      )
      .digest("hex");
    return { preview: { ...preview, previewKey: key }, q, agreement };
  }
  async function proposed(t: Db, s: OrgScope, id: string, b: P.RentScheduleInput) {
    const l = await requireLease(t, s, id),
      old = await read(t, s.orgId, id);
    if ((old?.version ?? 0) !== b.expectedVersion)
      throw fail.conflict("The rent schedule changed. Reopen it before saving");
    if (old && b.startDate !== old.next_date)
      throw fail.invalid("An existing schedule must continue from its next unbilled date");
    if (!old && b.startDate !== l.start_date && !b.startDate.endsWith("-01"))
      throw fail.invalid(
        "Start a new schedule at lease commencement or the first day of a month. Bill the current calendar month first to avoid leaving unbilled days",
      );
    if (!old && b.startDate < s.today)
      throw fail.invalid("A new schedule cannot silently generate historical rent; choose today or a future date");
    if (b.startDate < l.start_date || (l.end_date && b.startDate > l.end_date))
      throw fail.invalid("The schedule starts outside the lease");
    const r: ScheduleRow = {
      id: old?.id ?? "preview",
      org_id: s.orgId,
      lease_id: id,
      property_id: l.property_id,
      cadence: b.cadence,
      every_days: b.everyDays,
      starts_on: old?.starts_on ?? b.startDate,
      anchor_date: b.startDate,
      next_date: b.startDate,
      due_days: b.dueDays,
      status: "active",
      version: b.expectedVersion,
      last_error: null,
    };
    return { old, l, r, ...(await quote(t, s, l, r)) };
  }
  async function issueNext(s: BillingOp, id: string, key?: string) {
    return financeTransaction(db, s.orgId, async (t) => {
      const l = await requireLease(t, s, id),
        r = await read(t, s.orgId, id);
      if (!r) throw fail.notFound("Rent schedule");
      const q = await quote(t, s, l, r);
      if (key && key !== q.preview.previewKey)
        throw fail.conflict("Rent or schedule details changed. Preview again before issuing");
      if (!q.preview.due) throw fail.conflict("This rent interval is not due for invoicing yet");
      const invoiceId = await issueInTransaction(t, s, l, r, q);
      const [invoice] = await R.invoiceViews(t, [await R.invoiceRow(t, s.orgId, invoiceId)], s.today);
      return { invoice: invoice ?? null, schedule: out(await requireSchedule(t, s.orgId, id)) };
    });
  }
  return {
    async get(s: OrgScope, id: string) {
      await R.leaseRow(db, s.orgId, id);
      const r = await read(db, s.orgId, id);
      return { schedule: r ? out(r) : null };
    },
    async preview(s: OrgScope, id: string, b: P.RentScheduleInput) {
      return financeTransaction(db, s.orgId, async (t) => (await proposed(t, s, id, b)).preview);
    },
    async save(s: OrgScope, id: string, b: { input: P.RentScheduleInput; previewKey: string }) {
      return financeTransaction(db, s.orgId, async (t) => {
        const p = await proposed(t, s, id, b.input);
        if (p.preview.previewKey !== b.previewKey)
          throw fail.conflict("Rent or schedule details changed. Preview again before enabling");
        const r = p.r;
        await t.run(
          `INSERT INTO pm_rent_schedules(id,org_id,lease_id,property_id,cadence,every_days,starts_on,anchor_date,next_date,due_days,reason,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11)
          ON CONFLICT(lease_id) DO UPDATE SET cadence=EXCLUDED.cadence,every_days=EXCLUDED.every_days,anchor_date=EXCLUDED.anchor_date,due_days=EXCLUDED.due_days,status='active',version=pm_rent_schedules.version+1,reason=EXCLUDED.reason,last_error=NULL,updated_at=now()`,
          [
            p.old?.id ?? newId("prs"),
            s.orgId,
            id,
            r.property_id,
            r.cadence,
            r.every_days,
            r.starts_on,
            r.anchor_date,
            r.due_days,
            b.input.reason,
            s.userId,
          ],
        );
        const org = await t.row<{ timezone: string }>("SELECT timezone FROM organisations WHERE id=$1", [s.orgId]);
        await core.scheduler.ensureJob(t, {
          key: FLEXIBLE_RENT_JOB,
          orgId: s.orgId,
          targetId: r.property_id,
          label: "Flexible rent billing",
          cron: "0 6 * * *",
          timezone: org?.timezone ?? "UTC",
        });
        const saved = out(await requireSchedule(t, s.orgId, id));
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Rent schedule configured",
          target: id,
          before: p.old ? out(p.old) : null,
          after: saved,
          detail: b.input.reason,
        });
        return saved;
      });
    },
    async status(s: OrgScope, id: string, b: { action: "pause" | "resume"; expectedVersion: number; reason: string }) {
      return financeTransaction(db, s.orgId, async (t) => {
        const l = await R.leaseRow(t, s.orgId, id, true),
          r = await read(t, s.orgId, id);
        if (!r) throw fail.notFound("Rent schedule");
        if (r.version !== b.expectedVersion) throw fail.conflict("The rent schedule changed. Reopen it before saving");
        if (b.action === "resume" && (l.status !== "active" || (l.end_date && r.next_date > l.end_date)))
          throw fail.conflict("The lease has ended; future rent cannot resume");
        await t.run(
          "UPDATE pm_rent_schedules SET status=$3,version=version+1,reason=$4,last_error=NULL,updated_at=now() WHERE org_id=$1 AND lease_id=$2",
          [s.orgId, id, b.action === "pause" ? "paused" : "active", b.reason],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: b.action === "pause" ? "Rent schedule paused" : "Rent schedule resumed",
          target: id,
          detail: b.reason,
          before: out(r),
          after: out(await requireSchedule(t, s.orgId, id)),
        });
        return out(await requireSchedule(t, s.orgId, id));
      });
    },
    async previewRun(s: OrgScope, id: string) {
      return financeTransaction(db, s.orgId, async (t) => {
        const l = await requireLease(t, s, id),
          r = await read(t, s.orgId, id);
        if (!r) throw fail.notFound("Rent schedule");
        return (await quote(t, s, l, r)).preview;
      });
    },
    issueNext,
    async automatic(s: BillingOp, propertyId: string) {
      const due = await db.rows<ScheduleRow>(
        "SELECT * FROM pm_rent_schedules WHERE org_id=$1 AND property_id=$2 AND status='active' AND next_date<=$3 ORDER BY updated_at,next_date,id LIMIT 100",
        [s.orgId, propertyId, s.today],
      );
      let created = 0,
        blocked = 0;
      for (const initial of due) {
        for (let count = 0; count < 50; count++) {
          try {
            // Re-check inside the SAME finance lock as pause/edit and monthly billing.
            const result = await financeTransaction(db, s.orgId, async (t) => {
              const r = await read(t, s.orgId, initial.lease_id);
              if (!r || r.status !== "active" || r.next_date > s.today) return false;
              const l = await R.leaseRow(t, s.orgId, r.lease_id, true);
              if (l.status !== "active" || (l.end_date && r.next_date > l.end_date)) {
                await t.run(
                  "UPDATE pm_rent_schedules SET status='completed',version=version+1,updated_at=now() WHERE id=$1",
                  [r.id],
                );
                await recordAudit(t, {
                  actor: s.actor,
                  orgId: s.orgId,
                  action: "Rent schedule completed",
                  target: l.id,
                  detail: "Lease ended; no new invoice created",
                });
                return false;
              }
              // Both manual and automated billing share this transaction-bound issuer.
              return await issueInTransaction(t, s, l, r);
            });
            if (!result) break;
            created++;
          } catch (e) {
            const message = e instanceof ApiError ? e.message : "Rent billing failed; retry or contact PALTAS support";
            await db.run("UPDATE pm_rent_schedules SET last_error=$3,updated_at=now() WHERE org_id=$1 AND id=$2", [
              s.orgId,
              initial.id,
              message.slice(0, 1000),
            ]);
            blocked++;
            break;
          }
        }
      }
      return { summary: `${created} scheduled rent invoice(s); ${blocked} schedule(s) need review` };
    },
  };
  async function issueInTransaction(
    t: Db,
    s: BillingOp,
    l: R.LeaseRow,
    r: ScheduleRow,
    quoted?: Awaited<ReturnType<typeof quote>>,
  ) {
    const q = quoted ?? (await quote(t, s, l, r));
    const id = await issueInvoice(t, core, {
      orgId: s.orgId,
      kind: "rent",
      lease: l,
      period: r.next_date.slice(0, 7),
      issueDate: s.today,
      dueDate: q.preview.dueDate,
      note: `Scheduled ${r.cadence} billing; agreed monthly rent apportioned by calendar day`,
      billingKey: `rent-schedule:${r.id}:${r.next_date}`,
      authorityDate: r.next_date,
      rentFrom: r.next_date,
      rentThrough: q.preview.through,
      createdBy: s.userId,
      lines: [q.q.line],
    });
    if (!id) throw fail.conflict("An overlapping rent invoice exists; review this schedule");
    await t.run(
      "UPDATE pm_rent_schedules SET next_date=$3,status=$4,version=version+1,last_error=NULL,updated_at=now() WHERE org_id=$1 AND lease_id=$2",
      [s.orgId, l.id, q.preview.nextDate, l.end_date && q.preview.nextDate > l.end_date ? "completed" : r.status],
    );
    await recordAudit(t, {
      actor: s.actor,
      orgId: s.orgId,
      action: "Scheduled rent invoice issued",
      target: l.id,
      detail: `${q.preview.from} to ${q.preview.through} · ${id}`,
    });
    return id;
  }
}
