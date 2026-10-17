import { financeTransaction } from "../shared/finance-transaction.js";
/*
 * Supplier bills: entered by one person, approved by another, paid (recorded) by a third.
 *
 *   submit    a bill on a work order is matched to its purchase order: the work must be checked, the amount within the
 *             PO plus the tolerance (also across all bills on the PO); the same supplier + property + amount within 30
 *             days is a possible duplicate. Any issue holds the bill until someone clears the hold with a reason.
 *             The same supplier invoice number twice is refused outright.
 *   approve   above the owner's spending authority (management agreement) it waits for the owner (portal);
 *             otherwise it posts: owner cost Dr 2250 / Cr 2000; company cost Dr 5650 / Cr 2000.
 *   pay       recorded with the bank reference: Dr 2000 / Cr 1040 (owner cost, paid from the client account) or
 *             Cr 1000 (company cost). PALTAS moves no money.
 */
import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit, type Actor } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC } from "../accounts.js";
import type { PmDeps } from "../deps.js";
import { settingsOf } from "../setup/setup.service.js";
import { numberScope } from "../shared/money.js";
import { cr, dr, post } from "../shared/posting.js";
import * as R from "../shared/records.js";
import { addDays, applyBp, toBp } from "../shared/util.js";

export interface BillRow {
  id: string;
  org_id: string;
  number: string;
  supplier_id: string;
  supplier_name: string;
  property_id: string | null;
  unit_id: string | null;
  work_order_id: string | null;
  description: string;
  supplier_invoice_no: string | null;
  bill_date: string;
  due_date: string | null;
  amount_minor: number;
  recover_from: "owner" | "company";
  owner_id: string | null;
  status: P.Bill["status"];
  match_issues: string[];
  hold_cleared_by: string | null;
  submitted_by: string | null;
  approved_by: string | null;
  owner_approved_by: string | null;
  paid_by: string | null;
  paid_date: string | null;
  paid_reference: string | null;
  bank_line_id: string | null;
  approve_journal_id: string | null;
  migrated: boolean;
}

export const toBill = (r: BillRow): P.Bill => ({
  id: r.id,
  number: r.number,
  supplierId: r.supplier_id,
  supplierName: r.supplier_name,
  propertyId: r.property_id,
  unitId: r.unit_id,
  workOrderId: r.work_order_id,
  description: r.description,
  supplierInvoiceNo: r.supplier_invoice_no,
  billDate: r.bill_date,
  dueDate: r.due_date,
  amountMinor: r.amount_minor,
  recoverFrom: r.recover_from,
  ownerId: r.owner_id,
  status: r.status,
  matchIssues: r.match_issues,
  submittedBy: r.submitted_by,
  approvedBy: r.approved_by,
  ownerApprovedBy: r.owner_approved_by,
  paidBy: r.paid_by,
  paidDate: r.paid_date,
  paidReference: r.paid_reference,
  migrated: r.migrated,
});

export const BILL_SQL = "SELECT b.*, c.name AS supplier_name FROM pm_bills b JOIN contacts c ON c.id = b.supplier_id";

