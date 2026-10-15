// A property developer moves from spreadsheets and other software into PALTAS, through every stage of the
// migration engine, with real files (CSV, XLSX, JSON, a ZIP of site records and documents), real PostgreSQL and
// the typed client. Then the same export is imported again and creates nothing new.
import type { PaltasClient } from "@paltas/api-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { development } from "../dist/products/development/index.js";
import { developmentExport, migrationSettings, upload, waitFor } from "./support/migration-fixtures.js";
import { refused, startServer, type Person, type TestServer } from "./support/test-server.js";

const CUTOVER = "2026-09-30";
const PROFILE = {
  settings: { dateFormat: "YYYY-MM-DD" as const },
  entityHints: { buyer: ["buyers"] },
  aliases: { buyer: { source_record_id: ["contact id"], phone: ["mobile phone"], national_id: ["id/passport"] } },
  enums: { "buyer.party_type": { person: "individual", organisation: "company" } },
};
const EXPECTED_ENTITIES: Record<string, number> = {
  project: 2,
  phase: 2,
  building: 2,
  floor: 3,
  unit: 5,
  buyer: 3,
  investor: 1,
  reservation: 4,
  contract: 3,
  amendment: 1,
  instalment: 8,
  payment: 7,
  allocation: 6,
  supplier: 2,
  contractor: 2,
  opening_balance: 5,
  purchase_order: 2,
  work_order: 1,
  milestone: 2,
  handover: 1,
  defect: 1,
  dispute: 1,
  correspondence: 1,
};
const TOTAL_RECORDS = Object.values(EXPECTED_ENTITIES).reduce((a, b) => a + b, 0);

