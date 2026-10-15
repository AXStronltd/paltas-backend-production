// A second PALTAS server process that only runs the migration worker (crash tests kill it with SIGKILL).
// Usage: node migration-worker-child.mjs <database url> <business date>
import { buildApp } from "../../dist/app.js";
import { loadConfig } from "../../dist/config.js";
import { development } from "../../dist/products/development/index.js";

const [databaseUrl, today] = process.argv.slice(2);
const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  LOG_LEVEL: "silent",
  PALTAS_TODAY: today,
  MIGRATION_WORKER: "true",
  MIGRATION_WORKER_POLL_MS: "50",
  MIGRATION_LEASE_MS: "1000",
  MIGRATION_BATCH_SIZE: "2",
});
const app = await buildApp(config, { products: [development], migrate: false });
process.stdout.write(`worker ${app.core.migration.worker.id}\n`);
