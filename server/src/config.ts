// All settings come from environment variables, checked once at start-up. Nothing else reads process.env.
// See server/.env.example for every setting with an explanation.
import { Product, z } from "@paltas/contracts";

const Bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");
/** A yes/no setting whose default depends on NODE_ENV: unset or empty means "use the default". */
const OptionalBool = Bool.optional().or(z.literal("").transform(() => undefined));

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
  /** Public marketplace abuse limits, per caller address: reads per minute, submissions per hour. */
  MARKETPLACE_SEARCH_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(120),
  MARKETPLACE_SUBMIT_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(20),
  /** The scheduler (core/scheduler): background worker, polling, leases, retries. Worker default: on, except in tests. */
  SCHEDULER_WORKER: OptionalBool,
  SCHEDULER_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(5000),
  SCHEDULER_LEASE_MS: z.coerce.number().int().min(500).max(3_600_000).default(120_000),
  SCHEDULER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  SCHEDULER_RETRY_BASE_MS: z.coerce.number().int().min(100).max(3_600_000).default(30_000),
  /** Renewal invoices are issued this many days before the next billing period starts. */
  SCHEDULER_RENEWAL_LEAD_DAYS: z.coerce.number().int().min(0).max(60).default(7),
  /** Requests per minute for sensitive routes (password, two-factor, Super Admin changes, exports), per person. */
  SENSITIVE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  /** Requests per minute per address for provider webhooks. */
  WEBHOOK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(1200),
  /** Catalogue prices change only through a request approved by a second Super Admin. Default: on in production. */
  CATALOGUE_PRICE_APPROVAL: OptionalBool,
  /** How long a stopping server waits for requests and workers to finish before it exits anyway. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(25_000),
  /** Public self-service sign-up (core/signup). Off unless switched on. */
  SIGNUP_ENABLED: Bool.default(false),
  SIGNUP_PRODUCTS: z
    .string()
    .default("property")
    .transform((value) =>
      value
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    )
    .pipe(z.array(Product).max(5)),
  PLATFORM_EMAIL_PROVIDER: z.enum(["none", "resend"]).default("none"),
  RESEND_API_KEY: z.string().trim().min(1).optional(),
  PLATFORM_EMAIL_FROM: z.email().optional(),
  /** Sign-up requests per caller address per hour, and per e-mail address per day (also verification messages). */
  SIGNUP_PER_IP_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(10),
  SIGNUP_PER_EMAIL_PER_DAY: z.coerce.number().int().min(1).max(100).default(3),
  /** The version of the PALTAS terms a sign-up must accept (the published terms document). */
  SIGNUP_TERMS_VERSION: z.string().trim().min(1).max(40).default("2026-10"),
  SIGNUP_TERMS_URL: z.union([z.literal(""), z.url()]).default(""),
  /** Where the verification link points (the front end's verification page, which posts the token). */
  APP_BASE_URL: z.url().default("http://127.0.0.1:8080"),
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
  /** Public marketplace limits per caller address (products/agency/shared/limiter.ts). */
  marketplace: { searchPerMinute: number; submitPerHour: number };
  scheduler: SchedulerSettings;
  sensitiveRateLimitPerMinute: number;
  webhookRateLimitPerMinute: number;
  /** Prices of existing plans and modules change only through an approved price change request. */
  cataloguePriceApproval: boolean;
  shutdownTimeoutMs: number;
  signup: SignupSettings;
  platformEmail?: { apiKey: string; from: string };
}

export interface SignupSettings {
  enabled: boolean;
  allowedProducts: z.infer<typeof Product>[];
  perIpPerHour: number;
  perEmailPerDay: number;
  termsVersion: string;
  termsUrl: string;
  /** Base of the verification link, e.g. https://paltashub.com → https://paltashub.com/verify-email#token=… */
  appBaseUrl: string;
}

export interface SchedulerSettings {
  /** Run the scheduler worker in this process. */
  worker: boolean;
  pollMs: number;
  /** How long a worker's claim on a run lasts without a heartbeat before another worker may take it over. */
  leaseMs: number;
  /** Attempts per run before it is marked failed; retries wait retryBaseMs × 2^(attempt − 1), at most one hour. */
  maxAttempts: number;
  retryBaseMs: number;
  renewalLeadDays: number;
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
  if (e.PLATFORM_EMAIL_PROVIDER === "resend" && (!e.RESEND_API_KEY || !e.PLATFORM_EMAIL_FROM))
    throw new Error("Resend requires RESEND_API_KEY and PLATFORM_EMAIL_FROM");
  if (e.SECRETS_KEY && !isSecretsKey(e.SECRETS_KEY)) {
    throw new Error("SECRETS_KEY must be exactly 32 bytes encoded as canonical base64");
  }
  if (production && e.PALTAS_TODAY) throw new Error("PALTAS_TODAY must not be set in production");
  if (production && e.BILLING_MODE === "simulated") throw new Error("BILLING_MODE=simulated is refused in production");
  if (production && !e.SECRETS_KEY) throw new Error("SECRETS_KEY is required in production");
  if (production && e.SIGNUP_ENABLED && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(e.APP_BASE_URL))
    throw new Error("APP_BASE_URL must be the public front-end address in production while SIGNUP_ENABLED is on");

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
    scheduler: {
      worker: e.SCHEDULER_WORKER ?? e.NODE_ENV !== "test",
      pollMs: e.SCHEDULER_POLL_MS,
      leaseMs: e.SCHEDULER_LEASE_MS,
      maxAttempts: e.SCHEDULER_MAX_ATTEMPTS,
      retryBaseMs: e.SCHEDULER_RETRY_BASE_MS,
      renewalLeadDays: e.SCHEDULER_RENEWAL_LEAD_DAYS,
    },
    sensitiveRateLimitPerMinute: e.SENSITIVE_RATE_LIMIT_PER_MINUTE,
    webhookRateLimitPerMinute: e.WEBHOOK_RATE_LIMIT_PER_MINUTE,
    cataloguePriceApproval: e.CATALOGUE_PRICE_APPROVAL ?? production,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    platformEmail:
      e.PLATFORM_EMAIL_PROVIDER === "resend" && e.RESEND_API_KEY && e.PLATFORM_EMAIL_FROM
        ? { apiKey: e.RESEND_API_KEY, from: e.PLATFORM_EMAIL_FROM }
        : undefined,
    signup: {
      enabled: e.SIGNUP_ENABLED,
      allowedProducts: [...new Set(e.SIGNUP_PRODUCTS)],
      perIpPerHour: e.SIGNUP_PER_IP_PER_HOUR,
      perEmailPerDay: e.SIGNUP_PER_EMAIL_PER_DAY,
      termsVersion: e.SIGNUP_TERMS_VERSION,
      termsUrl: e.SIGNUP_TERMS_URL,
      appBaseUrl: e.APP_BASE_URL.replace(/\/+$/, ""),
    },
    marketplace: {
      searchPerMinute: e.MARKETPLACE_SEARCH_PER_MINUTE,
      submitPerHour: e.MARKETPLACE_SUBMIT_PER_HOUR,
    },
    ...overrides,
  };
}

/** Buffer.from() accepts malformed and truncated base64, so validate the exact key format at startup. */
function isSecretsKey(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}
