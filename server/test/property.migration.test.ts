// The Property Management migration domain on the shared engine, with the front end's own sample export
// (FE/samples/accounting-export: account list, customers, vendors, recurring rent, open invoices, deposits, unpaid
// bills, trial balance). The building and its units are set up in PALTAS first; the owner whose funds the trial balance
// holds comes in a small owners file. Every stage: detect, map, validate (duplicates, an ended lease, the total line,
// owner funds without an owner), resolve, dry run, approval by a second person, import, reconcile, sign-off — then the
// opening balances equal the trial balance, the clearing account is zero, and the imported leases bill like any other.
// Running the same export again creates nothing new.
import { readFileSync } from "node:fs";
import type { PaltasClient } from "@paltas/api-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upload, waitFor } from "./support/migration-fixtures.js";
import { pmOrg, setUpBuilding, startPropertyServer, tbBalance, type PmStaff } from "./support/property-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";

const CUTOVER = "2026-10-01";
const SAMPLE_FILES = [
  "Account List.csv",
  "Customer Contact List.csv",
  "Vendor Contact List.csv",
  "Recurring Template List.csv",
  "Open Invoices.csv",
  "Tenant Security Deposits QuickReport.csv",
  "Unpaid Bills.csv",
  "Trial Balance.csv",
];
// a copy of FE/samples/accounting-export, so the test runs in this repository on its own
const sample = (name: string) => readFileSync(new URL(`./fixtures/accounting-export/${name}`, import.meta.url));
const OWNERS = Buffer.from("Owner,Email,Phone\nMwangaza Holdings,accounts@mwangaza.example.com,0722 555 010\n");

const t = (source: string, field: string, transforms: unknown[] = [{ op: "trim" }]) => ({ source, field, transforms });
const MAPPINGS: Record<string, { entity: string; columns: ReturnType<typeof t>[] }> = {
  "Account List.csv": {
    entity: "account",
    columns: [
      t("Account", "source_record_id"),
      t("Account", "name"),
      t("Type", "type"),
      t("Detail Type", "detail_type"),
      t("Description", "description"),
      t("Balance", "balance"),
    ],
  },
  "Owners.csv": {
    entity: "owner",
    columns: [t("Owner", "source_record_id"), t("Owner", "name"), t("Email", "email"), t("Phone", "phone")],
  },
  "Customer Contact List.csv": {
    entity: "tenant",
    columns: [
      t("Customer", "source_record_id"),
      t("Full Name", "name"),
      t("Email", "email"),
      t("Phone Numbers", "phone"),
      t("Billing Address", "address"),
    ],
  },
  "Vendor Contact List.csv": {
    entity: "vendor",
    columns: [
      t("Vendor", "source_record_id"),
      t("Vendor", "name"),
      t("Email", "email"),
      t("Phone Numbers", "phone"),
      t("Tax ID", "tax_id"),
    ],
  },
  "Recurring Template List.csv": {
    entity: "lease",
    columns: [
      t("Template Name", "source_record_id"),
      t("Customer", "tenant_ref"),
      t("Template Name", "migrated_unit_no", [{ op: "extract", pattern: "^Rent\\s+(\\S+)" }]),
      t("Amount", "rent"),
      t("Memo", "start_date", [{ op: "extract", pattern: "(\\d{4}-\\d{2}-\\d{2})\\s+to" }]),
      t("Memo", "end_date", [{ op: "extract", pattern: "to\\s+(\\d{4}-\\d{2}-\\d{2})" }]),
      t("Interval", "due_day", [{ op: "extract", pattern: "day\\s+(\\d+)" }]),
    ],
  },
  "Open Invoices.csv": {
    entity: "opening_invoice",
    columns: [
      t("Num", "source_record_id"),
      t("Customer", "tenant_ref"),
      t("Date", "issue_date"),
      t("Due date", "due_date"),
      t("Open balance", "amount"),
      t("Amount", "original_amount"),
    ],
  },
  "Tenant Security Deposits QuickReport.csv": {
    entity: "deposit",
    columns: [t("Customer", "source_record_id"), t("Customer", "tenant_ref"), t("Amount", "amount")],
  },
  "Unpaid Bills.csv": {
    entity: "bill",
    columns: [
      t("Num", "source_record_id"),
      t("Vendor", "supplier_ref"),
      t("Num", "supplier_invoice_no"),
      t("Date", "bill_date"),
      t("Due date", "due_date"),
      t("Open balance", "amount"),
      t("Memo", "description"),
    ],
  },
  "Trial Balance.csv": {
    entity: "trial_balance",
    columns: [
      t("Account", "source_record_id"),
      t("Account", "account"),
      t("Debit", "debit"),
      t("Credit", "credit"),
      t("Account", "paltas_account", [
        {
          op: "enum",
          map: {
            "Kilimani Heights Trust Account": "1040",
            "Accounts Receivable (A/R)": "1120",
            "Tenant Security Deposits": "2300",
            "Owner Funds - Mwangaza Holdings": "2250",
            "Accounts Payable (A/P)": "2000",
            TOTAL: "skip",
          },
        },
      ]),
    ],
  },
};

