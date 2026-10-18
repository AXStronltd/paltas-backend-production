import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProject, devOrg, M, startDevServer, type DevStaff } from "./support/development-fixture.js";
import { refused, TODAY, type TestServer } from "./support/test-server.js";
import { setupNotifications } from "../dist/products/development/command/notifications.service.js";

describe("Developer command centre, CRM and setup notifications", () => {
  let S: TestServer, orgId: string, staff: DevStaff, other: string;
  beforeAll(async () => {
    S = await startDevServer();
    const a = await devOrg(S);
    orgId = a.orgId;
    staff = a.staff;
    other = (await S.newOrg({ product: "developer", plan: "DEV-PRO", trial: false })).orgId;
  });
  afterAll(() => S.close());
  it("shows real empty totals, keeps organisations isolated and protects report access", async () => {
    const d = await staff.ceo.api.development.commandCenter({ params: { orgId } });
    expect(d).toEqual({
      portfolioValueMinor: 0,
      collectedMinor: 0,
      outstandingMinor: 0,
      expensesMinor: 0,
      projects: [],
      activity: [],
    });
    await refused(staff.ceo.api.development.commandCenter({ params: { orgId: other } }), 404);
    await refused(staff.ag1.api.development.commandCenter({ params: { orgId } }), 403);
  });
  it("persists early CRM stages with optimistic concurrency and assigned-agent isolation", async () => {
    const b = await staff.ag1.api.development.createBuyer({
      params: { orgId },
      body: { name: "Buyer One", email: "buyerone@example.test" },
    });
    expect(b.pipelineVersion).toBe(0);
    const changed = await staff.ag1.api.development.moveBuyerStage({
      params: { orgId, buyerId: b.id },
      body: { stage: "site_visit", version: 0 },
    });
    expect(changed).toMatchObject({ stage: "site_visit", pipelineVersion: 1 });
    await refused(
      staff.ag1.api.development.moveBuyerStage({
        params: { orgId, buyerId: b.id },
        body: { stage: "contacted", version: 0 },
      }),
      409,
    );
    await refused(
      staff.ag2.api.development.moveBuyerStage({
        params: { orgId, buyerId: b.id },
        body: { stage: "contacted", version: 1 },
      }),
      404,
    );
    const reset = await staff.ag1.api.development.moveBuyerStage({
      params: { orgId, buyerId: b.id },
      body: { stage: "enquiry", version: 1 },
    });
    expect(reset.stage).toBe("enquiry");
    await refused(
      staff.viewer.api.development.moveBuyerStage({
        params: { orgId, buyerId: b.id },
        body: { stage: "contacted", version: 2 },
      }),
      403,
    );
  });
  it("aggregates project values without multiplying units and counts future unpaid instalments", async () => {
    const p = await buildProject(staff.ceo, orgId, { units: 2 });
    const buyer = await staff.ceo.api.development.createBuyer({
      params: { orgId },
      body: { name: "Contract Buyer", email: "contract@example.test" },
    });
    // Isolated financial fixture; no production database and no external payment execution.
    await S.sql(
      "INSERT INTO dev_contracts(id,org_id,unit_id,buyer_id,date,price_minor,status,number) VALUES('cc-contract',$1,$2,$3,$4,1000,'active','TEST-CC')",
      [orgId, p.units[0]!.id, buyer.id, TODAY],
    );
    await S.sql(
      "INSERT INTO dev_instalments(id,org_id,contract_id,seq,due_date,amount_minor) VALUES('cc-i1',$1,'cc-contract',1,$2,600),('cc-i2',$1,'cc-contract',2,'2099-01-01',400)",
      [orgId, TODAY],
    );
    await S.sql(
      "INSERT INTO dev_payments(id,org_id,contract_id,buyer_id,kind,date,amount_minor,reference) VALUES('cc-payment',$1,'cc-contract',$2,'receipt',$3,250,'TEST-ONLY')",
      [orgId, buyer.id, TODAY],
    );
    await S.sql(
      "INSERT INTO dev_payment_allocations(id,org_id,payment_id,instalment_id,amount_minor) VALUES('cc-allocation',$1,'cc-payment','cc-i1',250)",
      [orgId],
    );
    const d = await staff.ceo.api.development.commandCenter({ params: { orgId } });
    expect(d.portfolioValueMinor).toBe(M(30e6));
    expect(d.collectedMinor).toBe(250);
    expect(d.outstandingMinor).toBe(750);
    expect(d.projects[0]).toMatchObject({ id: p.projectId, units: 2, valueMinor: M(30e6) });
    expect(d.activity.map((x) => x.kind)).toEqual(expect.arrayContaining(["payment", "contract"]));
    await refused(
      staff.ceo.api.development.moveBuyerStage({
        params: { orgId, buyerId: buyer.id },
        body: { stage: "enquiry", version: 0 },
      }),
      409,
    );
  });
  it("schedules only due unfinished tasks, isolates user state and suppresses completed setup", async () => {
    const o = await S.newOrg({ product: "developer", plan: "DEV-PRO", trial: false });
    const P = { orgId: o.orgId };
    let r = await o.admin.api.development.listSetupAlerts({ params: P });
    expect(r.alerts.map((a) => a.step)).toEqual(["project"]);
    await S.sql("UPDATE subscriptions SET created_at=now()-interval '4 days' WHERE org_id=$1 AND product='developer'", [
      o.orgId,
    ]);
    r = await o.admin.api.development.listSetupAlerts({ params: P });
    expect(new Set(r.alerts.map((a) => a.step))).toEqual(new Set(["project", "leads", "budget"]));
    const a = r.alerts[0]!;
    await refused(
      staff.ceo.api.development.updateSetupAlert({ params: { ...P, alertId: a.id }, body: { dismiss: true } }),
      404,
    );
    await o.admin.api.development.updateSetupAlert({ params: { ...P, alertId: a.id }, body: { dismiss: false } });
    expect((await o.admin.api.development.listSetupAlerts({ params: P })).unread).toBe(2);
    await buildProject(o.admin, o.orgId, { units: 1 });
    expect(
      (await o.admin.api.development.listSetupAlerts({ params: P })).alerts.some((a) => a.step === "project"),
    ).toBe(false);
    // Permit this isolated fixture to exercise the post-release campaign and verified-recipient gate.
    await S.sql("UPDATE dev_onboarding_campaign SET eligible_after='2000-01-01'");
    await S.sql("UPDATE users SET email_verified_at=now() WHERE id=$1", [o.admin.userId]);
    const N = setupNotifications(S.app.ctx, S.app.core);
    await N.sendDue();
    await N.sendDue();
    const rows = await S.sql(
      "SELECT source_ref FROM notifications WHERE org_id=$1 AND source_ref LIKE 'developer.setup:%'",
      [o.orgId],
    );
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.source_ref)).size).toBe(2);
  });
});
