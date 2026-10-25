import { beforeAll, afterAll, it, expect } from "vitest";
import { startPropertyServer, pmOrg } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
let S: TestServer, orgId: string, preparer: Person, reviewer: Person;
beforeAll(async () => {
  S = await startPropertyServer();
  S.setToday("2026-10-25");
  const o = await pmOrg(S);
  orgId = o.orgId;
  preparer = o.staff.accountant;
  reviewer = o.staff.finance_director;
});
afterAll(() => S.close());
it("refuses a stale sign-off when new statement lines net to zero without changing the ledger", async () => {
  const r = await preparer.api.property.prepareReconciliation({
    params: { orgId },
    body: { statementDate: "2026-10-25", statementBalanceMinor: 0 },
  });
  expect(r.differenceMinor).toBe(0);
  await preparer.api.property.importBankLines({
    params: { orgId },
    body: {
      statement: "Synthetic offsetting lines",
      lines: [
        { date: "2026-10-25", amountMinor: 10000, reference: "UNKNOWN-IN", description: "Unreviewed incoming" },
        { date: "2026-10-25", amountMinor: -10000, reference: "UNKNOWN-OUT", description: "Unreviewed outgoing" },
      ],
    },
  });
  await refused(reviewer.api.property.approveReconciliation({ params: { orgId, reconciliationId: r.id } }), 409);
  expect(
    (await preparer.api.property.listReconciliations({ params: { orgId } })).reconciliations.find((x) => x.id === r.id)
      ?.status,
  ).toBe("prepared");
  expect((await S.sql("SELECT count(*)::int n FROM journal_entries WHERE org_id=$1", [orgId]))[0].n).toBe(0);
});
it("refuses changed matching/review state even when all stored numerical components still agree", async () => {
  const r = await preparer.api.property.prepareReconciliation({
    params: { orgId },
    body: { statementDate: "2026-10-25", statementBalanceMinor: 0 },
  });
  const lines = await preparer.api.property.listBankLines({ params: { orgId }, query: { status: "unmatched" } });
  await preparer.api.property.ignoreBankLine({
    params: { orgId, lineId: lines.lines[0]!.id },
    body: { reason: "Statement item investigated, evidence retained" },
  });
  const n = await preparer.api.property.prepareReconciliation({
    params: { orgId },
    body: { statementDate: "2026-10-25", statementBalanceMinor: 0 },
  });
  expect(n.ledgerBalanceMinor).toBe(r.ledgerBalanceMinor);
  expect(n.unmatchedLinesMinor).toBe(r.unmatchedLinesMinor);
  expect(n.differenceMinor).toBe(r.differenceMinor);
  await refused(reviewer.api.property.approveReconciliation({ params: { orgId, reconciliationId: r.id } }), 409);
  await refused(reviewer.api.property.approveReconciliation({ params: { orgId, reconciliationId: n.id } }), 409);
  const pending = await preparer.api.property.listBankLines({ params: { orgId }, query: { status: "unmatched" } });
  await preparer.api.property.ignoreBankLine({
    params: { orgId, lineId: pending.lines[0]!.id },
    body: { reason: "Both offsetting statement items classified with evidence" },
  });
  const final = await preparer.api.property.prepareReconciliation({
    params: { orgId },
    body: { statementDate: "2026-10-25", statementBalanceMinor: 0 },
  });
  expect(final.unmatchedCount).toBe(0);
  const result = await reviewer.api.property.approveReconciliation({ params: { orgId, reconciliationId: final.id } });
  expect(result.status).toBe("approved");
  await refused(reviewer.api.property.approveReconciliation({ params: { orgId, reconciliationId: final.id } }), 409);
});
it("requires a fresh preparation for an unapproved legacy snapshot and retains independent review and isolation", async () => {
  const r = await preparer.api.property.prepareReconciliation({
    params: { orgId },
    body: { statementDate: "2026-10-25", statementBalanceMinor: 0 },
  });
  await refused(preparer.api.property.approveReconciliation({ params: { orgId, reconciliationId: r.id } }), 403);
  await S.sql("UPDATE pm_reconciliations SET source_fingerprint=NULL WHERE id=$1", [r.id]);
  await refused(reviewer.api.property.approveReconciliation({ params: { orgId, reconciliationId: r.id } }), 409);
  const other = await pmOrg(S);
  await refused(
    other.staff.finance_director.api.property.approveReconciliation({ params: { orgId, reconciliationId: r.id } }),
    404,
  );
  const next = await preparer.api.property.prepareReconciliation({
    params: { orgId },
    body: { statementDate: "2026-10-25", statementBalanceMinor: 0 },
  });
  expect(
    (await reviewer.api.property.approveReconciliation({ params: { orgId, reconciliationId: next.id } })).status,
  ).toBe("approved");
});
