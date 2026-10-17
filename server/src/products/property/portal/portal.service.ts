import { financeTransaction } from "../shared/finance-transaction.js";
/*
 * The tenant and owner portals. A portal user is a member with the tenant or owner role whose sign-in is linked to a
 * contact; every query is scoped to that contact, so a tenant sees only their own leases, invoices, payments, requests
 * and documents, and an owner only their own properties, statement, approvals and payouts. Anything else answers
 * "not found".
 */
import type { property as P } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { toContact } from "../../../core/contacts/contacts.repo.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { BillsService, BillRow } from "../bills/bills.service.js";
import { BILL_SQL, toBill } from "../bills/bills.service.js";
import { documents, toDocument } from "../comms/comms.service.js";
import type { PmDeps } from "../deps.js";
import type { MaintenanceService } from "../maintenance/maintenance.service.js";
import { ownerStatement, type OwnersService } from "../owners/owners.service.js";
import { toClaim } from "../payments/payments.service.js";
import type { SetupService } from "../setup/setup.service.js";
import type { PortalScope } from "../shared/access.js";
import * as R from "../shared/records.js";
import { sum } from "../shared/util.js";

export function portalService(
  d: PmDeps,
  deps: { setup: SetupService; maintenance: MaintenanceService; bills: BillsService; owners: OwnersService },
) {
  const { core } = d;
  const db = core.db;

  return {
    async tenant(s: PortalScope) {
      const me = s.contact.id;
      const leases = await R.leaseRows(db, s.orgId, "l.tenant_id = $2 AND l.status IN ('active', 'ended')", [me]);
      const invoices = await R.invoiceViews(db, await R.invoiceRows(db, s.orgId, "i.tenant_id = $2", [me]), s.today);
      const payments = await R.paymentViews(db, await R.paymentRows(db, s.orgId, "p.tenant_id = $2", [me]));
      const claims = await db.rows<Parameters<typeof toClaim>[0]>(
        "SELECT * FROM pm_payment_claims WHERE org_id = $1 AND tenant_id = $2 ORDER BY submitted_at DESC",
        [s.orgId, me],
      );
      const requests = await db.rows<Parameters<typeof deps.maintenance.toRequest>[0]>(
        `${deps.maintenance.REQUEST_SQL} WHERE r.org_id = $1 AND r.reporter_id = $2 ORDER BY r.opened_at DESC`,
        [s.orgId, me],
      );
      const docs = await documents(
        db,
        s.orgId,
        "visibility = 'tenant' AND ((link_entity = 'lease' AND link_id = ANY($2)) OR (link_entity = 'contact' AND link_id = $3))",
        [leases.map((l) => l.id), me],
      );
      return {
        contact: toContact(s.contact),
        leases: await R.leaseViews(db, s.orgId, leases, s.today),
        invoices,
        payments,
        claims: claims.map(toClaim),
        requests: requests.map(deps.maintenance.toRequest),
        documents: docs.map(toDocument),
        balanceMinor: sum(invoices, (i) => i.balanceMinor),
        creditMinor: Math.max(0, await R.tenantCredit(db, s.orgId, me)),
      };
    },

    async tenantRequest(
      s: PortalScope,
      b: { leaseId: string; title: string; category: string; priority: P.MaintenanceRequest["priority"] },
    ) {
      const l = await db.row<{ tenant_id: string; property_id: string; unit_id: string; status: string }>(
        "SELECT tenant_id, property_id, unit_id, status FROM pm_leases WHERE org_id = $1 AND id = $2",
        [s.orgId, b.leaseId],
      );
      if (!l || l.tenant_id !== s.contact.id) throw fail.notFound("Lease not found");
      if (l.status !== "active") throw fail.conflict("Requests are made on an active lease");
      const id = await financeTransaction(db, s.orgId, async (t) => {
        const id = await deps.maintenance.openRequest(t, s, {
          propertyId: l.property_id,
          unitId: l.unit_id,
          reporterId: s.contact.id,
          title: b.title,
          category: b.category,
          priority: b.priority,
          source: "tenant_portal",
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Maintenance request from the tenant portal",
          target: id,
          detail: b.title,
        });
        return id;
      });
      return deps.maintenance.requestView(s.orgId, id);
    },

    async tenantPaymentReport(
      s: PortalScope,
      b: { amountMinor: number; date: string; method: P.PaymentMethod; reference: string; note: string },
    ) {
      if (b.date > s.today) throw fail.invalid("A payment cannot be dated in the future");
      return financeTransaction(db, s.orgId, async (t) => {
        const r = await t.row<Parameters<typeof toClaim>[0]>(
          `INSERT INTO pm_payment_claims (id, org_id, tenant_id, amount_minor, date, method, reference, note, status,
             submitted_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9) RETURNING *`,
          [newId("pcl"), s.orgId, s.contact.id, b.amountMinor, b.date, b.method, b.reference, b.note, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Payment reported by the tenant (to check against the bank)",
          target: r?.id ?? "",
          detail: `${b.amountMinor} · ${b.method} ${b.reference}`,
        });
        return toClaim(r as Parameters<typeof toClaim>[0]);
      });
    },

    async owner(s: PortalScope, f: { from?: string | undefined; to?: string | undefined }) {
      const me = s.contact.id;
      const period = deps.owners.defaultPeriod(s.today);
      const from = f.from ?? period.from;
      const to = f.to ?? period.to;
      const propertyIds = await db.rows<{ property_id: string }>(
        "SELECT DISTINCT property_id FROM pm_agreements WHERE org_id = $1 AND owner_id = $2 AND status = 'active'",
        [s.orgId, me],
      );
      const properties = [];
      for (const p of propertyIds)
        properties.push(
          await deps.setup.propertyView(s.orgId, await R.propertyRow(db, s.orgId, p.property_id), s.today),
        );
      const bills = await db.rows<BillRow>(
        `${BILL_SQL} WHERE b.org_id = $1 AND b.owner_id = $2 AND b.status = 'awaiting_owner' ORDER BY b.bill_date`,
        [s.orgId, me],
      );
      const wos = await db.rows<Parameters<typeof deps.maintenance.woViews>[0][number]>(
        `SELECT w.* FROM pm_work_orders w WHERE w.org_id = $1 AND w.needs_owner AND w.owner_approved_by IS NULL
           AND w.status IN ('po_pending', 'awaiting_owner')
           AND EXISTS (SELECT 1 FROM pm_agreements a WHERE a.property_id = w.property_id AND a.owner_id = $2
             AND a.status = 'active' AND (a.unit_id IS NULL OR a.unit_id = w.unit_id))
         ORDER BY w.created_at`,
        [s.orgId, me],
      );
      const payouts = await db.rows<Parameters<typeof deps.owners.toPayout>[0]>(
        `${deps.owners.PAYOUT_SQL} WHERE p.org_id = $1 AND p.owner_id = $2 ORDER BY p.created_at DESC`,
        [s.orgId, me],
      );
      return {
        contact: toContact(s.contact),
        properties,
        statement: await ownerStatement(db, s.orgId, me, s.contact.name, from, to),
        billsAwaitingApproval: bills.map(toBill),
        workOrdersAwaitingApproval: await deps.maintenance.woViews(wos, s.today),
        payouts: payouts.map(deps.owners.toPayout),
      };
    },

    ownerApproveBill: (s: PortalScope, billId: string) =>
      deps.bills.ownerApprove(s.orgId, s.contact.id, s.userId, s.actor, s.today, billId),

    async ownerApprovePo(s: PortalScope, workOrderId: string) {
      const w = await db.row<{ property_id: string; unit_id: string | null }>(
        "SELECT property_id, unit_id FROM pm_work_orders WHERE org_id = $1 AND id = $2",
        [s.orgId, workOrderId],
      );
      const mine =
        w &&
        (await db.row(
          `SELECT 1 FROM pm_agreements WHERE org_id = $1 AND property_id = $2 AND owner_id = $3 AND status = 'active'
             AND (unit_id IS NULL OR unit_id = $4)`,
          [s.orgId, w.property_id, s.contact.id, w.unit_id],
        ));
      if (!mine) throw fail.notFound("Work order not found");
      await financeTransaction(db, s.orgId, (t) =>
        deps.maintenance.approvePo(t, s.orgId, workOrderId, { userId: s.userId, role: "owner" }, s.actor),
      );
      return deps.maintenance.woView(s.orgId, workOrderId, s.today);
    },
  };
}

export type PortalService = ReturnType<typeof portalService>;
