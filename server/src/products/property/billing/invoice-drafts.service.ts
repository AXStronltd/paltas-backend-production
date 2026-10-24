import { chargeLineAmount } from "../shared/charge-pricing.js";
import { createHash } from "node:crypto";
import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import { financeTransaction } from "../shared/finance-transaction.js";
import { leaseRow, agreementForUnit } from "../shared/records.js";
import { chargeTypeRow } from "../setup/setup.service.js";

type Row = {
  id: string;
  org_id: string;
  lease_id: string;
  payload: P.InvoiceDraftInput;
  version: number;
  status: P.InvoiceDraft["status"];
  created_by: string;
  updated_by: string;
  approved_by: string | null;
  approval_signature: string | null;
  invoice_id: string | null;
  updated_at: string;
  tenant_name: string;
  unit_no: string;
};
const SQL = `SELECT d.*,c.name AS tenant_name,u.unit_no FROM pm_invoice_drafts d JOIN pm_leases l ON l.id=d.lease_id AND l.org_id=d.org_id JOIN contacts c ON c.id=l.tenant_id AND c.org_id=l.org_id JOIN pm_units u ON u.id=l.unit_id AND u.org_id=l.org_id`;
const view = (r: Row): P.InvoiceDraft => ({
  totalMinor: r.payload.lines.reduce((n, l) => n + chargeLineAmount(l.quantity, l.rateMinor), 0),
  lineAmountsMinor: r.payload.lines.map((l) => chargeLineAmount(l.quantity, l.rateMinor)),
  id: r.id,
  leaseId: r.lease_id,
  tenantName: r.tenant_name,
  unitNo: r.unit_no,
  version: r.version,
  status: r.status,
  input: r.payload,
  createdBy: r.created_by,
  updatedBy: r.updated_by,
  approvedBy: r.approved_by,
  invoiceId: r.invoice_id,
  updatedAt: r.updated_at,
});
export function invoiceDraftsService(
  d: PmDeps,
  issue: (t: Db, s: OrgScope, b: P.InvoiceDraftInput) => Promise<string>,
) {
  const db = d.core.db;
  // A configuration/ownership change cannot mix old approval inputs with new posting inputs.
  // All effects here are transactional database writes, so serialization failures can be retried safely.
  async function mutate<T>(s: OrgScope, work: (t: Db) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await db.tx(async (t) => {
          await t.run("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
          return financeTransaction(t, s.orgId, work);
        });
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        if (!["40001", "40P01"].includes(code)) throw error;
        if (attempt === 2)
          throw fail.conflict("Financial records changed during review. Reopen the draft and try again.");
      }
    }
    throw fail.conflict("Reopen the draft and try again");
  }

  const read = async (t: Db, s: OrgScope, id: string, lock = false) => {
    const r = await t.row<Row>(`${SQL} WHERE d.org_id=$1 AND d.id=$2 ${lock ? "FOR UPDATE OF d" : ""}`, [s.orgId, id]);
    if (!r) throw fail.notFound("Invoice draft not found");
    await checkLease(t, s, r.lease_id);
    return r;
  };
  async function checkLease(t: Db, s: OrgScope, id: string) {
    const l = await leaseRow(t, s.orgId, id);
    if (s.propertyIds && !s.propertyIds.includes(l.property_id))
      throw fail.notFound("Lease not found in assigned properties");
    return l;
  }
  async function validate(t: Db, s: OrgScope, input: P.InvoiceDraftInput) {
    const lease = await checkLease(t, s, input.leaseId);
    const agreement = await agreementForUnit(t, s.orgId, lease.unit_id);
    const definitions = [];
    let total = 0n;
    for (const line of input.lines) {
      const ct = await chargeTypeRow(t, s.orgId, line.chargeTypeId);
      definitions.push({
        id: ct.id,
        code: ct.code,
        name: ct.name,
        payee: ct.payee,
        fee: ct.fee_applies,
        vat: ct.vat_applies,
      });
      if (!ct.active) throw fail.invalid(`${ct.name} is inactive`);
      if (ct.metered) throw fail.invalid("Use the readings-based utility billing workflow for metered charges");
      const amount = chargeLineAmount(line.quantity, line.rateMinor);
      if (amount <= 0) throw fail.invalid(`${ct.name}: the calculated charge must be at least one minor currency unit`);
      total += BigInt(amount);
    }
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw fail.invalid("The invoice total exceeds the supported range");
    return createHash("sha256")
      .update(
        JSON.stringify({
          input,
          definitions,
          context: {
            tenantId: lease.tenant_id,
            unitId: lease.unit_id,
            status: lease.status,
            agreementId: agreement?.id ?? null,
            ownerId: agreement?.owner_id ?? null,
            feeBp: agreement?.fee_bp ?? null,
          },
        }),
      )
      .digest("hex");
  }
  const audit = (t: Db, s: OrgScope, id: string, action: string, detail: string) =>
    recordAudit(t, { actor: s.actor, orgId: s.orgId, action, target: id, detail });
  return {
    async list(s: OrgScope, q: { propertyId?: string; leaseId?: string; limit: number; offset: number }) {
      if (q.leaseId) await checkLease(db, s, q.leaseId);
      if (s.propertyIds && q.propertyId && !s.propertyIds.includes(q.propertyId))
        throw fail.notFound("Property not found");
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const filter =
          "WHERE d.org_id=$1 AND ($2::text IS NULL OR l.property_id=$2) AND ($3::text IS NULL OR d.lease_id=$3) AND ($4::text[] IS NULL OR l.property_id=ANY($4))";
        const args = [s.orgId, q.propertyId ?? null, q.leaseId ?? null, s.propertyIds ?? null];
        const total = await t.row<{ n: number }>(
          `SELECT count(*)::int AS n FROM pm_invoice_drafts d JOIN pm_leases l ON l.id=d.lease_id AND l.org_id=d.org_id ${filter}`,
          args,
        );
        const rows = await t.rows<Row>(`${SQL} ${filter} ORDER BY d.updated_at DESC,d.id DESC LIMIT $5 OFFSET $6`, [
          ...args,
          q.limit,
          q.offset,
        ]);
        return { drafts: rows.map(view), total: total?.n ?? 0, limit: q.limit, offset: q.offset };
      });
    },
    async create(s: OrgScope, input: P.InvoiceDraftInput) {
      return mutate(s, async (t) => {
        await validate(t, s, input);
        const id = newId("pid");
        await t.run(
          "INSERT INTO pm_invoice_drafts(id,org_id,lease_id,payload,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5)",
          [id, s.orgId, input.leaseId, JSON.stringify(input), s.userId],
        );
        await audit(t, s, id, "Invoice draft saved", "No invoice or journal posted");
        return view(await read(t, s, id));
      });
    },
    async update(s: OrgScope, id: string, expectedVersion: number, input: P.InvoiceDraftInput) {
      return mutate(s, async (t) => {
        const r = await read(t, s, id, true);
        if (r.version !== expectedVersion) throw fail.conflict("This draft changed. Reopen it before editing.");
        if (r.status !== "draft")
          throw fail.conflict("Return this invoice to draft before editing. Issued invoices use credit notes.");
        await validate(t, s, input);
        await t.run(
          "UPDATE pm_invoice_drafts SET lease_id=$3,payload=$4,version=version+1,updated_by=$5,updated_at=now(),approved_by=NULL,approval_signature=NULL WHERE org_id=$1 AND id=$2",
          [s.orgId, id, input.leaseId, JSON.stringify(input), s.userId],
        );
        await audit(t, s, id, "Invoice draft edited", `Version ${expectedVersion + 1}`);
        return view(await read(t, s, id));
      });
    },
    async action(
      s: OrgScope,
      id: string,
      b: { expectedVersion: number; action: "approve" | "return" | "issue" | "archive" | "restore"; reason: string },
    ) {
      return mutate(s, async (t) => {
        const r = await read(t, s, id, true);
        if (r.status === "issued" && b.action === "issue") return view(r); // retry returns the original invoice, never a second posting
        if (r.version !== b.expectedVersion) throw fail.conflict("The draft changed. Reopen it before continuing.");
        let signature = r.approval_signature;
        let status: P.InvoiceDraft["status"],
          approvedBy = r.approved_by,
          invoiceId = r.invoice_id;
        if (b.action === "approve") {
          if (r.status !== "draft") throw fail.conflict("Only a draft can be approved");
          if (r.updated_by === s.userId || r.created_by === s.userId)
            throw fail.separationOfDuties("Another authorised person must review and approve this draft");
          signature = await validate(t, s, r.payload);
          status = "approved";
          approvedBy = s.userId;
        } else if (b.action === "issue") {
          if (r.status !== "approved") throw fail.conflict("Approve this draft before issuing it");
          if (signature !== (await validate(t, s, r.payload)))
            throw fail.conflict(
              "Charge configuration changed after approval. Return the draft for review and approve it again.",
            );
          invoiceId = await issue(t, s, r.payload);
          status = "issued";
        } else if (b.action === "return") {
          if (r.status !== "approved")
            throw fail.conflict("Only an approved, unissued draft can be returned for editing");
          status = "draft";
          approvedBy = null;
          signature = null;
        } else if (b.action === "archive") {
          if (!["draft", "approved"].includes(r.status)) throw fail.conflict("Only unissued drafts can be archived");
          status = "archived";
          approvedBy = null;
          signature = null;
        } else {
          if (r.status !== "archived") throw fail.conflict("Only archived drafts can be restored");
          status = "draft";
          approvedBy = null;
          signature = null;
        }
        await t.run(
          "UPDATE pm_invoice_drafts SET status=$3,approved_by=$4,invoice_id=$5,version=version+1,updated_by=$6,updated_at=now(),approval_signature=$7 WHERE org_id=$1 AND id=$2",
          [s.orgId, id, status, approvedBy, invoiceId, s.userId, signature],
        );
        await audit(t, s, id, `Invoice draft ${b.action}`, b.reason);
        return view(await read(t, s, id));
      });
    },
    async remove(s: OrgScope, id: string, expectedVersion: number, reason: string) {
      return mutate(s, async (t) => {
        const r = await read(t, s, id, true);
        if (r.version !== expectedVersion) throw fail.conflict("The draft changed. Reopen it first.");
        if (r.status !== "draft")
          throw fail.conflict("Only an unapproved draft can be deleted. Issued financial history is retained.");
        await audit(t, s, id, "Invoice draft deleted", reason);
        await t.run("DELETE FROM pm_invoice_drafts WHERE org_id=$1 AND id=$2", [s.orgId, id]);
        return { deleted: true as const };
      });
    },
  };
}
