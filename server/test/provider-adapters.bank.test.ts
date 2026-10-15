// Bank transfers: a statement (CSV) is imported, PALTAS suggests matches, and a DIFFERENT person confirms each one;
// the payment then goes through the core payment rules. For organisations (their own references) and for PALTAS
// (subscription invoices).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { staffMember, standInProduct } from "./support/platform-fixtures.js";
import { refused, startServer, type Person, type TestServer } from "./support/test-server.js";

const CSV = [
  "Date,Amount,Reference,Description",
  '2026-11-01,"45,000.00",FT26305A1,Rent RENT-B2-NOV unit B2',
  "2026-11-01,30000.00,FT26305A2,Transfer from J Doe",
  "2026-11-02,-1500.00,FT26306X,Bank charges",
  "2026-11-02,12345.00,FT26306Y,Unknown deposit",
].join("\n");

describe("bank statement import", () => {
  let S: TestServer;
  let orgId: string;
  let orgAdmin: Person;
  let fd: Person; // imports
  let acc: Person; // confirms
  const stand = standInProduct();
  const refs: Record<string, string> = {};

  beforeAll(async () => {
    S = await startServer({ products: [stand.module] });
    const o = await S.newOrg({ name: "Bahari Residences", trial: false });
    orgId = o.orgId;
    orgAdmin = o.admin;
    fd = await S.addMember(orgId, o.admin.api, "finance_director");
    acc = await S.addMember(orgId, o.admin.api, "accountant");
    for (const [ref, amount] of [
      ["RENT-B2-NOV", 4_500_000],
      ["RENT-C3-NOV", 3_000_000],
    ] as const)
      refs[ref] = (
        await S.app.core.db.tx((t) =>
          S.app.core.providers.registerReference(t, {
            orgId,
            reference: ref,
            type: "rent.test",
            data: { dueMinor: amount, currency: "KES" },
            amountMinor: amount,
            currency: "KES",
          }),
        )
      ).id;
  });
  afterAll(() => S.close());

  let statementId: string;
  let lines: { id: string; bankRef: string }[];
  const P = () => ({ orgId });
  const line = (ref: string) => lines.find((l) => l.bankRef === ref)!.id;

  it("imports a statement and suggests matches; nothing is applied yet", async () => {
    const r = await fd.api.paymentProviders.importStatement({
      params: P(),
      body: { accountLabel: "KCB client account", currency: "KES", csv: CSV },
    });
    statementId = r.statement.id;
    lines = r.lines;
    expect(r.statement).toMatchObject({ lineCount: 4, open: 3, importedBy: fd.userId });
    expect(r.lines.map((l) => [l.bankRef, l.amountMinor, l.status])).toEqual([
      ["FT26305A1", 4_500_000, "suggested"],
      ["FT26305A2", 3_000_000, "suggested"],
      ["FT26306X", -150_000, "outgoing"],
      ["FT26306Y", 1_234_500, "unmatched"],
    ]);
    expect(r.lines[0]!.suggestions.map((s) => [s.reference, s.score, s.why])).toEqual([
      ["RENT-B2-NOV", 100, "Reference quoted and amount equal"],
    ]);
    expect(r.lines[1]!.suggestions.map((s) => [s.reference, s.score])).toEqual([["RENT-C3-NOV", 40]]);
    expect(await S.sql("SELECT 1 FROM payment_events WHERE provider = 'bank'")).toEqual([]);
    // the same file twice is refused
    await refused(
      fd.api.paymentProviders.importStatement({
        params: P(),
        body: { accountLabel: "KCB", currency: "KES", csv: CSV },
      }),
      409,
    );
  });

  it("the person who imported cannot confirm or ignore; a second person confirms through the core rules", async () => {
    const sod = await refused(
      fd.api.paymentProviders.confirmLine({
        params: { ...P(), statementId, lineId: line("FT26305A1") },
        body: { match: refs["RENT-B2-NOV"]!, reason: "Matches tenant B2 rent" },
      }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    expect(sod.message).toMatch(/imported the statement cannot confirm/);
    await refused(
      fd.api.paymentProviders.ignoreLine({
        params: { ...P(), statementId, lineId: line("FT26306Y") },
        body: { reason: "Not ours" },
      }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    const ok = await acc.api.paymentProviders.confirmLine({
      params: { ...P(), statementId, lineId: line("FT26305A1") },
      body: { match: refs["RENT-B2-NOV"]!, reason: "Matches tenant B2 rent" },
    });
    expect([ok.outcome.result, ok.line.status, ok.line.matchedReference, ok.line.decidedBy]).toEqual([
      "Applied — rent paid",
      "confirmed",
      "RENT-B2-NOV",
      acc.userId,
    ]);
    const [ev] = await S.sql<{ id: string; manual: boolean; recorded_by: string; amount_minor: number; ref: string }>(
      "SELECT id, manual, recorded_by, amount_minor, ref FROM payment_events WHERE provider = 'bank'",
    );
    expect(ev).toEqual({
      id: `bank:${orgId}:ft26305a1`,
      manual: true,
      recorded_by: acc.userId,
      amount_minor: 4_500_000,
      ref: "FT26305A1",
    });
    const refsNow = await acc.api.paymentProviders.listReferences({ params: P() });
    expect(refsNow.references.find((r) => r.reference === "RENT-B2-NOV")?.status).toBe("settled");
    // a decided line, or a settled reference, cannot be used again
    await refused(
      acc.api.paymentProviders.confirmLine({
        params: { ...P(), statementId, lineId: line("FT26305A1") },
        body: { match: refs["RENT-C3-NOV"]!, reason: "Second try" },
      }),
      409,
    );
    await refused(
      acc.api.paymentProviders.confirmLine({
        params: { ...P(), statementId, lineId: line("FT26305A2") },
        body: { match: refs["RENT-B2-NOV"]!, reason: "Wrong reference" },
      }),
      409,
    );
    const c3 = await acc.api.paymentProviders.confirmLine({
      params: { ...P(), statementId, lineId: line("FT26305A2") },
      body: { match: refs["RENT-C3-NOV"]!, reason: "J Doe pays for C3" },
    });
    expect(c3.outcome.result).toBe("Applied — rent paid");
    const ignored = await acc.api.paymentProviders.ignoreLine({
      params: { ...P(), statementId, lineId: line("FT26306Y") },
      body: { reason: "Owner's own top-up, not a tenant payment" },
    });
    expect(ignored.status).toBe("ignored");
    await refused(
      acc.api.paymentProviders.confirmLine({
        params: { ...P(), statementId, lineId: line("FT26306X") },
        body: { match: refs["RENT-C3-NOV"]!, reason: "Outgoing line" },
      }),
      409,
    );
    // the database refuses the importer as decider too
    await expect(
      S.sql("UPDATE bank_statement_lines SET decided_by = imported_by WHERE statement_id = $1", [statementId]),
    ).rejects.toThrow(/bank_match_needs_second_person/);
    const audit = await fd.api.organisations.listAudit({ params: P(), query: { limit: 50 } });
    expect(audit.entries.filter((e) => e.action === "Bank line confirmed")).toHaveLength(2);
    expect(audit.entries.some((e) => e.action === "Bank statement imported")).toBe(true);
  });

  it("a transaction already on an earlier statement is marked duplicate, never applied twice", async () => {
    const overlap = [
      "Date,Amount,Reference,Description",
      "2026-11-01,45000.00,FT26305A1,Rent RENT-B2-NOV",
      "2026-11-03,100.00,FT26307Z,Interest",
    ].join("\n");
    const r = await fd.api.paymentProviders.importStatement({
      params: P(),
      body: { accountLabel: "KCB client account", currency: "KES", csv: overlap },
    });
    expect(r.lines.map((l) => [l.bankRef, l.status])).toEqual([
      ["FT26305A1", "duplicate"],
      ["FT26307Z", "unmatched"],
    ]);
    expect((await acc.api.paymentProviders.listStatements({ params: P() })).statements).toHaveLength(2);
  });

  it("a statement with problems is refused with every problem and its line", async () => {
    const bad = [
      "Value Date,Credit,Bank Reference,Narrative",
      "01/11/2026,45000.00,FT1,Rent",
      "2026-11-02,12.345,,X",
    ].join("\n");
    const r = await refused(
      fd.api.paymentProviders.importStatement({
        params: P(),
        body: { accountLabel: "KCB", currency: "KES", csv: bad },
      }),
      400,
    );
    expect(r.details.problems).toEqual([
      'line 2: date "01/11/2026" is not YYYY-MM-DD',
      'line 3: amount "12.345" is not an exact amount',
      "line 3: no bank reference",
    ]);
    // with the right date format the first line reads
    const good = await fd.api.paymentProviders.importStatement({
      params: P(),
      body: {
        accountLabel: "KCB",
        currency: "KES",
        dateFormat: "DD/MM/YYYY",
        csv: bad.split("\n").slice(0, 2).join("\n"),
      },
    });
    expect(good.lines[0]!.valueDate).toBe("2026-11-01");
    await refused(
      fd.api.paymentProviders.importStatement({
        params: P(),
        body: { accountLabel: "KCB", currency: "KES", csv: "Date,Amount\n2026-11-01,1" },
      }),
      400,
    );
  });

  it("roles and isolation", async () => {
    const viewer = await S.addMember(orgId, orgAdmin.api, "viewer");
    await refused(
      viewer.api.paymentProviders.getStatement({ params: { ...P(), statementId } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    // the organisation administrator manages people, not money
    await refused(
      orgAdmin.api.paymentProviders.importStatement({
        params: P(),
        body: { accountLabel: "KCB", currency: "KES", csv: CSV + "\n" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const o = await S.newOrg({ name: "Other Estates" });
    const other = await S.addMember(o.orgId, o.admin.api, "accountant");
    await refused(other.api.paymentProviders.getStatement({ params: { ...P(), statementId } }), 404);
    await refused(other.api.paymentProviders.getStatement({ params: { orgId: o.orgId, statementId } }), 404);
    await refused(
      other.api.paymentProviders.confirmLine({
        params: { orgId: o.orgId, statementId, lineId: line("FT26306Y") },
        body: { match: refs["RENT-C3-NOV"]!, reason: "Cross-organisation attempt" },
      }),
      404,
    );
    expect((await other.api.paymentProviders.listReferences({ params: { orgId: o.orgId } })).references).toEqual([]);
  });
});

describe("bank statement import for PALTAS (subscription invoices)", () => {
  let S: TestServer;
  beforeAll(async () => (S = await startServer()));
  afterAll(() => S.close());

  it("matches open PALTAS invoices; a second Super Admin confirms; clients never reach it", async () => {
    const sa = await S.staff();
    const sa2 = await staffMember(S);
    const { orgId, admin } = await S.newOrg({ name: "Pwani Lettings", trial: false });
    const inv = await sa.api.admin.issueInvoice({ params: { orgId }, body: {} });
    const csv = [
      "Date,Amount,Reference,Description",
      `2026-10-12,${inv.totalMinor / 100}.00,EFT-9001,Payment ${inv.id} Pwani`,
    ].join("\n");
    const r = await sa.api.paymentProviders.adminImportStatement({
      body: { accountLabel: "PALTAS KES", currency: "KES", csv },
    });
    expect(r.lines[0]!.suggestions.map((s) => [s.kind, s.id, s.orgId, s.score])).toEqual([
      ["invoice", inv.id, orgId, 100],
    ]);
    const params = { statementId: r.statement.id, lineId: r.lines[0]!.id };
    await refused(
      sa.api.paymentProviders.adminConfirmLine({ params, body: { match: inv.id, reason: "Matches invoice" } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    const ok = await sa2.api.paymentProviders.adminConfirmLine({
      params,
      body: { match: inv.id, reason: "Matches invoice" },
    });
    expect(ok.outcome.result).toBe("Applied — invoice paid");
    const [paid] = await S.sql<{ status: string }>("SELECT status FROM billing_invoices WHERE id = $1", [inv.id]);
    expect(paid!.status).toBe("Paid");
    const [receipt] = await S.sql<{ manual: boolean; ref: string }>(
      "SELECT manual, ref FROM billing_receipts WHERE invoice_id = $1",
      [inv.id],
    );
    expect(receipt).toEqual({ manual: true, ref: "EFT-9001" });
    // the same bank reference can no longer be recorded by hand
    await refused(
      sa.api.admin.recordReceipt({ params: { invoiceId: inv.id }, body: { ref: "EFT-9001", reason: "Again by hand" } }),
      409,
    );
    // a client organisation never sees PALTAS statements, not even its finance people
    expect((await S.raw("GET", `/api/v1/admin/bank-statements/${r.statement.id}`, undefined, admin.token)).status).toBe(
      404,
    );
    const acc = await S.addMember(orgId, admin.api, "accountant");
    await refused(acc.api.paymentProviders.getStatement({ params: { orgId, statementId: r.statement.id } }), 404);
  });
});
