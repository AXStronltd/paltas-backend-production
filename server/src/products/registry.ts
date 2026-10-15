/*
 * How a product (Property Management, Development, Security …) plugs into the core.
 *
 * Each product lives in its own folder under src/products/<product>/ and exports ONE ProductModule. The core never
 * imports product code directly; it only asks the registry. That keeps every product separate and replaceable, and
 * means a product can only reach shared services (ledger, audit, access checks) through their public functions.
 */
import type { PaymentEvent, Product } from "@paltas/contracts";
import type { AppContext } from "../context.js";
import type { Db } from "../db/database.js";
import type { Route } from "../http/route.js";
import type { CoreServices } from "../core/core-services.js";
import type { AccountSeed } from "../core/ledger/default-chart.js";
import type { MigrationDomain } from "../core/migration/domain.js";
import type { ScheduledJobDefinition } from "../core/scheduler/types.js";

/** A payment event delivered for a type this product owns (e.g. "rent.payment"). */
export interface ProductPaymentEvent extends PaymentEvent {
  /** "<provider>:<provider event id>" — unique; already checked not to be a duplicate. */
  eventId: string;
  provider: string;
  /** Recorded by hand by PALTAS staff (bank transfer), not received from a provider. */
  manual: boolean;
  recordedBy: string | null;
}

export interface PaymentOutcome {
  /** Plain-language result kept with the event, e.g. "Applied — rent invoice RI-00012 paid". */
  result: string;
  orgId: string | null;
  targetId: string | null;
  invoiceId?: string | null;
  receiptId?: string | null;
}

export type PaymentHandler = (t: Db, event: ProductPaymentEvent) => Promise<PaymentOutcome>;

export interface ProductModule {
  product: Product;
  /** The product's API routes. Every route uses core.access to check membership, role and subscription. */
  routes(ctx: AppContext, core: CoreServices): Route[];
  /** How much of the plan's allowance is used (buildings for property, projects for development). */
  usage?(db: Db, orgId: string): Promise<number>;
  /** Payment event types this product applies, e.g. { "rent.payment": handler }. */
  paymentHandlers?: Record<string, PaymentHandler>;
  /** Ledger accounts every organisation subscribing to this product needs (added to its chart). */
  accounts?: AccountSeed[];
  /** The product's records as a data-migration target (core/migration): entities, rules, postings. */
  migration?: MigrationDomain;
  /**
   * Jobs the scheduler runs for this product (core/scheduler), e.g. the hotel night audit or monthly rent invoicing.
   * Definitions only: the product creates each organisation's schedule with core.scheduler.ensureJob(...).
   */
  scheduledJobs?(ctx: AppContext, core: CoreServices): ScheduledJobDefinition[];
}

export class ProductRegistry {
  private readonly byProduct = new Map<Product, ProductModule>();
  private readonly handlers = new Map<string, PaymentHandler>();

  constructor(modules: ProductModule[]) {
    for (const m of modules) {
      if (this.byProduct.has(m.product)) throw new Error(`Product ${m.product} is registered twice`);
      this.byProduct.set(m.product, m);
      for (const [type, h] of Object.entries(m.paymentHandlers ?? {})) {
        if (this.handlers.has(type)) throw new Error(`Payment type ${type} has two handlers`);
        this.handlers.set(type, h);
      }
    }
  }

  get modules(): ProductModule[] {
    return [...this.byProduct.values()];
  }

  /** Allowance used by an organisation for one product (0 until that product is built). */
  async usage(product: Product, db: Db, orgId: string): Promise<number> {
    const m = this.byProduct.get(product);
    return m?.usage ? m.usage(db, orgId) : 0;
  }

  accountsFor(product: Product): AccountSeed[] {
    return this.byProduct.get(product)?.accounts ?? [];
  }

  /** Add a core handler (subscription payments) alongside the products' handlers. */
  addPaymentHandler(type: string, handler: PaymentHandler) {
    if (this.handlers.has(type)) throw new Error(`Payment type ${type} has two handlers`);
    this.handlers.set(type, handler);
  }

  paymentHandler(type: string): PaymentHandler | undefined {
    return this.handlers.get(type);
  }
}
