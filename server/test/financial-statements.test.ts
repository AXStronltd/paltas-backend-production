import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refused, startServer, type TestServer } from "./support/test-server.js";

describe("posted financial statements", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await startServer();
  });
  afterAll(() => S.close());

  it.each(["KES", "ZAR", "USD"])(
    "reconciles one organisation in %s without conversion or cross-company totals",
    async (currency) => {
      const { orgId, admin } = await S.newOrg({ name: `Statements ${currency}`, trial: false, currency });
      const accountant = await S.addMember(orgId, admin.api, "accountant");
      const director = await S.addMember(orgId, admin.api, "finance_director");
      const agent = await S.addMember(orgId, admin.api, "leasing_agent");
      async function post(date: string, debit: string, credit: string, amount: number) {
        const j = await accountant.api.ledger.createJournal({
          params: { orgId },
          body: {
            date,
            memo: "Verified statement fixture",
            lines: [
              { account: debit, debitMinor: amount },
              { account: credit, creditMinor: amount },
            ],
          },
        });
        return director.api.ledger.approveJournal({ params: { orgId, journalId: j.id } });
      }
      await post("2026-09-30", "1000", "3000", 100_000);
      await post("2026-09-30", "1000", "4000", 20_000);
      const income = await post("2026-10-01", "1000", "4000", 10_000);
      await post("2026-10-02", "5000", "1000", 4_000);
      await post("2026-10-03", "4000", "1000", 3_000);
      await post("2026-10-04", "1000", "2000", 8_000);
      // A prepared journal and a future posting cannot change today's statements.
      await accountant.api.ledger.createJournal({
        params: { orgId },
        body: {
          date: "2026-10-05",
          memo: "Not approved",
          lines: [
            { account: "1000", debitMinor: 999 },
            { account: "4000", creditMinor: 999 },
          ],
        },
      });
      await post("2026-10-12", "1000", "4000", 999);
      const query = { from: "2026-10-01", to: "2026-10-11" };
      const r = await accountant.api.ledger.financialStatements({ params: { orgId }, query });
      expect(r).toMatchObject({
        currency,
        basis: "posted_accrual",
        profitAndLoss: { incomeMinor: 7_000, expensesMinor: 4_000, netProfitMinor: 3_000 },
        balanceSheet: {
          assetsMinor: 131_000,
          liabilitiesMinor: 8_000,
          equityMinor: 100_000,
          unclosedEarningsMinor: 23_000,
          differenceMinor: 0,
          balanced: true,
        },
      });
      expect(r.rows.find((x) => x.code === "1000")).toMatchObject({
        openingMinor: 120_000,
        debitMinor: 18_000,
        creditMinor: 7_000,
        movementMinor: 11_000,
        closingMinor: 131_000,
      });
      const tb = await accountant.api.ledger.trialBalance({ params: { orgId }, query: { asOf: query.to } });
      for (const row of r.rows) {
        const balance = tb.rows.find((x) => x.code === row.code)!;
        expect(row.closingMinor).toBe(balance.debitMinor - balance.creditMinor);
      }
      await refused(agent.api.ledger.financialStatements({ params: { orgId }, query }), 403);
      const other = await S.newOrg({ name: `Unrelated ${currency}`, trial: false, currency });
      await refused(other.admin.api.ledger.financialStatements({ params: { orgId }, query }), 404);
      expect(
        (await other.admin.api.ledger.financialStatements({ params: { orgId: other.orgId }, query })).rows,
      ).toEqual([]);
      await refused(
        accountant.api.ledger.financialStatements({
          params: { orgId },
          query: { from: "2026-10-11", to: "2026-10-01" },
        }),
        400,
      );
      await refused(
        accountant.api.ledger.financialStatements({
          params: { orgId },
          query: { from: "2026-10-01", to: "2026-10-12" },
        }),
        400,
      );
      // Reversals remain visible in the period; neither the original nor its correction is dropped.
      const reversal = await accountant.api.ledger.reverseJournal({
        params: { orgId, journalId: income.id },
        body: { date: "2026-10-05", reason: "Reverse incorrect income" },
      });
      await director.api.ledger.approveJournal({ params: { orgId, journalId: reversal.id } });
      const corrected = await accountant.api.ledger.financialStatements({ params: { orgId }, query });
      expect(corrected.profitAndLoss).toEqual({ incomeMinor: -3_000, expensesMinor: 4_000, netProfitMinor: -7_000 });
      expect(corrected.balanceSheet).toMatchObject({
        assetsMinor: 121_000,
        unclosedEarningsMinor: 13_000,
        balanced: true,
        differenceMinor: 0,
      });
    },
  );
});
