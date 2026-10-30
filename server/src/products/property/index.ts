import { reportSchedulesService, COLLECTION_REPORT_JOB } from "./reports/report-schedules.service.js";
import { reportScheduleRoutes } from "./reports/report-schedules.routes.js";
import { kulmiPayRoutes } from "../../core/payments/kulmipay/routes.js";
import { FLEXIBLE_RENT_JOB, rentSchedulesService } from "./billing/rent-schedules.service.js";
import { rentScheduleRoutes } from "./billing/rent-schedules.routes.js";
import { inspectionControlsService } from "./maintenance/inspection-controls.service.js";
import { inspectionControlRoutes } from "./maintenance/inspection-controls.routes.js";
import { preventiveService, PREVENTIVE_JOB } from "./maintenance/preventive.service.js";
import { preventiveRoutes } from "./maintenance/preventive.routes.js";
import { complaintRoutes } from "./people/complaints.routes.js";
import { complaintsService } from "./people/complaints.service.js";
import { utilityMetersService } from "./utilities/utility-meters.service.js";
import { utilityMeterRoutes } from "./utilities/utility-meters.routes.js";
import { collectionRemindersService, COLLECTION_REMINDERS_JOB } from "./billing/collection-reminders.service.js";
import { collectionReminderRoutes } from "./billing/collection-reminders.routes.js";
import { collectionPlanRoutes } from "./billing/collection-plans.routes.js";
import { collectionPlansService } from "./billing/collection-plans.service.js";
import { billingDisputeRoutes } from "./billing/billing-disputes.routes.js";
import { billingDisputesService } from "./billing/billing-disputes.service.js";
import { propertyPayrollService } from "./payroll/payroll.service.js";
import { propertyPayrollRoutes } from "./payroll/payroll.routes.js";
import { tenantControls } from "./leases/tenant-control.js";
import { property as propertyApi } from "@paltas/contracts";
import { route } from "../../http/route.js";
/*
 * Property Management (product "property", also the Almas Tower pilot): one ProductModule. Its services are built once
 * per server from the core services and the PM access gate. People (tenants, owners, suppliers, prospects) live in the
 * ONE core contact store (core/contacts); money posts to the ONE ledger (accounts.ts).
 *
 *   setup/        settings, charge types, properties, buildings, units, owners' agreements and payout details
 *   leases/       draft → active → renewal / rent review → notice → ended; recurring charges; meter readings
 *   billing/      monthly runs (rent, charges), charge invoices, late fees, credit notes
 *   payments/     recorded payments with allocation and receipts, tenant credit and statements, reported payments,
 *                 deposit settlements (second person)
 *   owners/       owner statements (equal to the ledger) and payouts (prepare / approve / release)
 *   bills/        supplier bills (enter / approve / pay, owner approval above the authority, PO matching)
 *   maintenance/  requests, work orders, quotes, purchase orders, completion and checks, inspections
 *   crm/          enquiries, leads, viewings, applications → leases
 *   comms/        notices (recorded, never sent) and document records
 *   bank/         client-account statement lines, matching, reconciliations
 *   reports/      dashboard, aged receivables, rent roll, client-money check
 *   portal/       the tenant and owner portals
 *   shared/       access gate, ledger posting, invoice issuing and collection, records
 *
 * Scheduled jobs (PALTAS scheduler, one schedule per property, turned on with property.properties.automation):
 *   property.monthly_billing   the monthly rent run, then the charges run, on the property's billing day
 *   property.late_fees         late fees every morning per the property's policy
 * Both are idempotent (one rent / charges invoice per lease and month, one late fee per overdue invoice).
 */
