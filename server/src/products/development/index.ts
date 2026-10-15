/*
 * Real Estate Development ("developer"): one ProductModule. The dev_* records of migration 0006 are the data-migration
 * target and, extended by migration 0008, the day-to-day product's own records — migrated and new records work alike.
 *
 *   setup/         rules and approval limits, cost codes, projects, phases, buildings, units, price lists, milestones,
 *                  documents, legal register
 *   sales/         buyers, correspondence, disputes, offers, reservations, the signed sale agreement and its schedule
 *   collections/   statements of account, buyer payments (recorded, verified by finance), billing, handover
 *   procurement/   suppliers and bank-detail changes, budgets and the cost report, requisitions, quotations, orders,
 *                  deliveries
 *   payables/      supplier invoices with three-way checks, credit notes, disputes, retention, payment runs
 *   work/          tasks, after-sales, defects
 *   reports/       dashboard tied to the ledger, approvals inbox
 *   shared/        access gate, ledger posting, rules and approvals, record loaders
 */
import type { ProductModule } from "../registry.js";
import { DEV_ACCOUNTS } from "./accounts.js";
import { collectionsRoutes } from "./collections/collections.routes.js";
import { collectionsService } from "./collections/collections.service.js";
import { developmentMigration } from "./migration-domain.js";
import { payablesRoutes } from "./payables/payables.routes.js";
import { payablesService } from "./payables/payables.service.js";
import { procurementRoutes } from "./procurement/procurement.routes.js";
import { procurementService } from "./procurement/procurement.service.js";
import { reportsRoutes } from "./reports/reports.routes.js";
import { reportsService } from "./reports/reports.service.js";
import { salesRoutes } from "./sales/sales.routes.js";
import { salesService } from "./sales/sales.service.js";
import { setupRoutes } from "./setup/setup.routes.js";
import { setupService } from "./setup/setup.service.js";
import { devGate } from "./shared/access.js";
import { workRoutes } from "./work/work.routes.js";
import { workService } from "./work/work.service.js";

export const development: ProductModule = {
  product: "developer",
  routes(_ctx, core) {
    const g = devGate(core);
    return [
      ...setupRoutes(g, setupService(core)),
      ...salesRoutes(g, salesService(core)),
      ...collectionsRoutes(g, collectionsService(core)),
      ...procurementRoutes(g, procurementService(core)),
      ...payablesRoutes(g, payablesService(core)),
      ...workRoutes(g, workService(core)),
      ...reportsRoutes(g, reportsService(core)),
    ];
  },
  // the plan's allowance counts projects
  usage: async (db, orgId) =>
    (await db.row<{ n: number }>("SELECT count(*)::int AS n FROM dev_projects WHERE org_id = $1", [orgId]))?.n ?? 0,
  accounts: DEV_ACCOUNTS,
  migration: developmentMigration,
};