describe("Property Management data migration (FE sample accounting export)", () => {
  let S: TestServer;
  let orgId: string;
  let st: PmStaff;
  let admin: Person;
  let fd: Person;
  let pm: Person;
  let jobId: string;
  let propertyId: string;
  const P = () => ({ orgId, jobId });

  async function uploadAndMap(api: PaltasClient, id: string) {
    for (const f of SAMPLE_FILES) await upload(api, orgId, id, f, sample(f));
    await upload(api, orgId, id, "Owners.csv", OWNERS);
    const detected = await api.migration.detect({ params: { orgId, jobId: id } });
    const { tables } = await api.migration.listTables({ params: { orgId, jobId: id } });
    for (const table of tables) {
      const m = MAPPINGS[table.name];
      if (!m) throw new Error(`No mapping for ${table.name}`);
      await api.migration.mapTable({ params: { orgId, jobId: id, tableId: table.id }, body: m as never });
    }
    return detected;
  }

  const rowOf = async (api: PaltasClient, entity: string, sourceRecordId: string) =>
    (await api.migration.listRows({ params: P(), query: { entity, sourceRecordId } })).rows;

  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-10-02");
    const o = await pmOrg(S, { name: "Kilimani Agents" });
    orgId = o.orgId;
    st = o.staff;
    admin = o.admin;
    fd = st.finance_director;
    pm = st.property_manager;
    // the building is set up in PALTAS first (the workspace's building set-up), with its units
    const B = await setUpBuilding(orgId, pm, {
      name: "Kilimani Heights",
      units: ["KH-1A", "KH-1B", "KH-2A", "KH-2B", "KH-3A", "KH-3B", "KH-4A"],
    });
    propertyId = B.propertyId;
  });
  afterAll(() => S.close());

  it("offers the Property Management domain with its built-in accounting-export profile", async () => {
    const { domains } = await admin.api.migration.listDomains({ params: { orgId } });
    const pmDomain = domains.find((d) => d.key === "property")!;
    expect(pmDomain.entities.map((e) => e.name)).toEqual([
      "account",
      "property",
      "unit",
      "owner",
      "tenant",
      "vendor",
      "lease",
      "opening_invoice",
      "deposit",
      "bill",
      "trial_balance",
      "historical_summary",
    ]);
    expect(pmDomain.accounts.map((a) => a.code).sort()).toEqual(["1040", "1120", "2250", "2300", "3900"]);
    const { profiles } = await admin.api.migration.listProfiles({ params: { orgId }, query: { domain: "property" } });
    expect(profiles.map((p) => p.name)).toContain("Accounting software export (QuickBooks-style)");
    await refused(
      pm.api.migration.createJob({
        params: { orgId },
        body: { domain: "property", name: "Not allowed", sourceSystem: "qb", cutoverDate: CUTOVER },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
  });

  it("detects the files, then validates: duplicates, the ended lease, the total line and owner funds need decisions", async () => {
    const profile = (
      await admin.api.migration.listProfiles({ params: { orgId }, query: { domain: "property" } })
    ).profiles.find((p) => p.builtIn)!;
    const job = await admin.api.migration.createJob({
      params: { orgId },
      body: {
        domain: "property",
        name: "Move from QuickBooks",
        sourceSystem: "QuickBooks",
        profileId: profile.id,
        cutoverDate: CUTOVER,
      },
    });
    jobId = job.id;
    const detected = await uploadAndMap(admin.api, jobId);
    const guessed = Object.fromEntries(detected.tables.map((x) => [x.name, x.entity]));
    expect(guessed).toMatchObject({
      "Account List.csv": "account",
      "Customer Contact List.csv": "tenant",
      "Vendor Contact List.csv": "vendor",
      "Recurring Template List.csv": "lease",
      "Open Invoices.csv": "opening_invoice",
      "Unpaid Bills.csv": "bill",
      "Trial Balance.csv": "trial_balance",
    });
    const v = await admin.api.migration.validate({ params: P() });
    expect(v.blocking).toBe(true);
    expect(v.byCode).toMatchObject({
      DUPLICATE: 4, // Joseph Mwangi twice: same email, same phone
      EXACT_DUPLICATE: 1, // invoice 1205 listed twice
      LEASE_ENDED: 1, // KH-3A ended 31 Aug but rent continues
      TB_TOTAL_LINE: 1,
      TB_OWNER_NEEDED: 1,
    });
    expect(v.byCode.TB_DETAIL_MISMATCH).toBeUndefined(); // receivables, deposits and payables agree with the detail
    expect(v.byCode.TB_NOT_BALANCED).toBeUndefined();
  });

  it("resolves: merge the duplicate customer, import the ended lease as periodic, skip the total line, name the owner", async () => {
    const [joseph] = await rowOf(admin.api, "tenant", "Kilimani Heights:KH-2B Joseph Mwangi");
    const [dup] = await rowOf(admin.api, "tenant", "Joseph Mwangi");
    await admin.api.migration.resolveRow({
      params: { ...P(), rowId: dup!.id },
      body: { action: "merge", intoRowId: joseph!.id, reason: "Same tenant listed without his unit" },
    });
    const [kh3a] = await rowOf(admin.api, "lease", "Rent KH-3A");
    await admin.api.migration.resolveRow({
      params: { ...P(), rowId: kh3a!.id },
      body: { action: "correct", values: { end_date: "" } },
    });
    const [total] = await rowOf(admin.api, "trial_balance", "TOTAL");
    await admin.api.migration.resolveRow({
      params: { ...P(), rowId: total!.id },
      body: { action: "skip", reason: "The export's total line" },
    });
    const [funds] = await rowOf(admin.api, "trial_balance", "Owner Funds - Mwangaza Holdings");
    const r = await admin.api.migration.resolveRow({
      params: { ...P(), rowId: funds!.id },
      body: { action: "correct", values: { owner_ref: "Mwangaza Holdings" } },
    });
    expect(r.validation.errors).toBe(0);
  });

  it("dry run: the opening entry balances and the clearing account nets to zero; approval needs a second person", async () => {
    const d = await admin.api.migration.dryRun({ params: P() });
    expect(Object.fromEntries(d.byEntity.map((e) => [e.entity, e.create]))).toMatchObject({
      account: 7,
      owner: 1,
      tenant: 7,
      vendor: 3,
      lease: 7,
      opening_invoice: 3,
      deposit: 7,
      bill: 2,
      trial_balance: 5,
    });
    const ledger = Object.fromEntries(d.ledger.map((l) => [l.account, l.debitMinor - l.creditMinor]));
    expect(ledger).toEqual({
      "1040": 107_940_000,
      "1120": 13_200_000,
      "2000": -5_740_000,
      "2250": -35_000_000,
      "2300": -80_400_000,
      "3900": 0,
    });
    await refused(
      admin.api.migration.approve({ params: P(), body: { confirm: "CONFIRM" } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await fd.api.migration.approve({ params: P(), body: { confirm: "CONFIRM" } });
  });

  it("imports, reconciles and signs off; the opening balances equal the trial balance", async () => {
    await admin.api.migration.startImport({ params: P() });
    const job = await waitFor(
      () => admin.api.migration.getJob({ params: P() }),
      (j) => j.status !== "importing" && j.status !== "approved",
    );
    expect(job.status).toBe("reconciled");
    expect(job.reconciliation!.ok).toBe(true);
    await refused(
      fd.api.migration.complete({ params: P(), body: { confirm: "CONFIRM" } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    expect((await admin.api.migration.complete({ params: P(), body: { confirm: "CONFIRM" } })).status).toBe(
      "completed",
    );

    expect(await tbBalance(fd, orgId, "1040")).toBe(107_940_000);
    expect(await tbBalance(fd, orgId, "1120")).toBe(13_200_000);
    expect(await tbBalance(fd, orgId, "2300")).toBe(-80_400_000);
    expect(await tbBalance(fd, orgId, "2250")).toBe(-35_000_000);
    expect(await tbBalance(fd, orgId, "3900")).toBe(0);
    // tenants, owner and suppliers are in the ONE contact store, with their roles
    const tenants = await pm.api.contacts.listContacts({ params: { orgId }, query: { type: "tenant" } });
    expect(tenants.contacts.map((c) => c.name).sort()).toEqual([
      "Grace Njoki",
      "Halima Abdi",
      "Joseph Mwangi",
      "Mary Atieno",
      "Otieno Omondi",
      "Samuel Kiptoo",
      "Wanjiru Kamau",
    ]);
    const suppliers = await pm.api.contacts.listContacts({ params: { orgId }, query: { type: "supplier" } });
    expect(suppliers.contacts.length).toBe(3);
    // the leases are on the units set up in PALTAS; KH-3A and KH-3B are periodic
    const { leases } = await pm.api.property.listLeases({ params: { orgId }, query: { propertyId } });
    expect(leases.length).toBe(7);
    expect(leases.every((l) => l.status === "active" && l.migrated)).toBe(true);
    expect(
      leases
        .filter((l) => l.endDate === null)
        .map((l) => l.unitNo)
        .sort(),
    ).toEqual(["KH-3A", "KH-3B"]);
    // the deposits held per lease come from the deposits report
    const held = Object.fromEntries(leases.map((l) => [l.unitNo, l.depositHeldMinor]));
    expect(held).toMatchObject({ "KH-1A": 11_000_000, "KH-4A": 13_000_000 });
    // the dashboard's figures equal the ledger, owner funds belong to the named owner
    const dash = await pm.api.property.dashboard({ params: { orgId }, query: {} });
    expect(dash.arrears.totalMinor).toBe(13_200_000);
    expect(Object.values(dash.ledger).every((c) => c.agrees)).toBe(true);
    const cm = await fd.api.property.clientMoney({ params: { orgId } });
    expect(cm.owners.map((o) => [o.name, o.fundsMinor])).toEqual([["Mwangaza Holdings", 35_000_000]]);
    expect(cm.unassignedOwnerFundsMinor).toBe(0);
  });

  it("the migrated books work: rent bills on migrated leases, an opening invoice is paid without crediting the owner twice", async () => {
    // the owner's agreement for the building is the one set up with it; October rent bills every migrated lease
    const run = await pm.api.property.runBilling({
      params: { orgId },
      body: { propertyId, period: "2026-10", kind: "rent" },
    });
    expect(run.created.length).toBe(7);
    const samuel = (await pm.api.contacts.listContacts({ params: { orgId }, query: { q: "Samuel" } })).contacts[0]!;
    const before = await tbBalance(fd, orgId, "2250");
    const p = await st.accountant.api.property.recordPayment({
      params: { orgId },
      body: {
        tenantId: samuel.id,
        date: "2026-10-02",
        amountMinor: 2_000_000,
        method: "bank_transfer",
        reference: "KH1B-ARREARS",
      },
    });
    // the oldest is the September invoice brought over (already the owner's in the old books): no owner credit
    expect(p.allocations[0]!.invoiceNumber).toBe("OB-1187");
    expect(await tbBalance(fd, orgId, "2250")).toBe(before);
    const ownerId = (await fd.api.property.clientMoney({ params: { orgId } })).owners[0]!.ownerId;
    const s = await fd.api.property.ownerStatement({
      params: { orgId, ownerId },
      query: { from: "2026-10-01", to: "2026-10-31" },
    });
    expect(s).toMatchObject({ openingBroughtForwardMinor: 35_000_000, agrees: true });
  });

  it("running the same export again creates nothing new", async () => {
    const job = await admin.api.migration.createJob({
      params: { orgId },
      body: { domain: "property", name: "Same export again", sourceSystem: "QuickBooks", cutoverDate: CUTOVER },
    });
    jobId = job.id;
    await uploadAndMap(admin.api, jobId);
    const v = await admin.api.migration.validate({ params: P() });
    expect(v.byCode.ALREADY_PRESENT).toBeGreaterThan(30);
    const [dup] = await rowOf(admin.api, "tenant", "Joseph Mwangi");
    const [joseph] = (await pm.api.contacts.listContacts({ params: { orgId }, query: { q: "Joseph" } })).contacts;
    await admin.api.migration.resolveRow({
      params: { ...P(), rowId: dup!.id },
      body: { action: "merge", intoTargetId: joseph!.id, reason: "Already imported as KH-2B's tenant" },
    });
    const [total] = await rowOf(admin.api, "trial_balance", "TOTAL");
    const r = await admin.api.migration.resolveRow({
      params: { ...P(), rowId: total!.id },
      body: { action: "skip", reason: "The export's total line" },
    });
    expect(r.validation.errors).toBe(0);
    const d = await admin.api.migration.dryRun({ params: P() });
    expect(d.wouldCreate).toBe(0);
    expect(d.ledger).toEqual([]);
  });
});
