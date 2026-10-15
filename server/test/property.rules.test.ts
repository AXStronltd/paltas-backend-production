// Property Management rules: organisation isolation (another organisation's ids answer 404), role refusals, separation
// of duties enforced in the service AND by database constraints, idempotent invoice runs (also when run concurrently),
// over-allocation refused by the database, and the plan's module and building allowance.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  newTenant,
  pmOrg,
  setUpBuilding,
  startPropertyServer,
  type Building,
  type PmStaff,
} from "./support/property-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";

describe("Property Management rules", () => {
  let S: TestServer;
  let orgId: string;
  let st: PmStaff;
  let pm: Person;
  let acct: Person;
  let fd: Person;
  let admin: Person;
  let B: Building;
  let other: { orgId: string; staff: PmStaff; B: Building };
  const ids: Record<string, string> = {};
  const O = () => ({ orgId });

  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-10-01");
    const o = await pmOrg(S, { name: "Rules Org" });
    orgId = o.orgId;
    st = o.staff;
    pm = st.property_manager;
    acct = st.accountant;
    fd = st.finance_director;
    admin = o.admin;
    B = await setUpBuilding(orgId, pm, { units: ["R-1", "R-2", "R-3", "R-4"] });
    await fd.api.property.updateOwnerProfile({
      params: { orgId, ownerId: B.ownerId },
      body: { bankAccountMasked: "••1111", verifyBank: true },
    });
    // three active leases to bill
    for (const [unit, name] of [
      ["R-1", "Tenant One"],
      ["R-2", "Tenant Two"],
      ["R-3", "Tenant Three"],
    ] as const) {
      const t = await newTenant(pm, orgId, name);
      const l = await pm.api.property.createLease({
        params: O(),
        body: { unitId: B.units[unit]!, tenantId: t, startDate: "2026-09-15", rentMinor: 3_000_000, depositMinor: 0 },
      });
      await pm.api.property.activateLease({ params: { orgId, leaseId: l.id }, body: { signedOn: "2026-09-10" } });
      ids[unit] = l.id;
      ids[`tenant-${unit}`] = t;
    }
    const og = await pmOrg(S, { name: "Other Agency" });
    other = {
      orgId: og.orgId,
      staff: og.staff,
      B: await setUpBuilding(og.orgId, og.staff.property_manager, { units: ["X-1"] }),
    };
  });
  afterAll(() => S.close());

  it("bills each lease once per month, even when runs race; the first month is prorated", async () => {
    const body = { propertyId: B.propertyId, period: "2026-09", kind: "rent" as const };
    const runs = await Promise.all([1, 2, 3].map(() => pm.api.property.runBilling({ params: O(), body })));
    expect(runs.reduce((n, r) => n + r.created.length, 0)).toBe(3);
    const inv = (await pm.api.property.listInvoices({ params: O(), query: { period: "2026-09" } })).invoices;
    expect(inv.length).toBe(3);
    // 15–30 September: 16 of 30 days of 3,000,000
    expect(inv.map((i) => i.amountMinor)).toEqual([1_600_000, 1_600_000, 1_600_000]);
    expect(inv[0]!.lines[0]!.description).toContain("Prorated 16 of 30 days");
    const journals = await S.sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM pm_ledger_links WHERE org_id = $1 AND kind = 'invoice'",
      [orgId],
    );
    expect(journals[0]!.n).toBe(3);
    // the database itself refuses a second rent invoice for the same lease and month
    const [one] = await S.sql<{ id: string }>("SELECT id FROM pm_invoices WHERE lease_id = $1", [ids["R-1"]]);
    await expect(
      S.sql(
        `INSERT INTO pm_invoices (id, org_id, number, kind, lease_id, tenant_id, owner_id, period, issue_date, due_date, amount_minor)
         SELECT 'pin_dup', org_id, 'INV-DUP', kind, lease_id, tenant_id, owner_id, period, issue_date, due_date, amount_minor
         FROM pm_invoices WHERE id = $1`,
        [one!.id],
      ),
    ).rejects.toThrow(/pm_invoices_rent_once/);
    // a month too far ahead is refused
    await refused(pm.api.property.runBilling({ params: O(), body: { ...body, period: "2026-12" } }), 400);
  });

  it("charges late fees once, after the grace days", async () => {
    S.setToday("2026-10-10"); // due 15 Sep (start date) + 7 grace days long passed
    const first = await acct.api.property.runLateFees({ params: O(), body: { propertyId: B.propertyId } });
    expect(first.created.map((i) => i.amountMinor)).toEqual([80_000, 80_000, 80_000]); // 5 % of 1,600,000
    const second = await acct.api.property.runLateFees({ params: O(), body: {} });
    expect(second.created).toEqual([]);
    const [f] = first.created;
    await expect(
      S.sql(
        `INSERT INTO pm_invoices (id, org_id, number, kind, lease_id, tenant_id, owner_id, issue_date, due_date, amount_minor, source_invoice_id)
         SELECT 'pin_dup2', org_id, 'INV-DUP2', kind, lease_id, tenant_id, owner_id, issue_date, due_date, amount_minor, source_invoice_id
         FROM pm_invoices WHERE id = $1`,
        [f!.id],
      ),
    ).rejects.toThrow(/pm_invoices_late_once/);
  });

  it("the database refuses over-allocating an invoice", async () => {
    const [i] = (await pm.api.property.listInvoices({ params: O(), query: { leaseId: ids["R-1"] } })).invoices;
    await expect(
      S.sql(
        "INSERT INTO pm_allocations (id, org_id, invoice_id, amount_minor, source, date) VALUES ('pal_x', $1, $2, $3, 'credit', '2026-10-10')",
        [orgId, i!.id, i!.amountMinor + 1],
      ),
    ).rejects.toThrow(/would be allocated/);
    await refused(
      acct.api.property.recordPayment({
        params: O(),
        body: {
          tenantId: ids["tenant-R-1"]!,
          date: "2026-10-10",
          amountMinor: 5_000_000,
          method: "bank_transfer",
          reference: "TOO-MUCH-1",
          allocations: [{ invoiceId: i!.id, amountMinor: i!.amountMinor + 1 }],
        },
      }),
      400,
    );
  });

  it("refuses roles that may not act", async () => {
    await refused(st.viewer.api.property.listProperties({ params: O() }), 403, "ROLE_NOT_ALLOWED");
    const agent = st.leasing_agent.api.property;
    await refused(
      agent.recordPayment({
        params: O(),
        body: { tenantId: ids["tenant-R-2"]!, date: "2026-10-10", amountMinor: 100, method: "cash", reference: "AG-1" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await refused(
      agent.runBilling({ params: O(), body: { propertyId: B.propertyId, period: "2026-10", kind: "rent" } }),
      403,
    );
    await refused(agent.createProperty({ params: O(), body: { name: "Agent Tower" } }), 403);
    await refused(acct.api.property.createProperty({ params: O(), body: { name: "Accountant Tower" } }), 403);
    await refused(
      acct.api.property.createLease({
        params: O(),
        body: { unitId: B.units["R-4"]!, tenantId: ids["tenant-R-1"]!, startDate: "2026-10-01", rentMinor: 1 },
      }),
      403,
    );
    // the maintenance manager and technician see properties and work orders, never the rent ledger
    await st.maintenance_manager.api.property.listProperties({ params: O() });
    await st.technician.api.property.listWorkOrders({ params: O(), query: {} });
    await refused(st.maintenance_manager.api.property.listInvoices({ params: O(), query: {} }), 403);
    await refused(st.technician.api.property.listLeases({ params: O(), query: {} }), 403);
    await refused(
      st.technician.api.property.createWorkOrder({
        params: O(),
        body: { propertyId: B.propertyId, scope: "Fix the gate" },
      }),
      403,
    );
    // the front desk logs requests but cannot lease
    await st.front_desk.api.property.createRequest({
      params: O(),
      body: { propertyId: B.propertyId, title: "Lift stuck on 3" },
    });
    await refused(st.front_desk.api.property.listLeases({ params: O(), query: {} }), 403);
    // the auditor reads, never records
    await st.auditor.api.property.agedReceivables({ params: O() });
    await refused(
      st.auditor.api.property.recordPayment({
        params: O(),
        body: {
          tenantId: ids["tenant-R-2"]!,
          date: "2026-10-10",
          amountMinor: 100,
          method: "cash",
          reference: "AUD-1",
        },
      }),
      403,
    );
    // portal roles reach nothing of the workspace, and nothing at all until linked to a contact
    const tenantUser = await S.addMember(orgId, admin.api, "tenant");
    await refused(tenantUser.api.property.listInvoices({ params: O(), query: {} }), 403, "ROLE_NOT_ALLOWED");
    await refused(tenantUser.api.property.tenantPortal({ params: O() }), 404);
    await refused(tenantUser.api.property.ownerPortal({ params: O(), query: {} }), 403);
    await refused(pm.api.property.tenantPortal({ params: O() }), 403);
  });

  it("enforces separation of duties in the service", async () => {
    const supplier = await pm.api.contacts.createContact({
      params: O(),
      body: { name: "Kilimani Security", email: "acc@kilisec.example.com" },
    });
    // fd enters a bill: fd cannot approve it; acct approves; acct cannot pay it
    const bill = await fd.api.property.submitBill({
      params: O(),
      body: {
        supplierId: supplier.contact.id,
        propertyId: B.propertyId,
        description: "Guarding October",
        supplierInvoiceNo: "KS-1009",
        billDate: "2026-10-01",
        amountMinor: 1_000_000,
        recoverFrom: "company",
      },
    });
    ids.bill = bill.id;
    await refused(fd.api.property.approveBill({ params: { orgId, billId: bill.id } }), 403, "SEPARATION_OF_DUTIES");
    await acct.api.property.approveBill({ params: { orgId, billId: bill.id } });
    await refused(
      acct.api.property.payBill({
        params: { orgId, billId: bill.id },
        body: { paidDate: "2026-10-10", reference: "OP-1" },
      }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    // the same supplier invoice number twice is refused
    await refused(
      pm.api.property.submitBill({
        params: O(),
        body: {
          supplierId: supplier.contact.id,
          propertyId: B.propertyId,
          description: "Guarding October again",
          supplierInvoiceNo: "ks-1009",
          billDate: "2026-10-02",
          amountMinor: 1_000_000,
          recoverFrom: "company",
        },
      }),
      409,
    );
    // payouts: preparer ≠ approver ≠ releaser
    const funds = await acct.api.property.listOwners({ params: O() });
    expect(funds.owners[0]!.fundsMinor).toBe(0);
    await refused(acct.api.property.preparePayout({ params: O(), body: { ownerId: B.ownerId } }), 409); // nothing to pay
  });

  it("backs separation of duties with database constraints", async () => {
    const [b] = await S.sql<{ id: string; submitted_by: string; approved_by: string }>(
      "SELECT id, submitted_by, approved_by FROM pm_bills WHERE id = $1",
      [ids.bill],
    );
    await expect(S.sql("UPDATE pm_bills SET approved_by = submitted_by WHERE id = $1", [b!.id])).rejects.toThrow(
      /bill_approved_by_second_person/,
    );
    await expect(
      S.sql("UPDATE pm_bills SET paid_by = approved_by, status = 'paid' WHERE id = $1", [b!.id]),
    ).rejects.toThrow(/bill_paid_by_third_person/);
    await S.sql(
      `INSERT INTO pm_payouts (id, org_id, number, owner_id, amount_minor, balance_minor, reserve_minor, as_of, status, prepared_by)
       VALUES ('ppo_t', $1, 'OPY-T', $2, 100, 100, 0, '2026-10-10', 'prepared', $3)`,
      [orgId, B.ownerId, acct.userId],
    );
    await expect(S.sql("UPDATE pm_payouts SET approved_by = prepared_by WHERE id = 'ppo_t'")).rejects.toThrow(
      /payout_approved_by_second_person/,
    );
    await S.sql("UPDATE pm_payouts SET approved_by = $1 WHERE id = 'ppo_t'", [fd.userId]);
    await expect(S.sql("UPDATE pm_payouts SET released_by = approved_by WHERE id = 'ppo_t'")).rejects.toThrow(
      /payout_released_by_other_than_approver/,
    );
    await S.sql(
      `INSERT INTO pm_deposit_refunds (id, org_id, number, lease_id, tenant_id, held_minor, arrears_minor, deductions_minor,
         refund_minor, status, requested_by)
       VALUES ('pdr_t', $1, 'DR-T', $2, $3, 100, 0, 0, 100, 'requested', $4)`,
      [orgId, ids["R-1"], ids["tenant-R-1"], acct.userId],
    );
    await expect(
      S.sql("UPDATE pm_deposit_refunds SET decided_by = requested_by, status = 'approved' WHERE id = 'pdr_t'"),
    ).rejects.toThrow(/deposit_refund_second_person/);
    await expect(S.sql("UPDATE pm_deposit_refunds SET refund_minor = 50 WHERE id = 'pdr_t'")).rejects.toThrow(/check/i);
    await S.sql(
      `INSERT INTO pm_reconciliations (id, org_id, account_code, statement_date, statement_balance_minor, ledger_balance_minor,
         uncleared_in_minor, uncleared_out_minor, unmatched_lines_minor, difference_minor, status, prepared_by)
       VALUES ('prc_t', $1, '1040', '2026-10-01', 0, 0, 0, 0, 0, 0, 'prepared', $2)`,
      [orgId, acct.userId],
    );
    await expect(S.sql("UPDATE pm_reconciliations SET approved_by = prepared_by WHERE id = 'prc_t'")).rejects.toThrow(
      /reconciliation_second_person/,
    );
    // two active leases on one unit for overlapping dates
    await expect(
      S.sql(
        `INSERT INTO pm_leases (id, org_id, number, property_id, unit_id, tenant_id, status, start_date, rent_minor)
         SELECT 'pls_dup', org_id, 'LS-DUP', property_id, unit_id, tenant_id, 'active', '2026-12-01', 1 FROM pm_leases WHERE id = $1`,
        [ids["R-1"]],
      ),
    ).rejects.toThrow(/pm_unit_not_double_let/);
  });

  it("answers 'not found' for another organisation's records", async () => {
    const theirs = other.staff.finance_director;
    const T = { orgId: other.orgId };
    const [inv] = (await pm.api.property.listInvoices({ params: O(), query: {} })).invoices;
    await refused(theirs.api.property.getProperty({ params: { ...T, propertyId: B.propertyId } }), 404);
    await refused(theirs.api.property.getLease({ params: { ...T, leaseId: ids["R-1"]! } }), 404);
    await refused(theirs.api.property.getInvoice({ params: { ...T, invoiceId: inv!.id } }), 404);
    await refused(theirs.api.property.approveBill({ params: { ...T, billId: ids.bill! } }), 404);
    await refused(
      theirs.api.property.ownerStatement({
        params: { ...T, ownerId: B.ownerId },
        query: { from: "2026-01-01", to: "2026-10-10" },
      }),
      404,
    );
    await refused(
      theirs.api.property.recordPayment({
        params: T,
        body: {
          tenantId: ids["tenant-R-1"]!,
          date: "2026-10-10",
          amountMinor: 100,
          method: "cash",
          reference: "X-ORG",
        },
      }),
      404,
    );
    await refused(
      theirs.api.property.createLease({
        params: T,
        body: { unitId: B.units["R-4"]!, tenantId: ids["tenant-R-1"]!, startDate: "2026-10-01", rentMinor: 100 },
      }),
      404,
    );
    await refused(
      theirs.api.property.createCreditNote({
        params: { ...T, invoiceId: inv!.id },
        body: { amountMinor: 1, reason: "Across orgs" },
      }),
      404,
    );
    await refused(theirs.api.property.tenantStatement({ params: { ...T, tenantId: ids["tenant-R-1"]! } }), 404);
    await refused(theirs.api.property.requestDepositRefund({ params: { ...T, leaseId: ids["R-1"]! }, body: {} }), 404);
    // and a non-member reaching into this organisation sees nothing at all
    await refused(theirs.api.property.listProperties({ params: O() }), 404);
    // their billing run does not touch our leases
    const r = await other.staff.property_manager.api.property.runBilling({
      params: T,
      body: { propertyId: other.B.propertyId, period: "2026-10", kind: "rent" },
    });
    expect(r.created).toEqual([]);
    await refused(
      other.staff.property_manager.api.property.runBilling({
        params: T,
        body: { propertyId: B.propertyId, period: "2026-10", kind: "rent" },
      }),
      404,
    );
  });

  it("follows the plan: modules and the building allowance", async () => {
    const small = await S.newOrg({ product: "property", plan: "PM-STARTER", trial: false });
    const T = { orgId: small.orgId };
    const mgr = await S.addMember(small.orgId, small.admin.api, "property_manager");
    await mgr.api.property.createProperty({ params: T, body: { name: "Only Building" } });
    await refused(
      mgr.api.property.createProperty({ params: T, body: { name: "Second Building" } }),
      402,
      "ALLOWANCE_EXCEEDED",
    );
    // the Standard plan has no CRM module: enquiries are refused with what it would cost
    const e = await refused(
      mgr.api.property.createEnquiry({ params: T, body: { name: "New Lead", email: "lead@example.com" } }),
      403,
      "MODULE_NOT_ENTITLED",
    );
    expect(e.details.module).toBe("crm");
  });
});
