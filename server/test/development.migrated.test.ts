// Records brought over by the data migration (the developer's previous systems, cut-over 2026-09-30) are ordinary
// Development records: their statements, payments, receivables, reservations, units, buyers and suppliers work with
// the day-to-day endpoints, and the dashboard still equals the ledger, opening balances included.
import type { PaltasClient } from "@paltas/api-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { developmentExport, migrationSettings, upload, waitFor } from "./support/migration-fixtures.js";
import { devOrg, doc, M, PLAN_10_50_40, startDevServer, type DevStaff } from "./support/development-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";

const CUTOVER = "2026-09-30";
const PROFILE = {
  settings: { dateFormat: "YYYY-MM-DD" as const },
  entityHints: { buyer: ["buyers"] },
  aliases: { buyer: { source_record_id: ["contact id"], phone: ["mobile phone"], national_id: ["id/passport"] } },
  enums: { "buyer.party_type": { person: "individual", organisation: "company" } },
};
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

/** Run the whole migration of the Mto export (the same decisions as the migration tests). */
async function migrate(api: PaltasClient, approver: PaltasClient, orgId: string) {
  const { id: profileId } = await api.migration.saveProfile({
    params: { orgId },
    body: { domain: "development", name: "Mto legacy export", description: "", config: PROFILE },
  });
  const job = await api.migration.createJob({
    params: { orgId },
    body: { domain: "development", name: "Cut-over", sourceSystem: "mto-legacy", profileId, cutoverDate: CUTOVER },
  });
  const P = { orgId, jobId: job.id };
  for (const f of developmentExport().files) await upload(api, orgId, job.id, f.name, f.data);
  await api.migration.detect({ params: P });
  const { tables } = await api.migration.listTables({ params: P });
  await api.migration.mapTable({
    params: { ...P, tableId: tables.find((t) => t.name === "opening-balances.csv")!.id },
    body: { entity: "opening_balance", columns: OPENING_BALANCE_COLUMNS },
  });
  await api.migration.validate({ params: P });
  const rows = (q: Record<string, string>) => api.migration.listRows({ params: P, query: q }).then((r) => r.rows);
  const [b4] = await rows({ entity: "buyer", sourceRecordId: "B-004" });
  const [b1] = await rows({ entity: "buyer", sourceRecordId: "B-001" });
  await api.migration.resolveRow({
    params: { ...P, rowId: b4!.id },
    body: { action: "merge", intoRowId: b1!.id, reason: "Same person entered twice in the CRM" },
  });
  const [c3] = await rows({ entity: "contract", sourceRecordId: "CTR-003" });
  await api.migration.resolveRow({
    params: { ...P, rowId: c3!.id },
    body: { action: "correct", values: { reported_balance: "5000000" } },
  });
  const [p8] = await rows({ entity: "payment", sourceRecordId: "PAY-008" });
  await api.migration.resolveRow({
    params: { ...P, rowId: p8!.id },
    body: { action: "skip", reason: "Contract never existed" },
  });
  const docs = (await api.migration.listDocuments({ params: P, query: { status: "review" } })).documents;
  await api.migration.resolveDocument({
    params: { ...P, documentId: docs.find((d) => d.filename === "scan-0007.pdf")!.id },
    body: { action: "link", entity: "contract", sourceRecordId: "CTR-003" },
  });
  await api.migration.resolveDocument({
    params: { ...P, documentId: docs.find((d) => d.filename === "B-001_B-002_joint_letter.pdf")!.id },
    body: { action: "exclude", reason: "Concerns two buyers; filed outside PALTAS" },
  });
  await api.migration.dryRun({ params: P });
  await approver.migration.approve({ params: P, body: { confirm: "CONFIRM" } });
  await api.migration.startImport({ params: P });
  const done = await waitFor(
    () => api.migration.getJob({ params: P }),
    (j) => j.status !== "importing",
  );
  if (done.status !== "reconciled") throw new Error(`Migration ended ${done.status}`);
}

