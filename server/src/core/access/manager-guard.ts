import { contactWithinScope } from "./property-contact-scope.js";
/** Request perimeter for delegated managers. Restricted scopes fail closed on unaudited/global operations. */
import type { Capability, Product, ProductRoles, Role } from "@paltas/contracts";
import type { Db } from "../../db/database.js";
import type { Route } from "../../http/route.js";
import { fail } from "../../http/errors.js";
import { delegatedCan, managerGrant } from "./manager-access.js";
import { productRole } from "./product-role.js";

type Req = Parameters<Route["handler"]>[0];
const FINE: Record<string, Capability> = {
  "property.invoices.plans.list": "property.tenants.history",
  "property.invoices.disputes.list": "property.tenants.history",
  "contacts.list": "property.tenants.view",
  "contacts.get": "property.tenants.view",
  "contacts.create": "property.tenants.register",
  "contacts.update": "property.tenants.edit",
  "property.leases.create": "property.tenants.leaseCreate",
  "property.leases.update": "property.tenants.leaseEdit",
  "property.leases.activate": "property.tenants.leaseActivate",
  "property.leases.activationPreview": "property.tenants.leaseActivate",
  "property.leases.renew": "property.tenants.leaseRenew",
  "property.leases.rentReview": "property.tenants.leaseEdit",
  "property.leases.notice": "property.tenants.leaseEnd",
  "property.leases.terminate": "property.tenants.leaseEnd",
  "property.leases.charges": "property.tenants.leaseEdit",
  "property.meters.record": "property.tenants.leaseEdit",
  "property.leases.cancel": "property.tenants.leaseEnd",
  "property.documents.add": "property.tenants.documents",
  "property.documents.upload": "property.tenants.documents",
  "property.documents.download": "property.tenants.documents",
  "property.documents.list": "property.tenants.documents",
  "contacts.activities.add": "property.tenants.edit",
  "contacts.messages.record": "property.tenants.edit",
  "property.notices.publish": "property.tenants.notices",
  "property.reports.collectionsOverview": "property.tenants.history",
  "property.payments.list": "property.tenants.history",
  "property.payments.get": "property.tenants.history",
  "property.invoices.list": "property.tenants.history",
  "property.invoices.get": "property.tenants.history",
  "property.deposits.list": "property.tenants.history",
  "property.tenants.control": "property.tenants.view",
  "property.tenants.statement": "property.tenants.history",
};
const TABLES: Record<string, string> = {
  planId:
    "SELECT i.property_id FROM pm_collection_plans p JOIN pm_invoices i ON i.id=p.invoice_id AND i.org_id=p.org_id WHERE p.org_id=$1 AND p.id=$2",
  disputeId:
    "SELECT i.property_id FROM pm_billing_disputes d JOIN pm_invoices i ON i.id=d.invoice_id AND i.org_id=d.org_id WHERE d.org_id=$1 AND d.id=$2",
  draftId:
    "SELECT l.property_id FROM pm_invoice_drafts d JOIN pm_leases l ON l.id=d.lease_id AND l.org_id=d.org_id WHERE d.org_id=$1 AND d.id=$2",
  propertyId: "SELECT id AS property_id FROM pm_properties WHERE org_id=$1 AND id=$2",
  buildingId: "SELECT property_id FROM pm_buildings WHERE org_id=$1 AND id=$2",
  unitId: "SELECT property_id FROM pm_units WHERE org_id=$1 AND id=$2",
  leaseId: "SELECT property_id FROM pm_leases WHERE org_id=$1 AND id=$2",
  invoiceId: "SELECT property_id FROM pm_invoices WHERE org_id=$1 AND id=$2",
  agreementId: "SELECT property_id FROM pm_agreements WHERE org_id=$1 AND id=$2",
  ownershipId: "SELECT property_id FROM pm_ownerships WHERE org_id=$1 AND id=$2",
  refundId:
    "SELECT l.property_id FROM pm_deposit_refunds r JOIN pm_leases l ON l.id=r.lease_id AND l.org_id=r.org_id WHERE r.org_id=$1 AND r.id=$2",
  workOrderId: "SELECT property_id FROM pm_work_orders WHERE org_id=$1 AND id=$2",
  requestId: "SELECT property_id FROM pm_maintenance_requests WHERE org_id=$1 AND id=$2",
  billId: "SELECT property_id FROM pm_bills WHERE org_id=$1 AND id=$2",
  inspectionId: "SELECT property_id FROM pm_inspections WHERE org_id=$1 AND id=$2",
};
const LISTS: Record<string, [string, string]> = {
  "property.invoices.plans.list": ["plans", "planId"],
  "property.invoices.disputes.list": ["disputes", "disputeId"],
  "property.invoices.drafts.list": ["drafts", "draftId"],
  "property.properties.list": ["properties", "propertyId"],
  "property.leases.list": ["leases", "leaseId"],
  "property.invoices.list": ["invoices", "invoiceId"],
  "property.payments.list": ["payments", "paymentId"],
  "property.deposits.list": ["refunds", "refundId"],
  "property.agreements.list": ["agreements", "agreementId"],
  "property.ownerships.list": ["ownerships", "ownershipId"],
  "property.maintenance.list": ["requests", "requestId"],
  "property.workOrders.list": ["workOrders", "workOrderId"],
  "property.inspections.list": ["inspections", "inspectionId"],
  "property.bills.list": ["bills", "billId"],
};
const SAFE_SHARED = new Set([
  "property.settings.get",
  "property.chargeTypes.list",
  "property.tariffs.list", // service filters unit overrides to assigned properties; shared tariff is configuration only
  "property.expenseCategories.list",
  "orgs.get",
  "subscription.entitlements",
]);
const SCOPED =
  /^(property\.(properties\.(list|get|update)|buildings\.(create|update|delete)|units\.(create|update)|tariffs\.create|ownerships\.(list|create|update|verify)|agreements\.(list|create|update|activate|end)|leases\..+|invoices\..+|payments\..+|tenants\..+|deposits\..+|maintenance\..+|workOrders\..+|inspections\..+|bills\..+|documents\..+|reports\.(dashboard|rentRoll|collectionsOverview))|contacts\.(list|get|create|update|activities\.add|messages\.record))$/;