import { resolveEntitlement } from "../../core/subscriptions/entitlement.service.js";
import { ApiError } from "../../http/errors.js";
import type { ProductModule } from "../registry.js";
import { PM_ACCOUNTS } from "./accounts.js";
import { bankRoutes } from "./bank/bank.routes.js";
import { bankService } from "./bank/bank.service.js";
import { billingRoutes } from "./billing/billing.routes.js";
import { billingService } from "./billing/billing.service.js";
import { billsRoutes } from "./bills/bills.routes.js";
import { billsService } from "./bills/bills.service.js";
import { commsRoutes } from "./comms/comms.routes.js";
import { commsService } from "./comms/comms.service.js";
import { crmWorkService } from "./crm/work.service.js";
import { crmRoutes } from "./crm/crm.routes.js";
import { crmService } from "./crm/crm.service.js";
import type { PmDeps } from "./deps.js";
import { leasesRoutes } from "./leases/leases.routes.js";
import { leasePeopleService } from "./leases/lease-people.service.js";
import { leasePeopleRoutes } from "./leases/lease-people.routes.js";
import { leasesService } from "./leases/leases.service.js";
import { maintenanceRoutes } from "./maintenance/maintenance.routes.js";
import { maintenanceService } from "./maintenance/maintenance.service.js";
import { propertyMigration } from "./migration-domain.js";
import { ownersRoutes } from "./owners/owners.routes.js";
import { ownersService } from "./owners/owners.service.js";
import { paymentsRoutes } from "./payments/payments.routes.js";
import { paymentsService } from "./payments/payments.service.js";
import { portalRoutes } from "./portal/portal.routes.js";
import { portalService } from "./portal/portal.service.js";
import { reportsRoutes } from "./reports/reports.routes.js";
import { reportsService } from "./reports/reports.service.js";
import { setupRoutes } from "./setup/setup.routes.js";
import { setupService } from "./setup/setup.service.js";
import { MODULE, pmAccess } from "./shared/access.js";
import { LATE_FEES_JOB, MONTHLY_BILLING_JOB } from "./shared/jobs.js";
import type { PropertyRow } from "./shared/records.js";

