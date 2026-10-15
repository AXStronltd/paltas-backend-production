/*
 * A real PALTAS server on a random port with its own fresh database, plus helpers:
 *   - api: the typed client from @paltas/api-client (validates every response against the contracts)
 *   - raw(): send anything, including malformed requests
 *   - staff(): a signed-in PALTAS Super Admin
 *   - newOrg(): an organisation with a signed-in administrator
 *   - webhook(): a correctly signed payment event
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createClient, type PaltasClient } from "@paltas/api-client";
import type { Product, Role } from "@paltas/contracts";
import { buildApp, type App } from "../../dist/app.js";
import { loadConfig, type Config } from "../../dist/config.js";
import { connect } from "../../dist/db/database.js";
import { createUser } from "../../dist/core/identity/identity.service.js";
import { newTotpSecret, totp } from "../../dist/core/identity/totp.js";
import { signPayload } from "../../dist/core/payments/signature.js";
import type { ProductModule } from "../../dist/products/registry.js";
import { adminUrl, dbUrl, templateName } from "./global-setup.js";

export const TODAY = "2026-10-11";
export const WEBHOOK_SECRET = "whsec_test_" + randomBytes(16).toString("hex");

/** A signed-in person with the password they chose at first sign-in. */
export interface Person {
  api: PaltasClient;
  token: string;
  userId: string;
  email: string;
  password: string;
}

export interface TestServer {
  app: App;
  base: string;
  /** A client with no token. */
  api: PaltasClient;
  client(token?: string | null): PaltasClient;
  raw(
    method: string,
    path: string,
    body?: unknown,
    token?: string | null,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: any }>;
  staff(): Promise<{ api: PaltasClient; token: string; userId: string }>;
  login(email: string, password: string, code?: string): Promise<{ api: PaltasClient; token: string }>;
  newOrg(o?: {
    name?: string;
    product?: Product;
    plan?: string;
    trial?: boolean;
    currency?: string;
  }): Promise<{ orgId: string; admin: Person }>;
  addMember(orgId: string, adminApi: PaltasClient, role: Role, email?: string): Promise<Person>;
  webhook(
    event: Record<string, unknown>,
    opts?: { provider?: string; t?: number; signature?: string },
  ): Promise<{ status: number; body: any }>;
  sql<T = any>(query: string, params?: unknown[]): Promise<T[]>;
  setToday(d: string): void;
  close(): Promise<void>;
}

let counter = 0;

export async function startServer(
  o: { products?: ProductModule[]; config?: Partial<Config> } = {},
): Promise<TestServer> {
  const name = `paltas_test_${process.pid}_${++counter}_${randomBytes(3).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${templateName()}`);
  await admin.end();

  const config = loadConfig(
    {
      NODE_ENV: "test",
      DATABASE_URL: dbUrl(name),
      LOG_LEVEL: "silent",
      PALTAS_TODAY: TODAY,
      WEBHOOK_SECRET_TESTPAY: WEBHOOK_SECRET,
      LOGIN_RATE_LIMIT_PER_MINUTE: "1000",
    },
    o.config,
  );
  const db = connect(config.databaseUrl, 5);
  const app = await buildApp(config, { db, products: o.products ?? [], migrate: false });
  await app.server.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const client = (token?: string | null) =>
    createClient({ baseUrl: base, token: token ?? null, validateResponses: true });

  const raw: TestServer["raw"] = async (method, path, body, token, headers) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const txt = await res.text();
    let json: unknown = txt;
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch {
      /* keep text */
    }
    return { status: res.status, body: json };
  };

  const login = async (email: string, password: string, code?: string) => {
    const r = await client().identity.login({ body: { email, password, ...(code ? { code } : {}) } });
    return { api: client(r.token), token: r.token };
  };

  let staffCache: { email: string; password: string; secret: string; userId: string } | null = null;
  const staff = async () => {
    if (!staffCache) {
      const secret = newTotpSecret();
      const password = "Test-Staff-" + randomBytes(6).toString("hex");
      const email = `sa+${randomBytes(3).toString("hex")}@paltas.test`;
      const { id } = await createUser(db, {
        email,
        name: "Test Super Admin",
        password,
        staffRole: "super_admin",
        mfaSecretSealed: app.ctx.secrets.seal(secret),
      });
      staffCache = { email, password, secret, userId: id };
    }
    const s = await login(staffCache.email, staffCache.password, totp(staffCache.secret));
    return { ...s, userId: staffCache.userId };
  };

  /** Sign in a brand-new account: replace its temporary password first, as a real person must. */
  const firstLogin = async (email: string, temporary: string) => {
    const t = await login(email, temporary);
    const fresh = "Fresh-Password-" + randomBytes(6).toString("hex");
    await t.api.identity.changePassword({ body: { currentPassword: temporary, newPassword: fresh } });
    const me = await t.api.identity.me();
    return { ...t, userId: me.user.id, password: fresh };
  };

  const newOrg: TestServer["newOrg"] = async (opts = {}) => {
    const s = await staff();
    const email = `admin+${randomBytes(4).toString("hex")}@org.test`;
    const product = opts.product ?? "property";
    const r = await s.api.admin.createOrganisation({
      body: {
        name: opts.name ?? "Test Org " + randomBytes(4).toString("hex"),
        product,
        plan: opts.plan ?? (product === "developer" ? "DEV-STD" : "PM-STARTER"),
        country: "Kenya",
        currency: opts.currency ?? "KES",
        timezone: "Africa/Nairobi",
        trial: opts.trial ?? true,
        admin: { email, name: "Org Admin" },
      },
    });
    const a = await firstLogin(email, r.temporaryPassword as string);
    return { orgId: r.id, admin: { api: a.api, token: a.token, email, userId: a.userId, password: a.password } };
  };

  const addMember: TestServer["addMember"] = async (orgId, adminApi, role, email) => {
    const e = email ?? `${role}+${randomBytes(4).toString("hex")}@org.test`;
    const r = await adminApi.organisations.addMember({ params: { orgId }, body: { email: e, name: role, role } });
    const a = await firstLogin(e, r.temporaryPassword as string);
    return { api: a.api, token: a.token, userId: a.userId, email: e, password: a.password };
  };

  const webhook: TestServer["webhook"] = async (event, opts = {}) => {
    const body = JSON.stringify(event);
    const sig = opts.signature ?? signPayload(WEBHOOK_SECRET, body, opts.t ?? Math.floor(Date.now() / 1000));
    return raw("POST", `/api/v1/webhooks/payments/${opts.provider ?? "testpay"}`, body, null, {
      "X-Paltas-Signature": sig,
    });
  };

  return {
    app,
    base,
    api: client(),
    client,
    raw,
    staff,
    login,
    newOrg,
    addMember,
    webhook,
    sql: (q, p) => db.rows(q, p ?? []),
    setToday: (d) => app.clock.setToday(d),
    close: async () => {
      await app.close();
      await db.close();
      const a = new pg.Client({ connectionString: adminUrl() });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** Expect a call to fail with this HTTP status (and optionally this error code). Returns the error. */
export async function refused(
  p: Promise<unknown>,
  status: number,
  code?: string,
): Promise<{ status: number; code: string; message: string; details?: any }> {
  try {
    await p;
  } catch (e) {
    const err = e as { status: number; code: string; message: string; details?: unknown };
    if (err.status !== status || (code && err.code !== code)) {
      throw new Error(`Expected ${status}${code ? " " + code : ""}, got ${err.status} ${err.code}: ${err.message}`, {
        cause: e,
      });
    }
    return err as never;
  }
  throw new Error(`Expected the call to be refused with ${status}, but it succeeded`);
}
