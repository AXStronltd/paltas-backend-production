// Development records not covered by the acceptance run: project and phase changes, unit blocking, cost codes in
// settings, the legal register, buyer details and follow-ups, buyer disputes, offer revision and withdrawal,
// reservation cancellation, tasks, supplier-invoice disputes and rejections.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildProject,
  devOrg,
  doc,
  M,
  PLAN_10_50_40,
  startDevServer,
  type DevStaff,
} from "./support/development-fixture.js";
import { refused, TODAY, type Person, type TestServer } from "./support/test-server.js";

describe("Real Estate Development: records", () => {
  let S: TestServer;
  let orgId: string;
  let st: DevStaff;
  let projectId: string;
  let units: { id: string; unitNo: string }[];
  const d = (p: Person) => p.api.development;
  const O = () => ({ orgId });

  beforeAll(async () => {
    S = await startDevServer();
    const o = await devOrg(S, "Kilele Homes");
    orgId = o.orgId;
    st = o.staff;
    const p = await buildProject(st.ceo, orgId, { units: 3 });
    projectId = p.projectId;
    units = p.units;
  });
  afterAll(() => S.close());

  it("projects, phases, unit blocking, cost codes and the legal register", async () => {
    const P = { orgId, projectId };
    const up = await d(st.pm).updateProject({
      params: P,
      body: { stage: "Superstructure", progressPct: 58, forecastEndDate: "2027-07-21" },
    });
    expect([up.stage, up.progressPct, up.forecastEndDate]).toEqual(["Superstructure", 58, "2027-07-21"]);
    const ph = await d(st.pm).createPhase({ params: P, body: { name: "Phase 2", startDate: "2027-01-01" } });
    expect(ph.phases.map((x) => x.name)).toEqual(["Phase 2"]);
    await refused(d(st.ceo).createProject({ params: O(), body: { name: "riverside gardens" } }), 409);

    const blocked = await d(st.sm).setUnitBlocked({
      params: { orgId, unitId: units[2]!.id },
      body: { blocked: true, reason: "Show unit until launch" },
    });
    expect(blocked.status).toBe("blocked");
    await refused(
      d(st.ag1).createOffer({
        params: O(),
        body: {
          buyerId: (
            await d(st.ag1).createBuyer({ params: O(), body: { name: "Blocked Buyer", phone: "+254 733 100 200" } })
          ).id,
          unitId: units[2]!.id,
          priceMinor: M(15e6),
          plan: PLAN_10_50_40,
        },
      }),
      409,
    );
    expect(
      (
        await d(st.sm).setUnitBlocked({
          params: { orgId, unitId: units[2]!.id },
          body: { blocked: false, reason: "Launched" },
        })
      ).status,
    ).toBe("available");

    const s = await d(st.fd).updateSettings({
      params: O(),
      body: {
        costCodes: [{ code: "14", name: "Smart home systems", account: "1530", active: true }],
        reservationDays: 21,
      },
    });
    expect(s.costCodes.find((c) => c.code === "14")).toEqual({
      code: "14",
      name: "Smart home systems",
      account: "1530",
      active: true,
    });
    expect(s.reservationDays).toBe(21);
    await refused(
      d(st.fd).updateSettings({
        params: O(),
        body: { costCodes: [{ code: "15", name: "Bad", account: "2000", active: true }] },
      }),
      400,
    );

    const insurance = await d(st.pm).createLegal({
      params: O(),
      body: { projectId, title: "Contractor all-risk insurance", kind: "insurance", expiryDate: "2026-11-15" },
    });
    const permit = await d(st.pm).createLegal({
      params: O(),
      body: { projectId, title: "County building approval", kind: "approval", expiryDate: "2027-03-31" },
    });
    const occupation = await d(st.pm).createLegal({
      params: O(),
      body: { projectId, title: "Occupation certificate", kind: "certificate", inProgress: true },
    });
    expect([insurance.status, permit.status, occupation.status]).toEqual(["renew", "valid", "in_progress"]);
    S.setToday("2026-11-20");
    const legal = await d(st.aud).listLegal({ params: O(), query: { projectId } });
    expect(legal.items.find((i) => i.id === insurance.id)!.status).toBe("expired");
    S.setToday(TODAY);
  });

  it("buyers: details, follow-up task, disputes; offers revised (approval withdrawn) and withdrawn; reservation cancelled", async () => {
    const b = await d(st.ag1).createBuyer({
      params: O(),
      body: { name: "Esther Nyambura", email: "esther@example.com" },
    });
    await refused(
      d(st.ag1).updateBuyer({ params: { orgId, buyerId: b.id }, body: { nextFollowUp: "2026-10-01" } }),
      400,
    );
    const up = await d(st.ag1).updateBuyer({
      params: { orgId, buyerId: b.id },
      body: { phone: "+254 722 333 444", nextFollowUp: "2026-10-14" },
    });
    expect([up.phone, up.nextFollowUp]).toEqual(["+254 722 333 444", "2026-10-14"]);
    const tasks = await d(st.ag1).listTasks({ params: O(), query: { view: "mine" } });
    expect(tasks.tasks.map((t) => t.title)).toEqual(
      expect.arrayContaining(["First contact with Esther Nyambura", "Follow up with Esther Nyambura"]),
    );
    const profile = await d(st.ag1).getBuyer({ params: { orgId, buyerId: b.id } });
    expect(profile.history.map((h) => h.action)).toEqual(["Buyer created", "Buyer details changed"]);

    const dsp = await d(st.ag1).openDispute({
      params: { orgId, buyerId: b.id },
      body: { subject: "Parking allocation", amountMinor: 0 },
    });
    await refused(
      d(st.ag1).resolveDispute({ params: { orgId, disputeId: dsp.id }, body: { resolution: "Bay 12 allocated" } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    expect(
      (
        await d(st.sm).resolveDispute({
          params: { orgId, disputeId: dsp.id },
          body: { resolution: "Bay 12 allocated" },
        })
      ).status,
    ).toBe("resolved");

    const o = await d(st.ag1).createOffer({
      params: O(),
      body: { buyerId: b.id, unitId: units[0]!.id, priceMinor: M(14.4e6), plan: PLAN_10_50_40 },
    });
    const waiting = await d(st.ag1).submitOffer({ params: { orgId, offerId: o.id } });
    expect(waiting.status).toBe("awaiting_approval");
    await d(st.sm).decideOffer({
      params: { orgId, offerId: o.id },
      body: { approve: false, reason: "Offer list price first" },
    });
    const revised = await d(st.ag1).reviseOffer({ params: { orgId, offerId: o.id }, body: { priceMinor: M(15e6) } });
    expect([revised.status, revised.approval, revised.discountBp]).toEqual(["draft", null, 0]);
    await refused(d(st.ag1).reviseOffer({ params: { orgId, offerId: o.id }, body: { priceMinor: M(15e6) } }), 400);
    expect(
      (
        await d(st.ag1).withdrawOffer({
          params: { orgId, offerId: o.id },
          body: { reason: "Buyer chose another unit" },
        })
      ).status,
    ).toBe("withdrawn");

    const o2 = await d(st.ag1).createOffer({
      params: O(),
      body: { buyerId: b.id, unitId: units[1]!.id, priceMinor: M(15e6), plan: PLAN_10_50_40 },
    });
    await d(st.ag1).submitOffer({ params: { orgId, offerId: o2.id } });
    const acc = await d(st.ag1).respondToOffer({ params: { orgId, offerId: o2.id }, body: { response: "accept" } });
    const r = await d(st.sm).cancelReservation({
      params: { orgId, reservationId: acc.reservationId! },
      body: { reason: "Buyer withdrew before signing" },
    });
    expect(r.status).toBe("cancelled");
    expect(
      (await d(st.aud).listUnits({ params: { orgId, projectId }, query: { status: "available" } })).units.map(
        (u) => u.id,
      ),
    ).toContain(units[1]!.id);
    expect((await d(st.ag1).listOffers({ params: O(), query: { buyerId: b.id } })).offers.map((x) => x.status)).toEqual(
      ["withdrawn", "withdrawn"],
    );
  });

  it("tasks: for yourself, or for others if you manage; completed by the assignee", async () => {
    await refused(
      d(st.ag1).createTask({
        params: O(),
        body: { title: "Call the bank", dueDate: TODAY, assigneeUserId: st.ag2.userId },
      }),
      403,
    );
    const t = await d(st.sm).createTask({
      params: O(),
      body: {
        title: "Weekly pipeline review",
        dueDate: "2026-10-10",
        priority: "high",
        category: "sales",
        assigneeUserId: st.ag2.userId,
      },
    });
    expect((await d(st.ag2).listTasks({ params: O(), query: { view: "overdue" } })).tasks.map((x) => x.id)).toContain(
      t.id,
    );
    await refused(d(st.ag1).completeTask({ params: { orgId, taskId: t.id }, body: {} }), 404);
    expect((await d(st.ag2).completeTask({ params: { orgId, taskId: t.id }, body: { note: "Done" } })).status).toBe(
      "done",
    );
    expect((await d(st.sm).listTasks({ params: O(), query: { view: "done" } })).tasks.map((x) => x.id)).toContain(t.id);
  });

  it("supplier invoices: a dispute blocks approval until the credit is accepted; rejected orders, requisitions and invoices", async () => {
    const s = await d(st.proc).registerSupplier({
      params: O(),
      body: { kind: "supplier", name: "Site Hire Plant Ltd", taxId: "P051888888H", bankAccount: "4444333322" },
    });
    await d(st.fd).approveSupplier({ params: { orgId, supplierId: s.id }, body: {} });
    await d(st.pm).setBudget({
      params: { orgId, projectId },
      body: { lines: [{ costCode: "10", originalMinor: M(2e6) }] },
    });
    const inv = await d(st.ap).captureInvoice({
      params: O(),
      body: {
        supplierId: s.id,
        projectId,
        costCode: "10",
        supplierInvoiceNo: "SHP-7781",
        date: TODAY,
        dueDate: "2026-10-16",
        description: "Excavator hire, September",
        netMinor: M(640_000),
        vatBp: 1600,
        evidenceDocumentId: (await doc(st.ap, orgId, "SHP-7781.pdf")).id,
      },
    });
    const disputed = await d(st.ap).disputeInvoice({
      params: { orgId, invoiceId: inv.id },
      body: { amountMinor: M(160_000), reason: "Billed 160 h; timesheets show 120 h" },
    });
    expect(disputed.status).toBe("disputed");
    await refused(d(st.fd).decideInvoice({ params: { orgId, invoiceId: inv.id }, body: { action: "approve" } }), 409);
    await refused(d(st.ap).settleInvoiceDispute({ params: { orgId, invoiceId: inv.id } }), 403, "ROLE_NOT_ALLOWED");
    const settled = await d(st.fd).settleInvoiceDispute({ params: { orgId, invoiceId: inv.id } });
    expect([settled.status, settled.netMinor, settled.creditNotesMinor, settled.dispute?.status]).toEqual([
      "matched",
      M(480_000),
      M(160_000),
      "settled",
    ]);
    const posted = await d(st.fd).decideInvoice({ params: { orgId, invoiceId: inv.id }, body: { action: "approve" } });
    expect(posted.status).toBe("approved");

    const other = await d(st.ap).captureInvoice({
      params: O(),
      body: {
        supplierId: s.id,
        projectId,
        costCode: "10",
        supplierInvoiceNo: "SHP-9000",
        date: TODAY,
        dueDate: TODAY,
        description: "Fuel",
        netMinor: M(10_000),
        vatBp: 0,
      },
    });
    expect(other.exceptions).toEqual(["No evidence attached"]);
    await refused(d(st.fd).decideInvoice({ params: { orgId, invoiceId: other.id }, body: { action: "reject" } }), 400);
    expect(
      (
        await d(st.fd).decideInvoice({
          params: { orgId, invoiceId: other.id },
          body: { action: "reject", reason: "No invoice document" },
        })
      ).status,
    ).toBe("rejected");

    const req = await d(st.pm).createRequisition({
      params: { orgId, projectId },
      body: { costCode: "10", item: "Site toilets", qty: 2, unit: "unit", estUnitPriceMinor: M(50_000) },
    });
    expect(
      (
        await d(st.fd).decideRequisition({
          params: { orgId, requisitionId: req.id },
          body: { approve: false, reason: "Hire instead of buying" },
        })
      ).status,
    ).toBe("rejected");
    const po = await d(st.proc).createPurchaseOrder({
      params: { orgId, projectId },
      body: {
        kind: "po",
        supplierId: s.id,
        costCode: "10",
        description: "Generator hire",
        lines: [{ item: "Generator 100 kVA, week", unit: "week", qty: 2, unitPriceMinor: M(45_000) }],
      },
    });
    expect(
      (
        await d(st.fd).decidePurchaseOrder({
          params: { orgId, poId: po.id },
          body: { approve: false, reason: "Use the second-hand unit" },
        })
      ).status,
    ).toBe("rejected");
    const cost = await d(st.pm).costReport({ params: { orgId, projectId } });
    expect(cost.rows.find((r) => r.costCode === "10")).toMatchObject({
      invoicedMinor: M(480_000),
      committedMinor: M(480_000),
      proposedMinor: 0,
    });
    expect(cost.ledger.agrees).toBe(true);
  });
});
