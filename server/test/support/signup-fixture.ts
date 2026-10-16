/*
 * Helpers for the self-service sign-up and trial tests: a server with sign-up switched on and the real products,
 * signing a business up through the public endpoint, reading the verification link from the outbox (the only place
 * it exists in clear), signing in, running the platform jobs for a given day, and one real write per product.
 */
import { randomBytes } from "node:crypto";
import type { PaltasClient } from "@paltas/api-client";
import type { Product } from "@paltas/contracts";
import type { Config } from "../../dist/config.js";
import { PRODUCTS } from "../../dist/products/index.js";
import { SALE } from "./agency-fixture.js";
import { TAX } from "./hotel-fixture.js";
import { DEFAULTS } from "./platform-fixtures.js";
import { startServer, type TestServer } from "./test-server.js";

export const ALL_PRODUCTS: Product[] = ["property", "developer", "hotel", "security", "agency"];
/** The Standard plan of each product (from the catalogue seed and the product migrations). */
export const STANDARD: Record<Product, string> = {
  property: "PM-STARTER",
  developer: "DEV-STD",
  hotel: "HOTEL-STD",
  security: "SEC-STD",
  agency: "AGENCY-STD",
};
export const TERMS = DEFAULTS.signup.termsVersion;

export function signupServer(signup: Partial<Config["signup"]> = {}, more: Partial<Config> = {}) {
  return startServer({
    products: PRODUCTS,
    config: {
      signup: { ...DEFAULTS.signup, enabled: true, perIpPerHour: 1000, perEmailPerDay: 50, ...signup },
      ...more,
    },
  });
}

const hex = (n = 4) => randomBytes(n).toString("hex");
export const uniquePhone = () => "+2547" + String(Math.floor(10_000_000 + Math.random() * 89_999_999));

export interface SignupInput {
  company: string;
  country: string;
  timezone: string;
  product: Product;
  plan: string;
  adminName: string;
  email: string;
  phone: string;
  password: string;
  terms: { accepted: true; version: string };
}

export function signupBody(product: Product, o: Partial<SignupInput> = {}): SignupInput {
  return {
    company: `Trial Business ${hex()}`,
    country: "Kenya",
    timezone: "Africa/Nairobi",
    product,
    plan: STANDARD[product],
    adminName: "Amina Yusuf",
    email: `owner+${hex()}@business.test`,
    phone: uniquePhone(),
    password: "Chosen-Password-" + hex(),
    terms: { accepted: true, version: TERMS },
    ...o,
  };
}

/** POST /api/v1/public/signup as anyone on the internet would (raw, so the exact answer can be compared). */
export function postSignup(S: TestServer, body: unknown) {
  return S.raw("POST", "/api/v1/public/signup", body);
}

/** The newest verification link recorded in the outbox for this address → its token. */
export async function verificationToken(S: TestServer, email: string): Promise<string> {
  const [n] = await S.sql<{ body: string }>(
    `SELECT body FROM notifications WHERE template_key = 'signup.verify' AND to_address = lower($1)
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [email],
  );
  const m = /verify-email[?#]token=([A-Za-z0-9_-]+)/.exec(n?.body ?? "");
  if (!m?.[1]) throw new Error("No verification link recorded for " + email);
  return m[1];
}

export interface Account {
  api: PaltasClient;
  token: string;
  orgId: string;
  email: string;
  password: string;
  product: Product;
}

/** Sign a business up and sign its administrator in with the password they chose. */
export async function signUpAndIn(S: TestServer, product: Product, o: Partial<SignupInput> = {}): Promise<Account> {
  const body = signupBody(product, o);
  const r = await postSignup(S, body);
  if (r.status !== 201) throw new Error(`Sign-up refused: ${r.status} ${JSON.stringify(r.body)}`);
  const s = await S.login(body.email, body.password);
  const me = await s.api.identity.me();
  const org = me.organisations[0];
  if (!org) throw new Error("Sign-up created no organisation for " + body.email);
  return { ...s, orgId: org.id, email: body.email, password: body.password, product };
}

/** Run a platform job's handler for today's (pinned) date, as the scheduler would. */
export async function runJob(S: TestServer, key: string) {
  const def = S.app.core.scheduler.definitions().find((d) => d.key === key);
  if (!def) throw new Error("No job " + key);
  const today = S.app.clock.today();
  return def.run({
    runId: "test-" + hex(),
    jobId: "test",
    key,
    orgId: null,
    targetId: null,
    period: today + "T00:20",
    scheduledFor: new Date().toISOString(),
    localDate: today,
    timezone: "UTC",
    trigger: "schedule",
    attempt: 1,
    db: S.app.core.db,
  });
}

/** One day of the platform's daily jobs: expiry and renewals, then the trial lifecycle. */
export async function dailyJobs(S: TestServer, day: string) {
  S.setToday(day);
  await runJob(S, "platform.subscriptions.renewals");
  return runJob(S, "platform.trials.lifecycle");
}

/** One real write in each product's own workspace (its first record). */
export function productWrite(a: Account, n: number): Promise<unknown> {
  const params = { orgId: a.orgId };
  switch (a.product) {
    case "property":
      return a.api.property.createProperty({ params, body: { name: `Trial Court ${n}` } });
    case "developer":
      return a.api.development.createProject({ params, body: { name: `Trial Heights ${n}` } });
    case "hotel":
      return a.api.hotel.createProperty({
        params,
        body: { name: `Trial Hotel ${n}`, country: "Kenya", city: "Mombasa", timezone: "Africa/Nairobi", tax: TAX },
      });
    case "security":
      return a.api.security.createClient({
        params,
        body: { name: `Trial Client ${n}`, contactName: "Daniel Kariuki", paymentTermsDays: 30 },
      });
    case "agency":
      return a.api.agency.createListing({ params, body: { ...SALE, title: `Trial listing number ${n}` } });
  }
}

/** How many of the records productWrite makes are in the workspace (read access only). */
export async function productRecords(a: Account): Promise<number> {
  const params = { orgId: a.orgId };
  switch (a.product) {
    case "property":
      return (await a.api.property.listProperties({ params })).properties.length;
    case "developer":
      return (await a.api.development.listProjects({ params })).projects.length;
    case "hotel":
      return (await a.api.hotel.listProperties({ params })).properties.length;
    case "security":
      return (await a.api.security.listClients({ params })).clients.length;
    case "agency":
      return (await a.api.agency.listListings({ params, query: {} })).listings.length;
  }
}

/** A contact in the ONE shared contact store (a core write every product's workspace makes). */
export function contactWrite(a: Account, n: number) {
  return a.api.contacts.createContact({
    params: { orgId: a.orgId },
    body: { name: `Trial Contact ${n}`, types: ["prospect"] },
  });
}
