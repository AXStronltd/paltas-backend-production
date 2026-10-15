// E-mail verification: only the token's hash is stored, the link is RECORDED in the outbox (never claimed as sent),
// it expires and works once, a new one replaces the old. The trial works at once; upgrading, paying and inviting
// members wait for a verified address; an address left unverified past the policy window suspends the trial
// (records kept) until it is verified.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contactWrite,
  dailyJobs,
  productRecords,
  productWrite,
  signUpAndIn,
  signupServer,
  verificationToken,
  type Account,
} from "./support/signup-fixture.js";
import { refused, TODAY, type TestServer } from "./support/test-server.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const INVALID = /not valid or has expired/;

describe("e-mail verification", () => {
  let S: TestServer;
  let a: Account;

  beforeAll(async () => {
    S = await signupServer();
    a = await signUpAndIn(S, "property");
  });
  afterAll(() => S.close());

  it("stores only the token's hash; the link is a recorded outbox message, not a sent one", async () => {
    const token = await verificationToken(S, a.email);
    const rows = await S.sql<{ token_hash: string; expires_at: string; notification_id: string }>(
      "SELECT token_hash, expires_at, notification_id FROM email_verifications WHERE email = $1",
      [a.email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(sha256(token));
    // 48 hours (policy.verifyLinkHours)
    expect(new Date(rows[0]!.expires_at).getTime() - Date.now()).toBeGreaterThan(47 * 3_600_000);
    const [n] = await S.sql<{ status: string; provider: string | null; sent_at: string | null; source: string }>(
      "SELECT status, provider, sent_at, source FROM notifications WHERE id = $1",
      [rows[0]!.notification_id],
    );
    expect(n).toEqual({ status: "recorded", provider: null, sent_at: null, source: "platform" });
    // the dispatch job hands it to the test adapter at most — still not "sent"
    await S.app.core.notifications.dispatchPending();
    const [after] = await S.sql<{ status: string }>("SELECT status FROM notifications WHERE id = $1", [
      rows[0]!.notification_id,
    ]);
    expect(after!.status).not.toBe("sent");
    // the raw token is nowhere else in the database (only inside the message body that carries the link)
    const dump = await S.sql<{ t: string }>("SELECT row_to_json(v)::text AS t FROM email_verifications v");
    expect(dump.some((r) => r.t.includes(token))).toBe(false);
  });

  it("the trial is usable at once; upgrading, paying and inviting members wait for verification", async () => {
    await productWrite(a, 1);
    await contactWrite(a, 1);
    const p = { orgId: a.orgId };
    // one at a time (each call starts only when it is awaited)
    const blocked = [
      () => a.api.organisations.addMember({ params: p, body: { email: "team@business.test", role: "accountant" } }),
      () => a.api.subscriptions.changePlan({ params: p, body: { plan: "PM-GROWTH", confirm: "CONFIRM" } }),
      () => a.api.subscriptions.buyAddon({ params: p, body: { module: "crm", confirm: "CONFIRM" } }),
      () => a.api.subscriptions.buyAllowance({ params: p, body: { confirm: "CONFIRM" } }),
      () =>
        a.api.subscriptions.addProduct({
          params: p,
          body: { product: "hotel", plan: "HOTEL-STD", confirm: "CONFIRM" },
        }),
      () =>
        a.api.subscriptions.upgrade({
          params: p,
          body: { plan: "PM-STARTER", frequency: "monthly", payment: "provider", confirm: "CONFIRM" },
        }),
    ];
    for (const call of blocked) {
      const r = await refused(call(), 403, "FORBIDDEN");
      expect(r.details.emailVerificationRequired).toBe(true);
    }
    expect(await S.sql("SELECT 1 FROM billing_invoices WHERE org_id = $1", [a.orgId])).toEqual([]);
    expect((await a.api.organisations.listMembers({ params: p })).members).toHaveLength(1);
  });

  it("a new link replaces the old; a link works once; an expired or made-up link is refused the same way", async () => {
    const old = await verificationToken(S, a.email);
    const again = await a.api.signup.resend();
    expect(again.delivery).toMatch(/Recorded in the PALTAS outbox.*nothing is sent/);
    const fresh = await verificationToken(S, a.email);
    expect(fresh).not.toBe(old);
    for (const t of [old, "x".repeat(43)])
      expect((await refused(S.api.signup.verify({ body: { token: t } }), 400)).message).toMatch(INVALID);
    // expiry
    await S.sql("UPDATE email_verifications SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [
      sha256(fresh),
    ]);
    expect((await refused(S.api.signup.verify({ body: { token: fresh } }), 400)).message).toMatch(INVALID);
    await a.api.signup.resend();
    const good = await verificationToken(S, a.email);
    expect(await S.api.signup.verify({ body: { token: good } })).toEqual({ verified: true });
    expect((await refused(S.api.signup.verify({ body: { token: good } }), 400)).message).toMatch(INVALID);
    await refused(a.api.signup.resend(), 409);
    // now the team can be invited
    const m = await a.api.organisations.addMember({
      params: { orgId: a.orgId },
      body: { email: "team@business.test", role: "accountant" },
    });
    expect(m.member.role).toBe("accountant");
    // a staff-onboarded administrator has nothing to verify
    const staffOrg = await S.newOrg({ name: "Onboarded By Staff" });
    await refused(staffOrg.admin.api.signup.resend(), 404);
    expect((await staffOrg.admin.api.identity.me()).organisations[0]!.emailVerification).toBe("not_required");
  });

  it("unverified past the policy window: the trial is suspended (records kept) until the address is verified", async () => {
    const late = await signUpAndIn(S, "hotel");
    await productWrite(late, 1);
    await dailyJobs(S, "2026-10-18"); // 7 days: still inside the window
    expect((await late.api.subscriptions.entitlements({ params: { orgId: late.orgId }, query: {} })).status).toBe(
      "trial",
    );
    const r = await dailyJobs(S, "2026-10-19");
    expect(r.summary).toMatch(/[1-9]\d* unverified sign-up\(s\) suspended/);
    const e = await late.api.subscriptions.entitlements({ params: { orgId: late.orgId }, query: {} });
    expect([e.status, e.usable]).toEqual(["suspended", false]);
    await refused(productWrite(late, 2), 402, "SUBSCRIPTION_INACTIVE");
    expect(await productRecords(late)).toBe(1);
    const [msg] = await S.sql<{ status: string }>(
      "SELECT status FROM notifications WHERE org_id = $1 AND template_key = 'signup.unverified'",
      [late.orgId],
    );
    expect(msg!.status).toBe("recorded");
    // the verified organisation was not touched
    expect((await a.api.subscriptions.entitlements({ params: { orgId: a.orgId }, query: {} })).status).toBe("trial");
    // the person can still sign in, ask for a link and verify: the trial works again
    await late.api.signup.resend();
    await S.api.signup.verify({ body: { token: await verificationToken(S, late.email) } });
    const back = await late.api.subscriptions.entitlements({ params: { orgId: late.orgId }, query: {} });
    expect([back.status, back.usable, back.trial?.trialEnds]).toEqual(["trial", true, "2026-11-10"]);
    await contactWrite(late, 1);
    await dailyJobs(S, "2026-10-20");
    expect((await late.api.subscriptions.entitlements({ params: { orgId: late.orgId }, query: {} })).status).toBe(
      "trial",
    );
    const actions = (await late.api.organisations.listAudit({ params: { orgId: late.orgId }, query: {} })).entries.map(
      (x) => x.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        "Self-service sign-up — organisation created",
        "Trial started",
        "Trial suspended — e-mail address not verified",
        "E-mail address verified",
        "Suspension lifted — e-mail address verified",
      ]),
    );
    S.setToday(TODAY);
  });
});
