/*
 * The Security Services product ("security"): one ProductModule. Its services are built once per server from the
 * core services and the integration adapters (labelled test adapters until certified ones exist).
 *
 *   setup/          settings, payroll rules, clients and portal users, sites, posts and post orders, checkpoints,
 *                   contracts with service levels, sales pipeline
 *   workforce/      guards, licences, vetting, training, expiry alerts, equipment issue and return
 *   roster/         shifts, assignment (no double-booking), offers, publishing, attendance evidence, no-shows,
 *                   timesheet approval, messages to guards
 *   field/          patrols and checkpoints, incidents, the append-only occurrence book, alarms and response,
 *                   the signed alarm-provider webhook
 *   access/         visitor reception, watchlist, doors, access groups, credentials, access-rule checks
 *   finance/        client billing, receipts, certificates, late charges, collections, bank lines (billing);
 *                   payroll inputs, costs and remittances (payroll) — all posted to the ONE ledger
 *   reports/        dashboard, KPIs and site profitability from the ledger, client service reports, client portal
 *   integrations/   adapters: access control, messaging, biometrics, CCTV, alarm monitoring, tax authority, payouts
 */
import type { ProductModule } from "../registry.js";
import { SECURITY_ACCOUNTS } from "./accounts.js";
import { accessRoutes } from "./access/access.routes.js";
import { accessService } from "./access/access.service.js";
import type { SecurityDeps } from "./deps.js";
import { fieldRoutes } from "./field/field.routes.js";
import { fieldService } from "./field/field.service.js";
import { billingService } from "./finance/billing.service.js";
import { financeRoutes } from "./finance/finance.routes.js";
import { payrollService } from "./finance/payroll.service.js";
import { sandboxAdapters, type SecurityAdapters } from "./integrations/adapters.js";
import { reportsRoutes } from "./reports/reports.routes.js";
import { reportsService } from "./reports/reports.service.js";
import { rosterRoutes } from "./roster/roster.routes.js";
import { rosterService } from "./roster/roster.service.js";
import { setupRoutes } from "./setup/setup.routes.js";
import { setupService } from "./setup/setup.service.js";
import { securityAccess } from "./shared/access.js";
import { workforceRoutes } from "./workforce/workforce.routes.js";
import { workforceService } from "./workforce/workforce.service.js";

/** Build the security product with the given adapters (default: the labelled test adapters). */
export function securityProduct(adapters: SecurityAdapters = sandboxAdapters): ProductModule {
  return {
    product: "security",
    accounts: SECURITY_ACCOUNTS,
    // the plan allowance counts active sites
    usage: async (db, orgId) =>
      (await db.row<{ n: number }>("SELECT count(*)::int AS n FROM sec_sites WHERE org_id = $1 AND active", [orgId]))
        ?.n ?? 0,
    routes(ctx, core) {
      const d: SecurityDeps = { ctx, core, adapters };
      const a = securityAccess(core);
      const workforce = workforceService(d);
      const billing = billingService(d);
      return [
        ...setupRoutes(a, setupService(d)),
        ...workforceRoutes(a, workforce),
        ...rosterRoutes(a, rosterService(d)),
        ...fieldRoutes(a, fieldService(d)),
        ...accessRoutes(a, accessService(d)),
        ...financeRoutes(a, billing, payrollService(d)),
        ...reportsRoutes(a, reportsService(d, { billing, workforce })),
      ];
    },
  };
}

export const security = securityProduct();
