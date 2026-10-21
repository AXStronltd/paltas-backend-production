// Super Admin operations for production: organisation suspension and reactivation, catalogue price changes approved by
// a second Super Admin (with history), the streamed per-organisation data export, and audit search.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportPlan } from "../dist/core/admin/export.js";
import { DEFAULTS, staffMember } from "./support/platform-fixtures.js";
import { refused, startServer, type Person, type TestServer } from "./support/test-server.js";

describe("Super Admin operations", () => {
  let S: TestServer;
  let sa: Awaited<ReturnType<TestServer["staff"]>>;
  let sa2: Awaited<ReturnType<typeof staffMember>>;
  let A: { orgId: string; admin: Person };
  let B: { orgId: string; admin: Person };

  beforeAll(async () => {
    // production behaviour: prices change only through an approved request
    S = await startServer({ config: { cataloguePriceApproval: true, scheduler: { ...DEFAULTS.scheduler } } });
    sa = await S.staff();
    sa2 = await staffMember(S);
    A = await S.newOrg({ name: "Almas Tower Management", trial: false });
    B = await S.newOrg({ name: "Other Estates", trial: false });
  });
  afterAll(() => S.close());

  describe("suspension", () => {
    it("suspends a whole organisation with a reason: its members are refused, others are not; reactivation restores", async () => {
      const acc = await S.addMember(A.orgId, A.admin.api, "accountant");
      expect((await acc.api.organisations.get({ params: { orgId: A.orgId } })).id).toBe(A.orgId);
      await refused(sa.api.ops.suspendOrg({ params: { orgId: A.orgId }, body: { reason: "x" } }), 400);
      const s = await sa.api.ops.suspendOrg({
        params: { orgId: A.orgId },
        body: { reason: "Fraud investigation 2026-117" },
      });
      expect(s.suspended).toBe(true);
      await refused(sa.api.ops.suspendOrg({ params: { orgId: A.orgId }, body: { reason: "Again please" } }), 409);
      for (const p of [acc, A.admin]) {
        const r = await refused(p.api.organisations.get({ params: { orgId: A.orgId } }), 403, "FORBIDDEN");
        expect([r.message, r.details]).toEqual([
          "This organisation is suspended by PALTAS — contact PALTAS support",
          { suspended: true },
        ]);
        await refused(p.api.ledger.trialBalance({ params: { orgId: A.orgId } }), 403);
      }
      // another organisation is not affected; staff still see everything
      expect((await B.admin.api.organisations.get({ params: { orgId: B.orgId } })).id).toBe(B.orgId);
      expect((await sa.api.admin.listOrganisations()).organisations.some((o) => o.id === A.orgId)).toBe(true);
      // reactivation
      await refused(sa.api.ops.reactivateOrg({ params: { orgId: B.orgId }, body: { reason: "Not suspended" } }), 409);
      await sa.api.ops.reactivateOrg({
        params: { orgId: A.orgId },
        body: { reason: "Investigation closed, no fault" },
      });
      expect((await acc.api.organisations.get({ params: { orgId: A.orgId } })).id).toBe(A.orgId);
      const h = await sa.api.ops.listSuspensions({ params: { orgId: A.orgId } });
      expect([h.suspended, h.history.map((x) => [x.action, x.reason, x.byUserId])]).toEqual([
        false,
        [
          ["reactivate", "Investigation closed, no fault", sa.userId],
          ["suspend", "Fraud investigation 2026-117", sa.userId],
        ],
      ]);
      await expect(S.sql("DELETE FROM org_suspensions WHERE org_id = $1", [A.orgId])).rejects.toThrow(
        /cannot be changed/,
      );
    });

    it("only a Super Admin may suspend; support staff may look; clients never see it", async () => {
      const support = await staffMember(S, "support");
      await refused(
        support.api.ops.suspendOrg({ params: { orgId: B.orgId }, body: { reason: "Support attempt" } }),
        403,
        "STAFF_ROLE_NOT_ALLOWED",
      );
      expect((await support.api.ops.listSuspensions({ params: { orgId: B.orgId } })).suspended).toBe(false);
      await refused(A.admin.api.ops.suspendOrg({ params: { orgId: B.orgId }, body: { reason: "Owner attempt" } }), 404);
      await refused(sa.api.ops.suspendOrg({ params: { orgId: "ORG-NOPE" }, body: { reason: "Does not exist" } }), 404);
    });
  });

  describe("price changes", () => {
    const plan = {
      name: "Property Management — Standard",
      tier: "Standard" as const,
      product: "property" as const,
      modules: ["maint", "finance", "docs"],
      buildingsIncluded: 1,
      baseMinor: 2_500_000,
      extraBuildingMinor: 1_500_000,
      currency: "KES",
      taxPct: 16,
      capSites: 2,
      capUnits: 100,
    };

    it("prices of an existing plan or module cannot be changed directly; other plan details can", async () => {
      const r = await refused(
        sa.api.admin.savePlan({ params: { planId: "PM-STARTER" }, body: { ...plan, baseMinor: 2_600_000 } }),
        409,
      );
      expect(r.message).toMatch(/approved by a second staff member with billing rights/);
      await refused(
        sa.api.admin.saveModule({ params: { moduleKey: "crm" }, body: { priceMinor: 1, currency: "KES" } }),
        409,
      );
      expect(
        (await sa.api.admin.savePlan({ params: { planId: "PM-STARTER" }, body: { ...plan, trialDays: 21 } })).created,
      ).toBe(false);
      await sa.api.admin.saveModule({ params: { moduleKey: "crm" }, body: { available: true } });
    });

    it("a requested change applies only when ANOTHER Super Admin approves it; history keeps before and after", async () => {
      const req = await sa.api.ops.requestPriceChange({
        body: {
          target: "plan",
          targetId: "PM-STARTER",
          baseMinor: 2_750_000,
          currency: "KES",
          reason: "Annual price review 2027",
        },
      });
      expect([req.status, req.before, req.proposed]).toEqual([
        "pending",
        { baseMinor: 2_500_000, extraBuildingMinor: 1_500_000, currency: "KES" },
        { baseMinor: 2_750_000, extraBuildingMinor: 1_500_000, currency: "KES" },
      ]);
      // nothing changed yet
      expect((await sa.api.admin.catalogue()).plans.find((p) => p.id === "PM-STARTER")?.base).toMatchObject({
        amount: 25000,
      });
      await refused(
        sa2.api.ops.requestPriceChange({
          body: { target: "plan", targetId: "PM-STARTER", baseMinor: 1, currency: "KES", reason: "Competing change" },
        }),
        409,
      );
      await refused(
        sa.api.ops.approvePriceChange({ params: { changeId: req.id }, body: {} }),
        403,
        "SEPARATION_OF_DUTIES",
      );
      await refused(
        sa.api.ops.rejectPriceChange({ params: { changeId: req.id }, body: { reason: "Changed my mind" } }),
        403,
        "SEPARATION_OF_DUTIES",
      );
      // the database refuses it too
      await expect(
        S.sql("UPDATE catalogue_price_changes SET status = 'rejected', decided_by = requested_by WHERE id = $1", [
          req.id,
        ]),
      ).rejects.toThrow(/price_change_needs_second_person/);
      const done = await sa2.api.ops.approvePriceChange({
        params: { changeId: req.id },
        body: { note: "Board approved" },
      });
      expect([done.status, done.decidedBy, done.applied]).toEqual([
        "applied",
        sa2.userId,
        { baseMinor: 2_750_000, extraBuildingMinor: 1_500_000, currency: "KES" },
      ]);
      expect((await sa.api.admin.catalogue()).plans.find((p) => p.id === "PM-STARTER")?.base).toMatchObject({
        amount: 27500,
      });
      await refused(sa2.api.ops.approvePriceChange({ params: { changeId: req.id }, body: {} }), 409);
      const audit = await sa.api.ops.auditSearch({ query: { action: "Price change approved" } });
      expect(audit.entries[0]).toMatchObject({ target: "plan:PM-STARTER", actorUserId: sa2.userId });
    });

    it("module prices and rejections follow the same rule; the history lists every request", async () => {
      const req = await sa2.api.ops.requestPriceChange({
        body: { target: "module", targetId: "crm", priceMinor: 999_900, currency: "KES", reason: "CRM repricing" },
      });
      const rej = await sa.api.ops.rejectPriceChange({
        params: { changeId: req.id },
        body: { reason: "Too high for the market" },
      });
      expect([rej.status, rej.decisionNote, rej.applied]).toEqual(["rejected", "Too high for the market", null]);
      await refused(
        sa.api.ops.requestPriceChange({
          body: { target: "module", targetId: "nope", priceMinor: 1, currency: "KES", reason: "Unknown module" },
        }),
        404,
      );
      const same = await refused(
        sa.api.ops.requestPriceChange({
          body: {
            target: "plan",
            targetId: "PM-STARTER",
            baseMinor: 2_750_000,
            currency: "KES",
            reason: "No real change",
          },
        }),
        400,
      );
      expect(same.message).toMatch(/already the prices/);
      const all = await sa.api.ops.listPriceChanges();
      expect(all.changes.map((c) => [c.targetId, c.status])).toEqual([
        ["crm", "rejected"],
        ["PM-STARTER", "applied"],
      ]);
      expect((await sa.api.ops.listPriceChanges({ query: { status: "applied" } })).changes).toHaveLength(1);
      await refused(A.admin.api.ops.listPriceChanges(), 404);
    });
  });

  describe("data export", () => {
    it("streams every record of one organisation, nothing of another, no secrets — and audits it with the reason", async () => {
      await A.admin.api.notifications.recordConsent({
        params: { orgId: A.orgId },
        body: {
          channel: "email",
          address: "tenant@example.com",
          purpose: "marketing",
          granted: true,
          source: "Website form",
        },
      });
      await refused(sa.api.ops.exportOrg({ params: { orgId: A.orgId }, query: { reason: "no" } }), 400);
      // the typed client checks the whole document against the contract
      const doc = await sa.api.ops.exportOrg({
        params: { orgId: A.orgId },
        query: { reason: "Subject access request SAR-0042" },
      });
      expect([doc.format, doc.organisation.id]).toEqual(["paltas-org-export/1", A.orgId]);
      expect(doc.members.map((m) => m.email)).toContain(A.admin.email);
      for (const t of [
        "subscriptions",
        "memberships",
        "ledger_accounts",
        "audit_log",
        "notification_consents",
        "org_suspensions",
      ])
        expect(Object.keys(doc.tables)).toContain(t);
      for (const [name, rows] of Object.entries(doc.tables))
        for (const r of rows) if ("org_id" in r) expect([name, r.org_id]).toEqual([name, A.orgId]);
      expect(doc.tables.notification_consents!.map((c) => c.address)).toEqual(["tenant@example.com"]);
      const text = JSON.stringify(doc);
      for (const secret of ["password_hash", "mfa_secret_sealed", "token_hash", B.orgId])
        expect(text).not.toContain(secret);
      expect(doc.tables.sessions).toBeUndefined();

      // streamed as a download
      const res = await fetch(`${S.base}/api/v1/admin/orgs/${A.orgId}/export?reason=Offboarding%20request`, {
        headers: { Authorization: "Bearer " + sa.token },
      });
      expect([res.status, res.headers.get("content-type"), res.headers.get("content-disposition")]).toEqual([
        200,
        "application/json; charset=utf-8",
        `attachment; filename="paltas-export-${A.orgId}.json"`,
      ]);
      expect((JSON.parse(await res.text()) as { organisation: { id: string } }).organisation.id).toBe(A.orgId);

      const audit = await sa.api.ops.auditSearch({ query: { orgId: A.orgId, action: "Organisation data exported" } });
      expect(audit.entries.map((e) => [e.detail, e.actorUserId])).toEqual([
        ["Offboarding request", sa.userId],
        ["Subject access request SAR-0042", sa.userId],
      ]);
    });

    it("tables that only point at an organisation's rows are included through that link", async () => {
      const plan = await exportPlan(S.app.ctx.db);
      const nights = plan.find((p) => p.table === "hotel_stay_nights");
      expect(nights?.where).toBe('("stay_id" IN (SELECT "id" FROM "hotel_stays" WHERE org_id = $1))');
      expect(plan.find((p) => p.table === "users")).toBeUndefined();
      expect(plan.find((p) => p.table === "mig_upload_chunks")?.columns).not.toContain("data");
    });

    it("only a Super Admin exports; unknown organisations are not found", async () => {
      const support = await staffMember(S, "support");
      await refused(
        support.api.ops.exportOrg({ params: { orgId: A.orgId }, query: { reason: "Support curiosity" } }),
        403,
      );
      await refused(sa.api.ops.exportOrg({ params: { orgId: "ORG-NOPE" }, query: { reason: "Nobody here" } }), 404);
      expect(
        (await S.raw("GET", `/api/v1/admin/orgs/${A.orgId}/export?reason=Owner%20attempt`, undefined, A.admin.token))
          .status,
      ).toBe(404);
    });
  });

  describe("audit search", () => {
    it("filters by organisation, person, action, words and dates, and pages", async () => {
      const byAction = await sa.api.ops.auditSearch({ query: { action: "Organisation suspended" } });
      expect(byAction.entries.map((e) => [e.orgId, e.detail])).toEqual([[A.orgId, "Fraud investigation 2026-117"]]);
      const words = await sa.api.ops.auditSearch({ query: { q: "fraud INVESTIGATION" } });
      expect(words.entries.length).toBeGreaterThanOrEqual(1);
      expect((await sa.api.ops.auditSearch({ query: { q: "100%_" } })).entries).toEqual([]);
      const mine = await sa.api.ops.auditSearch({ query: { actorUserId: sa2.userId } });
      expect(mine.entries.every((e) => e.actorUserId === sa2.userId)).toBe(true);
      expect(mine.entries.length).toBeGreaterThan(0);
      // the day B's entries were written, in the database's time zone as the filter reads it (not Node's UTC clock)
      const [written] = await S.sql<{ d: string }>(
        "SELECT to_char(max(at), 'YYYY-MM-DD') AS d FROM audit_log WHERE org_id = $1",
        [B.orgId],
      );
      const today = written!.d;
      expect(
        (await sa.api.ops.auditSearch({ query: { from: today, to: today, orgId: B.orgId } })).entries.length,
      ).toBeGreaterThan(0);
      expect((await sa.api.ops.auditSearch({ query: { to: "2020-01-01" } })).entries).toEqual([]);
      const page1 = await sa.api.ops.auditSearch({ query: { limit: 3 } });
      expect(page1.entries).toHaveLength(3);
      const page2 = await sa.api.ops.auditSearch({ query: { limit: 3, before: page1.nextBefore! } });
      expect(Number(page2.entries[0]!.id)).toBeLessThan(Number(page1.entries[2]!.id));
      await refused(B.admin.api.ops.auditSearch(), 404);
    });
  });
});