const GLOBAL =
  /^property\.(settings\.update|chargeTypes\.(create|update)|properties\.create|bank\.|reconciliations\.|payouts\.|owners\.|reports\.(clientMoney|aged|dashboard))/;
export function managerGuard(db: Db) {
  return (routes: Route[]): Route[] =>
    routes.map((r) => ({
      ...r,
      handler: async (req: Req) => {
        const orgId = req.params.orgId;
        if (!req.user || typeof orgId !== "string") return r.handler(req);
        const actorId = req.user.id;
        const m = await db.row<{ role: Role; product_roles: ProductRoles | null; status: string }>(
          "SELECT role,product_roles,status FROM memberships WHERE org_id=$1 AND user_id=$2",
          [orgId, req.user.id],
        );
        if (!m || m.status !== "active") return r.handler(req); // the normal core gate rejects unknown/suspended members
        const prefix = r.endpoint.id.split(".")[0] ?? "";
        const product: Product | undefined = ["property", "developer", "agency", "hotel", "security"].includes(prefix)
          ? (prefix as Product)
          : undefined;
        const managed = product
          ? productRole(m.role, m.product_roles, product) === "main_manager"
          : m.role === "main_manager" || Object.values(m.product_roles ?? {}).includes("main_manager");
        if (!managed) return r.handler(req);
        const selected =
          product ??
          (m.product_roles?.property === "main_manager" || m.role === "main_manager"
            ? "property"
            : (Object.entries(m.product_roles ?? {}).find(([, role]) => role === "main_manager")?.[0] as
                Product | undefined));
        if (!selected) throw fail.forbidden("No operational delegation");
        const g = await managerGrant(db, orgId, req.user.id, selected);
        if (!g?.enabled)
          throw fail.forbidden("Your Main Manager access has been revoked. Contact the company administrator.");
        if (
          (selected === "property" || prefix === "property") &&
          FINE[r.endpoint.id] &&
          !delegatedCan(g, FINE[r.endpoint.id] as Capability)
        )
          throw fail.roleNotAllowed("The company administrator has not granted this action");
        if (
          r.endpoint.id === "contacts.update" &&
          req.body &&
          typeof req.body === "object" &&
          "userId" in req.body &&
          !delegatedCan(g, "property.tenants.assign")
        )
          throw fail.roleNotAllowed("Assigning portal users requires tenant assignment permission");
        if (r.endpoint.id === "property.leases.get" && !delegatedCan(g, "property.tenants.history"))
          throw fail.roleNotAllowed("Viewing the lease financial record requires tenant payment history permission");
        if (g.propertyIds === null) return r.handler(req);
        // A scoped manager never reaches an organisation-wide ledger/export/audit/payment-provider surface.
        if (
          selected !== "property" ||
          (!r.endpoint.id.startsWith("property.") &&
            !r.endpoint.id.startsWith("contacts.") &&
            !["orgs.get", "subscription.entitlements"].includes(r.endpoint.id))
        )
          throw fail.forbidden("This operation requires organisation-wide delegation");
        if (r.stream || GLOBAL.test(r.endpoint.id) || (!SCOPED.test(r.endpoint.id) && !SAFE_SHARED.has(r.endpoint.id)))
          throw fail.forbidden("This operation affects organisation-wide records; ask the company administrator");
        const ids = new Set(g.propertyIds);
        const contactAllowed = (id: string) => contactWithinScope(db, orgId, id, [...ids], actorId);
        async function allowed(key: string, id: string): Promise<boolean> {
          if (["tenantId", "contactId", "ownerId"].includes(key)) return contactAllowed(id);
          if (key === "paymentId") {
            const p = await db.row<{ tenant_id: string }>(
              "SELECT tenant_id FROM pm_payments WHERE org_id=$1 AND id=$2",
              [orgId, id],
            );
            return !!p && contactAllowed(p.tenant_id);
          }
          if (key === "documentId") {
            const doc = await db.row<{ link_entity: string; link_id: string }>(
              "SELECT link_entity,link_id FROM pm_documents WHERE org_id=$1 AND id=$2",
              [orgId, id],
            );
            return !!doc && linkedAllowed(doc.link_entity, doc.link_id);
          }
          const q = TABLES[key];
          if (!q) return false;
          const p = await db.row<{ property_id: string }>(q, [orgId, id]);
          return !!p && ids.has(p.property_id);
        }
        async function linkedAllowed(entity: string, id: string): Promise<boolean> {
          const keys: Record<string, string> = {
            property: "propertyId",
            unit: "unitId",
            lease: "leaseId",
            contact: "contactId",
            workorder: "workOrderId",
            inspection: "inspectionId",
            bill: "billId",
          };
          const key = keys[entity];
          return !!key && allowed(key, id);
        }
        let bound = false;
        async function check(value: unknown) {
          if (!value || typeof value !== "object") return;
          const record = value as Record<string, unknown>;
          if (typeof record.linkEntity === "string" && typeof record.linkId === "string") {
            bound = true;
            if (!(await linkedAllowed(record.linkEntity, record.linkId)))
              throw fail.notFound("Document context not found in your assigned properties");
          }
          for (const [k, v] of Object.entries(value)) {
            if (k === "orgId") continue;
            if (
              (TABLES[k] || ["tenantId", "contactId", "ownerId", "paymentId", "documentId"].includes(k)) &&
              typeof v === "string"
            ) {
              bound = true;
              if (!(await allowed(k, v))) throw fail.notFound("Record not found in your assigned properties");
            }
            if (k === "unitIds" && Array.isArray(v))
              for (const id of v) {
                bound = true;
                if (typeof id !== "string" || !(await allowed("unitId", id)))
                  throw fail.notFound("Unit not found in your assigned properties");
              }
            if (Array.isArray(v)) for (const x of v) await check(x);
            else if (v && typeof v === "object") await check(v);
          }
        }
        await check(req.params);
        await check(req.query);
        await check(req.body);
        if (
          ["property.reports.dashboard", "property.reports.rentRoll", "property.reports.collectionsOverview"].includes(
            r.endpoint.id,
          ) &&
          !bound
        )
          throw fail.invalid("Choose an assigned property for this report");
        if (r.endpoint.id === "property.documents.list" && !bound)
          throw fail.invalid("Select a lease, contact or property to view its documents");
        const list = LISTS[r.endpoint.id];
        const contactsList = r.endpoint.id === "contacts.list";
        if (!bound && !list && !contactsList && r.endpoint.id !== "contacts.create" && !SAFE_SHARED.has(r.endpoint.id))
          throw fail.forbidden("Select an assigned property or record before using this action");
        const out = await r.handler(req);
        if (out && typeof out === "object" && (list || contactsList)) {
          const key = list?.[0] ?? "contacts",
            field = list?.[1] ?? "contactId";
          const data = out as Record<string, unknown>;
          const rows = data[key];
          if (Array.isArray(rows)) {
            const filtered = [];
            for (const x of rows) if (x && typeof x.id === "string" && (await allowed(field, x.id))) filtered.push(x);
            data[key] = filtered;
            if (
              "total" in data &&
              ![
                "property.payments.list",
                "property.invoices.drafts.list",
                "property.invoices.disputes.list",
                "property.invoices.plans.list",
              ].includes(r.endpoint.id)
            )
              data.total = filtered.length;
          }
        }
        return out;
      },
    }));
}
