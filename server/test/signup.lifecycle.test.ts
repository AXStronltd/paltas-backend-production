// The same self-service journey for EACH of the five products, on one timeline, with the platform jobs run day by
// day: sign up → trial → write allowed → reminders (T-10, T-7, T-3, T-1) → expiry → write refused (records kept,
// export allowed) → upgrade → PALTAS staff confirm the bank transfer → active → write allowed. Every product must
// show exactly the same days, reminders and expiry.
import type { Product } from "@paltas/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALL_PRODUCTS,
  contactWrite,
  dailyJobs,
  productRecords,
  productWrite,
  signUpAndIn,
  signupServer,
  STANDARD,
  verificationToken,
  type Account,
} from "./support/signup-fixture.js";
import { refused, TODAY, type TestServer } from "./support/test-server.js";

const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1))
    out.push(d.toISOString().slice(0, 10));
  return out;
};

describe("one trial journey, identical for every product", () => {
  let S: TestServer;
  let sa: Awaited<ReturnType<TestServer["staff"]>>;
  const acc = {} as Record<Product, Account>;
  /** What each product went through, compared across products at the end. */
  const seen = {} as Record<Product, Record<string, unknown>>;
  const ent = (a: Account) =>
    a.api.subscriptions.entitlements({ params: { orgId: a.orgId }, query: { product: a.product } });

  beforeAll(async () => {
    S = await signupServer();
    sa = await S.staff();
    for (const p of ALL_PRODUCTS) {
      acc[p] = await signUpAndIn(S, p);
      seen[p] = {};
    }
  });
  afterAll(() => S.close());

  it("day 0: every sign-up is a usable trial from the one policy, and the product can be used at once", async () => {
    for (const p of ALL_PRODUCTS) {
      const a = acc[p];
      const e = await ent(a);
      expect([e.product, e.status, e.usable, e.plan]).toEqual([p, "trial", true, STANDARD[p]]);
      seen[p].day0 = e.trial;
      const me = await a.api.identity.me();
      expect(me.user.staff).toBe(false);
      expect(me.organisations[0]!.role).toBe("org_admin");
      expect(me.organisations[0]!.emailVerification).toBe("required");
      expect(me.organisations[0]!.trials).toEqual([{ product: p, ...e.trial }]);
      // the product's own workspace and the shared contact store both accept changes during the trial
      await productWrite(a, 1);
      await contactWrite(a, 1);
      expect(await productRecords(a)).toBe(1);
    }
    expect(seen.property.day0).toEqual({
      phase: "trial",
      trialEnds: "2026-11-10",
      graceEnds: "2026-11-10",
      daysLeft: 30,
      graceDaysLeft: 0,
    });
  });

  it("upgrading waits for a verified e-mail address; the link from the outbox verifies it", async () => {
    for (const p of ALL_PRODUCTS) {
      const a = acc[p];
      const r = await refused(
        a.api.subscriptions.upgrade({
          params: { orgId: a.orgId },
          body: { plan: STANDARD[p], frequency: "monthly", payment: "bank_transfer", confirm: "CONFIRM" },
        }),
        403,
        "FORBIDDEN",
      );
      expect(r.details.emailVerificationRequired).toBe(true);
      await S.api.signup.verify({ body: { token: await verificationToken(S, a.email) } });
      expect((await a.api.identity.me()).organisations[0]!.emailVerification).toBe("verified");
    }
  });

  it("time passes: reminders at T-10, T-7, T-3 and T-1, then read-only without extra grace", async () => {
    const reminders = async (a: Account) =>
      (
        await S.sql<{ source_ref: string }>(
          "SELECT source_ref FROM notifications WHERE org_id = $1 AND template_key = 'trial.reminder' ORDER BY source_ref",
          [a.orgId],
        )
      ).map((r) => r.source_ref.split(":")[2]);
    for (const day of days("2026-10-12", "2026-11-19")) {
      await dailyJobs(S, day);
      if (day === "2026-11-03") await dailyJobs(S, day); // the same day twice: nothing recorded twice
      for (const p of ALL_PRODUCTS) {
        const e = await ent(acc[p]);
        (seen[p].timeline ??= []) as unknown[];
        (seen[p].timeline as unknown[]).push([day, e.status, e.usable, e.trial?.phase, e.trial?.daysLeft]);
        if (day === "2026-11-12") {
          // trial has ended: changes are refused immediately, with records retained
          expect([e.status, e.usable, e.trial?.phase, e.trial?.graceDaysLeft]).toEqual([
            "expired",
            false,
            "expired",
            0,
          ]);
          await refused(contactWrite(acc[p], 2), 402, "SUBSCRIPTION_INACTIVE");
        }
      }
    }
    for (const p of ALL_PRODUCTS) {
      seen[p].reminders = await reminders(acc[p]);
      const ended = await S.sql("SELECT 1 FROM notifications WHERE org_id = $1 AND template_key = 'trial.ended'", [
        acc[p].orgId,
      ]);
      seen[p].ended = ended.length;
      const statuses = await S.sql<{ status: string }>(
        "SELECT DISTINCT status FROM notifications WHERE org_id = $1 AND template_key LIKE 'trial.%'",
        [acc[p].orgId],
      );
      // recorded in the outbox, never "sent" (no e-mail provider is connected)
      expect(statuses.every((s) => s.status === "recorded")).toBe(true);
    }
    expect(seen.property.reminders).toEqual(["2026-10-31", "2026-11-03", "2026-11-07", "2026-11-09"]);
    expect(seen.property.ended).toBe(1);
    const tl = seen.property.timeline as [string, string, boolean, string, number][];
    expect(tl.find((x) => x[0] === "2026-11-10")).toEqual(["2026-11-10", "trial", true, "trial", 0]);
    expect(tl.find((x) => x[0] === "2026-11-17")).toEqual(["2026-11-17", "expired", false, "expired", 0]);
    expect(tl.find((x) => x[0] === "2026-11-18")).toEqual(["2026-11-18", "expired", false, "expired", 0]);
  });

  it("expired: writes are refused, every record is kept and readable, and the data can be exported", async () => {
    for (const p of ALL_PRODUCTS) {
      const a = acc[p];
      const [sub] = await S.sql<{ status: string }>("SELECT status FROM subscriptions WHERE org_id = $1", [a.orgId]);
      expect(sub!.status).toBe("expired");
      await refused(productWrite(a, 2), 402, "SUBSCRIPTION_INACTIVE");
      await refused(contactWrite(a, 3), 402, "SUBSCRIPTION_INACTIVE");
      expect(await productRecords(a)).toBe(1);
      expect((await a.api.contacts.listContacts({ params: { orgId: a.orgId }, query: {} })).contacts.length).toBe(1);
      const x = await S.raw(
        "GET",
        `/api/v1/orgs/${a.orgId}/export?reason=${encodeURIComponent("Keep a copy after the trial")}`,
        undefined,
        a.token,
      );
      expect(x.status).toBe(200);
      expect(x.body.organisation.id).toBe(a.orgId);
      expect(x.body.tables.contacts.length).toBe(1);
    }
  });

  it("upgrade: an invoice from the catalogue price; active ONLY after PALTAS staff confirm the bank transfer", async () => {
    for (const p of ALL_PRODUCTS) {
      const a = acc[p];
      const opts = await a.api.subscriptions.upgradeOptions({ params: { orgId: a.orgId }, query: { product: p } });
      const std = opts.plans.find((x) => x.id === STANDARD[p])!;
      expect([opts.status, opts.emailVerified, std.frequencies, std.contactSales]).toEqual([
        "expired",
        true,
        ["monthly"],
        false,
      ]);
      const [cat] = await S.sql<{ base_minor: number }>("SELECT base_minor FROM catalogue_plans WHERE id = $1", [
        STANDARD[p],
      ]);
      expect(std.price!.amountMinor).toBe(cat!.base_minor);
      await refused(
        a.api.subscriptions.upgrade({
          params: { orgId: a.orgId },
          body: { plan: STANDARD[p], frequency: "yearly", payment: "bank_transfer", confirm: "CONFIRM" },
        }),
        400,
      );
      const up = await a.api.subscriptions.upgrade({
        params: { orgId: a.orgId },
        body: { plan: STANDARD[p], frequency: "monthly", payment: "bank_transfer", confirm: "CONFIRM" },
      });
      expect(up.invoice!.netMinor).toBe(cat!.base_minor);
      expect(up.payment.reference).toBe(up.invoice!.id);
      // a submitted form changes nothing: still expired, still read-only
      expect((await ent(a)).status).toBe("expired");
      await refused(contactWrite(a, 4), 402, "SUBSCRIPTION_INACTIVE");
      const waiting = await sa.api.admin.listUpgrades({ query: { status: "awaiting" } });
      expect(waiting.upgrades.find((u) => u.invoice.id === up.invoice!.id)?.method).toBe("bank_transfer");
      const paid = await sa.api.admin.recordReceipt({
        params: { invoiceId: up.invoice!.id },
        body: { ref: `BANK-${p.toUpperCase()}-0001`, reason: "Bank transfer seen on the PALTAS statement" },
      });
      expect(paid.result).toMatch(/^Applied/);
      const e = await ent(a);
      seen[p].after = [e.status, e.usable, e.trial, e.plan];
      await contactWrite(a, 5);
      expect(await productRecords(a)).toBe(1);
      expect((await a.api.contacts.listContacts({ params: { orgId: a.orgId }, query: {} })).contacts.length).toBe(2);
    }
    expect(seen.property.after).toEqual(["active", true, null, "PM-STARTER"]);
  });

  it("every product went through exactly the same days, reminders and expiry", () => {
    const strip = (x: Record<string, unknown>) => ({ ...x, after: (x.after as unknown[]).slice(0, 3) });
    for (const p of ALL_PRODUCTS) expect(strip(seen[p])).toEqual(strip(seen.property));
    expect(TODAY).toBe("2026-10-11");
  });
});

