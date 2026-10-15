/*
 * Real Estate Development. This round builds its records as a DATA-MIGRATION TARGET only (dev_* tables, migration
 * 0006): customers bring projects, units, buyers, contracts, schedules, payments, suppliers, works and documents
 * from their previous system. Day-to-day Development screens and endpoints come in the Development round.
 */
import type { ProductModule } from "../registry.js";
import { developmentMigration } from "./migration-domain.js";

export const development: ProductModule = {
  product: "developer",
  routes: () => [],
  // the plan's allowance counts projects
  usage: async (db, orgId) =>
    (await db.row<{ n: number }>("SELECT count(*)::int AS n FROM dev_projects WHERE org_id = $1", [orgId]))?.n ?? 0,
  accounts: developmentMigration.accounts.map(({ code, name, type, system }) => ({ code, name, type, system })),
  migration: developmentMigration,
};
