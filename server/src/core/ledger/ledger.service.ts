/*
 * The organisation's ONE double-entry ledger.
 *
 * Manual journals: prepare → a different person approves → posted. Mistakes are reversed, never edited.
 * Automatic postings by product workflows: postSystemJournal(), posted at once, once per source document.
 * Months can be closed; nothing posts into a closed month until it is reopened (with a reason).
 *
 * This service checks everything first to give clear messages; the database enforces the same rules again
 * (migration 0002), so no code path — including future product code — can break them.
 */
import type { AccountType, Journal, JournalStatus } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import { nextNumber } from "../../db/counters.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { monthName } from "../../lib/dates.js";
import { newId } from "../../lib/ids.js";
import type { OrgScope } from "../access/org-access.js";
import { recordAudit, SYSTEM } from "../audit/audit.service.js";
import * as repo from "./ledger.repo.js";

const FIRST_DIGIT: Record<AccountType, RegExp> = {
  asset: /^1/,
  liability: /^2/,
  equity: /^3/,
  income: /^4/,
  expense: /^[5-9]/,
};

export interface SystemJournalInput {
  orgId: string;
  date: string;
  memo: string;
  /** "system:<module>", e.g. "system:rent". */
  source: `system:${string}`;
  /** The source document (invoice, payment …). The same document is never posted twice. */
  sourceRef: string;
  lines: repo.NewLine[];
  reverses?: string;
}

async function orgCurrency(db: Db, orgId: string): Promise<string> {
  const o = await db.row<{ currency: string }>("SELECT currency FROM organisations WHERE id = $1", [orgId]);
  if (!o) throw fail.notFound("Organisation not found");
  return o.currency;
}

async function isClosed(db: Db, orgId: string, date: string): Promise<boolean> {
  return !!(await db.row(
    "SELECT 1 FROM ledger_periods WHERE org_id = $1 AND month = date_trunc('month', $2::date)::date AND status = 'closed'",
    [orgId, date],
  ));
}

/**
 * Lines must use this organisation's accounts — active ones, except in a reversal, which must always be possible —
 * and balance above zero.
 */
async function checkLines(
  db: Db,
  orgId: string,
  lines: repo.NewLine[],
  o: { allowInactive?: boolean } = {},
): Promise<void> {
  if (lines.length < 2) throw fail.invalid("A journal needs at least two lines");
  for (const l of lines) {
    if (
      !Number.isSafeInteger(l.debitMinor) ||
      !Number.isSafeInteger(l.creditMinor) ||
      l.debitMinor < 0 ||
      l.creditMinor < 0 ||
      l.debitMinor > 0 === l.creditMinor > 0
    ) {
      throw fail.invalid(`Account ${l.account}: each line is either a debit or a credit, above zero`);
    }
    const a = await repo.account(db, orgId, l.account);
    if (!a) throw fail.invalid(`Account ${l.account} is not in your chart of accounts`);
    if (!a.active && !o.allowInactive) throw fail.invalid(`Account ${l.account} (${a.name}) is inactive`);
  }
  const dr = lines.reduce((s, l) => s + l.debitMinor, 0);
  const cr = lines.reduce((s, l) => s + l.creditMinor, 0);
  if (!Number.isSafeInteger(dr) || !Number.isSafeInteger(cr)) throw fail.invalid("The journal total is too large");
  if (dr !== cr) throw fail.invalid(`The journal does not balance: debits ${dr}, credits ${cr} (minor units)`);
}

