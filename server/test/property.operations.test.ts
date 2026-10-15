// Property Management operations: lease lifecycle (escalation, rent review, renewal), VAT on fees and agency charges,
// credit notes, maintenance from the tenant portal through quotes, a purchase order above the approval limit and the
// owner's authority, completion with evidence and checks, a bill matched to its PO and held, owner approval from the
// owner portal, inspections, notices recorded (not sent) with consent, documents in the portals, reported payments
// and a bank line recorded as a payment.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  newTenant,
  pmOrg,
  setUpBuilding,
  startPropertyServer,
  tbBalance,
  type Building,
  type PmStaff,
} from "./support/property-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";

describe("Property Management operations", () => {
  let S: TestServer;
  let orgId: string;
  let st: PmStaff;
  let pm: Person;
  let acct: Person;
  let fd: Person;
  let mm: Person;
  let tech: Person;
  let admin: Person;
  let ownerUser: Person;
  let tenantUser: Person;
  let B: Building;
  let tenantId: string;
  let leaseId: string;
  let otherTenantId: string;
  let requestId: string;
  let woId: string;
  let maji: string;
  const O = () => ({ orgId });

  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-10-01");
    const o = await pmOrg(S, { name: "Operations Org" });
    orgId = o.orgId;
    st = o.staff;
    admin = o.admin;
    pm = st.property_manager;
    acct = st.accountant;
    fd = st.finance_director;
    mm = st.maintenance_manager;
    tech = st.technician;
    B = await setUpBuilding(orgId, pm, { units: ["B-1", "B-2", "B-3"], authorityMinor: 2_000_000 });
    ownerUser = await S.addMember(orgId, admin.api, "owner");
    tenantUser = await S.addMember(orgId, admin.api, "tenant");
    await pm.api.contacts.updateContact({
      params: { orgId, contactId: B.ownerId },
      body: { userId: ownerUser.userId },
    });
    tenantId = await newTenant(pm, orgId, "Wanjiru Kamau");
    await pm.api.contacts.updateContact({
      params: { orgId, contactId: tenantId },
      body: { userId: tenantUser.userId },
    });
    otherTenantId = await pm.api.contacts
      .createContact({ params: O(), body: { name: "Joseph Mwangi", phone: "0712 401 104", types: ["tenant"] } })
      .then((r) => r.contact.id);
  });
  afterAll(() => S.close());

  it("writes escalation steps, reviews the rent and renews the lease", async () => {
    const draft = await pm.api.property.createLease({
      params: O(),
      body: {
        unitId: B.units["B-1"]!,
        tenantId,
        startDate: "2026-10-01",
        endDate: "2028-09-30",
        rentMinor: 5_000_000,
        escalationPct: 10,
        escalationMonths: 12,
      },
    });
    leaseId = draft.id;
    await refused(
      pm.api.property.updateLease({ params: { orgId, leaseId }, body: { escalationPct: 5, escalationMonths: null } }),
      400,
    );
    const { lease } = await pm.api.property.activateLease({
      params: { orgId, leaseId },
      body: { signedOn: "2026-09-28" },
    });
    expect(lease.rentSteps).toEqual([
      { effectiveFrom: "2026-10-01", rentMinor: 5_000_000, reason: "start" },
      { effectiveFrom: "2027-10-01", rentMinor: 5_500_000, reason: "escalation" },
    ]);
    await refused(pm.api.property.updateLease({ params: { orgId, leaseId }, body: { rentMinor: 1 } }), 409);
    const reviewed = await pm.api.property.reviewRent({
      params: { orgId, leaseId },
      body: { rentMinor: 5_200_000, effectiveFrom: "2027-01-01", reason: "Annual market review agreed" },
    });
    expect(reviewed.rentSteps.map((s) => [s.effectiveFrom, s.rentMinor, s.reason])).toEqual([
      ["2026-10-01", 5_000_000, "start"],
      ["2027-01-01", 5_200_000, "review"],
      ["2027-10-01", 5_500_000, "escalation"],
    ]);
    const renewed = await pm.api.property.renewLease({
      params: { orgId, leaseId },
      body: { endDate: "2029-09-30", rentMinor: 6_000_000, effectiveFrom: "2028-10-01" },
    });
    expect(renewed.endDate).toBe("2029-09-30");
    expect(renewed.rentSteps.at(-1)).toEqual({ effectiveFrom: "2028-10-01", rentMinor: 6_000_000, reason: "renewal" });
    await refused(
      pm.api.property.renewLease({
        params: { orgId, leaseId },
        body: { endDate: "2029-01-01", rentMinor: 6_000_000, effectiveFrom: "2028-10-01" },
      }),
      400,
    );
    expect(renewed.currentRentMinor).toBe(5_000_000);
  });

  it("charges VAT on management fees and on VAT-able agency charges once registered; credit notes reverse the unpaid part", async () => {
    await fd.api.property.updateSettings({ params: O(), body: { vatPct: 16, vatFrom: "2026-10-01" } });
    const adminFee = await pm.api.property.createChargeType({
      params: O(),
      body: { code: "ADMIN", name: "Lease preparation fee", payee: "agency", vatApplies: true },
    });
    const rent = await pm.api.property.runBilling({
      params: O(),
      body: { propertyId: B.propertyId, period: "2026-10", kind: "rent" },
    });
    const fee = await pm.api.property.createChargeInvoice({
      params: O(),
      body: { leaseId, lines: [{ chargeTypeId: adminFee.id, rateMinor: 1_160_000 }] },
    });
    expect(fee.lines[0]).toMatchObject({ code: "ADMIN", payee: "agency", amountMinor: 1_160_000 });
    await acct.api.property.recordPayment({
      params: O(),
      body: {
        tenantId,
        date: "2026-10-01",
        amountMinor: 6_160_000,
        method: "bank_transfer",
        reference: "WK-OCT",
        allocations: [
          { invoiceId: rent.created[0]!.id, amountMinor: 5_000_000 },
          { invoiceId: fee.id, amountMinor: 1_160_000 },
        ],
      },
    });
    // fee 10 % of 5,000,000 = 500,000 + VAT 80,000 from the owner; agency charge 1,160,000 = 1,000,000 + VAT 160,000
    expect(await tbBalance(acct, orgId, "4650")).toBe(-500_000);
    expect(await tbBalance(acct, orgId, "4660")).toBe(-1_000_000);
    expect(await tbBalance(acct, orgId, "2100")).toBe(-(80_000 + 160_000));
    expect(await tbBalance(acct, orgId, "2250")).toBe(-(5_000_000 - 580_000));
    // a credit note can only reduce what is unpaid
    const water = await pm.api.property.createChargeType({
      params: O(),
      body: { code: "REPAIR", name: "Damage recharge", payee: "owner" },
    });
    const recharge = await pm.api.property.createChargeInvoice({
      params: O(),
      body: { leaseId, lines: [{ chargeTypeId: water.id, description: "Broken window", rateMinor: 300_000 }] },
    });
    await refused(
      acct.api.property.createCreditNote({
        params: { orgId, invoiceId: rent.created[0]!.id },
        body: { amountMinor: 1, reason: "Too late" },
      }),
      409,
    );
    const credited = await acct.api.property.createCreditNote({
      params: { orgId, invoiceId: recharge.id },
      body: { amountMinor: 100_000, reason: "Agreed partial waiver" },
    });
    expect(credited).toMatchObject({ creditedMinor: 100_000, balanceMinor: 200_000, status: "part_paid" });
    expect(await tbBalance(acct, orgId, "2150")).toBe(-200_000);
  });

  it("takes a tenant's request from the portal; the tenant sees only their own records", async () => {
    const r = await tenantUser.api.property.tenantRequest({
      params: O(),
      body: { leaseId, title: "Kitchen sink leaking", priority: "high" },
    });
    expect(r).toMatchObject({ source: "tenant_portal", status: "open", unitId: B.units["B-1"], reporterId: tenantId });
    requestId = r.id;
    const other = await pm.api.property.createLease({
      params: O(),
      body: { unitId: B.units["B-2"]!, tenantId: otherTenantId, startDate: "2026-10-01", rentMinor: 4_000_000 },
    });
    await pm.api.property.activateLease({ params: { orgId, leaseId: other.id }, body: { signedOn: "2026-09-30" } });
    await refused(
      tenantUser.api.property.tenantRequest({ params: O(), body: { leaseId: other.id, title: "Not my unit" } }),
      404,
    );
    const me = await tenantUser.api.property.tenantPortal({ params: O() });
    expect(me.leases.map((l) => l.id)).toEqual([leaseId]);
    expect(new Set(me.invoices.map((i) => i.tenantId))).toEqual(new Set([tenantId]));
    expect(me.requests.map((x) => x.id)).toEqual([requestId]);
    expect(me.balanceMinor).toBe(200_000);
  });

  it("runs the work order: quotes → PO above the approver's limit and the owner's authority → owner approval → work → check", async () => {
    const wo = await mm.api.property.createWorkOrder({
      params: O(),
      body: { propertyId: B.propertyId, requestId, scope: "Replace sink trap and seal the counter", priority: "high" },
    });
    woId = wo.id;
    expect(wo).toMatchObject({ status: "requesting_quotes", dueDate: "2026-10-04", unitId: B.units["B-1"] });
    maji = (
      await pm.api.contacts.createContact({
        params: O(),
        body: { name: "Maji Plumbers", email: "jobs@maji.example.com" },
      })
    ).contact.id;
    const fixit = (
      await pm.api.contacts.createContact({ params: O(), body: { name: "Fix-It Ltd", email: "ops@fixit.example.com" } })
    ).contact.id;
    await mm.api.property.addQuote({
      params: { orgId, workOrderId: woId },
      body: { supplierId: maji, amountMinor: 2_500_000, days: 2, fileName: "maji-quote.pdf" },
    });
    await mm.api.property.addQuote({
      params: { orgId, workOrderId: woId },
      body: { supplierId: fixit, amountMinor: 2_800_000, fileName: "fixit-quote.pdf" },
    });
    const po = await mm.api.property.raisePurchaseOrder({
      params: { orgId, workOrderId: woId },
      body: { supplierId: maji },
    });
    expect(po.po).toMatchObject({ amountMinor: 2_500_000, needsOwner: true, approvedBy: null });
    // the raiser cannot approve; the property manager's limit (none set) is too low; the finance director can
    await refused(
      mm.api.property.approvePurchaseOrder({ params: { orgId, workOrderId: woId } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await refused(pm.api.property.approvePurchaseOrder({ params: { orgId, workOrderId: woId } }), 403, "FORBIDDEN");
    await fd.api.property.updateSettings({ params: O(), body: { poLimits: { property_manager: 3_000_000 } } });
    const staffOk = await pm.api.property.approvePurchaseOrder({ params: { orgId, workOrderId: woId } });
    expect(staffOk.status).toBe("awaiting_owner");
    // no work before the owner approves
    await refused(
      tech.api.property.completeWorkOrder({ params: { orgId, workOrderId: woId }, body: { evidence: ["after.jpg"] } }),
      409,
    );
    const portal = await ownerUser.api.property.ownerPortal({ params: O(), query: {} });
    expect(portal.workOrdersAwaitingApproval.map((w) => w.id)).toEqual([woId]);
    expect(portal.properties.map((p) => p.id)).toEqual([B.propertyId]);
    const ownerOk = await ownerUser.api.property.ownerApprovePurchaseOrder({ params: { orgId, workOrderId: woId } });
    expect(ownerOk.status).toBe("approved");
    const done = await tech.api.property.completeWorkOrder({
      params: { orgId, workOrderId: woId },
      body: { notes: "Trap replaced, counter sealed", evidence: ["sink-after-1.jpg", "sink-after-2.jpg"] },
    });
    expect(done.completion?.evidence.length).toBe(2);
    await refused(
      tech.api.property.verifyWorkOrder({ params: { orgId, workOrderId: woId }, body: { accepted: true } }),
      403,
    );
    const checked = await mm.api.property.verifyWorkOrder({
      params: { orgId, workOrderId: woId },
      body: { accepted: true, note: "Dry after 24h" },
    });
    expect(checked.status).toBe("verified");
    const req = (await pm.api.property.listRequests({ params: O(), query: {} })).requests.find(
      (x) => x.id === requestId,
    )!;
    expect(req.status).toBe("resolved");
  });

  it("matches the supplier's bill to the PO: an amount above the tolerance is held; the owner approves above the authority", async () => {
    S.setToday("2026-10-05");
    const bill = await pm.api.property.submitBill({
      params: O(),
      body: {
        supplierId: maji,
        workOrderId: woId,
        description: "Sink repair B-1",
        supplierInvoiceNo: "MJ-2026-118",
        billDate: "2026-10-03",
        amountMinor: 2_600_000,
        recoverFrom: "owner",
      },
    });
    expect(bill.status).toBe("held");
    expect(bill.matchIssues.join(" ")).toMatch(/more than the PO 2500000 plus 2%/);
    await refused(acct.api.property.approveBill({ params: { orgId, billId: bill.id } }), 409);
    await refused(
      pm.api.property.clearBillHold({ params: { orgId, billId: bill.id }, body: { reason: "I am sure it is fine" } }),
      403,
    );
    await acct.api.property.clearBillHold({
      params: { orgId, billId: bill.id },
      body: { reason: "Extra seal agreed by phone, see email of 3 Oct" },
    });
    const sent = await acct.api.property.approveBill({ params: { orgId, billId: bill.id } });
    expect(sent.status).toBe("awaiting_owner");
    const before = await tbBalance(acct, orgId, "2250");
    const portal = await ownerUser.api.property.ownerPortal({ params: O(), query: {} });
    expect(portal.billsAwaitingApproval.map((b) => b.id)).toEqual([bill.id]);
    const ok = await ownerUser.api.property.ownerApproveBill({ params: { orgId, billId: bill.id } });
    expect(ok).toMatchObject({ status: "approved", ownerApprovedBy: ownerUser.userId });
    expect(await tbBalance(acct, orgId, "2250")).toBe(before + 2_600_000);
    const paid = await fd.api.property.payBill({
      params: { orgId, billId: bill.id },
      body: { paidDate: "2026-10-03", reference: "EQB-MJ-118" },
    });
    expect(paid.status).toBe("paid");
    const wo = (await pm.api.property.listWorkOrders({ params: O(), query: {} })).workOrders.find(
      (w) => w.id === woId,
    )!;
    expect(wo.status).toBe("billed");
    // the owner's statement shows the expense, equal to the ledger
    const stmt = (
      await ownerUser.api.property.ownerPortal({ params: O(), query: { from: "2026-10-01", to: "2026-10-31" } })
    ).statement;
    expect(stmt.expensesMinor).toBe(2_600_000);
    expect(stmt.agrees).toBe(true);
    // an owner cannot approve another owner's bill
    const outsiderOwner = await S.addMember(orgId, admin.api, "owner");
    const c = await pm.api.contacts.createContact({
      params: O(),
      body: { name: "Other Owner", email: "oo@example.com", types: ["owner"] },
    });
    await pm.api.contacts.updateContact({
      params: { orgId, contactId: c.contact.id },
      body: { userId: outsiderOwner.userId },
    });
    await refused(outsiderOwner.api.property.ownerApproveBill({ params: { orgId, billId: bill.id } }), 404);
  });

  it("records an inspection; every damaged area opens a maintenance request", async () => {
    const ins = await pm.api.property.scheduleInspection({
      params: O(),
      body: { propertyId: B.propertyId, unitId: B.units["B-3"]!, kind: "routine", scheduledDate: "2026-10-05" },
    });
    const done = await pm.api.property.completeInspection({
      params: { orgId, inspectionId: ins.id },
      body: {
        items: [
          { area: "Kitchen", condition: "good" },
          { area: "Bathroom", condition: "damaged", note: "Cracked basin" },
          { area: "Balcony door", condition: "needs_repair" },
        ],
      },
    });
    expect(done.status).toBe("completed");
    expect(done.requestIds.length).toBe(2);
    const reqs = (await pm.api.property.listRequests({ params: O(), query: {} })).requests.filter((r) =>
      done.requestIds.includes(r.id),
    );
    expect(reqs.map((r) => [r.source, r.priority]).sort()).toEqual([
      ["inspection", "high"],
      ["inspection", "normal"],
    ]);
    await refused(
      pm.api.property.completeInspection({
        params: { orgId, inspectionId: ins.id },
        body: { items: [{ area: "x", condition: "good" }] },
      }),
      409,
    );
  });

  it("publishes a notice: one message per tenant, recorded (not sent) or blocked without consent", async () => {
    const r = await pm.api.property.publishNotice({
      params: O(),
      body: {
        propertyId: B.propertyId,
        title: "Water shut-off",
        body: "Water off on 12 October, 9am–1pm.",
        channel: "email",
      },
    });
    expect(r.notice).toMatchObject({ recipients: 2, recorded: 1, blocked: 1 });
    expect(r.messages.map((m) => m.status).sort()).toEqual(["blocked", "recorded"]);
    expect(r.messages.every((m) => m.status !== ("sent" as string))).toBe(true);
    const inapp = await pm.api.property.publishNotice({
      params: O(),
      body: { propertyId: B.propertyId, title: "Lift service", body: "Lift B serviced on Friday.", channel: "inapp" },
    });
    expect(inapp.notice).toMatchObject({ recipients: 2, recorded: 2, blocked: 0 });
    await refused(
      st.leasing_agent.api.property.publishNotice({
        params: O(),
        body: { propertyId: B.propertyId, title: "x x x", body: "y y y" },
      }),
      403,
    );
  });

  it("keeps document records; tenant-visible lease documents show in the tenant portal only", async () => {
    await pm.api.property.addDocument({
      params: O(),
      body: {
        name: "Signed lease B-1",
        docType: "lease",
        linkEntity: "lease",
        linkId: leaseId,
        filename: "lease-B1.pdf",
        sizeBytes: 182_000,
        visibility: "tenant",
      },
    });
    await pm.api.property.addDocument({
      params: O(),
      body: {
        name: "Owner mandate",
        docType: "agreement",
        linkEntity: "property",
        linkId: B.propertyId,
        filename: "mandate.pdf",
      },
    });
    await refused(
      pm.api.property.addDocument({
        params: O(),
        body: { name: "X", docType: "other", linkEntity: "lease", linkId: "pls_nope", filename: "x.pdf" },
      }),
      404,
    );
    const me = await tenantUser.api.property.tenantPortal({ params: O() });
    expect(me.documents.map((d) => d.name)).toEqual(["Signed lease B-1"]);
    const all = await pm.api.property.listDocuments({ params: O(), query: {} });
    expect(all.documents.length).toBe(2);
  });

  it("checks reported payments against the bank: matched by recording the payment, or rejected", async () => {
    const cashBefore = await tbBalance(acct, orgId, "1040");
    const claim = await tenantUser.api.property.tenantPaymentReport({
      params: O(),
      body: { amountMinor: 200_000, date: "2026-10-04", method: "mobile_money", reference: "RJ45KX" },
    });
    expect(claim.status).toBe("pending");
    const fake = await tenantUser.api.property.tenantPaymentReport({
      params: O(),
      body: { amountMinor: 999_000, date: "2026-10-04", method: "bank_transfer", reference: "NOT-ON-STATEMENT" },
    });
    // a reported payment is never money by itself
    expect(await tbBalance(acct, orgId, "1040")).toBe(cashBefore);
    const pay = await acct.api.property.recordPayment({
      params: O(),
      body: {
        tenantId,
        date: "2026-10-04",
        amountMinor: 200_000,
        method: "mobile_money",
        reference: "RJ45KX",
        claimId: claim.id,
      },
    });
    expect(pay.allocatedMinor).toBe(200_000);
    await acct.api.property.rejectClaim({
      params: { orgId, claimId: fake.id },
      body: { reason: "Not on the statement for 4 October" },
    });
    const { claims } = await acct.api.property.listClaims({ params: O(), query: {} });
    expect(claims.map((c) => [c.reference, c.status]).sort()).toEqual([
      ["NOT-ON-STATEMENT", "rejected"],
      ["RJ45KX", "matched"],
    ]);
    const me = await tenantUser.api.property.tenantPortal({ params: O() });
    expect(me.balanceMinor).toBe(0);
  });

  it("records an unknown incoming bank line as the tenant's payment, matched to the line", async () => {
    const [rent] = (
      await pm.api.property.runBilling({
        params: O(),
        body: { propertyId: B.propertyId, period: "2026-11", kind: "rent" },
      })
    ).created;
    expect(rent).toBeTruthy();
    const imp = await acct.api.property.importBankLines({
      params: O(),
      body: {
        statement: "Oct statement",
        lines: [{ date: "2026-10-05", amountMinor: 1_000_000, reference: "BB-778", description: "B-2 J MWANGI" }],
      },
    });
    expect(imp.matched).toBe(0);
    const line = imp.lines[0]!;
    const matched = await acct.api.property.matchBankLine({
      params: { orgId, lineId: line.id },
      body: { to: "new_payment", tenantId: otherTenantId, method: "bank_transfer" },
    });
    expect(matched).toMatchObject({ status: "matched", matchedKind: "payment" });
    const pays = await acct.api.property.listPayments({ params: O(), query: { tenantId: otherTenantId } });
    expect(pays.payments[0]).toMatchObject({ amountMinor: 1_000_000, reference: "BB-778", bankMatched: true });
    await refused(
      acct.api.property.matchBankLine({
        params: { orgId, lineId: line.id },
        body: { to: "payment", id: pays.payments[0]!.id },
      }),
      409,
    );
    const rr = await pm.api.property.rentRoll({ params: O(), query: {} });
    expect(rr.rows.map((r) => [r.unitNo, r.status])).toEqual([
      ["B-1", "let"],
      ["B-2", "let"],
      ["B-3", "vacant"],
    ]);
    const dash = await pm.api.property.dashboard({ params: O(), query: {} });
    expect(Object.values(dash.ledger).every((c) => c.agrees)).toBe(true);
  });
});