export async function billRow(t: Db, orgId: string, id: string, lock = false): Promise<BillRow> {
  if (lock) await t.run("SELECT 1 FROM pm_bills WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, id]);
  const r = await t.row<BillRow>(`${BILL_SQL} WHERE b.org_id = $1 AND b.id = $2`, [orgId, id]);
  if (!r) throw fail.notFound("Bill not found");
  return r;
}

export function billsService(d: PmDeps) {
  const { core } = d;
  const db = core.db;

  /** Post an approved bill (inside the caller's transaction). */
  async function postApproval(t: Db, orgId: string, b: BillRow, actor: Actor, date: string) {
    const owner = b.recover_from === "owner";
    const journalId = await post(t, core, {
      orgId,
      date,
      kind: "bill",
      memo: `${b.number} · ${b.supplier_name} · ${b.description}${owner ? " (charged to the owner)" : " (company cost)"}`,
      ref: `bill:${b.id}`,
      link: { propertyId: b.property_id, ownerId: owner ? b.owner_id : null },
      lines: [
        dr(owner ? ACC.ownerFunds : ACC.companyRepairs, b.amount_minor, b.description),
        cr(ACC.payables, b.amount_minor, b.supplier_name),
      ],
    });
    await t.run("UPDATE pm_bills SET status = 'approved', approved_at = now(), approve_journal_id = $2 WHERE id = $1", [
      b.id,
      journalId,
    ]);
    await recordAudit(t, {
      actor,
      orgId,
      action: "Bill approved and posted",
      target: b.number,
      detail: `${b.amount_minor} · ${b.recover_from}`,
    });
  }

  /** Does the owner have to approve this bill (owner cost above the agreement's spending authority)? */
  async function needsOwner(t: Db, orgId: string, b: BillRow): Promise<boolean> {
    if (b.recover_from !== "owner" || !b.property_id || b.migrated) return false;
    const ag = b.unit_id
      ? await R.agreementForUnit(t, orgId, b.unit_id)
      : await t.row<R.AgreementRow>(
          "SELECT a.*, '' AS owner_name FROM pm_agreements a WHERE a.org_id = $1 AND a.property_id = $2 AND a.unit_id IS NULL AND a.status = 'active'",
          [orgId, b.property_id],
        );
    return !!ag && b.amount_minor > ag.authority_minor;
  }

  return {
    postApproval,

    async submit(
      s: OrgScope,
      b: {
        supplierId: string;
        propertyId?: string | undefined;
        unitId?: string | undefined;
        workOrderId?: string | undefined;
        description: string;
        supplierInvoiceNo: string;
        billDate: string;
        dueDate?: string | undefined;
        amountMinor: number;
        recoverFrom: "owner" | "company";
      },
    ) {
      let propertyId = b.propertyId ?? null;
      let unitId = b.unitId ?? null;
      const issues: string[] = [];
      const st = await settingsOf(db, s.orgId);
      const id = newId("pbi");
      await financeTransaction(db, s.orgId, async (t) => {
        const supplier = await core.contacts.live(t, s.orgId, b.supplierId);
        if (b.workOrderId) {
          const wo = await t.row<{
            property_id: string;
            unit_id: string | null;
            status: string;
            po_supplier_id: string | null;
            po_amount_minor: number | null;
            po_approved_by: string | null;
            verified_by: string | null;
          }>("SELECT * FROM pm_work_orders WHERE org_id = $1 AND id = $2 FOR UPDATE", [s.orgId, b.workOrderId]);
          if (!wo) throw fail.notFound("Work order not found");
          if (!wo.po_amount_minor || !wo.po_approved_by || wo.status === "awaiting_owner")
            throw fail.conflict("Bills must reference an approved purchase order");
          if (wo.po_supplier_id !== b.supplierId) throw fail.invalid("The purchase order is for another supplier");
          propertyId = wo.property_id;
          unitId = wo.unit_id;
          const limit = wo.po_amount_minor + applyBp(wo.po_amount_minor, toBp(st.matchTolerancePct));
          if (!wo.verified_by) issues.push("Work not yet checked by the property manager");
          if (b.amountMinor > limit)
            issues.push(
              `Invoice ${b.amountMinor} is more than the PO ${wo.po_amount_minor} plus ${st.matchTolerancePct}%`,
            );
          const billed = await t.row<{ n: number }>(
            "SELECT COALESCE(sum(amount_minor), 0)::bigint AS n FROM pm_bills WHERE work_order_id = $1 AND status <> 'rejected'",
            [b.workOrderId],
          );
          if ((billed?.n ?? 0) + b.amountMinor > limit)
            issues.push(`Total billed on the PO would be ${(billed?.n ?? 0) + b.amountMinor}, above the PO`);
        }
        if (propertyId) await R.propertyRow(t, s.orgId, propertyId);
        if (unitId) {
          const u = await R.unitRow(t, s.orgId, unitId);
          if (propertyId && u.property_id !== propertyId) throw fail.invalid("That unit is not in this property");
          propertyId = u.property_id;
        }
        let ownerId: string | null = null;
        if (b.recoverFrom === "owner") {
          if (!propertyId) throw fail.invalid("An owner's cost needs the property (or unit) it is for");
          const ag = unitId
            ? await R.agreementForUnit(t, s.orgId, unitId)
            : (
                await R.agreements(t, s.orgId, "a.property_id = $2 AND a.unit_id IS NULL AND a.status = 'active'", [
                  propertyId,
                ])
              )[0];
          if (!ag) throw fail.conflict("No active management agreement: the cost cannot be charged to an owner");
          ownerId = ag.owner_id;
        }
        const dupNo = await t.row<{ number: string }>(
          `SELECT number FROM pm_bills WHERE org_id = $1 AND supplier_id = $2 AND status <> 'rejected'
             AND upper(btrim(supplier_invoice_no)) = upper(btrim($3))`,
          [s.orgId, b.supplierId, b.supplierInvoiceNo],
        );
        if (dupNo) throw fail.conflict(`Supplier invoice ${b.supplierInvoiceNo} is already entered as ${dupNo.number}`);
        const near = await t.row<{ number: string }>(
          `SELECT number FROM pm_bills WHERE org_id = $1 AND supplier_id = $2 AND status <> 'rejected'
             AND property_id IS NOT DISTINCT FROM $3 AND amount_minor = $4 AND bill_date BETWEEN $5 AND $6`,
          [s.orgId, b.supplierId, propertyId, b.amountMinor, addDays(b.billDate, -30), addDays(b.billDate, 30)],
        );
        if (near)
          issues.push(`Possible duplicate: same supplier, property and amount as ${near.number} within 30 days`);
        await core.contacts.addTypes(t, s.orgId, b.supplierId, ["supplier"]);
        const number = await nextNumber(t, numberScope(s.orgId), "BILL", 5);
        await t.run(
          `INSERT INTO pm_bills (id, org_id, number, supplier_id, property_id, unit_id, work_order_id, description,
             supplier_invoice_no, bill_date, due_date, amount_minor, recover_from, owner_id, status, match_issues, submitted_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            id,
            s.orgId,
            number,
            b.supplierId,
            propertyId,
            unitId,
            b.workOrderId ?? null,
            b.description,
            b.supplierInvoiceNo,
            b.billDate,
            b.dueDate ?? null,
            b.amountMinor,
            b.recoverFrom,
            ownerId,
            issues.length ? "held" : "submitted",
            JSON.stringify(issues),
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: issues.length ? "Bill entered and held" : "Bill entered",
          target: number,
          detail: `${supplier.name} · ${b.amountMinor}${issues.length ? ` · ${issues.join("; ")}` : ""}`,
        });
      });
      return toBill(await billRow(db, s.orgId, id));
    },

    async list(s: OrgScope, status?: P.Bill["status"]) {
      const rows = await db.rows<BillRow>(
        `${BILL_SQL} WHERE b.org_id = $1 AND ($2::text IS NULL OR b.status = $2) ORDER BY b.bill_date DESC, b.number`,
        [s.orgId, status ?? null],
      );
      return { bills: rows.map(toBill) };
    },

    async approve(s: OrgScope, id: string) {
      await financeTransaction(db, s.orgId, async (t) => {
        const b = await billRow(t, s.orgId, id, true);
        if (b.status === "held") throw fail.conflict(`Held: ${b.match_issues.join("; ")} — clear the hold first`);
        if (b.status !== "submitted") throw fail.conflict(`This bill is ${b.status.replace("_", " ")}`);
        if (b.submitted_by === s.userId)
          throw fail.separationOfDuties("You entered this bill — someone else must approve it");
        await t.run("UPDATE pm_bills SET approved_by = $2 WHERE id = $1", [id, s.userId]);
        if (await needsOwner(t, s.orgId, b)) {
          await t.run("UPDATE pm_bills SET status = 'awaiting_owner' WHERE id = $1", [id]);
          await recordAudit(t, {
            actor: s.actor,
            orgId: s.orgId,
            action: "Bill sent to the owner for approval",
            target: b.number,
            detail: `${b.amount_minor} is above the owner's spending authority`,
          });
          return;
        }
        await postApproval(t, s.orgId, b, s.actor, s.today);
      });
      return toBill(await billRow(db, s.orgId, id));
    },

    async clearHold(s: OrgScope, id: string, reason: string) {
      await financeTransaction(db, s.orgId, async (t) => {
        const b = await billRow(t, s.orgId, id, true);
        if (b.status !== "held") throw fail.conflict("This bill is not held");
        if (b.submitted_by === s.userId)
          throw fail.separationOfDuties("You entered this bill — someone else must clear its hold");
        await t.run(
          "UPDATE pm_bills SET status = 'submitted', hold_cleared_by = $2, hold_cleared_reason = $3 WHERE id = $1",
          [id, s.userId, reason],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Bill hold cleared",
          target: b.number,
          detail: `${b.match_issues.join("; ")} · ${reason}`,
        });
      });
      return toBill(await billRow(db, s.orgId, id));
    },

    async reject(s: OrgScope, id: string, reason: string) {
      await financeTransaction(db, s.orgId, async (t) => {
        const b = await billRow(t, s.orgId, id, true);
        if (b.status === "paid" || b.status === "rejected")
          throw fail.conflict(`A ${b.status} bill cannot be rejected`);
        if (b.approve_journal_id) {
          const owner = b.recover_from === "owner";
          await post(t, core, {
            orgId: s.orgId,
            date: s.today,
            kind: "bill",
            memo: `Reversal of ${b.number}: rejected · ${reason}`,
            ref: `bill-reversal:${b.id}`,
            link: { propertyId: b.property_id, ownerId: owner ? b.owner_id : null },
            lines: [
              dr(ACC.payables, b.amount_minor, b.supplier_name),
              cr(owner ? ACC.ownerFunds : ACC.companyRepairs, b.amount_minor, `Reversal: ${b.description}`),
            ],
          });
        }
        await t.run("UPDATE pm_bills SET status = 'rejected', rejected_reason = $2 WHERE id = $1", [id, reason]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Bill rejected",
          target: b.number,
          detail: reason,
        });
      });
      return toBill(await billRow(db, s.orgId, id));
    },

    async pay(s: OrgScope, id: string, p: { paidDate: string; reference: string }) {
      await financeTransaction(db, s.orgId, async (t) => {
        const b = await billRow(t, s.orgId, id, true);
        if (b.status !== "approved") throw fail.conflict(`Only an approved bill can be paid (this one is ${b.status})`);
        if (b.approved_by === s.userId)
          throw fail.separationOfDuties("You approved this bill — someone else records its payment");
        if (p.paidDate > s.today) throw fail.invalid("A payment cannot be dated in the future");
        const used = await t.row<{ number: string }>(
          "SELECT number FROM pm_bills WHERE org_id = $1 AND upper(btrim(paid_reference)) = upper(btrim($2))",
          [s.orgId, p.reference],
        );
        if (used) throw fail.conflict(`Reference ${p.reference} is already used for ${used.number}`);
        const fromClient = b.recover_from === "owner";
        const journalId = await post(t, core, {
          orgId: s.orgId,
          date: p.paidDate,
          kind: "bill_payment",
          memo: `${b.number} paid · ${b.supplier_name} · ${p.reference} (recorded; PALTAS moves no money)`,
          ref: `bill-payment:${b.id}`,
          link: { propertyId: b.property_id, ownerId: fromClient ? b.owner_id : null },
          lines: [
            dr(ACC.payables, b.amount_minor, b.supplier_name),
            cr(fromClient ? ACC.clientBank : ACC.operatingBank, b.amount_minor, p.reference),
          ],
        });
        await t.run(
          "UPDATE pm_bills SET status = 'paid', paid_by = $2, paid_date = $3, paid_reference = $4, pay_journal_id = $5 WHERE id = $1",
          [id, s.userId, p.paidDate, p.reference, journalId],
        );
        if (b.work_order_id)
          await t.run("UPDATE pm_work_orders SET status = 'billed' WHERE id = $1 AND status = 'verified'", [
            b.work_order_id,
          ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Bill payment recorded",
          target: b.number,
          detail: `${b.amount_minor} from the ${fromClient ? "client" : "operating"} account · ${p.reference}`,
        });
      });
      return toBill(await billRow(db, s.orgId, id));
    },

    /** The owner (portal) approves a bill above the authority on their own property. */
    async ownerApprove(orgId: string, ownerId: string, userId: string, actor: Actor, today: string, id: string) {
      await financeTransaction(db, orgId, async (t) => {
        const b = await billRow(t, orgId, id, true);
        if (b.owner_id !== ownerId) throw fail.notFound("Bill not found");
        if (b.status !== "awaiting_owner") throw fail.conflict(`This bill is ${b.status.replace("_", " ")}`);
        await t.run("UPDATE pm_bills SET owner_approved_by = $2, owner_approved_at = now() WHERE id = $1", [
          id,
          userId,
        ]);
        await postApproval(t, orgId, b, actor, today);
      });
      return toBill(await billRow(db, orgId, id));
    },
  };
}

export type BillsService = ReturnType<typeof billsService>;
