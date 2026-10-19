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
  STRIPE_ENABLED: Bool.default(false),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  /** Dedicated account identity; verified through Stripe before collection. */
  STRIPE_ACCOUNT_ID: z
    .string()
    .regex(/^acct_[A-Za-z0-9]+$/)
    .or(z.literal(""))
    .default(""),
  /** JSON array of {planId,currency,priceId}; server-owned, approved regional catalogue prices only. */
  STRIPE_PRICE_MAP: z.string().default("[]"),
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
  SIGNUP_REQUIRE_PROFILE: Bool.default(false),
  SIGNUP_PLAN_IDS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  PM_DOCUMENT_FILE_UPLOADS_ENABLED: Bool.default(true),
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
  /** Sign-up requests per caller address per hour, and per e-mail address per day (also verification messages). */
  SIGNUP_PER_IP_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(10),
  SIGNUP_PER_EMAIL_PER_DAY: z.coerce.number().int().min(1).max(100).default(3),
  /** The version of the PALTAS terms a sign-up must accept (the published terms document). */
  SIGNUP_TERMS_VERSION: z.string().trim().min(1).max(40).default("2026-10"),
  SIGNUP_TERMS_URL: z.union([z.literal(""), z.url()]).default(""),
  /** Where the verification link points (the front end's verification page, which posts the token). */
  APP_BASE_URL: z.url().default("http://127.0.0.1:8080"),
  /** The public sign-up options (plans, terms): requests per minute per address, and browser cache life. */
  PUBLIC_READ_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  PUBLIC_CACHE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
  /** Self-service password reset: link life (minutes) and request limits. */
  PASSWORD_RESET_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
  PASSWORD_RESET_PER_IP_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(20),
  PASSWORD_RESET_PER_ACCOUNT_PER_HOUR: z.coerce.number().int().min(1).max(100).default(3),
  /**
   * PALTAS's own e-mail (verification, password reset, trial notices) — core/notifications/email-providers.ts.
   * none, or a provider without its credentials = messages are recorded only, never sent; the server still starts.
   */
  PLATFORM_EMAIL_PROVIDER: z
    .enum(["none", "smtp", "resend", "postmark", "sendgrid"])
    .or(z.literal("").transform(() => "none" as const))
    .default("none"),
  /** The one sending mailbox ("PALTAS <supportpaltas@gmail.com>"); its address is also the reply-to and help contact. */
  PLATFORM_EMAIL_FROM: z.string().trim().default("PALTAS <supportpaltas@gmail.com>"),
  /** SMTP (PLATFORM_EMAIL_PROVIDER=smtp): e.g. smtp.gmail.com, 465 (implicit TLS) or 587 (STARTTLS), the account and
   * its app password. SMTP_SECURE overrides the TLS mode (default: implicit TLS on 465, STARTTLS otherwise). */
  SMTP_HOST: z.string().trim().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  SMTP_SECURE: OptionalBool,
  SMTP_USER: z.string().trim().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** HTTPS e-mail APIs: the key of the provider chosen in PLATFORM_EMAIL_PROVIDER. */
  RESEND_API_KEY: z.string().trim().optional(),
  POSTMARK_SERVER_TOKEN: z.string().trim().optional(),
  SENDGRID_API_KEY: z.string().trim().optional(),
  /** Verifies the provider's delivery webhook: Resend signing secret (whsec_…), Postmark "user:password" of the
   * webhook's basic auth, or SendGrid's verification public key (base64). */
  PLATFORM_EMAIL_WEBHOOK_SECRET: z.string().optional(),
  /** The provider's API address. Only for tests against a local fake server; the default is the provider's own. */
  PLATFORM_EMAIL_API_URL: z
    .url()
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

const MB = 1024 * 1024;

/** A key used only outside production so local set-ups work without configuration. Never use it for real data. */
const DEVELOPMENT_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");