export function ledgerService(ctx: AppContext) {
  const { db, clock } = ctx;

  async function load(t: Db, orgId: string, id: string): Promise<Journal> {
    const row = await repo.entry(t, orgId, id);
    if (!row) throw fail.notFound("Journal not found");
    const [j] = await repo.withLines(t, [row]);
    return j as Journal;
  }

  /** Prepare a manual journal; it waits for someone else to approve it. */
  async function prepareJournal(
    s: OrgScope,
    input: { date: string; memo: string; lines: repo.NewLine[]; reverses?: string },
  ) {
    await checkLines(db, s.orgId, input.lines, { allowInactive: !!input.reverses });
    if (await isClosed(db, s.orgId, input.date))
      throw fail.periodClosed(`${monthName(input.date)} is closed — reopen it or choose another date`);
    return db.tx(async (t) => {
      const id = newId("je");
      await repo.insertEntry(
        t,
        {
          id,
          org_id: s.orgId,
          number: await nextNumber(t, s.orgId, "JE", 6),
          date: input.date,
          memo: input.memo,
          currency: await orgCurrency(t, s.orgId),
          source: "manual",
          source_ref: null,
          prepared_by: s.userId,
          reverses: input.reverses ?? null,
        },
        input.lines,
      );
      const j = await load(t, s.orgId, id);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: input.reverses ? "Reversal prepared" : "Journal prepared",
        target: j.number,
        detail: input.memo,
        after: { totalMinor: j.totalMinor, date: j.date },
      });
      return j;
    });
  }

  return {
    // ---------------------------------------------------------------- accounts
    async listAccounts(orgId: string) {
      return { currency: await orgCurrency(db, orgId), accounts: await repo.accounts(db, orgId, clock.today()) };
    },

    async createAccount(s: OrgScope, input: { code: string; name: string; type: AccountType }) {
      if (!FIRST_DIGIT[input.type].test(input.code)) {
        throw fail.invalid(
          "The account code's first digit must match its type (1 asset, 2 liability, 3 equity, 4 income, 5–9 expense)",
        );
      }
      if (await repo.account(db, s.orgId, input.code)) throw fail.conflict(`Account ${input.code} already exists`);
      await db.tx(async (t) => {
        await t.run("INSERT INTO ledger_accounts (org_id, code, name, type) VALUES ($1, $2, $3, $4)", [
          s.orgId,
          input.code,
          input.name,
          input.type,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Account added",
          target: input.code,
          detail: `${input.name} (${input.type})`,
        });
      });
      return (await repo.accounts(db, s.orgId, clock.today())).find((a) => a.code === input.code) as repo.AccountRow & {
        balanceMinor: number;
      };
    },

    async updateAccount(s: OrgScope, code: string, input: { name?: string | undefined; active?: boolean | undefined }) {
      const before = await repo.account(db, s.orgId, code);
      if (!before) throw fail.notFound("Account not found");
      const current = (await repo.accounts(db, s.orgId, "9999-12-31")).find((a) => a.code === code);
      if (input.active === false) {
        if (before.system) throw fail.conflict("This account is used by automatic postings and cannot be deactivated");
        if (current && current.balanceMinor !== 0)
          throw fail.conflict("Only an account with a zero balance can be deactivated");
      }
      await db.tx(async (t) => {
        await t.run(
          "UPDATE ledger_accounts SET name = COALESCE($3, name), active = COALESCE($4, active) WHERE org_id = $1 AND code = $2",
          [s.orgId, code, input.name ?? null, input.active ?? null],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Account changed",
          target: code,
          before,
          after: { ...before, ...input },
        });
      });
      return (await repo.accounts(db, s.orgId, clock.today())).find((a) => a.code === code) as repo.AccountRow & {
        balanceMinor: number;
      };
    },

    // ---------------------------------------------------------------- journals
    async listJournals(
      orgId: string,
      f: { status?: JournalStatus | undefined; from?: string | undefined; to?: string | undefined; limit: number },
    ) {
      const rows = await db.rows<repo.EntryRow>(
        `SELECT * FROM journal_entries
         WHERE org_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::date IS NULL OR date >= $3) AND ($4::date IS NULL OR date <= $4)
         ORDER BY date DESC, number DESC LIMIT $5`,
        [orgId, f.status ?? null, f.from ?? null, f.to ?? null, f.limit],
      );
      return repo.withLines(db, rows);
    },

    getJournal: (orgId: string, id: string) => load(db, orgId, id),

    prepareJournal,

    async approveJournal(s: OrgScope, id: string) {
      return db.tx(async (t) => {
        const e = await repo.entry(t, s.orgId, id, true);
        if (!e) throw fail.notFound("Journal not found");
        if (e.status !== "awaiting_approval")
          throw fail.conflict(`This journal is already ${e.status.replace("_", " ")}`);
        if (e.source === "manual" && e.prepared_by === s.userId) {
          throw fail.separationOfDuties("You prepared this journal — someone else must approve it");
        }
        if (await isClosed(t, s.orgId, e.date))
          throw fail.periodClosed(`${monthName(e.date)} is closed — reopen it before approving`);
        if (e.reverses) {
          const original = await repo.entry(t, s.orgId, e.reverses, true);
          if (!original || original.status !== "posted" || original.reversed_by)
            throw fail.conflict("The original journal is no longer reversible");
        }
        await repo.markPosted(t, id, s.userId);
        if (e.reverses) await t.run("UPDATE journal_entries SET reversed_by = $1 WHERE id = $2", [id, e.reverses]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: e.reverses ? "Reversal approved and posted" : "Journal approved and posted",
          target: e.number,
          detail: e.memo,
        });
        return load(t, s.orgId, id);
      });
    },

    async rejectJournal(s: OrgScope, id: string, reason: string) {
      return db.tx(async (t) => {
        const e = await repo.entry(t, s.orgId, id, true);
        if (!e) throw fail.notFound("Journal not found");
        if (e.status !== "awaiting_approval")
          throw fail.conflict(`This journal is already ${e.status.replace("_", " ")}`);
        await t.run("UPDATE journal_entries SET status = 'rejected', rejected_reason = $2 WHERE id = $1", [id, reason]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Journal rejected",
          target: e.number,
          detail: reason,
        });
        return load(t, s.orgId, id);
      });
    },

    /** Prepare the mirror image of a posted journal. It is approved like any manual journal. */
    async reverseJournal(s: OrgScope, id: string, input: { date: string; reason: string }) {
      const original = await load(db, s.orgId, id);
      if (original.status !== "posted") throw fail.conflict("Only a posted journal can be reversed");
      if (original.source !== "manual")
        throw fail.conflict(
          "Correct this transaction in its product workflow so the source records and ledger stay together",
        );
      if (original.reversedBy) throw fail.conflict(`Already reversed by ${original.reversedBy}`);
      if (input.date < original.date) throw fail.invalid("A reversal cannot be dated before the journal it reverses");
      const pending = await db.row(
        "SELECT 1 FROM journal_entries WHERE reverses = $1 AND status = 'awaiting_approval'",
        [id],
      );
      if (pending) throw fail.conflict("A reversal of this journal is already waiting for approval");
      return prepareJournal(s, {
        date: input.date,
        memo: `Reversal of ${original.number}: ${input.reason}`,
        reverses: id,
        lines: original.lines.map((l) => ({
          account: l.account,
          debitMinor: l.creditMinor,
          creditMinor: l.debitMinor,
          memo: l.memo,
        })),
      });
    },

    /**
     * For product workflows: post an automatic journal at once, inside the caller's transaction.
     * Posting the same source document again returns the existing journal (safe to retry).
     */
    async postSystemJournal(t: Db, input: SystemJournalInput): Promise<Journal> {
      const existing = await t.row<repo.EntryRow>(
        "SELECT * FROM journal_entries WHERE org_id = $1 AND source = $2 AND source_ref = $3 AND status <> 'rejected'",
        [input.orgId, input.source, input.sourceRef],
      );
      if (existing) return load(t, input.orgId, existing.id);
      if (input.reverses) {
        const original = await repo.entry(t, input.orgId, input.reverses, true);
        if (!original || original.status !== "posted" || original.reversed_by)
          throw fail.conflict("The original journal cannot be reversed");
        if (input.date < original.date) throw fail.invalid("A correction cannot predate its original posting");
      }
      await checkLines(t, input.orgId, input.lines);
      const id = newId("je");
      const number = await nextNumber(t, input.orgId, "JE", 6);
      await repo.insertEntry(
        t,
        {
          id,
          org_id: input.orgId,
          number,
          date: input.date,
          memo: input.memo,
          currency: await orgCurrency(t, input.orgId),
          source: input.source,
          source_ref: input.sourceRef,
          prepared_by: null,
          reverses: input.reverses ?? null,
        },
        input.lines,
      );
      await repo.markPosted(t, id, null);
      await recordAudit(t, {
        actor: SYSTEM,
        orgId: input.orgId,
        action: "Automatic journal posted",
        target: number,
        detail: `${input.source} · ${input.sourceRef}`,
      });
      return load(t, input.orgId, id);
    },

    // ---------------------------------------------------------------- reports
    async trialBalance(orgId: string, asOf?: string) {
      const date = asOf ?? clock.today();
      const rows = (await repo.lineTotals(db, orgId, date)).map((r) => {
        const net = r.dr - r.cr;
        return {
          code: r.code,
          name: r.name,
          type: r.type,
          debitMinor: Math.max(net, 0),
          creditMinor: Math.max(-net, 0),
        };
      });
      const totals = {
        debitMinor: rows.reduce((a, r) => a + r.debitMinor, 0),
        creditMinor: rows.reduce((a, r) => a + r.creditMinor, 0),
      };
      return {
        asOf: date,
        currency: await orgCurrency(db, orgId),
        rows,
        totals,
        balanced: totals.debitMinor === totals.creditMinor,
      };
    },

    async accountActivity(orgId: string, code: string, from: string, to: string) {
      if (from > to) throw fail.invalid("The start date is after the end date");
      const account = (await repo.accounts(db, orgId, to)).find((a) => a.code === code);
      if (!account) throw fail.notFound("Account not found");
      const opening = await db.row<{ n: number }>(
        `SELECT COALESCE(sum(l.debit_minor - l.credit_minor), 0)::bigint AS n FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
         WHERE l.org_id = $1 AND l.account_code = $2 AND e.date < $3`,
        [orgId, code, from],
      );
      const moves = await db.rows<{
        date: string;
        id: string;
        number: string;
        memo: string;
        debit_minor: number;
        credit_minor: number;
      }>(
        `SELECT e.date, e.id, e.number, COALESCE(NULLIF(l.memo, ''), e.memo) AS memo, l.debit_minor, l.credit_minor
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
         WHERE l.org_id = $1 AND l.account_code = $2 AND e.date BETWEEN $3 AND $4
         ORDER BY e.date, e.number, l.line_no`,
        [orgId, code, from, to],
      );
      let running = opening?.n ?? 0;
      const lines = moves.map((m) => {
        running += m.debit_minor - m.credit_minor;
        return {
          date: m.date,
          journalId: m.id,
          number: m.number,
          memo: m.memo,
          debitMinor: m.debit_minor,
          creditMinor: m.credit_minor,
          balanceMinor: running,
        };
      });
      return { account, openingMinor: opening?.n ?? 0, lines, closingMinor: running };
    },

    // ---------------------------------------------------------------- periods
    async listPeriods(orgId: string) {
      const rows = await db.rows<{
        month: string;
        status: "open" | "closed";
        changed_by: string | null;
        changed_at: string;
        reason: string;
      }>("SELECT * FROM ledger_periods WHERE org_id = $1 ORDER BY month DESC", [orgId]);
      return rows.map((r) => ({
        month: r.month.slice(0, 7),
        status: r.status,
        changedBy: r.changed_by,
        changedAt: r.changed_at,
        reason: r.reason,
      }));
    },

    async closePeriod(s: OrgScope, month: string, reason: string) {
      if (month > clock.today().slice(0, 7)) throw fail.invalid("A month can be closed only once it has started");
      return setPeriod(s, month, "closed", reason);
    },

    async reopenPeriod(s: OrgScope, month: string, reason: string) {
      const cur = await db.row<{ status: string }>(
        "SELECT status FROM ledger_periods WHERE org_id = $1 AND month = $2",
        [s.orgId, `${month}-01`],
      );
      if (cur?.status !== "closed") throw fail.conflict(`${monthName(`${month}-01`)} is not closed`);
      return setPeriod(s, month, "open", reason);
    },
  };

  async function setPeriod(s: OrgScope, month: string, status: "open" | "closed", reason: string) {
    const first = `${month}-01`;
    return db.tx(async (t) => {
      // exclusive per-(organisation, month) lock: postings into this month (shared lock, migration 0003) wait for us
      await t.run("SELECT pg_advisory_xact_lock(ledger_period_lock_key($1, $2::date))", [s.orgId, first]);
      if (status === "closed") {
        const waiting = await t.row<{ n: number }>(
          `SELECT count(*)::int AS n FROM journal_entries WHERE org_id = $1 AND status = 'awaiting_approval'
           AND date >= $2::date AND date < ($2::date + interval '1 month')`,
          [s.orgId, first],
        );
        if (waiting && waiting.n > 0) {
          throw fail.conflict(
            `${waiting.n} journal(s) dated in ${monthName(first)} still await approval — approve or reject them first`,
          );
        }
      }
      const cur = await t.row<{ status: string }>(
        "SELECT status FROM ledger_periods WHERE org_id = $1 AND month = $2 FOR UPDATE",
        [s.orgId, `${month}-01`],
      );
      if ((cur?.status ?? "open") === status) throw fail.conflict(`${monthName(`${month}-01`)} is already ${status}`);
      const row = await t.row<{
        month: string;
        status: "open" | "closed";
        changed_by: string;
        changed_at: string;
        reason: string;
      }>(
        `INSERT INTO ledger_periods (org_id, month, status, changed_by, reason) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, month) DO UPDATE SET status = EXCLUDED.status, changed_by = EXCLUDED.changed_by,
           changed_at = now(), reason = EXCLUDED.reason
         RETURNING *`,
        [s.orgId, `${month}-01`, status, s.userId, reason],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: status === "closed" ? "Month closed" : "Month reopened",
        target: month,
        detail: reason,
      });
      const r = row as NonNullable<typeof row>;
      return {
        month: r.month.slice(0, 7),
        status: r.status,
        changedBy: r.changed_by,
        changedAt: r.changed_at,
        reason: r.reason,
      };
    });
  }
}

export type LedgerService = ReturnType<typeof ledgerService>;
