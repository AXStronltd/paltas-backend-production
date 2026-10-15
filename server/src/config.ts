// All settings come from environment variables, checked once at start-up. Nothing else reads process.env.
// See server/.env.example for every setting with an explanation.
import { z } from "@paltas/contracts";

const Bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgres:// URL"),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  /** "provider": purchases wait for a signed payment event (always in production). "simulated": local demo only. */
  BILLING_MODE: z.enum(["provider", "simulated"]).default("provider"),
  SESSION_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(30),
  CORS_ORIGINS: z.string().default(""),
  /** 32 random bytes, base64. Encrypts authenticator secrets at rest. Required in production. */
  SECRETS_KEY: z.string().optional(),
  /** Pin the business date for demos and tests. Refused in production. */
  PALTAS_TODAY: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  TRUST_PROXY: Bool.default(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  /** Data migration limits and the background import worker (see core/migration). */
  MIGRATION_MAX_FILE_MB: z.coerce.number().int().min(1).max(1024).default(50),
  MIGRATION_MAX_JOB_MB: z.coerce.number().int().min(1).max(10240).default(500),
  MIGRATION_MAX_OPEN_UPLOADS: z.coerce.number().int().min(1).max(1000).default(20),
  MIGRATION_ZIP_MAX_ENTRIES: z.coerce.number().int().min(1).max(100_000).default(2000),
  MIGRATION_ZIP_MAX_UNCOMPRESSED_MB: z.coerce.number().int().min(1).max(10240).default(200),
  MIGRATION_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(500),
  MIGRATION_WORKER: Bool.default(true),
  MIGRATION_WORKER_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  MIGRATION_LEASE_MS: z.coerce.number().int().min(500).max(3_600_000).default(60_000),
});

const MB = 1024 * 1024;

/** A key used only outside production so local set-ups work without configuration. Never use it for real data. */
const DEVELOPMENT_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");

export interface Config {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  databasePoolSize: number;
  billingMode: "provider" | "simulated";
  sessionMinutes: number;
  corsOrigins: string[];
  secretsKey: string;
  fixedToday: string | null;
  trustProxy: boolean;
  logLevel: string;
  loginRateLimitPerMinute: number;
  /** Shared signing secret per payment provider adapter, from WEBHOOK_SECRET_<PROVIDER>. */
  webhookSecrets: Record<string, string>;
  migration: MigrationSettings;
}

export interface MigrationSettings {
  /** Largest single upload, and all uploads of one job together. */
  maxFileBytes: number;
  maxJobBytes: number;
  /** Most files of one job that may be announced and not yet completed at the same time. */
  maxOpenUploads: number;
  /** ZIP safety: most entries, and most bytes once unpacked (all entries together). */
  zipMaxEntries: number;
  zipMaxUncompressedBytes: number;
  /** Rows per import batch (one transaction each). */
  batchSize: number;
  /** Run the background import worker in this process. */
  worker: boolean;
  workerPollMs: number;
  /** How long a worker's claim on a batch lasts without a heartbeat before another worker may resume it. */
  leaseMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuration is not valid — ${problems}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  if (production && e.PALTAS_TODAY) throw new Error("PALTAS_TODAY must not be set in production");
  if (production && e.BILLING_MODE === "simulated") throw new Error("BILLING_MODE=simulated is refused in production");
  if (production && !e.SECRETS_KEY) throw new Error("SECRETS_KEY is required in production");

  const webhookSecrets = Object.fromEntries(
    Object.entries(env)
      .filter(([k, v]) => k.startsWith("WEBHOOK_SECRET_") && v)
      .map(([k, v]) => [k.slice("WEBHOOK_SECRET_".length).toLowerCase(), v as string]),
  );

  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    databasePoolSize: e.DATABASE_POOL_SIZE,
    billingMode: e.BILLING_MODE,
    sessionMinutes: e.SESSION_MINUTES,
    corsOrigins: e.CORS_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    secretsKey: e.SECRETS_KEY ?? DEVELOPMENT_SECRETS_KEY,
    fixedToday: e.PALTAS_TODAY ?? null,
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    loginRateLimitPerMinute: e.LOGIN_RATE_LIMIT_PER_MINUTE,
    webhookSecrets,
    migration: {
      maxFileBytes: e.MIGRATION_MAX_FILE_MB * MB,
      maxJobBytes: e.MIGRATION_MAX_JOB_MB * MB,
      maxOpenUploads: e.MIGRATION_MAX_OPEN_UPLOADS,
      zipMaxEntries: e.MIGRATION_ZIP_MAX_ENTRIES,
      zipMaxUncompressedBytes: e.MIGRATION_ZIP_MAX_UNCOMPRESSED_MB * MB,
      batchSize: e.MIGRATION_BATCH_SIZE,
      worker: e.MIGRATION_WORKER,
      workerPollMs: e.MIGRATION_WORKER_POLL_MS,
      leaseMs: e.MIGRATION_LEASE_MS,
    },
    ...overrides,
  };
}