export interface Config {
  pmDocumentFileUploadsEnabled?: boolean;
  env: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  databasePoolSize: number;
  billingMode: "provider" | "simulated";
  stripe?: {
    enabled: boolean;
    accountId?: string;
    secretKey: string;
    webhookSecret: string;
    prices: { planId: string; currency: string; priceId: string }[];
  };
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
  /** Public read-only answers (signup.options): per-address limit and Cache-Control max-age. */
  publicRead: { perMinute: number; cacheSeconds: number };
  email: EmailSettings;
  passwordReset: { minutes: number; perIpPerHour: number; perAccountPerHour: number };
}

export interface EmailSettings {
  /** null = no provider configured (or its credentials are missing): messages stay "recorded — not sent". */
  provider: "smtp" | "resend" | "postmark" | "sendgrid" | null;
  /** Why the chosen provider is not in use (e.g. SMTP_PASSWORD not entered yet), for the logs and the report. */
  notConfigured: string | null;
  apiKey: string | null;
  smtp: { host: string; port: number; secure: boolean; user: string; password: string } | null;
  /** PLATFORM_EMAIL_FROM: display name and address. */
  fromName: string;
  fromAddress: string;
  webhookSecret: string | null;
  apiUrl: string | null;
}

/** "Name <address>" or a bare address. */
export function parseMailbox(raw: string): { name: string; address: string } | null {
  const m = /^\s*(?:"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+\.[^<>\s]+)>|([^<>\s]+@[^<>\s]+\.[^<>\s]+))\s*$/.exec(raw);
  if (!m) return null;
  return { name: (m[1] ?? "").trim(), address: (m[2] ?? m[3] ?? "").toLowerCase() };
}

export interface SignupSettings {
  enabled: boolean;
  requireProfile?: boolean;
  allowedPlanIds?: string[];
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
  if (e.SECRETS_KEY && !isSecretsKey(e.SECRETS_KEY)) {
    throw new Error("SECRETS_KEY must be exactly 32 bytes encoded as canonical base64");
  }
  if (production && e.PALTAS_TODAY) throw new Error("PALTAS_TODAY must not be set in production");
  if (production && e.BILLING_MODE === "simulated") throw new Error("BILLING_MODE=simulated is refused in production");
  if (production && !e.SECRETS_KEY) throw new Error("SECRETS_KEY is required in production");
  if (production && e.SIGNUP_ENABLED && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(e.APP_BASE_URL))
    throw new Error("APP_BASE_URL must be the public front-end address in production while SIGNUP_ENABLED is on");

  // A missing or incomplete e-mail set-up is never an error: the live API must still start. Messages then stay
  // "recorded — not sent", and production sign-up stays closed until a provider is in use (signup.service).
  const chosen = e.PLATFORM_EMAIL_PROVIDER === "none" ? null : e.PLATFORM_EMAIL_PROVIDER;
  const from = parseMailbox(e.PLATFORM_EMAIL_FROM);
  const apiKey =
    (chosen === "resend"
      ? e.RESEND_API_KEY
      : chosen === "postmark"
        ? e.POSTMARK_SERVER_TOKEN
        : chosen === "sendgrid"
          ? e.SENDGRID_API_KEY
          : undefined) || null;
  const smtp =
    e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASSWORD
      ? {
          host: e.SMTP_HOST,
          port: e.SMTP_PORT,
          secure: e.SMTP_SECURE ?? e.SMTP_PORT === 465,
          user: e.SMTP_USER,
          password: e.SMTP_PASSWORD,
        }
      : null;
  const KEY_NAME = { resend: "RESEND_API_KEY", postmark: "POSTMARK_SERVER_TOKEN", sendgrid: "SENDGRID_API_KEY" };
  const notConfigured = !chosen
    ? null
    : !from
      ? 'PLATFORM_EMAIL_FROM is not a mailbox, e.g. "PALTAS <supportpaltas@gmail.com>"'
      : chosen === "smtp"
        ? smtp
          ? null
          : "PLATFORM_EMAIL_PROVIDER=smtp needs SMTP_HOST, SMTP_USER and SMTP_PASSWORD"
        : apiKey
          ? null
          : `PLATFORM_EMAIL_PROVIDER=${chosen} needs ${KEY_NAME[chosen]}`;
  if (production && e.PLATFORM_EMAIL_API_URL && !e.PLATFORM_EMAIL_API_URL.startsWith("https://"))
    throw new Error("PLATFORM_EMAIL_API_URL must be https in production (it is for tests against a local fake server)");

  const webhookSecrets = Object.fromEntries(
    Object.entries(env)
      .filter(([k, v]) => k.startsWith("WEBHOOK_SECRET_") && v)
      .map(([k, v]) => [k.slice("WEBHOOK_SECRET_".length).toLowerCase(), v as string]),
  );

  if (
    e.STRIPE_ENABLED &&
    /^(sk|rk)_live_/.test(e.STRIPE_SECRET_KEY) &&
    new URL(e.APP_BASE_URL).hostname !== "paltas.io"
  )
    throw new Error("Stripe live keys are refused outside the production PALTAS origin");
  if (
    e.STRIPE_ENABLED &&
    new URL(e.APP_BASE_URL).hostname === "paltas.io" &&
    !/^(sk|rk)_live_/.test(e.STRIPE_SECRET_KEY)
  )
    throw new Error("Production Stripe collection requires a live key");
  const stripePrices = z
    .array(
      z.object({
        planId: z.string().min(1),
        currency: z.string().regex(/^[A-Z]{3}$/),
        priceId: z.string().regex(/^price_[A-Za-z0-9]+$/),
      }),
    )
    .parse(JSON.parse(e.STRIPE_PRICE_MAP));
  if (
    e.STRIPE_ENABLED &&
    (!/^(sk|rk)_(test|live)_/.test(e.STRIPE_SECRET_KEY) ||
      !e.STRIPE_ACCOUNT_ID ||
      !e.STRIPE_WEBHOOK_SECRET.startsWith("whsec_") ||
      !stripePrices.length)
  )
    throw new Error("Stripe requires an account ID, secret key, webhook secret and approved price mappings");
  return {
    stripe: {
      enabled: e.STRIPE_ENABLED,
      accountId: e.STRIPE_ACCOUNT_ID,
      secretKey: e.STRIPE_SECRET_KEY,
      webhookSecret: e.STRIPE_WEBHOOK_SECRET,
      prices: stripePrices,
    },
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
    pmDocumentFileUploadsEnabled: e.PM_DOCUMENT_FILE_UPLOADS_ENABLED,
    signup: {
      enabled: e.SIGNUP_ENABLED,
      requireProfile: e.SIGNUP_REQUIRE_PROFILE,
      allowedPlanIds: e.SIGNUP_PLAN_IDS,
      allowedProducts: [...new Set(e.SIGNUP_PRODUCTS)],
      perIpPerHour: e.SIGNUP_PER_IP_PER_HOUR,
      perEmailPerDay: e.SIGNUP_PER_EMAIL_PER_DAY,
      termsVersion: e.SIGNUP_TERMS_VERSION,
      termsUrl: e.SIGNUP_TERMS_URL,
      appBaseUrl: e.APP_BASE_URL.replace(/\/+$/, ""),
    },
    publicRead: { perMinute: e.PUBLIC_READ_RATE_LIMIT_PER_MINUTE, cacheSeconds: e.PUBLIC_CACHE_SECONDS },
    passwordReset: {
      minutes: e.PASSWORD_RESET_MINUTES,
      perIpPerHour: e.PASSWORD_RESET_PER_IP_PER_HOUR,
      perAccountPerHour: e.PASSWORD_RESET_PER_ACCOUNT_PER_HOUR,
    },
    email: {
      provider: chosen && !notConfigured ? chosen : null,
      notConfigured,
      apiKey,
      smtp,
      fromName: from?.name || "PALTAS",
      fromAddress: from?.address ?? "",
      webhookSecret: e.PLATFORM_EMAIL_WEBHOOK_SECRET?.trim() || null,
      apiUrl: e.PLATFORM_EMAIL_API_URL?.replace(/\/+$/, "") ?? null,
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
