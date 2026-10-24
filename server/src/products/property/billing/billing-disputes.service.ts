import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import { financeTransaction } from "../shared/finance-transaction.js";
import { invoiceRow } from "../shared/records.js";

type Row = {
  id: string;
  org_id: string;
  invoice_id: string;
  tenant_id: string;
  amount_minor: number;
  reason: string;
  status: P.BillingDispute["status"];
  resolution: string;
  credit_note_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  invoice_number: string;
  tenant_name: string;
  unit_no: string | null;
  property_id: string | null;
};
const SQL = `SELECT d.*,i.number AS invoice_number,i.property_id,c.name AS tenant_name,u.unit_no FROM pm_billing_disputes d JOIN pm_invoices i ON i.id=d.invoice_id AND i.org_id=d.org_id JOIN contacts c ON c.id=d.tenant_id AND c.org_id=d.org_id LEFT JOIN pm_units u ON u.id=i.unit_id AND u.org_id=i.org_id`;
export function billingDisputesService(d: PmDeps) {
  const db = d.core.db;
  const scope = (s: OrgScope, propertyId: string | null) => {
    if (s.propertyIds && (!propertyId || !s.propertyIds.includes(propertyId)))
      throw fail.notFound("Invoice not found in assigned properties");
  };
  async function row(t: Db, s: OrgScope, id: string, tenantId?: string, lock = false) {
    const r = await t.row<Row>(`${SQL} WHERE d.org_id=$1 AND d.id=$2 ${lock ? "FOR UPDATE OF d" : ""}`, [s.orgId, id]);
    if (!r || (tenantId && r.tenant_id !== tenantId)) throw fail.notFound("Billing dispute not found");
    scope(s, r.property_id);
    return r;
  }
  async function view(t: Db, r: Row): Promise<P.BillingDispute> {
    const events = await t.rows<P.BillingDispute["events"][number]>(
      `SELECT id,action,reason,created_at AS "createdAt" FROM pm_billing_dispute_events WHERE org_id=$1 AND dispute_id=$2 ORDER BY created_at,id`,
      [r.org_id, r.id],
    );
    return {
      id: r.id,
      invoiceId: r.invoice_id,
      invoiceNumber: r.invoice_number,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      unitNo: r.unit_no,
      amountMinor: r.amount_minor,
      reason: r.reason,
      status: r.status,
      resolution: r.resolution,
      creditNoteId: r.credit_note_id,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      events,
    };
  }
  async function event(t: Db, s: OrgScope, id: string, action: string, reason: string) {
    await t.run(
      "INSERT INTO pm_billing_dispute_events(id,org_id,dispute_id,action,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)",
      [newId("pde"), s.orgId, id, action, reason, s.userId],
    );
    await recordAudit(t, {
      orgId: s.orgId,
      actor: s.actor,
      action: `Billing dispute ${action}`,
      target: id,
      detail: reason,
    });
  }
  return {
    async list(s: OrgScope, q: P.DisputeQuery, tenantId?: string) {
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const where = `WHERE d.org_id=$1 AND ($2::text IS NULL OR d.invoice_id=$2) AND ($3::text IS NULL OR i.property_id=$3) AND ($4::text[] IS NULL OR i.property_id=ANY($4)) AND ($5::text IS NULL OR d.tenant_id=$5)`;
        const args = [s.orgId, q.invoiceId ?? null, q.propertyId ?? null, s.propertyIds ?? null, tenantId ?? null];
        const total = await t.row<{ n: number }>(
          `SELECT count(*)::int AS n FROM pm_billing_disputes d JOIN pm_invoices i ON i.id=d.invoice_id AND i.org_id=d.org_id ${where}`,
          args,
        );
        const rows = await t.rows<Row>(`${SQL} ${where} ORDER BY d.updated_at DESC,d.id DESC LIMIT $6 OFFSET $7`, [
          ...args,
          q.limit,
          q.offset,
        ]);
        const disputes = [];
        for (const r of rows) disputes.push(await view(t, r));
        return { disputes, total: total?.n ?? 0, limit: q.limit, offset: q.offset };
      });
    },
    async create(s: OrgScope, input: P.DisputeInput, tenantId?: string) {
      return financeTransaction(db, s.orgId, async (t) => {
        const invoice = await invoiceRow(t, s.orgId, input.invoiceId);
        if (tenantId && invoice.tenant_id !== tenantId) throw fail.notFound("Invoice not found");
        scope(s, invoice.property_id);
        if (input.amountMinor > invoice.amount_minor)
          throw fail.invalid("The queried amount cannot exceed the original invoice total");
        if (
          await t.row(
            "SELECT id FROM pm_billing_disputes WHERE org_id=$1 AND invoice_id=$2 AND status IN ('open','reviewing')",
            [s.orgId, input.invoiceId],
          )
        )
          throw fail.conflict("This invoice already has an open dispute. Review that case instead.");
        const id = newId("pds");
        await t.run(
          "INSERT INTO pm_billing_disputes(id,org_id,invoice_id,tenant_id,amount_minor,reason,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7)",
          [id, s.orgId, invoice.id, invoice.tenant_id, input.amountMinor, input.reason, s.userId],
        );
        await event(t, s, id, "opened", input.reason);
        return view(t, await row(t, s, id, tenantId));
      });
    },
    async action(s: OrgScope, id: string, b: P.DisputeAction, tenantId?: string) {
      return financeTransaction(db, s.orgId, async (t) => {
        const r = await row(t, s, id, tenantId, true);
        if (r.version !== b.expectedVersion) throw fail.conflict("This dispute changed. Reopen it before continuing.");
        if (tenantId && !["reopen", "withdraw"].includes(b.action))
          throw fail.forbidden("Only your authorised manager can review and resolve a dispute");
        if (b.creditNoteId && b.action !== "resolve")
          throw fail.invalid("Link a credit note only when resolving a dispute");
        let status: P.BillingDispute["status"],
          resolution = "",
          credit: string | null = null;
        const active = ["open", "reviewing"].includes(r.status);
        if (b.action === "reopen") {
          if (active) throw fail.conflict("This dispute is already open");
          if (
            await t.row(
              "SELECT id FROM pm_billing_disputes WHERE org_id=$1 AND invoice_id=$2 AND id<>$3 AND status IN ('open','reviewing')",
              [s.orgId, r.invoice_id, r.id],
            )
          )
            throw fail.conflict("Another open dispute already covers this invoice");
          status = "open";
        } else {
          if (!active) throw fail.conflict("Reopen this closed dispute before making further changes");
          status =
            b.action === "review"
              ? "reviewing"
              : b.action === "resolve"
                ? "resolved"
                : b.action === "reject"
                  ? "rejected"
                  : "withdrawn";
          if (status === "resolved" || status === "rejected") resolution = b.reason;
          if (b.creditNoteId) {
            const note = await t.row<{ id: string }>(
              "SELECT id FROM pm_credit_notes WHERE org_id=$1 AND id=$2 AND invoice_id=$3 AND journal_id IS NOT NULL AND created_at >= $4::timestamptz",
              [s.orgId, b.creditNoteId, r.invoice_id, r.created_at],
            );
            if (!note)
              throw fail.invalid("Select a posted credit note created for this invoice after the dispute was opened");
            credit = note.id;
          }
        }
        await t.run(
          "UPDATE pm_billing_disputes SET status=$3,resolution=$4,credit_note_id=$5,updated_by=$6,updated_at=now(),version=version+1 WHERE org_id=$1 AND id=$2",
          [s.orgId, id, status, resolution, credit, s.userId],
        );
        await event(t, s, id, b.action, credit ? `${b.reason} · Posted credit note ${credit}` : b.reason);
        return view(t, await row(t, s, id, tenantId));
      });
    },
  };
}
