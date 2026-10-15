// One test per problem found by the independent review of 14 October 2026, so none can return unnoticed.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refused, startServer, type Person, type TestServer } from "./support/test-server.js";

describe("independent review findings stay fixed", () => {
  let S: TestServer;
  let orgId: string;
  let admin: Person, accountant: Person, fd: Person;
  let otherOrg: string;
  const lines = (dr: string, cr: string, n: number) => [
    { account: dr, debitMinor: n },
    { account: cr, creditMinor: n },
  ];

  beforeAll(async () => {
    S = await startServer();
    ({ orgId, admin } = await S.newOrg({ name: "Review Co", trial: false }));
    accountant = await S.addMember(orgId, admin.api, "accountant");
    fd = await S.addMember(orgId, admin.api, "finance_director");
    otherOrg = (await S.newOrg({ name: "Review Other Co", trial: false })).orgId;
  });
  afterAll(() => S.close());

  const posted = async (memo: string, date = "2026-10-05") => {
    const j = await accountant.api.ledger.createJournal({
      params: { orgId },
      body: { date, memo, lines: lines("1000", "4000", 100) },
    });
    return fd.api.ledger.approveJournal({ params: { orgId, journalId: j.id } });
  };

  it("1. a line cannot be moved into a posted journal (lines are write-once)", async () => {
    const p = await posted("Posted one");
    const waiting = await accountant.api.ledger.createJournal({
      params: { orgId },
      body: { date: "2026-10-05", memo: "Waiting", lines: lines("1000", "4000", 50) },
    });
    await expect(
      S.sql("UPDATE journal_lines SET entry_id = $1, line_no = 3 WHERE entry_id = $2 AND line_no = 1", [
        p.id,
        waiting.id,
      ]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(S.sql("UPDATE journal_lines SET memo = 'x' WHERE entry_id = $1", [waiting.id])).rejects.toThrow(
      /cannot be changed/,
    );
  });

  it("2. a journal cannot be moved to another organisation, before or while posting", async () => {
    const w = await accountant.api.ledger.createJournal({
      params: { orgId },
      body: { date: "2026-10-05", memo: "Mine", lines: lines("1000", "4000", 70) },
    });
    await expect(
      S.sql(
        "UPDATE journal_entries SET org_id = $1, status = 'posted', posted_at = now(), approved_by = $2 WHERE id = $3",
        [otherOrg, fd.userId, w.id],
      ),
    ).rejects.toThrow(/cannot be edited/);
    await expect(S.sql("UPDATE journal_entries SET org_id = $1 WHERE id = $2", [otherOrg, w.id])).rejects.toThrow(
      /cannot be edited/,
    );
  });

  it("3. the preparer of a manual journal cannot be erased to approve it oneself", async () => {
    const w = await accountant.api.ledger.createJournal({
      params: { orgId },
      body: { date: "2026-10-05", memo: "Self", lines: lines("1000", "4000", 80) },
    });
    await expect(S.sql("UPDATE journal_entries SET prepared_by = NULL WHERE id = $1", [w.id])).rejects.toThrow(
      /cannot be edited/,
    );
    await expect(
      S.sql(
        "INSERT INTO journal_entries (id, org_id, number, date, memo, currency, source, status) VALUES ('je_np', $1, 'JE-NP', '2026-10-05', 'x', 'KES', 'manual', 'awaiting_approval')",
        [orgId],
      ),
    ).rejects.toThrow(/manual_journal_names_preparer/);
  });

  it("4. closing a month and posting into it cannot both succeed", async () => {
    const w = await accountant.api.ledger.createJournal({
      params: { orgId },
      body: { date: "2026-08-10", memo: "August", lines: lines("1000", "4000", 90) },
    });
    const closer = new pg.Client({ connectionString: S.app.ctx.config.databaseUrl });
    const poster = new pg.Client({ connectionString: S.app.ctx.config.databaseUrl });
    await closer.connect();
    await poster.connect();
    try {
      await closer.query("BEGIN");
      await closer.query("SELECT pg_advisory_xact_lock(ledger_period_lock_key($1, '2026-08-01'))", [orgId]);
      await closer.query(
        "INSERT INTO ledger_periods (org_id, month, status, reason) VALUES ($1, '2026-08-01', 'closed', 'race test')",
        [orgId],
      );
      // the posting waits for the close, then sees it
      const posting = poster.query(
        "UPDATE journal_entries SET status = 'posted', posted_at = now(), approved_by = $1 WHERE id = $2",
        [fd.userId, w.id],
      );
      await new Promise((r) => setTimeout(r, 300));
      await closer.query("COMMIT");
      await expect(posting).rejects.toThrow(/August 2026 is closed/);
    } finally {
      await closer.end();
      await poster.end();
    }
  });

  it("5. a journal can only be marked reversed by its own posted reversal", async () => {
    const p = await posted("To be reversed");
    const unrelated = await posted("Unrelated");
    await expect(
      S.sql("UPDATE journal_entries SET reversed_by = $1 WHERE id = $2", [unrelated.id, p.id]),
    ).rejects.toThrow(/its own posted reversal/);
    const rev = await accountant.api.ledger.reverseJournal({
      params: { orgId, journalId: p.id },
      body: { date: "2026-10-06", reason: "Proper reversal" },
    });
    await expect(S.sql("UPDATE journal_entries SET reversed_by = $1 WHERE id = $2", [rev.id, p.id])).rejects.toThrow(
      /its own posted reversal/,
    ); // not posted yet
    await fd.api.ledger.approveJournal({ params: { orgId, journalId: rev.id } });
    expect((await fd.api.ledger.getJournal({ params: { orgId, journalId: p.id } })).reversedBy).toBe(rev.id);
  });

  it("6. an existing account is invited, sees nothing until it accepts, and its details stay private", async () => {
    const elsewhere = await S.newOrg({ name: "Rival Co", trial: false });
    const cfo = await S.addMember(elsewhere.orgId, elsewhere.admin.api, "finance_director", "cfo@rival.test");
    const r = await admin.api.organisations.addMember({
      params: { orgId },
      body: { email: "cfo@rival.test", role: "viewer" },
    });
    expect(r.member).toMatchObject({ status: "invited", name: "cfo@rival.test" });
    expect(r.temporaryPassword).toBeNull();
    await refused(cfo.api.organisations.get({ params: { orgId } }), 404);
    const me = await cfo.api.identity.me();
    expect(me.invitations).toEqual([{ orgId, orgName: "Review Co", role: "viewer" }]);
    expect(me.organisations.map((o) => o.id)).toEqual([elsewhere.orgId]);
    await refused(
      admin.api.organisations.updateMember({ params: { orgId, userId: cfo.userId }, body: { status: "active" } }),
      409,
    );
    await cfo.api.identity.declineInvitation({ params: { orgId } });
    expect(
      (await admin.api.organisations.listMembers({ params: { orgId } })).members.some(
        (m) => m.email === "cfo@rival.test",
      ),
    ).toBe(false);
    await admin.api.organisations.addMember({ params: { orgId }, body: { email: "cfo@rival.test", role: "viewer" } });
    await cfo.api.identity.acceptInvitation({ params: { orgId } });
    expect((await cfo.api.organisations.get({ params: { orgId } })).id).toBe(orgId);
    await refused(cfo.api.identity.acceptInvitation({ params: { orgId } }), 404);
  });

  it("7. parallel wrong passwords still lock the account", async () => {
    const m = await S.addMember(orgId, admin.api, "viewer");
    await Promise.all(
      Array.from({ length: 12 }, () =>
        S.raw("POST", "/api/v1/auth/login", { email: m.email, password: "wrong-wrong-wrong" }),
      ),
    );
    await refused(S.api.identity.login({ body: { email: m.email, password: m.password } }), 429, "TOO_MANY_ATTEMPTS");
  });

  it("8. two administrators demoting each other at once cannot leave the organisation without one", async () => {
    const o = await S.newOrg({ name: "Two Admins Co", trial: false });
    const second = await S.addMember(o.orgId, o.admin.api, "org_admin");
    const results = await Promise.allSettled([
      o.admin.api.organisations.updateMember({
        params: { orgId: o.orgId, userId: second.userId },
        body: { role: "viewer" },
      }),
      second.api.organisations.updateMember({
        params: { orgId: o.orgId, userId: o.admin.userId },
        body: { role: "viewer" },
      }),
    ]);
    // the first change locks the organisation; the second then runs as a viewer or finds no other administrator
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const admins = await S.sql(
      "SELECT 1 FROM memberships WHERE org_id = $1 AND role = 'org_admin' AND status = 'active'",
      [o.orgId],
    );
    expect(admins.length).toBe(1);
  });

  it("9. dates that do not exist are refused cleanly (400, not a server error)", async () => {
    const bad = await S.raw(
      "POST",
      `/api/v1/orgs/${orgId}/ledger/journals`,
      { date: "2026-02-31", memo: "Bad date", lines: lines("1000", "4000", 1) },
      accountant.token,
    );
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/does not exist/);
    expect(
      (await S.raw("POST", `/api/v1/orgs/${orgId}/ledger/periods/2026-13/close`, { reason: "Bad month" }, fd.token))
        .status,
    ).toBe(400);
    expect(
      (await S.raw("GET", `/api/v1/orgs/${orgId}/ledger/trial-balance?asOf=9999-99-99`, undefined, fd.token)).status,
    ).toBe(400);
  });

  it("smaller points: inactive accounts can still be reversed; odd provider names; session age limit", async () => {
    await fd.api.ledger.createAccount({
      params: { orgId },
      body: { code: "5600", name: "Old expense", type: "expense" },
    });
    const j = await accountant.api.ledger.createJournal({
      params: { orgId },
      body: { date: "2026-10-07", memo: "Old expense", lines: lines("5600", "1000", 300) },
    });
    await fd.api.ledger.approveJournal({ params: { orgId, journalId: j.id } });
    const back = await accountant.api.ledger.createJournal({
      params: { orgId },
      body: { date: "2026-10-07", memo: "Clear it", lines: lines("1000", "5600", 300) },
    });
    await fd.api.ledger.approveJournal({ params: { orgId, journalId: back.id } });
    await fd.api.ledger.updateAccount({ params: { orgId, code: "5600" }, body: { active: false } });
    const rev = await accountant.api.ledger.reverseJournal({
      params: { orgId, journalId: j.id },
      body: { date: "2026-10-08", reason: "Reverse after deactivation" },
    });
    expect(rev.status).toBe("awaiting_approval");

    for (const p of ["constructor", "__proto__", "tostring"])
      expect((await S.webhook({ id: "x" }, { provider: p })).status).toBe(404);

    const m = await S.addMember(orgId, admin.api, "viewer");
    await S.sql("UPDATE sessions SET created_at = now() - interval '13 hours' WHERE user_id = $1", [m.userId]);
    await refused(m.api.identity.me(), 401, "NOT_SIGNED_IN");
  });
});