describe("data migration: Real Estate Development, end to end", () => {
  let S: TestServer;
  let orgId: string;
  let admin: Person;
  let fd: Person;
  let viewer: Person;
  let agent: Person;
  let accountant: Person;
  let jobId: string;
  let profileId: string;
  const P = () => ({ orgId, jobId });
  const count = async (table: string) =>
    Number((await S.sql(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgId]))[0].n);

  const OPENING_BALANCE_COLUMNS = [
    { source: "Ref", field: "source_record_id", transforms: [{ op: "trim" as const }] },
    { source: "Type", field: "kind", transforms: [{ op: "lower" as const }] },
    { source: "Contract", field: "contract_ref", transforms: [] },
    { source: "Reservation", field: "reservation_ref", transforms: [] },
    { source: "Supplier", field: "supplier_ref", transforms: [] },
    { source: "Balance date", field: "as_of", transforms: [{ op: "date" as const, format: "DD/MM/YYYY" as const }] },
    {
      source: "Amount",
      field: "amount",
      transforms: [{ op: "number" as const, decimalSeparator: "," as const, thousandsSeparator: "." as const }],
    },
    { source: "Note", field: "memo", transforms: [] },
  ];

  async function mapOpeningBalances(api: PaltasClient, id: string) {
    const { tables } = await api.migration.listTables({ params: { orgId, jobId: id } });
    const ob = tables.find((t) => t.name === "opening-balances.csv")!;
    return api.migration.mapTable({
      params: { orgId, jobId: id, tableId: ob.id },
      body: { entity: "opening_balance", columns: OPENING_BALANCE_COLUMNS },
    });
  }

  /** Upload the export, read it, confirm the one mapping detection cannot guess. */
  async function prepare(api: PaltasClient, id: string) {
    for (const f of developmentExport().files) await upload(api, orgId, id, f.name, f.data);
    await api.migration.detect({ params: { orgId, jobId: id } });
    await mapOpeningBalances(api, id);
  }

  async function resolveAll(api: PaltasClient, id: string, buyerTarget?: string) {
    const rows = (q: Record<string, string>) =>
      api.migration.listRows({ params: { orgId, jobId: id }, query: q }).then((r) => r.rows);
    const [b4] = await rows({ entity: "buyer", sourceRecordId: "B-004" });
    if (buyerTarget)
      await api.migration.resolveRow({
        params: { orgId, jobId: id, rowId: b4!.id },
        body: { action: "merge", intoTargetId: buyerTarget, reason: "Same person as B-001 already in PALTAS" },
      });
    else {
      const [b1] = await rows({ entity: "buyer", sourceRecordId: "B-001" });
      await api.migration.resolveRow({
        params: { orgId, jobId: id, rowId: b4!.id },
        body: { action: "merge", intoRowId: b1!.id, reason: "Same person entered twice in the CRM" },
      });
    }
    if (buyerTarget) {
      // the source still holds CTR-003's wrong balance: the same correction is made again
      const [c3] = await rows({ entity: "contract", sourceRecordId: "CTR-003" });
      await api.migration.resolveRow({
        params: { orgId, jobId: id, rowId: c3!.id },
        body: { action: "correct", values: { reported_balance: "5000000" } },
      });
    }
    const [p8] = await rows({ entity: "payment", sourceRecordId: "PAY-008" });
    await api.migration.resolveRow({
      params: { orgId, jobId: id, rowId: p8!.id },
      body: { action: "skip", reason: "Test receipt against a contract that never existed" },
    });
    const docs = (await api.migration.listDocuments({ params: { orgId, jobId: id }, query: { status: "review" } }))
      .documents;
    const scan = docs.find((d) => d.filename === "scan-0007.pdf")!;
    await api.migration.resolveDocument({
      params: { orgId, jobId: id, documentId: scan.id },
      body: { action: "link", entity: "contract", sourceRecordId: "CTR-003" },
    });
    const joint = docs.find((d) => d.filename === "B-001_B-002_joint_letter.pdf")!;
    return api.migration.resolveDocument({
      params: { orgId, jobId: id, documentId: joint.id },
      body: { action: "exclude", reason: "Concerns two buyers; filed outside PALTAS" },
    });
  }

  beforeAll(async () => {
    S = await startServer({ products: [development], config: { migration: migrationSettings() } });
    const o = await S.newOrg({ name: "Mto Developers", product: "developer", plan: "DEV-PRO", trial: false });
    orgId = o.orgId;
    admin = o.admin;
    fd = await S.addMember(orgId, admin.api, "finance_director");
    viewer = await S.addMember(orgId, admin.api, "viewer");
    agent = await S.addMember(orgId, admin.api, "sales_agent");
    accountant = await S.addMember(orgId, admin.api, "accountant");
  });
  afterAll(() => S.close());

  it("offers the Development domain and source-system profiles, and saves the organisation's own profile", async () => {
    const { domains } = await admin.api.migration.listDomains({ params: { orgId } });
    expect(domains.map((d) => d.key)).toEqual(["development"]);
    const dev = domains[0]!;
    expect(dev.entities.map((e) => e.name)).toEqual(
      Object.keys(EXPECTED_ENTITIES).sort(
        (a, b) => dev.entities.findIndex((e) => e.name === a) - dev.entities.findIndex((e) => e.name === b),
      ),
    );
    expect(dev.entities.find((e) => e.name === "buyer")!.duplicateKeys).toEqual([
      ["email"],
      ["phone"],
      ["national_id"],
    ]);
    expect(dev.accounts.map((a) => a.code)).toEqual(["1170", "2400", "3900"]);
    const built = await admin.api.migration.listProfiles({ params: { orgId }, query: { domain: "development" } });
    expect(built.profiles.filter((p) => p.builtIn).map((p) => p.name)).toEqual([
      "Accounting software CSV export",
      "CRM contacts CSV",
      "Generic spreadsheet",
      "Project management export",
    ]);
    const saved = await admin.api.migration.saveProfile({
      params: { orgId },
      body: {
        domain: "development",
        name: "Mto legacy export",
        description: "Our CRM and sales sheets",
        config: PROFILE,
      },
    });
    profileId = saved.id;
    expect(saved.builtIn).toBe(false);
    await refused(
      admin.api.migration.saveProfile({
        params: { orgId },
        body: { domain: "development", name: "Bad", description: "", config: { ...PROFILE, aliases: { villa: {} } } },
      }),
      400,
    );
    // the chart now has the Development accounts
    const { accounts } = await fd.api.ledger.listAccounts({ params: { orgId } });
    expect(accounts.filter((a) => ["1170", "2400", "3900"].includes(a.code)).length).toBe(3);
  });

  it("refuses roles that may not run a migration", async () => {
    const body = { domain: "development", name: "Not allowed", sourceSystem: "legacy", cutoverDate: CUTOVER };
    await refused(viewer.api.migration.createJob({ params: { orgId }, body }), 403, "ROLE_NOT_ALLOWED");
    await refused(agent.api.migration.createJob({ params: { orgId }, body }), 403, "ROLE_NOT_ALLOWED");
    await refused(accountant.api.migration.createJob({ params: { orgId }, body }), 403, "ROLE_NOT_ALLOWED");
    await refused(viewer.api.migration.listJobs({ params: { orgId } }), 403, "ROLE_NOT_ALLOWED");
  });

  it("source selected → files uploaded → detected → mapped", async () => {
    const job = await admin.api.migration.createJob({
      params: { orgId },
      body: {
        domain: "development",
        name: "Move from spreadsheets",
        sourceSystem: "Mto-Legacy",
        profileId,
        cutoverDate: CUTOVER,
      },
    });
    jobId = job.id;
    expect([job.status, job.number, job.sourceSystem, job.currency]).toEqual([
      "created",
      "MIG-00001",
      "mto-legacy",
      "KES",
    ]);
    const files = developmentExport().files;
    for (const f of files.slice(0, -1)) {
      const r = await upload(admin.api, orgId, jobId, f.name, f.data);
      expect(r.file.status).toBe("stored");
    }
    const z = await upload(admin.api, orgId, jobId, "site-and-documents.zip", files.at(-1)!.data);
    expect(z.file.detectedType).toBe("zip");
    const byName = Object.fromEntries(z.extracted.map((f) => [f.filename, f]));
    expect(byName["milestones.csv"]!.status).toBe("stored");
    expect(byName["CTR-001_signed.pdf"]!.detectedType).toBe("pdf");
    expect(byName["broken.pdf"]!.status).toBe("refused");
    expect(byName["notes.docx"]!.status).toBe("refused");
    expect(byName["old-export.zip"]!.refusal).toMatch(/inside the archive are not opened/);
    expect(byName["._scan-0007.pdf"]!.refusal).toMatch(/system file/);
    expect((await admin.api.migration.getJob({ params: P() })).status).toBe("uploaded");

    const { tables, documents } = await admin.api.migration.detect({ params: P() });
    const entityOf = Object.fromEntries(tables.map((t) => [t.name, t.entity]));
    expect(entityOf).toMatchObject({
      "projects.csv": "project",
      "inventory.xlsx · Phases": "phase",
      "inventory.xlsx · Blocks": "building",
      "inventory.xlsx · Floors": "floor",
      "inventory.xlsx · Units": "unit",
      "buyers.csv": "buyer",
      "sales.xlsx · Reservations": "reservation",
      "sales.xlsx · Contracts": "contract",
      "sales.xlsx · Amendments": "amendment",
      "sales.xlsx · Instalments": "instalment",
      "receipts.json · payments": "payment",
      "receipts.json · allocations": "allocation",
      "procurement.xlsx · Suppliers": "supplier",
      "procurement.xlsx · Contractors": "contractor",
      "procurement.xlsx · Purchase Orders": "purchase_order",
      "procurement.xlsx · Work Orders": "work_order",
      "milestones.csv": "milestone",
      "handovers.csv": "handover",
      "defects.csv": "defect",
      "disputes.csv": "dispute",
      "correspondence.csv": "correspondence",
      "investors.csv": "investor",
      "manifest.csv": "document_manifest",
    });
    const units = tables.find((t) => t.name === "inventory.xlsx · Units")!;
    expect(units.rowCount).toBe(6);
    expect(units.sample[0]).toMatchObject({ "Unit ID": "U-A101", Area: "85.5", "List Price": "12500000" });
    const phases = tables.find((t) => t.name === "inventory.xlsx · Phases")!;
    expect(phases.sample[0]!["Start Date"]).toBe("2025-01-15"); // date-formatted spreadsheet cell
    const buyers = tables.find((t) => t.name === "buyers.csv")!;
    expect(buyers.mapping.map((m) => m.field)).toEqual(
      expect.arrayContaining(["source_record_id", "name", "email", "phone", "national_id", "party_type"]),
    );
    expect(documents.map((d) => [d.filename, d.status]).sort()).toEqual([
      ["B-001_B-002_joint_letter.pdf", "review"],
      ["CTR-001_signed.pdf", "review"],
      ["U-B101_floorplan.png", "review"],
      ["broken.pdf", "corrupt"],
      ["handover-photo.jpg", "review"],
      ["notes.docx", "unsupported"],
      ["scan-0007.pdf", "review"],
    ]);
    expect((await admin.api.migration.getJob({ params: P() })).status).toBe("detected");

    // validation needs every table mapped: the opening balances need explicit transforms
    await prepareMapping();
    expect((await admin.api.migration.getJob({ params: P() })).status).toBe("mapped");
  });

  async function prepareMapping() {
    const { tables } = await admin.api.migration.listTables({ params: P() });
    const ob = tables.find((t) => t.name === "opening-balances.csv")!;
    // required fields must be mapped
    await refused(
      admin.api.migration.mapTable({
        params: { ...P(), tableId: ob.id },
        body: { entity: "opening_balance", columns: [{ source: "Amount", field: "amount", transforms: [] }] },
      }),
      400,
    );
    await mapOpeningBalances(admin.api, jobId);
  }

  it("validated: duplicates, a broken reference, a balance that does not add up and documents needing review", async () => {
    const v = await admin.api.migration.validate({ params: P() });
    expect(v.blocking).toBe(true);
    expect(v.byCode).toMatchObject({
      DUPLICATE: 6, // B-001 and B-004: same email, phone and ID
      BROKEN_REFERENCE: 1, // PAY-008 → CTR-999
      BALANCE_MISMATCH: 1, // CTR-003 says 5,100,000.00; price − payments = 5,000,000.00
      DOCUMENT_REVIEW: 2, // no match / two matches
      EXACT_DUPLICATE: 1, // U-B102 listed twice
      DOCUMENT_CORRUPT: 1,
      DOCUMENT_UNSUPPORTED: 1,
    });
    expect(v.errors).toBe(10);
    const { issues } = await admin.api.migration.listIssues({ params: P(), query: { code: "BALANCE_MISMATCH" } });
    expect(issues[0]).toMatchObject({ entity: "contract", sourceRecordId: "CTR-003", field: "reported_balance" });
    expect(issues[0]!.message).toContain("800000000 − net payments 300000000 = 500000000");
    const broken = await admin.api.migration.listIssues({ params: P(), query: { code: "BROKEN_REFERENCE" } });
    expect(broken.issues[0]!.message).toMatch(/Sales contract CTR-999 is not in the upload or in PALTAS/);
    expect((await admin.api.migration.getJob({ params: P() })).status).toBe("validated");
    // a dry run waits until every error is resolved
    await refused(admin.api.migration.dryRun({ params: P() }), 409);
    // auto-linked documents
    const linked = (await admin.api.migration.listDocuments({ params: P(), query: { status: "linked" } })).documents;
    expect(linked.map((d) => [d.filename, d.linkEntity, d.linkSourceId, d.linkMode]).sort()).toEqual([
      ["CTR-001_signed.pdf", "contract", "CTR-001", "auto"],
      ["U-B101_floorplan.png", "unit", "U-B101", "auto"],
      ["handover-photo.jpg", "handover", "HO-001", "auto"],
    ]);
    const review = (await admin.api.migration.listDocuments({ params: P(), query: { status: "review" } })).documents;
    expect(review.find((d) => d.filename === "B-001_B-002_joint_letter.pdf")!.candidates).toEqual([
      { entity: "buyer", sourceRecordId: "B-001" },
      { entity: "buyer", sourceRecordId: "B-002" },
    ]);
  });

  it("resolved: merge, skip, correct and document decisions — the viewer cannot make them", async () => {
    const [ctr3] = (
      await admin.api.migration.listRows({ params: P(), query: { entity: "contract", sourceRecordId: "CTR-003" } })
    ).rows;
    await refused(
      viewer.api.migration.resolveRow({
        params: { ...P(), rowId: ctr3!.id },
        body: { action: "correct", values: { reported_balance: "5000000" } },
      }),
      403,
    );
    const fixed = await admin.api.migration.resolveRow({
      params: { ...P(), rowId: ctr3!.id },
      body: { action: "correct", values: { reported_balance: "5000000" } },
    });
    expect(fixed.row.status).toBe("valid");
    expect(fixed.row.data!.reported_balance).toBe(500_000_000);
    expect(fixed.validation.byCode.BALANCE_MISMATCH).toBeUndefined();

    const doc = await resolveAll(admin.api, jobId);
    expect(doc.status).toBe("excluded");
    const job = await admin.api.migration.getJob({ params: P() });
    expect(job.status).toBe("resolved");
    expect(job.validation!.errors).toBe(0);
    expect(job.counts).toMatchObject({ skipped: 1, merged: 2, errors: 0, documentsInReview: 0 });
    // B-004's reservation now points at B-001
    const [r3] = (
      await admin.api.migration.listRows({ params: P(), query: { entity: "reservation", sourceRecordId: "R-003" } })
    ).rows;
    expect(r3!.issues).toEqual([]);
  });

  it("dry run simulates everything and writes nothing", async () => {
    const journalsBefore = await count("journal_entries");
    const auditBefore = await count("audit_log");
    const d = await admin.api.migration.dryRun({ params: P() });
    expect(d.rolledBack).toBe(true);
    expect(d.wouldCreate).toBe(TOTAL_RECORDS);
    expect(Object.fromEntries(d.byEntity.map((e) => [e.entity, e.create]))).toEqual(EXPECTED_ENTITIES);
    const money = (e: string) => d.byEntity.find((x) => x.entity === e)!.money;
    expect(money("contract").price).toBe(3_550_000_000);
    expect(money("payment").amount).toBe(1_810_000_000);
    expect(money("instalment").amount).toBe(3_600_000_000);
    expect(money("opening_balance").amount).toBe(1_275_000_000);
    expect(d.documents).toEqual({ linked: 4, unlinked: 0, excluded: 1 });
    expect(d.ledger).toEqual([
      { account: "1170", name: "Buyer receivables", debitMinor: 1_200_000_000, creditMinor: 0 },
      { account: "2000", name: "Accounts payable (suppliers)", debitMinor: 0, creditMinor: 45_000_000 },
      { account: "2400", name: "Buyer deposits held", debitMinor: 0, creditMinor: 30_000_000 },
      { account: "3900", name: "Opening balance equity", debitMinor: 0, creditMinor: 1_125_000_000 },
    ]);
    // nothing written: no records, no journals, no batches; only the dry run's own audit entry
    for (const t of [
      "dev_projects",
      "dev_units",
      "dev_contacts",
      "dev_contracts",
      "dev_payments",
      "dev_opening_balances",
      "dev_documents",
    ])
      expect(await count(t)).toBe(0);
    expect(await count("journal_entries")).toBe(journalsBefore);
    expect(await count("mig_batches")).toBe(0);
    expect(await count("audit_log")).toBe(auditBefore + 1);
    expect((await admin.api.migration.getJob({ params: P() })).status).toBe("dry_run");
  });

  it("approval: never by the person who ran the dry run, never by a viewer or sales agent", async () => {
    await refused(admin.api.migration.startImport({ params: P() }), 409);
    await refused(
      admin.api.migration.approve({ params: P(), body: { confirm: "CONFIRM" } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await refused(viewer.api.migration.approve({ params: P(), body: { confirm: "CONFIRM" } }), 403, "ROLE_NOT_ALLOWED");
    await refused(agent.api.migration.approve({ params: P(), body: { confirm: "CONFIRM" } }), 403, "ROLE_NOT_ALLOWED");
    const j = await fd.api.migration.approve({ params: P(), body: { confirm: "CONFIRM" } });
    expect([j.status, j.approvedBy, j.dryRunBy]).toEqual(["approved", fd.userId, admin.userId]);
  });

  it("importing runs in the server worker, in batches, then reconciles exactly", async () => {
    const queued = await admin.api.migration.startImport({ params: P() });
    expect(queued.status).toBe("importing");
    const job = await waitFor(
      () => accountant.api.migration.getJob({ params: P() }),
      (j) => j.status !== "importing",
    );
    expect(job.status).toBe("reconciled");
    expect(job.progress).toMatchObject({ batchesDone: 24, batchesFailed: 0, percent: 100 });
    const rec = job.reconciliation!;
    expect(rec.ok).toBe(true);
    expect(rec.mismatches).toEqual([]);
    expect(
      Object.fromEntries(rec.counts.filter((c) => c.entity !== "document").map((c) => [c.entity, c.destination])),
    ).toEqual(EXPECTED_ENTITIES);
    expect(rec.counts.find((c) => c.entity === "document")).toMatchObject({ source: 4, destination: 4 });
    expect(rec.money.find((m) => m.entity === "contract" && m.check === "Contract price total")).toMatchObject({
      source: 3_550_000_000,
      destination: 3_550_000_000,
      difference: 0,
    });
    expect(rec.relationships.find((m) => m.entity === "reservation" && m.check === "Buyer linked")).toMatchObject({
      source: 4,
      destination: 4,
    });
    expect(rec.ledger).toEqual([
      {
        check: "Account 1170 (debit − credit)",
        entity: null,
        source: 1_200_000_000,
        destination: 1_200_000_000,
        difference: 0,
        ok: true,
      },
      {
        check: "Account 2000 (debit − credit)",
        entity: null,
        source: -45_000_000,
        destination: -45_000_000,
        difference: 0,
        ok: true,
      },
      {
        check: "Account 2400 (debit − credit)",
        entity: null,
        source: -30_000_000,
        destination: -30_000_000,
        difference: 0,
        ok: true,
      },
      {
        check: "Account 3900 (debit − credit)",
        entity: null,
        source: -1_125_000_000,
        destination: -1_125_000_000,
        difference: 0,
        ok: true,
      },
      { check: "Trial balance difference", entity: null, source: 0, destination: 0, difference: 0, ok: true },
    ]);

    // records with their source keys and links
    expect(await count("dev_projects")).toBe(2);
    expect(await count("dev_contacts")).toBe(4); // 3 buyers + 1 investor
    const [res] = await S.sql(
      `SELECT c.name, r.deposit_minor FROM dev_reservations r JOIN dev_contacts c ON c.id = r.buyer_id
       WHERE r.org_id = $1 AND r.source_record_id = 'R-003'`,
      [orgId],
    );
    expect(res).toEqual({ name: "Amina Hassan", deposit_minor: 30_000_000 });
    const [unit] = await S.sql(
      "SELECT area_sqm, list_price_minor, source_system FROM dev_units WHERE org_id = $1 AND source_record_id = 'U-A101'",
      [orgId],
    );
    expect(unit).toEqual({ area_sqm: 85.5, list_price_minor: 1_250_000_000, source_system: "mto-legacy" });
    const docs = await S.sql(
      'SELECT filename, link_entity, link_id IS NOT NULL AS linked FROM dev_documents WHERE org_id = $1 ORDER BY filename COLLATE "C"',
      [orgId],
    );
    expect(docs).toEqual([
      { filename: "CTR-001_signed.pdf", link_entity: "contract", linked: true },
      { filename: "U-B101_floorplan.png", link_entity: "unit", linked: true },
      { filename: "handover-photo.jpg", link_entity: "handover", linked: true },
      { filename: "scan-0007.pdf", link_entity: "contract", linked: true },
    ]);
    const [scan] = await S.sql(
      `SELECT k.source_record_id FROM dev_documents d JOIN dev_contracts k ON k.id = d.link_id
       WHERE d.org_id = $1 AND d.filename = 'scan-0007.pdf'`,
      [orgId],
    );
    expect(scan.source_record_id).toBe("CTR-003");

    // opening balances: ONE balanced journal, posted once
    const { journals } = await fd.api.ledger.listJournals({ params: { orgId }, query: {} });
    const mig = journals.filter((j) => j.source === "system:migration");
    expect(mig.length).toBe(1);
    expect([mig[0]!.date, mig[0]!.status, mig[0]!.totalMinor]).toEqual([CUTOVER, "posted", 1_200_000_000]);
    const tb = await fd.api.ledger.trialBalance({ params: { orgId }, query: { asOf: CUTOVER } });
    expect(tb.balanced).toBe(true);
    const row = (code: string) => tb.rows.find((r) => r.code === code);
    expect([
      row("1170")?.debitMinor,
      row("2400")?.creditMinor,
      row("2000")?.creditMinor,
      row("3900")?.creditMinor,
    ]).toEqual([1_200_000_000, 30_000_000, 45_000_000, 1_125_000_000]);
    const records = await accountant.api.migration.listRecords({ params: P(), query: { entity: "contract" } });
    expect(records.records.map((r) => [r.sourceRecordId, r.label])).toEqual([
      ["CTR-001", "SA-1001"],
      ["CTR-002", "SA-1002"],
      ["CTR-003", "SA-1003"],
    ]);
  });

  it("reports: downloadable CSV/JSON report and exception file, and the audit trail", async () => {
    const csv = await accountant.api.migration.report({ params: P(), query: { kind: "report", format: "csv" } });
    expect([csv.filename, csv.contentType]).toEqual(["MIG-00001-migration-report.csv", "text/csv"]);
    expect(csv.content).toContain("reconciliation: money,Contract price total,contract,3550000000,3550000000,0,ok");
    const json = JSON.parse(
      (await accountant.api.migration.report({ params: P(), query: { kind: "report", format: "json" } })).content,
    );
    expect(json.reconciliation.ok).toBe(true);
    expect(json.batches.length).toBe(24);
    const ex = (await admin.api.migration.report({ params: P(), query: { kind: "exceptions", format: "csv" } }))
      .content;
    expect(ex).toContain("PAY-008,skipped");
    expect(ex).toContain("Test receipt against a contract that never existed");
    expect(ex).toMatch(/B-004,merged/);
    expect(ex).toMatch(/U-B102,merged,warning,EXACT_DUPLICATE/);
    expect(ex).toMatch(/broken\.pdf,,,,,corrupt/);
    expect(ex).toMatch(/notes\.docx,,,,,unsupported/);
    expect(ex).toMatch(/B-001_B-002_joint_letter\.pdf,,,,,excluded/);
    expect(ex).toMatch(/old-export\.zip,,,,,refused,error,FILE_REFUSED/);
    const { entries } = await accountant.api.migration.audit({ params: P() });
    const actions = entries.map((e) => e.action);
    for (const a of [
      "Migration started",
      "File uploaded",
      "Files read",
      "Table mapped",
      "Migration validated",
      "Row resolved",
      "Document linked",
      "Document excluded",
      "Dry run",
      "Migration approved",
      "Import queued",
      "Import batch 1 done",
      "Import finished and reconciled",
    ])
      expect(actions).toContain(a);
    expect(entries.find((e) => e.action === "Migration approved")!.actorUserId).toBe(fd.userId);
    expect(entries.find((e) => e.action === "Import batch 1 done")!.actorRole).toBe("system");
  });

  it("another organisation's migration does not exist for you", async () => {
    const other = await S.newOrg({ name: "Other Developer", product: "developer", plan: "DEV-PRO" });
    await refused(other.admin.api.migration.getJob({ params: P() }), 404);
    await refused(other.admin.api.migration.getJob({ params: { orgId: other.orgId, jobId } }), 404);
    await refused(
      other.admin.api.migration.report({ params: { orgId: other.orgId, jobId }, query: { format: "csv" } }),
      404,
    );
    const pm = await S.newOrg({ name: "A property manager", product: "property" });
    await refused(
      pm.admin.api.migration.createJob({
        params: { orgId: pm.orgId },
        body: { domain: "development", name: "Wrong product", sourceSystem: "legacy", cutoverDate: CUTOVER },
      }),
      404,
    );
  });

  it("sign-off by a person who may approve, other than the approver; after it, batches can no longer be rolled back", async () => {
    await refused(
      viewer.api.migration.complete({ params: P(), body: { confirm: "CONFIRM" } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await refused(
      fd.api.migration.complete({ params: P(), body: { confirm: "CONFIRM" } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    const done = await admin.api.migration.complete({ params: P(), body: { confirm: "CONFIRM" } });
    expect([done.status, done.completedBy, done.approvedBy]).toEqual(["completed", admin.userId, fd.userId]);
    await refused(
      fd.api.migration.rollbackBatch({
        params: { ...P(), seq: 24 },
        body: { reason: "Changed my mind", confirm: "CONFIRM" },
      }),
      409,
    );
  });

  it("running the same export again creates nothing new and posts nothing twice", async () => {
    const recordsBefore = await Promise.all(
      ["dev_projects", "dev_units", "dev_contacts", "dev_payments", "dev_documents"].map(count),
    );
    const journalsBefore = await count("journal_entries");
    const again = await admin.api.migration.createJob({
      params: { orgId },
      body: {
        domain: "development",
        name: "The same export again",
        sourceSystem: "mto-legacy",
        profileId,
        cutoverDate: CUTOVER,
      },
    });
    await prepare(admin.api, again.id);
    const v = await admin.api.migration.validate({ params: { orgId, jobId: again.id } });
    expect(v.byCode.ALREADY_PRESENT).toBe(TOTAL_RECORDS);
    expect(v.byCode.DUPLICATE_EXISTING).toBe(3); // B-004 matches the B-001 now in PALTAS
    const [b1] = await S.sql("SELECT id FROM dev_contacts WHERE org_id = $1 AND source_record_id = 'B-001'", [orgId]);
    await resolveAll(admin.api, again.id, b1.id);
    const d = await admin.api.migration.dryRun({ params: { orgId, jobId: again.id } });
    expect(d.wouldCreate).toBe(0);
    expect(d.ledger).toEqual([]);
    await fd.api.migration.approve({ params: { orgId, jobId: again.id }, body: { confirm: "CONFIRM" } });
    await admin.api.migration.startImport({ params: { orgId, jobId: again.id } });
    const job = await waitFor(
      () => admin.api.migration.getJob({ params: { orgId, jobId: again.id } }),
      (j) => j.status !== "importing",
    );
    expect(job.status).toBe("reconciled");
    expect(job.reconciliation!.mismatches).toEqual([]);
    expect(job.reconciliation!.ok).toBe(true);
    expect(
      await Promise.all(["dev_projects", "dev_units", "dev_contacts", "dev_payments", "dev_documents"].map(count)),
    ).toEqual(recordsBefore);
    expect(await count("journal_entries")).toBe(journalsBefore);
  });
});