describe("existing trial promises survive policy changes", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await signupServer();
  });
  afterAll(() => S.close());
  it("keeps a granted grace period while new trials expire without extra grace", async () => {
    const staff = await S.staff();
    const current = await staff.api.admin.trialPolicy();
    const { version: _v, updatedAt: _u, atExpiry: _a, keepRecords: _k, ...settings } = current.policy;
    await staff.api.admin.updateTrialPolicy({
      body: { ...settings, graceDays: 7, reason: "Legacy trial terms for regression" },
    });
    const legacy = await signUpAndIn(S, "property");
    await S.api.signup.verify({ body: { token: await verificationToken(S, legacy.email) } });
    await staff.api.admin.updateTrialPolicy({
      body: { ...settings, graceDays: 0, reason: "New trials end after thirty days" },
    });
    const fresh = await signUpAndIn(S, "hotel");
    await S.api.signup.verify({ body: { token: await verificationToken(S, fresh.email) } });
    await dailyJobs(S, "2026-11-11");
    const old = await legacy.api.subscriptions.entitlements({ params: { orgId: legacy.orgId }, query: {} });
    const next = await fresh.api.subscriptions.entitlements({ params: { orgId: fresh.orgId }, query: {} });
    expect([old.usable, old.trial?.phase]).toEqual([true, "grace"]);
    expect([next.usable, next.trial?.phase]).toEqual([false, "expired"]);
    await contactWrite(legacy, 1);
    await refused(contactWrite(fresh, 1), 402, "SUBSCRIPTION_INACTIVE");
  });
});
