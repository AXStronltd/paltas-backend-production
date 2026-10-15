/*
 * The core's public services, created once and handed to core routes and to every product module.
 * Products use ONLY these (access checks, the ledger, audit, …) — never another module's internals.
 */
import type { AppContext } from "../context.js";
import type { Database } from "../db/database.js";
import { orgAccess, type OrgAccess } from "./access/org-access.js";
import { adminService, type AdminService } from "./admin/admin.service.js";
import { loadCatalogue } from "./catalogue/catalogue.service.js";
import { identityService, type IdentityService } from "./identity/identity.service.js";
import { ledgerService, type LedgerService } from "./ledger/ledger.service.js";
import { migrationService, type MigrationService } from "./migration/migration.service.js";
import { organisationsService, type OrganisationsService } from "./organisations/organisations.service.js";
import { paymentsService, type PaymentsService } from "./payments/payments.service.js";
import { subscriptionsService, type SubscriptionsService } from "./subscriptions/subscriptions.service.js";

export interface CoreServices {
  db: Database;
  identity: IdentityService;
  access: OrgAccess;
  organisations: OrganisationsService;
  subscriptions: SubscriptionsService;
  payments: PaymentsService;
  ledger: LedgerService;
  admin: AdminService;
  /** Data migration into any product that registers a migration domain. */
  migration: MigrationService;
  catalogue(): ReturnType<typeof loadCatalogue>;
}

export function createCoreServices(ctx: AppContext): CoreServices {
  const subscriptions = subscriptionsService(ctx);
  const payments = paymentsService(ctx);
  // core owns PALTAS subscription payments; products register their own payment types
  ctx.products.addPaymentHandler("subscription.payment", (t, ev) =>
    subscriptions.billing.applySubscriptionPayment(t, ev),
  );
  const ledger = ledgerService(ctx);
  return {
    db: ctx.db,
    identity: identityService(ctx),
    access: orgAccess(ctx),
    organisations: organisationsService(ctx),
    subscriptions,
    payments,
    ledger,
    admin: adminService(ctx, { billing: subscriptions.billing, payments }),
    migration: migrationService(ctx, { ledger }),
    catalogue: () => loadCatalogue(ctx.db),
  };
}