export const property: ProductModule = {
  product: "property",
  accounts: PM_ACCOUNTS,
  // the plan's building allowance counts properties (a property is one building or estate; blocks inside it are free)
  usage: async (db, orgId) =>
    (await db.row<{ n: number }>("SELECT count(*)::int AS n FROM pm_properties WHERE org_id = $1", [orgId]))?.n ?? 0,
  migration: propertyMigration,
  routes(ctx, core) {
    const access = pmAccess(core);
    const d: PmDeps = { ctx, core, access };
    const setup = setupService(d);
    const controls = tenantControls(d);
    const leases = leasesService(d);
    const billing = billingService(d);
    const payments = paymentsService(d);
    const owners = ownersService(d);
    const bills = billsService(d);
    const maintenance = maintenanceService(d);
    return [
      ...kulmiPayRoutes(d),
      route(propertyApi.getTenantControl, async (req) =>
        controls.get(await access.org(req.user, req.params.orgId, "property.tenants.view"), req.params.tenantId),
      ),
      route(propertyApi.setTenantControl, async (req) =>
        controls.change(
          await access.org(
            req.user,
            req.params.orgId,
            req.body.action === "suspend"
              ? "property.tenants.suspend"
              : req.body.action === "restore"
                ? "property.tenants.restore"
                : "property.tenants.archive",
            { write: true },
          ),
          req.params.tenantId,
          req.body,
        ),
      ),
      ...complaintRoutes(access, complaintsService(d)),
      ...propertyPayrollRoutes(access, propertyPayrollService(d)),
      ...setupRoutes(access, setup),
      ...leasesRoutes(access, leases, billing, payments),
      ...leasePeopleRoutes(access, leasePeopleService(d)),
      ...billingRoutes(access, billing),
      ...rentScheduleRoutes(access, rentSchedulesService(d)),
      ...billingDisputeRoutes(access, billingDisputesService(d)),
      ...collectionPlanRoutes(access, collectionPlansService(d)),
      ...collectionReminderRoutes(access, collectionRemindersService(d)),
      ...utilityMeterRoutes(access, utilityMetersService(d)),
      ...paymentsRoutes(access, payments),
      ...ownersRoutes(access, owners),
      ...billsRoutes(access, bills),
      ...maintenanceRoutes(access, maintenance),
      ...inspectionControlRoutes(access, inspectionControlsService(d, maintenance)),
      ...preventiveRoutes(access, preventiveService(d, maintenance)),
      ...crmRoutes(access, crmService(d, { leases }), crmWorkService(d)),
      ...commsRoutes(access, commsService(d)),
      ...bankRoutes(access, bankService(d, { payments })),
      ...reportsRoutes(access, reportsService(d)),
      ...reportScheduleRoutes(access, reportSchedulesService(d)),
      ...portalRoutes(access, portalService(d, { setup, maintenance, bills, owners })),
    ];
  },
  scheduledJobs(ctx, core) {
    const pd = { ctx, core, access: pmAccess(core) };
    const preventive = preventiveService(pd, maintenanceService(pd));
    const billing = billingService(pd);
    const reminders = collectionRemindersService({ ctx, core, access: pmAccess(core) });
    const SYSTEM = { userId: null, role: "system:scheduler" };
    /** The property, when its subscription can still bill (active, with the finance module) — else why not. */
    async function target(orgId: string | null, propertyId: string | null): Promise<PropertyRow | string> {
      if (!orgId || !propertyId) return "No property named — nothing done";
      const en = await resolveEntitlement(ctx.db, ctx.products, ctx.clock.today(), orgId, "property").catch(() => null);
      if (!en?.ent.usable) return "The Property Management subscription is not active — nothing done";
      if (!en.ent.modules[MODULE.finance]) return "Finance is not in the plan — nothing done";
      const p = await ctx.db.row<PropertyRow>("SELECT * FROM pm_properties WHERE org_id = $1 AND id = $2", [
        orgId,
        propertyId,
      ]);
      return p ?? "The property no longer exists — nothing done";
    }
    return [
      {
        key: COLLECTION_REPORT_JOB,
        label: "Collection report preparation",
        scope: "org",
        async run(job) {
          if (!job.orgId || !job.targetId) return { summary: "No report schedule selected" };
          return reportSchedulesService(pd).automatic(job.orgId, job.targetId, job.localDate);
        },
      },
      {
        key: FLEXIBLE_RENT_JOB,
        label: "Flexible lease rent billing",
        scope: "org",
        async run(job) {
          const p = await target(job.orgId, job.targetId);
          if (typeof p === "string") return { summary: p };
          return rentSchedulesService(pd).automatic(
            { orgId: p.org_id, userId: null, actor: SYSTEM, today: job.localDate },
            p.id,
          );
        },
      },
      {
        key: PREVENTIVE_JOB,
        label: "Preventive property servicing",
        scope: "org",
        async run(job) {
          if (!job.orgId || !job.targetId) return { summary: "No property selected" };
          return preventive.automatic(job.orgId, job.targetId, job.localDate);
        },
      },
      {
        key: COLLECTION_REMINDERS_JOB,
        label: "Collection reminders",
        scope: "org",
        async run(job) {
          const p = await target(job.orgId, job.targetId);
          if (typeof p === "string") return { summary: p };
          return reminders.automatic(p.org_id, p.id, job.localDate);
        },
      },
      {
        key: MONTHLY_BILLING_JOB,
        label: "Property Management monthly billing run",
        scope: "org",
        async run(job) {
          const p = await target(job.orgId, job.targetId);
          if (typeof p === "string") return { summary: p };
          if (!p.auto_billing) return { summary: `Automatic billing is off for ${p.name} — nothing done` };
          const op = { orgId: p.org_id, userId: null, actor: SYSTEM, today: ctx.clock.today() };
          const period = op.today.slice(0, 7);
          const rent = await billing.runBilling(op, { propertyId: p.id, period, kind: "rent" });
          let charges: string;
          try {
            const c = await billing.runBilling(op, { propertyId: p.id, period, kind: "charges" });
            charges = `${c.created.length} charges invoice(s)`;
          } catch (e) {
            if (!(e instanceof ApiError)) throw e;
            charges = `charges not billed: ${e.message}`;
          }
          return {
            summary: `${p.name} ${period}: ${rent.created.length} rent invoice(s), ${rent.skipped.length} skipped · ${charges}`,
          };
        },
      },
      {
        key: LATE_FEES_JOB,
        label: "Property Management late fees",
        scope: "org",
        async run(job) {
          const p = await target(job.orgId, job.targetId);
          if (typeof p === "string") return { summary: p };
          if (!p.auto_late_fees) return { summary: `Automatic late fees are off for ${p.name} — nothing done` };
          const r = await billing.runLateFees(
            { orgId: p.org_id, userId: null, actor: SYSTEM, today: ctx.clock.today() },
            { propertyId: p.id },
          );
          return { summary: `${p.name}: ${r.created.length} late fee(s) charged` };
        },
      },
    ];
  },
};
