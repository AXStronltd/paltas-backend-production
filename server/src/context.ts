/*
 * The services every module receives. Built once in app.ts and passed down explicitly — no hidden globals —
 * so any module can be read, tested or replaced on its own.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.js";
import type { Database } from "./db/database.js";
import type { Clock } from "./lib/clock.js";
import type { SecretBox } from "./lib/secret-box.js";
import type { ProductRegistry } from "./products/registry.js";

export interface AppContext {
  config: Config;
  db: Database;
  clock: Clock;
  log: FastifyBaseLogger;
  secrets: SecretBox;
  products: ProductRegistry;
}
