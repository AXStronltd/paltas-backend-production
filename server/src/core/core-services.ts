/*
 * The core's public services, created once and handed to core routes and to every product module.
 * Products use ONLY these (access checks, the ledger, audit, …) — never another module's internals.
 */
import type { AppContext } from "../context.js";
import type { Database } from "../db/database.js";
import { orgAccess, type OrgAccess } from "./access/org-access.js";
import { adminService, type AdminService } from "./admin/admin.service.js";
import { opsService, type OpsService } from "./admin/ops.service.js";
import { loadCatalogue } from "./catalogue/catalogue.service.js";
import { contactsService, type ContactsService } from "./contacts/contacts.service.js";
import { identityService, type IdentityService } from "./identity/identity.service.js";
import { ledgerService, type LedgerService } from "./ledger/ledger.service.js";
import { migrationService, type MigrationService } from "./migration/migration.service.js";
import { notificationsService, type NotificationsService } from "./notifications/notifications.service.js";
import { organisationsService, type OrganisationsService } from "./organisations/organisations.service.js";
import { paymentsService, type PaymentsService } from "./payments/payments.service.js";
import {
  providersService,
  UNMATCHED_PAYMENT,
  unmatchedPaymentHandler,
  type ProvidersService,
} from "./payments/providers.service.js";
import { platformJobs } from "./scheduler/platform-jobs.js";
import { schedulerService, type SchedulerService } from "./scheduler/scheduler.service.js";
import { trialJobs } from "./signup/lifecycle-jobs.js";
import { signupService, type SignupService } from "./signup/signup.service.js";
import { upgradeService, type UpgradeService } from "./signup/upgrade.service.js";
import { createSchedulerWorker, type SchedulerWorker } from "./scheduler/worker.js";
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
  /** Durable scheduled jobs (platform and per organisation); products register theirs via ProductModule. */
  scheduler: SchedulerService;
  schedulerWorker: SchedulerWorker;
  /** The one outbox for e-mail, SMS, WhatsApp and push (recorded → queued → sent/failed by provider report). */
  notifications: NotificationsService;
  /** Payment provider adapters (M-Pesa, card, bank statements) and payment references. */
  providers: ProvidersService;
  /** Super Admin operations: suspension, price changes with approval, audit search. */
  ops: OpsService;
  /** The organisation's ONE contact store (tenants, owners, prospects, suppliers), shared by every product. */
  contacts: ContactsService;
  /** Self-service sign-up, e-mail verification and the one platform trial policy (core/signup). */
  signup: SignupService;
  /** Self-service upgrade of a trial or lapsed subscription, and the organisation's own export. */
  upgrades: UpgradeService;
  catalogue(): ReturnType<typeof loadCatalogue>;
}

export function createCoreServices(ctx: AppContext): CoreServices {
  const subscriptions = subscriptionsService(ctx);
  const payments = paymentsService(ctx);
  // core owns PALTAS subscription payments; products register their own payment types
  ctx.products.addPaymentHandler("subscription.payment", (t, ev) =>
    subscriptions.billing.applySubscriptionPayment(t, ev),
  );
  // a provider payment whose reference matches nothing is kept and held for review
  ctx.products.addPaymentHandler(UNMATCHED_PAYMENT, unmatchedPaymentHandler);
  const ledger = ledgerService(ctx);
  const notifications = notificationsService(ctx, ctx.emailTransport);
  const scheduler = schedulerService(ctx);
  scheduler.register(platformJobs(ctx, { billing: subscriptions.billing, notifications }));
  const signup = signupService(ctx, { notifications });
  scheduler.register(trialJobs(ctx, { notifications, signup }));
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
    scheduler,
    schedulerWorker: createSchedulerWorker({
      scheduler,
      log: ctx.log,
      pollMs: ctx.config.scheduler.pollMs,
      leaseMs: ctx.config.scheduler.leaseMs,
    }),
    notifications,
    providers: providersService(ctx, { payments }),
    ops: opsService(ctx),
    contacts: contactsService(ctx, { notifications }),
    signup,
    upgrades: upgradeService(ctx, { billing: subscriptions.billing, signup }),
    catalogue: () => loadCatalogue(ctx.db),
  };
}
