import { financeTransaction } from "../shared/finance-transaction.js";
/*
 * Leases: draft → active (signed; unit free for the dates; covered by a management agreement; escalation steps
 * written; deposit invoiced) → renewed / rent reviewed → notice → ended at move-out. A draft can be cancelled.
 * Recurring charges per lease and meter readings feed the monthly charges run.
 */
import type { contacts as C, property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import { rentLine } from "../billing/billing.service.js";
import { chargeTypeRow } from "../setup/setup.service.js";
import { issueInvoice, numberScope } from "../shared/money.js";
import * as R from "../shared/records.js";
import { addDays, addMonths, applyBp, dueDateIn, toBp } from "../shared/util.js";

class PreviewOnly extends Error {
  constructor(
    readonly result: {
      rentMinor: number;
      depositMinor: number;
      period: string | null;
      issueDate: string | null;
      dueDate: string | null;
      note: string;
    },
  ) {
    super("Activation preview rolled back");
  }
}

export interface LeaseTerms {
  startDate: string;
  endDate: string | null;
  rentMinor: number;
  depositMinor: number;
  depositMode: "collect" | "held" | "none";
  dueDay: number;
  escalationPct: number;
  escalationMonths: number | null;
  noticeDays: number;
  charges: { chargeTypeId: string; amountMinor: number | null }[];
}

export function leasesService(d: PmDeps) {
  const { core } = d;
  const db = core.db;

  const views = (s: { orgId: string; today: string }, rows: R.LeaseRow[]) => R.leaseViews(db, s.orgId, rows, s.today);
  const one = async (s: { orgId: string; today: string }, id: string): Promise<P.Lease> => {
    const [v] = await views(s, [await R.leaseRow(db, s.orgId, id)]);
    return v as P.Lease;
  };

  function checkTerms(t: Pick<LeaseTerms, "startDate" | "endDate" | "escalationPct" | "escalationMonths">) {
    if (t.endDate && t.endDate < t.startDate) throw fail.invalid("The lease ends before it starts");
    if (t.escalationPct > 0 && !t.escalationMonths)
      throw fail.invalid("Say how often the escalation applies (every N months)");
  }

  async function writeCharges(t: Db, orgId: string, leaseId: string, charges: LeaseTerms["charges"]) {
    await t.run("DELETE FROM pm_lease_charges WHERE lease_id = $1", [leaseId]);
    const seen = new Set<string>();
    for (const c of charges) {
      if (seen.has(c.chargeTypeId)) throw fail.invalid("A charge type appears twice on the lease");
      seen.add(c.chargeTypeId);
      const ct = await chargeTypeRow(t, orgId, c.chargeTypeId);
      if (!ct.active) throw fail.invalid(`${ct.name} is no longer used`);
      if (ct.metered && c.amountMinor !== null)
        throw fail.invalid(`${ct.name} is metered: it is billed from readings, not a fixed amount`);
      const amount = ct.metered ? null : (c.amountMinor ?? (ct.rate_minor > 0 ? ct.rate_minor : null));
      if (!ct.metered && !amount) throw fail.invalid(`Give the monthly amount for ${ct.name}`);
      await t.run(
        "INSERT INTO pm_lease_charges (lease_id, charge_type_id, org_id, amount_minor) VALUES ($1, $2, $3, $4)",
        [leaseId, c.chargeTypeId, orgId, amount],
      );
    }
  }

  /** Rent steps from the start: the starting rent, then +escalation every N months until the lease ends. */
  async function writeSteps(t: Db, l: R.LeaseRow, by: string) {
    await t.run("DELETE FROM pm_rent_steps WHERE lease_id = $1 AND reason IN ('start', 'escalation')", [l.id]);
    await t.run(
      "INSERT INTO pm_rent_steps (lease_id, org_id, effective_from, rent_minor, reason, created_by) VALUES ($1, $2, $3, $4, 'start', $5) ON CONFLICT DO NOTHING",
      [l.id, l.org_id, l.start_date, l.rent_minor, by],
    );
    if (!l.escalation_bp || !l.escalation_months) return;
    const horizon = l.end_date ?? addMonths(l.start_date, 120);
    let rent = l.rent_minor;
    for (let k = 1; k <= 60; k++) {
      const from = addMonths(l.start_date, k * l.escalation_months);
      if (from > horizon) break;
      rent += applyBp(rent, l.escalation_bp);
      await t.run(
        "INSERT INTO pm_rent_steps (lease_id, org_id, effective_from, rent_minor, reason, created_by) VALUES ($1, $2, $3, $4, 'escalation', $5) ON CONFLICT DO NOTHING",
        [l.id, l.org_id, from, rent, by],
      );
    }
  }

  async function createDraft(
    t: Db,
    s: OrgScope,
    b: LeaseTerms & {
      unitId: string;
      tenantId: string;
      buildingId?: string;
      floor?: string;
      applicationId?: string | null;
    },
  ): Promise<string> {
    checkTerms(b);
    const unit = await R.unitRow(t, s.orgId, b.unitId);
    if (b.buildingId !== undefined && b.buildingId !== unit.building_id)
      throw fail.invalid("The unit is not in the selected block");
    if (b.floor !== undefined && b.floor !== unit.floor) throw fail.invalid("The unit is not on the selected floor");
    if (unit.status === "off_market") throw fail.conflict(`Unit ${unit.unit_no} is off the market`);
    await core.contacts.live(t, s.orgId, b.tenantId);
    await core.contacts.addTypes(t, s.orgId, b.tenantId, ["tenant"] as C.ContactType[]);
    const id = newId("pls");
    await t.run(
      `INSERT INTO pm_leases (id, org_id, number, property_id, unit_id, tenant_id, status, start_date, end_date, rent_minor,
         deposit_minor, deposit_mode, due_day, escalation_bp, escalation_months, notice_days, application_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        id,
        s.orgId,
        await nextNumber(t, numberScope(s.orgId), "LS", 5),
        unit.property_id,
        unit.id,
        b.tenantId,
        b.startDate,
        b.endDate,
        b.rentMinor,
        b.depositMinor,
        b.depositMinor > 0 ? b.depositMode : "none",
        b.dueDay,
        toBp(b.escalationPct),
        b.escalationMonths,
        b.noticeDays,
        b.applicationId ?? null,
        s.userId,
      ],
    );
    await writeCharges(t, s.orgId, id, b.charges);
    await core.contacts.activity(t, {
      orgId: s.orgId,
      contactId: b.tenantId,
      kind: "lease",
      text: `Draft lease for unit ${unit.unit_no} from ${b.startDate}`,
      refType: "lease",
      refId: id,
      by: s.userId,
    });
    await recordAudit(t, {
      actor: s.actor,
      orgId: s.orgId,
      action: "Lease drafted",
      target: id,
      detail: `${unit.unit_no} · rent ${b.rentMinor} · deposit ${b.depositMinor}`,
    });
    return id;
  }

  async function activate(
    s: OrgScope,
    id: string,
    b: {
      signedOn: string;
      billFirstRent?: boolean;
      billingMode?: "standard" | "historical";
      billDeposit?: boolean;
      firstRentPeriod?: string;
      expectedRentMinor?: number;
      expectedDepositMinor?: number;
    },
    preview = false,
  ) {
    const invoiceIds = await financeTransaction(db, s.orgId, async (t) => {
      const l = await R.leaseRow(t, s.orgId, id, true);
      if (l.status !== "draft") throw fail.conflict(`This lease is already ${l.status}`);
      if (b.signedOn > s.today) throw fail.invalid("The signing date is in the future");
      if (l.end_date && l.end_date < s.today) throw fail.conflict("This lease would already have ended");
      const unit = await R.unitRow(t, s.orgId, l.unit_id);
      if (unit.status === "off_market") throw fail.conflict(`Unit ${unit.unit_no} is off the market`);
      if (!(await R.agreementForUnit(t, s.orgId, l.unit_id, s.today)))
        throw fail.conflict(
          `No verified management authority covers unit ${unit.unit_no} today — complete ownership and management authority first`,
          {
            correction: {
              action: "complete_ownership",
              propertyId: l.property_id,
              unitId: l.unit_id,
              tenantId: l.tenant_id,
              leaseId: l.id,
            },
          },
        );
      // the database refuses two active leases on one unit for overlapping dates (pm_unit_not_double_let)
      try {
        await t.run("SAVEPOINT lease_activate");
        await t.run(
          "UPDATE pm_leases SET status = 'active', signed_on = $2, activated_by = $3, activated_at = now() WHERE id = $1",
          [id, b.signedOn, s.userId],
        );
        await t.run("RELEASE SAVEPOINT lease_activate");
      } catch (e) {
        await t.run("ROLLBACK TO SAVEPOINT lease_activate");
        if ((e as { code?: string }).code === "23P01")
          throw fail.conflict(`Unit ${unit.unit_no} already has an active lease for these dates`);
        throw e;
      }
      await writeSteps(t, l, s.userId);
      let invoiceId: string | null = null;
      if (
        b.billingMode !== "historical" &&
        l.start_date.slice(0, 7) >= s.today.slice(0, 7) &&
        b.billDeposit !== false &&
        l.deposit_mode === "collect" &&
        l.deposit_minor > 0
      ) {
        invoiceId = await issueInvoice(t, core, {
          orgId: s.orgId,
          kind: "deposit",
          lease: l,
          period: s.today.slice(0, 7),
          issueDate: s.today,
          dueDate: l.start_date > s.today ? l.start_date : s.today,
          note: "Security deposit, refundable",
          createdBy: s.userId,
          lines: [
            {
              code: "DEPOSIT",
              description: "Security deposit (refundable)",
              quantity: 1,
              rateMinor: l.deposit_minor,
              amountMinor: l.deposit_minor,
              payee: "deposit",
              feeApplies: false,
              vatApplies: false,
            },
          ],
        });
      }
      let firstRentInvoiceId: string | null = null;
      if (b.billFirstRent) {
        if (l.start_date.slice(0, 7) < s.today.slice(0, 7) && !b.firstRentPeriod)
          throw fail.invalid(
            "Historical lease: select and preview the next unpaid rent period explicitly, or activate without invoices",
          );
        const period = b.firstRentPeriod ?? l.start_date.slice(0, 7);
        if (period < l.start_date.slice(0, 7) || (l.end_date && period > l.end_date.slice(0, 7)))
          throw fail.invalid("The selected rent period is outside this lease");
        if (period > addMonths(s.today, 1).slice(0, 7))
          throw fail.invalid(
            "The lease starts more than one month ahead. Activate without billing rent now; bill closer to the start date.",
          );
        const rent = await rentLine(t, l, period);
        firstRentInvoiceId = await issueInvoice(t, core, {
          orgId: s.orgId,
          kind: "rent",
          lease: l,
          period,
          issueDate: period === l.start_date.slice(0, 7) ? l.start_date : s.today,
          dueDate: [
            l.start_date > `${period}-01` ? l.start_date : dueDateIn(period, l.due_day),
            period === l.start_date.slice(0, 7) ? l.start_date : s.today,
          ]
            .sort()
            .at(-1) as string,
          note: rent.note,
          createdBy: s.userId,
          lines: [rent.line],
        });
      }
      // a lease from a rental application wins its lead
      if (l.application_id) {
        const app = await t.row<{ lead_id: string }>("SELECT lead_id FROM pm_applications WHERE id = $1", [
          l.application_id,
        ]);
        if (app)
          await t.run("UPDATE pm_leads SET stage = 'won', stage_at = now() WHERE id = $1 AND stage <> 'won'", [
            app.lead_id,
          ]);
      }
      await core.contacts.activity(t, {
        orgId: s.orgId,
        contactId: l.tenant_id,
        kind: "lease",
        text: `Lease ${l.number} activated for unit ${l.unit_no} (signed ${b.signedOn})`,
        refType: "lease",
        refId: id,
        by: s.userId,
      });
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Lease activated",
        target: l.number,
        detail: `${l.unit_no} · ${l.tenant_name} · ${l.start_date} → ${l.end_date ?? "periodic"}`,
      });
      const deposit = invoiceId ? await R.invoiceRow(t, s.orgId, invoiceId) : null;
      const rent = firstRentInvoiceId ? await R.invoiceRow(t, s.orgId, firstRentInvoiceId) : null;
      if (b.expectedRentMinor !== undefined && b.expectedRentMinor !== (rent?.amount_minor ?? 0))
        throw fail.conflict("Rent changed after preview. Review the invoice again before confirming");
      if (b.expectedDepositMinor !== undefined && b.expectedDepositMinor !== (deposit?.amount_minor ?? 0))
        throw fail.conflict("Deposit changed after preview. Review the invoice again before confirming");
      if (preview)
        throw new PreviewOnly({
          rentMinor: rent?.amount_minor ?? 0,
          depositMinor: deposit?.amount_minor ?? 0,
          period: rent?.period ?? null,
          issueDate: rent?.issue_date ?? null,
          dueDate: rent?.due_date ?? null,
          note: rent?.note ?? "No rent invoice will be created",
        });
      return { deposit: invoiceId, rent: firstRentInvoiceId };
    });
    const lease = await one(s, id);
    let depositInvoice: P.Invoice | null = null;
    if (invoiceIds.deposit) {
      const [v] = await R.invoiceViews(db, [await R.invoiceRow(db, s.orgId, invoiceIds.deposit)], s.today);
      depositInvoice = v ?? null;
    }
    let firstRentInvoice: P.Invoice | null = null;
    if (invoiceIds.rent) {
      const [v] = await R.invoiceViews(db, [await R.invoiceRow(db, s.orgId, invoiceIds.rent)], s.today);
      firstRentInvoice = v ?? null;
    }
    return { lease, depositInvoice, ...(b.billFirstRent ? { firstRentInvoice } : {}) };
  }

  return {
    views,
    one,
    createDraft,

    async list(
      s: OrgScope,
      f: { status?: P.Lease["status"] | undefined; propertyId?: string | undefined; tenantId?: string | undefined },
    ) {
      const rows = await R.leaseRows(
        db,
        s.orgId,
        "($2::text IS NULL OR l.status = $2) AND ($3::text IS NULL OR l.property_id = $3) AND ($4::text IS NULL OR l.tenant_id = $4)",
        [f.status ?? null, f.propertyId ?? null, f.tenantId ?? null],
      );
      return { leases: await views(s, rows) };
    },

    async create(s: OrgScope, b: LeaseTerms & { unitId: string; tenantId: string }) {
      const id = await financeTransaction(db, s.orgId, (t) => createDraft(t, s, b));
      return one(s, id);
    },

    async update(s: OrgScope, id: string, b: Partial<LeaseTerms>) {
      await financeTransaction(db, s.orgId, async (t) => {
        const l = await R.leaseRow(t, s.orgId, id, true);
        if (l.status !== "draft")
          throw fail.conflict("Only a draft lease can be changed — renew or review the rent instead");
        const next = {
          startDate: b.startDate ?? l.start_date,
          endDate: b.endDate === undefined ? l.end_date : b.endDate,
          escalationPct: b.escalationPct ?? l.escalation_bp / 100,
          escalationMonths: b.escalationMonths === undefined ? l.escalation_months : b.escalationMonths,
        };
        checkTerms(next);
        const deposit = b.depositMinor ?? l.deposit_minor;
        await t.run(
          `UPDATE pm_leases SET start_date = $3, end_date = $4, rent_minor = $5, deposit_minor = $6, deposit_mode = $7,
             due_day = $8, escalation_bp = $9, escalation_months = $10, notice_days = $11 WHERE org_id = $1 AND id = $2`,
          [
            s.orgId,
            id,
            next.startDate,
            next.endDate,
            b.rentMinor ?? l.rent_minor,
            deposit,
            deposit > 0 ? (b.depositMode ?? (l.deposit_mode === "none" ? "collect" : l.deposit_mode)) : "none",
            b.dueDay ?? l.due_day,
            toBp(next.escalationPct),
            next.escalationMonths,
            b.noticeDays ?? l.notice_days,
          ],
        );
        if (b.charges) await writeCharges(t, s.orgId, id, b.charges);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Draft lease changed",
          target: l.number,
          after: b,
        });
      });
      return one(s, id);
    },

    activate,
    async previewActivation(s: OrgScope, id: string, b: Parameters<typeof activate>[2]) {
      try {
        await activate(s, id, b, true);
      } catch (e) {
        if (e instanceof PreviewOnly) return e.result;
        throw e;
      }
      throw new Error("Activation preview did not roll back");
    },

    async renew(s: OrgScope, id: string, b: { endDate: string | null; rentMinor: number; effectiveFrom: string }) {
      await financeTransaction(db, s.orgId, async (t) => {
        const l = await R.leaseRow(t, s.orgId, id, true);
        if (l.status !== "active") throw fail.conflict("Only an active lease can be renewed");
        if (b.effectiveFrom < l.start_date) throw fail.invalid("The new rent cannot start before the lease");
        if (b.endDate && l.end_date && b.endDate <= l.end_date) throw fail.invalid("A renewal extends the end date");
        if (b.endDate && b.endDate < b.effectiveFrom)
          throw fail.invalid("The lease would end before the new rent starts");
        try {
          await t.run("SAVEPOINT lease_renew");
          await t.run(
            "UPDATE pm_leases SET end_date = $2, notice_given_on = NULL, move_out_date = NULL WHERE id = $1",
            [id, b.endDate],
          );
          await t.run("RELEASE SAVEPOINT lease_renew");
        } catch (e) {
          await t.run("ROLLBACK TO SAVEPOINT lease_renew");
          if ((e as { code?: string }).code === "23P01")
            throw fail.conflict("Another lease starts on this unit before the new end date");
          throw e;
        }
        // later automatic escalations are replaced by the renewal's rent
        await t.run("DELETE FROM pm_rent_steps WHERE lease_id = $1 AND effective_from >= $2", [id, b.effectiveFrom]);
        await t.run(
          "INSERT INTO pm_rent_steps (lease_id, org_id, effective_from, rent_minor, reason, created_by) VALUES ($1, $2, $3, $4, 'renewal', $5)",
          [id, s.orgId, b.effectiveFrom, b.rentMinor, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Lease renewed",
          target: l.number,
          detail: `to ${b.endDate ?? "periodic"} · rent ${b.rentMinor} from ${b.effectiveFrom}`,
        });
      });
      return one(s, id);
    },

    async reviewRent(s: OrgScope, id: string, b: { rentMinor: number; effectiveFrom: string; reason: string }) {
      await financeTransaction(db, s.orgId, async (t) => {
        const l = await R.leaseRow(t, s.orgId, id, true);
        if (l.status !== "active") throw fail.conflict("Only an active lease's rent can be reviewed");
        if (b.effectiveFrom < l.start_date || (l.end_date && b.effectiveFrom > l.end_date))
          throw fail.invalid("The new rent must start within the lease");
        const billed = await t.row<{ period: string }>(
          "SELECT period FROM pm_invoices WHERE lease_id = $1 AND kind = 'rent' AND period >= $2 ORDER BY period LIMIT 1",
          [id, b.effectiveFrom.slice(0, 7)],
        );
        if (billed && b.effectiveFrom <= `${billed.period}-01`)
          throw fail.conflict(`Rent for ${billed.period} is already billed — the review can start after it`);
        await t.run(
          `INSERT INTO pm_rent_steps (lease_id, org_id, effective_from, rent_minor, reason, created_by)
           VALUES ($1, $2, $3, $4, 'review', $5)
           ON CONFLICT (lease_id, effective_from) DO UPDATE SET rent_minor = EXCLUDED.rent_minor, reason = 'review'`,
          [id, s.orgId, b.effectiveFrom, b.rentMinor, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Rent reviewed",
          target: l.number,
          detail: `${b.rentMinor} from ${b.effectiveFrom} · ${b.reason}`,
        });
      });
      return one(s, id);
    },

    async notice(s: OrgScope, id: string, b: { noticeDate: string; moveOutDate: string }) {
      await financeTransaction(db, s.orgId, async (t) => {
        const l = await R.leaseRow(t, s.orgId, id, true);
        if (l.status !== "active") throw fail.conflict("Notice is given on an active lease");
        if (b.moveOutDate < b.noticeDate) throw fail.invalid("The move-out date is before the notice date");
        const earliest = addDays(b.noticeDate, l.notice_days);
        await t.run("UPDATE pm_leases SET notice_given_on = $2, move_out_date = $3 WHERE id = $1", [
          id,
          b.noticeDate,
          b.moveOutDate,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Notice recorded",
          target: l.number,
          detail: `notice ${b.noticeDate} · move-out ${b.moveOutDate}${b.moveOutDate < earliest ? ` (shorter than the ${l.notice_days}-day notice period)` : ""}`,
        });
      });
      return one(s, id);
    },

    async terminate(s: OrgScope, id: string, b: { moveOutDate: string; reason: string }) {
      await financeTransaction(db, s.orgId, async (t) => {
        const l = await R.leaseRow(t, s.orgId, id, true);
        if (l.status !== "active") throw fail.conflict("Only an active lease can be ended");
        if (b.moveOutDate < l.start_date) throw fail.invalid("The move-out date is before the lease started");
        if (b.moveOutDate > s.today) throw fail.invalid("End the lease on or after the move-out day");
        const later = await t.row<{ number: string; period: string }>(
          "SELECT number, period FROM pm_invoices WHERE lease_id = $1 AND kind = 'rent' AND period > $2 ORDER BY period LIMIT 1",
          [id, b.moveOutDate.slice(0, 7)],
        );
        if (later)
          throw fail.conflict(
            `Rent ${later.number} (${later.period}) is billed after the move-out — issue a credit note for it first`,
          );
        await t.run(
          "UPDATE pm_leases SET status = 'ended', end_date = $2, move_out_date = $2, ended_reason = $3 WHERE id = $1",
          [id, b.moveOutDate, b.reason],
        );
        await t.run("DELETE FROM pm_rent_steps WHERE lease_id = $1 AND effective_from > $2", [id, b.moveOutDate]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Lease ended",
          target: l.number,
          detail: `move-out ${b.moveOutDate} · ${b.reason}`,
        });
      });
      return one(s, id);
    },

    async cancel(s: OrgScope, id: string, b: { reason: string }) {
      await financeTransaction(db, s.orgId, async (t) => {
        const l = await R.leaseRow(t, s.orgId, id, true);
        if (l.status !== "draft")
          throw fail.conflict("Only a draft lease can be cancelled — end an active lease instead");
        await t.run("UPDATE pm_leases SET status = 'cancelled', ended_reason = $2 WHERE id = $1", [id, b.reason]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Draft lease cancelled",
          target: l.number,
          detail: b.reason,
        });
      });
      return one(s, id);
    },

    async setCharges(s: OrgScope, id: string, charges: LeaseTerms["charges"]) {
      await financeTransaction(db, s.orgId, async (t) => {
        const l = await R.leaseRow(t, s.orgId, id, true);
        if (l.status !== "draft" && l.status !== "active") throw fail.conflict("This lease has ended");
        await writeCharges(t, s.orgId, id, charges);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Lease charges set",
          target: l.number,
          after: charges,
        });
      });
      return one(s, id);
    },

    async recordReadings(
      s: OrgScope,
      b: { period: string; readings: { unitId: string; chargeTypeId: string; previous: number; current: number }[] },
    ) {
      const ids = await financeTransaction(db, s.orgId, async (t) => {
        const out: string[] = [];
        for (const r of b.readings) {
          await R.unitRow(t, s.orgId, r.unitId);
          const ct = await chargeTypeRow(t, s.orgId, r.chargeTypeId);
          if (!ct.metered) throw fail.invalid(`${ct.name} is not metered`);
          if (r.current < r.previous)
            throw fail.invalid(`The reading for ${ct.code} went down (${r.previous} → ${r.current}) — check the meter`);
          const billed = await t.row(
            `SELECT 1 FROM pm_invoices i JOIN pm_leases l ON l.id = i.lease_id
             WHERE l.unit_id = $1 AND i.kind = 'charge' AND i.recurring AND i.period = $2`,
            [r.unitId, b.period],
          );
          if (billed)
            throw fail.conflict(`Charges for ${b.period} are already billed on that unit — readings are locked`);
          const row = await t.row<{ id: string }>(
            `INSERT INTO pm_meter_readings (id, org_id, unit_id, charge_type_id, period, previous, current, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (unit_id, charge_type_id, period) DO UPDATE SET previous = EXCLUDED.previous,
               current = EXCLUDED.current, recorded_by = EXCLUDED.recorded_by, recorded_at = now()
             RETURNING id`,
            [newId("pmr"), s.orgId, r.unitId, r.chargeTypeId, b.period, r.previous, r.current, s.userId],
          );
          out.push((row as { id: string }).id);
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Meter readings recorded",
          detail: `${b.period} · ${b.readings.length} reading(s)`,
        });
        return out;
      });
      return { readings: await readings(db, s.orgId, "m.id = ANY($2)", [ids]) };
    },

    async listReadings(s: OrgScope, f: { period: string; propertyId?: string | undefined }) {
      return {
        readings: await readings(db, s.orgId, "m.period = $2 AND ($3::text IS NULL OR u.property_id = $3)", [
          f.period,
          f.propertyId ?? null,
        ]),
      };
    },
  };
}

async function readings(db: Db, orgId: string, where: string, params: unknown[]): Promise<P.MeterReading[]> {
  const rows = await db.rows<{
    id: string;
    unit_id: string;
    unit_no: string;
    charge_type_id: string;
    code: string;
    period: string;
    previous: number;
    current: number;
  }>(
    `SELECT m.*, u.unit_no, ct.code FROM pm_meter_readings m JOIN pm_units u ON u.id = m.unit_id
     JOIN pm_charge_types ct ON ct.id = m.charge_type_id WHERE m.org_id = $1 AND ${where} ORDER BY u.unit_no, ct.code`,
    [orgId, ...params],
  );
  return rows.map((r) => ({
    id: r.id,
    unitId: r.unit_id,
    unitNo: r.unit_no,
    chargeTypeId: r.charge_type_id,
    code: r.code,
    period: r.period,
    previous: Number(r.previous),
    current: Number(r.current),
    consumption: Number(r.current) - Number(r.previous),
  }));
}

export type LeasesService = ReturnType<typeof leasesService>;
