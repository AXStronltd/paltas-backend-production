/*
 * The services every module receives. Built once in app.ts and passed down explicitly — no hidden globals —
 * so any module can be read, tested or replaced on its own.
 */
import type { FastifyBaseLogger } from "fastify";
import type Stripe from "stripe";
import type { Config } from "./config.js";
import type { EmailTransport } from "./core/notifications/email-providers.js";
import type { Database } from "./db/database.js";
import type { Clock } from "./lib/clock.js";
import type { SecretBox } from "./lib/secret-box.js";
import type { SupportAssistant } from "./core/support/assistant.js";
import type { ProductRegistry } from "./products/registry.js";

export interface AppContext {
  /** Dependency injection for isolated provider tests, never configured by an HTTP request or environment URL. */
  rentStripeClient?: Stripe;
  config: Config;
  db: Database;
  clock: Clock;
  log: FastifyBaseLogger;
  secrets: SecretBox;
  products: ProductRegistry;
  /** How e-mail reaches its provider (default: the real network; tests point it at local fake servers). */
  emailTransport?: EmailTransport;
  /** Tests only: the PALTAS assistant of the support chat (production: the Anthropic API, see core/support). */
  supportAssistant?: SupportAssistant | null;
}
