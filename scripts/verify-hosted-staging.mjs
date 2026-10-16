// Opt-in hosted staging smoke test. Never points to production. Requires a Resend read key only to inspect actual delivery.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { connect } from "../server/dist/db/database.js";
if (process.env.PALTAS_RUN_HOSTED_STAGING !== "1")
  throw new Error(
    "Set PALTAS_RUN_HOSTED_STAGING=1 to create synthetic records and send verification emails on staging only",
  );
const stageUrl = new URL(process.env.PALTAS_STAGE_DATABASE_URL || "");
if (
  stageUrl.username !== "postgres.qpfxwqladmbsxoqdfcjj" ||
  stageUrl.hostname !== "aws-0-eu-west-1.pooler.supabase.com" ||
  stageUrl.searchParams.get("sslmode") !== "verify-full"
)
  throw new Error("Dedicated verified staging database required");
const base = "https://paltas-api-staging.onrender.com";
const db = connect(process.env.PALTAS_STAGE_DATABASE_URL, 1);
let n = 0;
const pass = (m) => {
  n++;
  console.log("PASS " + m);
};
const delay = (ms) => new Promise((r) => globalThis.setTimeout(r, ms));
async function api(method, path, body, token) {
  const r = await globalThis.fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: globalThis.AbortSignal.timeout(25000),
  });
  const data = await r.json();
  return { status: r.status, data };
}
try {
  let opts;
  for (let i = 0; i < 30; i++) {
    try {
      opts = (await api("GET", "/api/v1/public/signup-options")).data;
      if (opts.enabled && opts.termsVersion === "staging-2026-10-16") break;
    } catch {
      /* Retry while the staging deployment starts. */
    }
    await delay(5000);
  }
  assert(opts?.enabled);
  assert(opts.plans.every((p) => p.product === "property"));
  pass("Hosted registration opens for Property Management only with staging terms");
  const stamp = Date.now(),
    pw = randomBytes(24).toString("base64url") + "!aA4";
  const email = `supportpaltas+stage${stamp}@gmail.com`;
  const company = `PALTAS Synthetic Stage ${stamp}`;
  const body = {
    company,
    country: "United Kingdom",
    timezone: "Europe/London",
    product: "property",
    plan: "PM-GROWTH",
    adminName: "Staging Test Administrator",
    email,
    phone: "+447" + String(stamp).slice(-9),
    password: pw,
    terms: { accepted: true, version: opts.termsVersion },
  };
  assert.equal(
    (await api("POST", "/api/v1/public/signup", { ...body, terms: { accepted: false, version: opts.termsVersion } }))
      .status,
    400,
  );
  pass("Missing policy acceptance rejected");
  assert.equal(
    (await api("POST", "/api/v1/public/signup", { ...body, terms: { accepted: true, version: "outdated" } })).status,
    400,
  );
  pass("Outdated policy acceptance rejected");
  let r = await api("POST", "/api/v1/public/signup", body);
  assert.equal(r.status, 201);
  pass("Real hosted registration creates company");
  r = await api("POST", "/api/v1/auth/login", { email, password: pw });
  assert.equal(r.status, 200);
  const token = r.data.token;
  assert.equal(r.data.user.staff, false);
  pass("Secure login creates client account without staff privileges");
  const me = (await api("GET", "/api/v1/me", null, token)).data;
  const org = me.organisations.find((o) => o.name === company);
  assert(org);
  assert.equal(org.role, "org_admin");
  assert.equal(org.trials.find((t) => t.product === "property").daysLeft, 30);
  pass("Company membership and 30-day trial activated");
  const signup = await db.row("select terms_version,terms_accepted_at from org_signups where org_id=$1", [org.id]);
  assert.equal(signup.terms_version, opts.termsVersion);
  assert(signup.terms_accepted_at);
  pass("Policy version and acceptance timestamp persisted in Supabase");
  let msg;
  for (let i = 0; i < 36; i++) {
    msg = await db.row(
      "select status,provider_message_id from notifications where org_id=$1 and template_key='signup.verify' order by created_at desc limit 1",
      [org.id],
    );
    if (msg?.provider_message_id) break;
    await delay(5000);
  }
  assert(msg?.provider_message_id, "verification email not dispatched");
  assert(["queued", "sent"].includes(msg.status));
  pass("Hosted scheduler dispatched verification email through Resend");
  let emailRecord;
  for (let i = 0; i < 24; i++) {
    const rr = await globalThis.fetch("https://api.resend.com/emails/" + msg.provider_message_id, {
      headers: { Authorization: "Bearer " + process.env.PALTAS_RESEND_READ_KEY },
      signal: globalThis.AbortSignal.timeout(15000),
    });
    assert.equal(rr.status, 200);
    emailRecord = await rr.json();
    if (emailRecord.last_event === "delivered") break;
    await delay(5000);
  }
  assert.equal(emailRecord.last_event, "delivered");
  pass("Resend confirms verification email delivered to support Gmail alias");
  const content = String(emailRecord.html || "") + " " + String(emailRecord.text || "");
  const match = content.match(/https:\/\/paltas-staging\.netlify\.app\/verify-email#token=([A-Za-z0-9_-]+)/);
  assert(match, "delivered message lacks staging verification link");
  const verifyToken = match[1];
  r = await api("POST", "/api/v1/public/signup/verify", { token: verifyToken });
  assert.equal(r.status, 200);
  assert(r.data.verified);
  assert.notEqual((await api("POST", "/api/v1/public/signup/verify", { token: verifyToken })).status, 200);
  pass("Delivered verification link accepted once; replay rejected");
  const verified = (await api("GET", "/api/v1/me", null, token)).data.organisations.find((o) => o.id === org.id);
  assert.equal(verified.emailVerification, "verified");
  pass("Company email verification status persisted");
  r = await api(
    "POST",
    `/api/v1/orgs/${org.id}/property/properties`,
    { name: "Synthetic Staging Court", address: "Test address — no real tenant records" },
    token,
  );
  assert.equal(r.status, 201);
  const property = r.data;
  pass("Property created through hosted API");
  r = await api(
    "POST",
    `/api/v1/orgs/${org.id}/contacts`,
    { name: "Synthetic Tenant", types: ["tenant"], email: "tenant@example.invalid" },
    token,
  );
  assert.equal(r.status, 201);
  const contact = r.data.contact || r.data;
  pass("Tenant contact created through hosted API");
  assert(await db.row("select id from pm_properties where id=$1 and org_id=$2", [property.id, org.id]));
  assert(await db.row("select id from contacts where id=$1 and org_id=$2", [contact.id, org.id]));
  pass("Property and tenant records independently confirmed in Supabase PostgreSQL");
  assert.equal((await api("GET", `/api/v1/orgs/${org.id}/property/properties`)).status, 401);
  pass("Unauthenticated company access denied");
  assert.equal((await api("POST", "/api/v1/auth/logout", null, token)).status, 200);
  assert.equal((await api("GET", "/api/v1/me", null, token)).status, 401);
  pass("Logout revokes server session");
  r = await api("POST", "/api/v1/auth/login", { email, password: pw });
  assert.equal(r.status, 200);
  const token2 = r.data.token;
  const records = (await api("GET", `/api/v1/orgs/${org.id}/property/properties`, null, token2)).data;
  assert(records.properties.some((p) => p.id === property.id));
  pass("Property remains available after fresh login");
  const memberEmail = `supportpaltas+viewer${stamp}@gmail.com`;
  r = await api(
    "POST",
    `/api/v1/orgs/${org.id}/members`,
    { email: memberEmail, name: "Synthetic Read Only User", role: "viewer" },
    token2,
  );
  assert.equal(r.status, 201);
  const temporary = r.data.temporaryPassword;
  r = await api("POST", "/api/v1/auth/login", { email: memberEmail, password: temporary });
  assert.equal(r.status, 200);
  const viewer = r.data.token;
  assert.equal(
    (await api("POST", "/api/v1/me/password", { currentPassword: temporary, newPassword: pw }, viewer)).status,
    200,
  );
  assert.equal(
    (await api("POST", `/api/v1/orgs/${org.id}/property/properties`, { name: "Forbidden property" }, viewer)).status,
    403,
  );
  assert.equal(
    (
      await api(
        "POST",
        `/api/v1/orgs/${org.id}/members`,
        { email: "forbidden@example.invalid", role: "org_admin" },
        viewer,
      )
    ).status,
    403,
  );
  pass("Viewer cannot create properties or grant administrator access");
  const otherEmail = `supportpaltas+other${stamp}@gmail.com`;
  r = await api("POST", "/api/v1/public/signup", {
    ...body,
    company: `PALTAS Isolation ${stamp}`,
    email: otherEmail,
    phone: "+448" + String(stamp).slice(-9),
  });
  assert.equal(r.status, 201);
  r = await api("POST", "/api/v1/auth/login", { email: otherEmail, password: pw });
  assert.equal(r.status, 200);
  const otherToken = r.data.token;
  assert.equal(
    (await api("GET", `/api/v1/orgs/${org.id}/property/properties/${property.id}`, null, otherToken)).status,
    404,
  );
  assert.equal(
    (await api("POST", `/api/v1/orgs/${org.id}/property/properties`, { name: "Cross-company write" }, otherToken))
      .status,
    404,
  );
  assert.equal((await api("GET", `/api/v1/orgs/${org.id}/contacts/${contact.id}`, null, otherToken)).status, 404);
  pass("Second company cannot read or write first company property or tenant");
  console.log("HOSTED RESULT " + n + " checks passed");
} catch (e) {
  console.log("HOSTED TEST FAILED:", e.message?.replace(/Bearer\s+\S+/g, "[redacted]").slice(0, 350));
  process.exitCode = 1;
} finally {
  await db.close();
}