describe("Real Estate Development: migrated records with the day-to-day endpoints", () => {
  let S: TestServer;
  let orgId: string;
  let st: DevStaff;
  const d = (p: Person) => p.api.development;
  const O = () => ({ orgId });
  const idOf = async (table: string, source: string) =>
    (await S.sql(`SELECT id FROM ${table} WHERE org_id = $1 AND source_record_id = $2`, [orgId, source]))[0]
      .id as string;

  beforeAll(async () => {
    S = await startDevServer({ config: { migration: migrationSettings() } });
    const o = await devOrg(S, "Mto Developers");
    orgId = o.orgId;
    st = o.staff;
    await migrate(st.ceo.api, st.fd.api, orgId);
  }, 120_000);
  afterAll(() => S.close());

  it("projects, units, buyers and suppliers are listed as migrated records", async () => {
    const { projects } = await d(st.aud).listProjects({ params: O() });
    expect(projects.map((p) => [p.name, p.migrated, p.unitCount])).toEqual([
      ["Mto Gardens", true, 2],
      ["Mto Heights", true, 3],
    ]);
    const { buyers } = await d(st.fd).listBuyers({ params: O(), query: {} });
    expect(buyers.map((b) => b.name)).toEqual(["Amina Hassan", "Brian Otieno", "Chebet Holdings Ltd"]);
    expect(buyers.every((b) => b.migrated && b.stage === "paying_instalments")).toBe(true);
    const { suppliers } = await d(st.aud).listSuppliers({ params: O() });
    expect(suppliers.filter((s) => s.migrated).map((s) => [s.name, s.status])).toContainEqual([
      "Kenya Cement Supplies",
      "approved",
    ]);
    const docs = await d(st.aud).listDocuments({ params: O(), query: { linkEntity: "contract" } });
    expect(docs.documents.map((x) => [x.filename, x.migrated])).toEqual([
      ["CTR-001_signed.pdf", true],
      ["scan-0007.pdf", true],
    ]);
  });

  it("the dashboard ties the opening balances to the ledger before anything else happens", async () => {
    const dash = await d(st.fd).dashboard({ params: O(), query: {} });
    expect(dash.collections.receivables).toEqual({ subledgerMinor: M(12e6), ledgerMinor: M(12e6), agrees: true });
    expect(dash.payables.accountsPayable).toEqual({
      subledgerMinor: M(450_000),
      ledgerMinor: M(450_000),
      agrees: true,
    });
    expect(dash.collections.depositsHeldMinor).toBe(M(300_000));
  });

  it("a migrated contract: statement of account, a payment that clears the migrated arrears (Cr 1170), billing", async () => {
    const contractId = await idOf("dev_contracts", "CTR-001");
    const sa = await d(st.fd).contractStatement({ params: { orgId, contractId }, query: {} });
    expect(sa.totals).toEqual({
      dueToDateMinor: M(12.5e6),
      paidMinor: M(7.5e6),
      overdueMinor: M(5e6),
      notYetDueMinor: 0,
      balanceMinor: M(5e6),
    });
    expect(sa.lines.filter((l) => l.kind === "receipt").map((l) => l.reference)).toEqual(["RC-9001", "RC-9002"]);
    const last = sa.instalments.find((i) => i.openMinor > 0)!;
    // a reference already in the migrated history cannot be recorded again
    await refused(
      d(st.fd).reportPayment({
        params: { orgId, contractId },
        body: {
          instalmentId: last.id,
          amountMinor: M(5e6),
          method: "bank_transfer",
          reference: "rc-9001",
          date: "2026-10-11",
        },
      }),
      409,
    );
    const rep = await d(st.fd).reportPayment({
      params: { orgId, contractId },
      body: {
        instalmentId: last.id,
        amountMinor: M(5e6),
        method: "bank_transfer",
        reference: "FT26101155501",
        date: "2026-10-11",
      },
    });
    const ok = await d(st.acct).verifyPayment({ params: { orgId, reportId: rep.id }, body: { approve: true } });
    const j = await st.fd.api.ledger.getJournal({ params: { orgId, journalId: ok.journalId! } });
    expect(j.lines.map((l) => [l.account, l.debitMinor, l.creditMinor])).toEqual([
      ["1010", M(5e6), 0],
      ["1170", 0, M(5e6)],
    ]);
    // the other migrated arrears are adopted by billing without posting them twice
    const bill = await d(st.acct).billInstalments({ params: O(), body: {} });
    expect([bill.billed, bill.amountMinor]).toEqual([0, 0]);
    const dash = await d(st.fd).dashboard({ params: O(), query: {} });
    expect(dash.collections.receivables).toEqual({ subledgerMinor: M(7e6), ledgerMinor: M(7e6), agrees: true });
    const after = await d(st.fd).contractStatement({ params: { orgId, contractId }, query: {} });
    expect(after.totals.balanceMinor).toBe(0);
  });

  it("a migrated reservation is honoured: no new offer on its unit, and it converts into a contract", async () => {
    const unitId = await idOf("dev_units", "U-A201");
    const brian = await idOf("dev_contacts", "B-002");
    await refused(
      d(st.sm).createOffer({
        params: O(),
        body: { buyerId: brian, unitId, priceMinor: M(12.8e6), plan: PLAN_10_50_40 },
      }),
      409,
    );
    const reservationId = await idOf("dev_reservations", "R-003");
    const signed = (await doc(st.sm, orgId, "SA-A201.pdf")).id;
    await refused(
      d(st.sm).signContract({
        params: { orgId, reservationId },
        body: { date: "2026-10-11", signedDocumentId: signed },
      }),
      400,
    );
    const k = await d(st.sm).signContract({
      params: { orgId, reservationId },
      body: { date: "2026-10-11", signedDocumentId: signed, priceMinor: M(12.8e6), plan: PLAN_10_50_40 },
    });
    expect([k.priceMinor, k.instalments.length, k.migrated]).toEqual([M(12.8e6), 14, false]);
    const [u] = await S.sql("SELECT status FROM dev_units WHERE id = $1", [unitId]);
    expect(u.status).toBe("sold");
  });

  it("a migrated buyer buys a migrated available unit; a migrated supplier takes a new order", async () => {
    const brian = await idOf("dev_contacts", "B-002");
    const unitId = await idOf("dev_units", "U-B102");
    const o = await d(st.sm).createOffer({
      params: O(),
      body: { buyerId: brian, unitId, priceMinor: M(8e6), plan: PLAN_10_50_40 },
    });
    expect(o.askingMinor).toBe(M(8e6));
    // a migrated buyer is linked to the one contact store the first time they are worked on
    const [link] = await S.sql(
      "SELECT c.name FROM dev_contacts d JOIN contacts c ON c.id = d.contact_id WHERE d.id = $1",
      [brian],
    );
    expect(link).toEqual({ name: "Brian Otieno" });
    await d(st.sm).submitOffer({ params: { orgId, offerId: o.id } });
    const acc = await d(st.sm).respondToOffer({ params: { orgId, offerId: o.id }, body: { response: "accept" } });
    await refused(
      d(st.sm).approveReservation({ params: { orgId, reservationId: acc.reservationId! } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    expect((await d(st.sm2).approveReservation({ params: { orgId, reservationId: acc.reservationId! } })).status).toBe(
      "active",
    );

    const projectId = await idOf("dev_projects", "P-001");
    const supplierId = await idOf("dev_suppliers", "S-001");
    const po = await d(st.proc).createPurchaseOrder({
      params: { orgId, projectId },
      body: {
        kind: "po",
        supplierId,
        costCode: "06",
        description: "Cement, second lot",
        lines: [{ item: "Cement", unit: "bag", qty: 500, unitPriceMinor: M(500) }],
      },
    });
    // no budget on this migrated project yet: finance is blocked, the CEO may approve the exception
    await refused(d(st.fd).decidePurchaseOrder({ params: { orgId, poId: po.id }, body: { approve: true } }), 409);
    await d(st.ceo).decidePurchaseOrder({ params: { orgId, poId: po.id }, body: { approve: true } });
    const cost = await d(st.pm).costReport({ params: { orgId, projectId } });
    expect(cost.rows.map((r) => [r.costCode, r.committedMinor])).toEqual([
      ["06", M(250_000)],
      ["—", M(450_000)], // the migrated PO-501, which had no cost code
    ]);
    const { purchaseOrders } = await d(st.aud).listPurchaseOrders({ params: O(), query: { projectId } });
    expect(purchaseOrders.find((p) => p.number === "PO-501")).toMatchObject({ migrated: true, status: "open" });
  });
});
