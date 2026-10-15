// The one double-entry ledger: chart of accounts, manual journals with a second approver, reversals, closed months,
// reports — and the database refusing anything that would break the books, even from code that skips the service.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refused, startServer, type Person, type TestServer } from "./support/test-server.js";

describe("ledger", () => {
  let S: TestServer;
  let orgId: string;
  let admin: Person, accountant: Person, fd: Person, auditor: Person, agent: Person;
  const lines = (dr: string, cr: string, amount: number) => [
    { account: dr, debitMinor: amount },
    { account: cr, creditMinor: amount },
  ];

  beforeAll(async () => {
    S = await startServer();
    const o = await S.newOrg({ name: "Ledger Co", trial: false });
    orgId = o.orgId;
    admin = o.admin;
    accountant = await S.addMember(orgId, admin.api, "accountant");
    fd = await S.addMember(orgId, admin.api, "finance_director");
    auditor = await S.addMember(orgId, admin.api, "auditor");
    agent = await S.addMember(orgId, admin.api, "leasing_agent");
  });
  afterAll(() => S.close());

  it("starts with the core chart; accounts follow the first-digit rule", async () => {
    const chart = await accountant.api.ledger.listAccounts({ params: { orgId } });
    expect(chart.currency).toBe("KES");
    expect(chart.accounts.map((a) => a.code)).toEqual([
      "1000",
      "1100",
      "2000",
      "2100",
      "3000",
      "3100",
      "4000",
      "5000",
      "5300",
    ]);
    await refused(
      fd.api.ledger.createAccount({ params: { orgId }, body: { code: "4100", name: "Wrong type", type: "asset" } }),
      400,
    );
    await refused(
      fd.api.ledger.createAccount({ params: { orgId }, body: { code: "1000", name: "Duplicate", type: "asset" } }),
      409,
    );
    await refused(
      accountant.api.ledger.createAccount({
        params: { orgId },
        body: { code: "5400", name: "Software", type: "expense" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const a = await fd.api.ledger.createAccount({
      params: { orgId },
      body: { code: "5400", name: "Software and administration", type: "expense" },
    });
    expect(a).toMatchObject({ code: "5400", type: "expense", active: true, system: false, balanceMinor: 0 });
  });

  let first: string;
  it("a manual journal is prepared, then approved by someone else, and only then posts", async () => {
    const j = await accountant.api.ledger.createJournal({
      params: { orgId },
      body: { date: "2026-10-05", memo: "Owner capital paid in", lines: lines("1000", "3000", 1_000_000) },
    });
    first = j.id;
    expect([j.status, j.number, j.totalMinor, j.preparedBy]).toEqual([
      "awaiting_approval",
      "JE-000001",
      1_000_000,
      accountant.userId,
    ]);
    expect((await accountant.api.ledger.trialBalance({ params: { orgId } })).rows).toEqual([]); // nothing posted yet
    const self = await refused(
      accountant.api.ledger.approveJournal({ params: { orgId, journalId: j.id } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    expect(self.message).toMatch(/someone else/);
    await refused(agent.api.ledger.approveJournal({ params: { orgId, journalId: j.id } }), 403, "ROLE_NOT_ALLOWED");
    await refused(admin.api.ledger.approveJournal({ params: { orgId, journalId: j.id } }), 403, "ROLE_NOT_ALLOWED");
    const posted = await fd.api.ledger.approveJournal({ params: { orgId, journalId: j.id } });
    expect([posted.status, posted.approvedBy]).toEqual(["posted", fd.userId]);
    await refused(fd.api.ledger.approveJournal({ params: { orgId, journalId: j.id } }), 409);
    const tb = await auditor.api.ledger.trialBalance({ params: { orgId } });
    expect(tb.rows).toEqual([
      {
        code: "1000",
        name: "Operating bank account (company money)",
        type: "asset",
        debitMinor: 1_000_000,
        creditMinor: 0,
      },
      { code: "3000", name: "Company equity", type: "equity", debitMinor: 0, creditMinor: 1_000_000 },
    ]);
    expect(tb.balanced).toBe(true);
  });

  it("refuses unbalanced, one-sided, inactive-account and unknown-account journals", async () => {
    const body = (l: { account: string; debitMinor?: number; creditMinor?: number }[]) => ({
      params: { orgId },
      body: { date: "2026-10-06", memo: "Bad journal", lines: l },
    });
    expect(
      (
        await refused(
          accountant.api.ledger.createJournal(
            body([
              { account: "1000", debitMinor: 500 },
              { account: "4000", creditMinor: 400 },
            ]),
          ),
          400,
        )
      ).message,
    ).toMatch(/does not balance/);
    await refused(
      accountant.api.ledger.createJournal(
        body([
          { account: "1000", debitMinor: 500, creditMinor: 500 },
          { account: "4000", creditMinor: 0 },
        ]),
      ),
      400,
    );
    await refused(accountant.api.ledger.createJournal(body([{ account: "1000", debitMinor: 500 }])), 400);
    expect((await refused(accountant.api.ledger.createJournal(body(lines("1999", "4000", 100))), 400)).message).toMatch(
      /not in your chart/,
    );
    await fd.api.ledger.updateAccount({ params: { orgId, code: "5400" }, body: { active: false } });
    expect((await refused(accountant.api.ledger.createJournal(body(lines("5400", "1000", 100))), 400)).message).toMatch(
      /inactive/,
    );
    await refused(fd.api.ledger.updateAccount({ params: { orgId, code: "1000" }, body: { active: false } }), 409); // system account
    await refused(agent.api.ledger.createJournal(body(lines("5000", "1000", 100))), 403, "ROLE_NOT_ALLOWED");
    await refused(auditor.api.ledger.createJournal(body(lines("5000", "1000", 100))), 403, "ROLE_NOT_ALLOWED");
  });

  it("an account with a balance cannot be deactivated", async () => {
    await refused(fd.api.ledger.updateAccount({ params: { orgId, code: "3000" }, body: { active: false } }), 409);
    const renamed = await fd.api.ledger.updateAccount({
      params: { orgId, code: "3000" },
      body: { name: "Owner's equity" },
    });
    expect(renamed.name).toBe("Owner's equity");
  });

  it("a rejected journal never posts and cannot be approved later", async () => {
    const j = await accountant.api.ledger.createJournal({
      params: { orgId },
      body: { date: "2026-10-07", memo: "Typo journal", lines: lines("5000", "1000", 999) },
    });
    const r = await fd.api.ledger.rejectJournal({
      params: { orgId, journalId: j.id },
      body: { reason: "Wrong amount, re-enter" },
    });
    expect([r.status, r.rejectedReason]).toEqual(["rejected", "Wrong amount, re-enter"]);
    await refused(fd.api.ledger.approveJournal({ params: { orgId, journalId: j.id } }), 409);
  });

  it("a posted journal is corrected by a reversal, never edited; it can be reversed only once", async () => {
    const rev = await accountant.api.ledger.reverseJournal({
      params: { orgId, journalId: first },
      body: { date: "2026-10-08", reason: "Capital was a loan" },
    });
    expect(rev.status).toBe("awaiting_approval");
    expect(rev.reverses).toBe(first);
    expect(rev.lines.map((l) => [l.account, l.debitMinor, l.creditMinor])).toEqual([
      ["1000", 0, 1_000_000],
      ["3000", 1_000_000, 0],
    ]);
    await refused(
      accountant.api.ledger.reverseJournal({
        params: { orgId, journalId: first },
        body: { date: "2026-10-08", reason: "Second try" },
      }),
      409,
    );
    await refused(
      accountant.api.ledger.reverseJournal({
        params: { orgId, journalId: rev.id },
        body: { date: "2026-10-08", reason: "Not posted yet" },
      }),
      409,
    );
    await fd.api.ledger.approveJournal({ params: { orgId, journalId: rev.id } });
    const original = await auditor.api.ledger.getJournal({ params: { orgId, journalId: first } });
    expect(original.reversedBy).toBe(rev.id);
    await refused(
      accountant.api.ledger.reverseJournal({
        params: { orgId, journalId: first },
        body: { date: "2026-10-09", reason: "Third try" },
      }),
      409,
    );
    const tb = await auditor.api.ledger.trialBalance({ params: { orgId } });
    expect(tb.rows.every((r) => r.debitMinor === 0 && r.creditMinor === 0)).toBe(true);
  });

  it("the database itself refuses to change or delete posted journals, or post an unbalanced one", async () => {
    await expect(S.sql("UPDATE journal_entries SET memo = 'edited' WHERE id = $1", [first])).rejects.toThrow(
      /cannot be (changed|edited)/,
    );
    await expect(S.sql("UPDATE journal_lines SET debit_minor = 1 WHERE entry_id = $1", [first])).rejects.toThrow(
      /cannot be changed/,
    );
    await expect(S.sql("DELETE FROM journal_entries WHERE id = $1", [first])).rejects.toThrow(/cannot be deleted/);
    await expect(S.sql("TRUNCATE journal_lines")).rejects.toThrow(/cannot be emptied/);
    // an unbalanced posting attempted directly in SQL fails when the transaction commits
    const attempt = S.app.ctx.db.tx(async (t) => {
      await t.run(
        "INSERT INTO journal_entries (id, org_id, number, date, memo, currency, source, status) VALUES ('je_x', $1, 'JE-X', '2026-10-10', 'x', 'KES', 'system:test', 'awaiting_approval')",
        [orgId],
      );
      await t.run(
        "INSERT INTO journal_lines (entry_id, line_no, org_id, account_code, debit_minor) VALUES ('je_x', 1, $1, '1000', 500)",
        [orgId],
      );
      await t.run(
        "INSERT INTO journal_lines (entry_id, line_no, org_id, account_code, credit_minor) VALUES ('je_x', 2, $1, '4000', 400)",
        [orgId],
      );
      await t.run("UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = 'je_x'");
    });
    await expect(attempt).rejects.toThrow(/does not balance/);
    // a manual journal approved by its own preparer is refused by a database constraint
    const selfApprove = S.app.ctx.db.tx(async (t) => {
      await t.run(
        "INSERT INTO journal_entries (id, org_id, number, date, memo, currency, source, status, prepared_by) VALUES ('je_y', $1, 'JE-Y', '2026-10-10', 'y', 'KES', 'manual', 'awaiting_approval', $2)",
        [orgId, accountant.userId],
      );
      await t.run(
        "INSERT INTO journal_lines (entry_id, line_no, org_id, account_code, debit_minor) VALUES ('je_y', 1, $1, '1000', 500)",
        [orgId],
      );
      await t.run(
        "INSERT INTO journal_lines (entry_id, line_no, org_id, account_code, credit_minor) VALUES ('je_y', 2, $1, '4000', 500)",
        [orgId],
      );
      await t.run(
        "UPDATE journal_entries SET status = 'posted', posted_at = now(), approved_by = $1 WHERE id = 'je_y'",
        [accountant.userId],
      );
    });
    await expect(selfApprove).rejects.toThrow(/manual_journal_needs_second_person/);
  });

  it("closing a month stops postings into it; reopening needs a reason and is audited", async () => {
    const waiting = await accountant.api.ledger.createJournal({
      params: { orgId },
      body: { date: "2026-09-20", memo: "September rent", lines: lines("1100", "4000", 50_000) },
    });
    const blocked = await refused(
      fd.api.ledger.closePeriod({ params: { orgId, month: "2026-09" }, body: { reason: "September books done" } }),
      409,
    );
    expect(blocked.message).toMatch(/still await approval/);
    await fd.api.ledger.approveJournal({ params: { orgId, journalId: waiting.id } });
    await refused(
      accountant.api.ledger.closePeriod({
        params: { orgId, month: "2026-09" },
        body: { reason: "September books done" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await refused(
      fd.api.ledger.closePeriod({ params: { orgId, month: "2026-12" }, body: { reason: "Future month" } }),
      400,
    );
    const closed = await fd.api.ledger.closePeriod({
      params: { orgId, month: "2026-09" },
      body: { reason: "September books done" },
    });
    expect([closed.month, closed.status, closed.changedBy]).toEqual(["2026-09", "closed", fd.userId]);
    await refused(
      fd.api.ledger.closePeriod({ params: { orgId, month: "2026-09" }, body: { reason: "Again please" } }),
      409,
    );
    await refused(
      accountant.api.ledger.createJournal({
        params: { orgId },
        body: { date: "2026-09-25", memo: "Late entry", lines: lines("5000", "1000", 100) },
      }),
      409,
      "PERIOD_CLOSED",
    );
    // a journal prepared before the close cannot be approved into it either
    const reopened = await fd.api.ledger.reopenPeriod({
      params: { orgId, month: "2026-09" },
      body: { reason: "Late supplier invoice" },
    });
    expect(reopened.status).toBe("open");
    await accountant.api.ledger.createJournal({
      params: { orgId },
      body: { date: "2026-09-26", memo: "Late supplier invoice", lines: lines("5000", "2000", 7_500) },
    });
    await refused(
      fd.api.ledger.closePeriod({ params: { orgId, month: "2026-09" }, body: { reason: "Closed again" } }),
      409,
    ); // the late journal is waiting
    await refused(
      fd.api.ledger.reopenPeriod({ params: { orgId, month: "2026-08" }, body: { reason: "Was never closed" } }),
      409,
    );
    const audit = await admin.api.organisations.listAudit({ params: { orgId }, query: { limit: 100 } });
    expect(audit.entries.map((e) => e.action)).toEqual(
      expect.arrayContaining(["Month closed", "Month reopened", "Journal approved and posted"]),
    );
    expect((await auditor.api.ledger.listPeriods({ params: { orgId } })).periods[0]).toMatchObject({
      month: "2026-09",
      status: "open",
    });
  });

  it("the database refuses a posting into a closed month even without the service", async () => {
    await fd.api.ledger.approveJournal({
      params: {
        orgId,
        journalId: (
          await auditor.api.ledger.listJournals({ params: { orgId }, query: { status: "awaiting_approval" } })
        ).journals[0]!.id,
      },
    });
    await fd.api.ledger.closePeriod({ params: { orgId, month: "2026-09" }, body: { reason: "September final" } });
    const sneak = S.app.ctx.db.tx(async (t) => {
      await t.run(
        "INSERT INTO journal_entries (id, org_id, number, date, memo, currency, source, status) VALUES ('je_z', $1, 'JE-Z', '2026-09-30', 'z', 'KES', 'system:test', 'awaiting_approval')",
        [orgId],
      );
      await t.run(
        "INSERT INTO journal_lines (entry_id, line_no, org_id, account_code, debit_minor) VALUES ('je_z', 1, $1, '1000', 5)",
        [orgId],
      );
      await t.run(
        "INSERT INTO journal_lines (entry_id, line_no, org_id, account_code, credit_minor) VALUES ('je_z', 2, $1, '4000', 5)",
        [orgId],
      );
      await t.run("UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = 'je_z'");
    });
    await expect(sneak).rejects.toThrow(/September 2026 is closed/);
  });

  it("automatic postings from product workflows post once per source document", async () => {
    const post = () =>
      S.app.ctx.db.tx((t) =>
        S.app.core.ledger.postSystemJournal(t, {
          orgId,
          date: "2026-10-10",
          memo: "Rent invoice RI-00001",
          source: "system:rent",
          sourceRef: "RI-00001",
          lines: [
            { account: "1100", debitMinor: 6_200_000, creditMinor: 0, dimensions: { unit: "A-101" } },
            { account: "4000", debitMinor: 0, creditMinor: 6_200_000 },
          ],
        }),
      );
    const a = await post();
    const b = await post();
    expect(a.id).toBe(b.id);
    expect([a.status, a.source, a.preparedBy, a.approvedBy]).toEqual(["posted", "system:rent", null, null]);
    const count = await S.sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM journal_entries WHERE source_ref = 'RI-00001'",
    );
    expect(count[0]!.n).toBe(1);
    await expect(
      S.app.ctx.db.tx((t) =>
        S.app.core.ledger.postSystemJournal(t, {
          orgId,
          date: "2026-10-10",
          memo: "x",
          source: "system:rent",
          sourceRef: "RI-BAD",
          lines: [
            { account: "1100", debitMinor: 5, creditMinor: 0 },
            { account: "4000", debitMinor: 0, creditMinor: 4 },
          ],
        }),
      ),
    ).rejects.toThrow(/does not balance/);
  });

  it("account activity shows the opening balance, each movement and a running balance", async () => {
    const act = await auditor.api.ledger.accountActivity({
      params: { orgId, code: "1100" },
      query: { from: "2026-10-01", to: "2026-10-31" },
    });
    expect(act.openingMinor).toBe(50_000); // September rent
    expect(act.lines.map((l) => [l.date, l.debitMinor, l.balanceMinor])).toEqual([
      ["2026-10-10", 6_200_000, 6_250_000],
    ]);
    expect(act.closingMinor).toBe(6_250_000);
    await refused(
      auditor.api.ledger.accountActivity({
        params: { orgId, code: "1100" },
        query: { from: "2026-10-31", to: "2026-10-01" },
      }),
      400,
    );
    await refused(
      auditor.api.ledger.accountActivity({
        params: { orgId, code: "1999" },
        query: { from: "2026-10-01", to: "2026-10-31" },
      }),
      404,
    );
  });

  it("the trial balance always balances, and journals can be filtered", async () => {
    const tb = await auditor.api.ledger.trialBalance({ params: { orgId }, query: { asOf: "2026-10-31" } });
    expect(tb.balanced).toBe(true);
    expect(tb.totals.debitMinor).toBe(tb.totals.creditMinor);
    const sept = await auditor.api.ledger.listJournals({
      params: { orgId },
      query: { from: "2026-09-01", to: "2026-09-30" },
    });
    expect(sept.journals.every((j) => j.date.startsWith("2026-09"))).toBe(true);
    const tbSept = await auditor.api.ledger.trialBalance({ params: { orgId }, query: { asOf: "2026-09-30" } });
    expect(tbSept.rows.find((r) => r.code === "1100")?.debitMinor).toBe(50_000);
  });

  it("another organisation's ledger is invisible", async () => {
    const other = await S.newOrg({ name: "Other Co", trial: false });
    await refused(other.admin.api.ledger.getJournal({ params: { orgId, journalId: first } }), 404);
    await refused(other.admin.api.ledger.getJournal({ params: { orgId: other.orgId, journalId: first } }), 404);
    expect((await other.admin.api.ledger.trialBalance({ params: { orgId: other.orgId } })).rows).toEqual([]);
  });

  it("without the Finance module the ledger can be read but not changed", async () => {
    const sa = await S.staff();
    await sa.api.admin.savePlan({
      params: { planId: "PM-BASIC" },
      body: {
        name: "Property Management — Basic",
        tier: null,
        product: "property",
        modules: ["maint"],
        buildingsIncluded: 1,
        baseMinor: 1_000_000,
        currency: "KES",
        taxPct: 16,
      },
    });
    const basic = await S.newOrg({ name: "Basic Co", plan: "PM-BASIC", trial: false });
    const acc = await S.addMember(basic.orgId, basic.admin.api, "accountant");
    expect((await acc.api.ledger.trialBalance({ params: { orgId: basic.orgId } })).balanced).toBe(true);
    const r = await refused(
      acc.api.ledger.createJournal({
        params: { orgId: basic.orgId },
        body: { date: "2026-10-10", memo: "Not allowed", lines: lines("5000", "1000", 100) },
      }),
      403,
      "MODULE_NOT_ENTITLED",
    );
    expect(r.details).toMatchObject({ module: "finance", canBuy: true });
  });
});
