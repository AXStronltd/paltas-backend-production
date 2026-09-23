/* ====================================================================== *
 * THE LEDGER — WHERE A FINANCIAL FIGURE COMES FROM.
 *
 * Every number an accountant or an auditor is shown has to be reachable
 * from here: report → account → journal entry → line → the invoice,
 * payment or expense that caused it. Totals cached on other tables are a
 * convenience; when one of them disagrees with a statement, this is the
 * record that settles it.
 *
 * FOUR RULES, ENFORCED HERE RATHER THAN HOPED FOR
 *
 *   1. A POSTED ENTRY BALANCES. Debits equal credits, in the transaction
 *      currency AND in the reporting currency. An entry that does not
 *      balance is refused; it is never posted and later "corrected".
 *
 *   2. A POSTED ENTRY IS IMMUTABLE. Nothing edits or deletes it. A mistake
 *      is fixed by posting a reversal that says what it reverses and why,
 *      so the original and the correction are both in the history.
 *
 *   3. A CLOSED PERIOD DOES NOT MOVE. Posting into a closed period is
 *      refused. Reopening is a separate, audited act.
 *
 *   4. NOTHING CROSSES AN ORGANIZATION. Every account, entry and line
 *      carries orgId, and every read and write is scoped by it. An entry
 *      whose lines point at another organization's accounts is refused.
 *
 * WHY THE AMOUNTS ARE BigInt
 *
 * Minor units — cents, not fractions of a cent — matching Payment and
 * Expense, which are already BigInt in this schema. A float cannot hold
 * 0.1 and a column somebody reconciles against a bank statement is the
 * last place to discover that.
 * ====================================================================== */

/* ------------------------------------------------------------ errors */

/**
 * Refusals a caller is expected to handle, separated from bugs. Each one
 * names the rule it enforces, because "invalid journal" in a log tells
 * whoever reads it nothing about what to do next.
 */
export class LedgerError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code, message, detail) => {
  throw new LedgerError(code, message, detail);
};

/* ------------------------------------------------- the chart of accounts */

/**
 * Which side increases each kind of account. Stored on the row as well, so
 * a report never re-derives it, but this is the source the seeder uses.
 */
export const NORMAL_BALANCE = {
  ASSET: "DEBIT",
  EXPENSE: "DEBIT",
  LIABILITY: "CREDIT",
  INCOME: "CREDIT",
  EQUITY: "CREDIT",
};

/**
 * A starting chart for a property management organization.
 *
 * It is a STARTING POINT, not a fixed list: codes and names belong to the
 * client's accountant, who will add, rename and disable. Nothing in the
 * posting path reads these constants — postings resolve accounts by code
 * against the database — so changing this list cannot change how anything
 * already posted is reported.
 */
export const DEFAULT_CHART = [
  // ── assets ──
  { code: "1000", name: "Bank", type: "ASSET" },
  { code: "1010", name: "Cash", type: "ASSET" },
  { code: "1100", name: "Accounts receivable", type: "ASSET" },
  { code: "1110", name: "Rent receivable", type: "ASSET", parent: "1100" },
  { code: "1120", name: "Service charge receivable", type: "ASSET", parent: "1100" },
  { code: "1200", name: "Prepayments", type: "ASSET" },

  // ── liabilities ──
  { code: "2000", name: "Accounts payable", type: "LIABILITY" },
  { code: "2100", name: "Tenant deposits held", type: "LIABILITY" },
  { code: "2200", name: "Owner payable", type: "LIABILITY" },
  { code: "2300", name: "Tax payable", type: "LIABILITY" },
  { code: "2400", name: "Accrued expenses", type: "LIABILITY" },

  // ── income ──
  { code: "4000", name: "Rent", type: "INCOME" },
  { code: "4010", name: "Service charges", type: "INCOME" },
  { code: "4020", name: "Management fees", type: "INCOME" },
  { code: "4030", name: "Late fees", type: "INCOME" },
  { code: "4040", name: "Parking", type: "INCOME" },
  { code: "4050", name: "Utilities recovered", type: "INCOME" },
  { code: "4090", name: "Other property income", type: "INCOME" },

  // ── expenses ──
  { code: "5000", name: "Maintenance", type: "EXPENSE" },
  { code: "5010", name: "Repairs", type: "EXPENSE" },
  { code: "5020", name: "Utilities", type: "EXPENSE" },
  { code: "5030", name: "Cleaning", type: "EXPENSE" },
  { code: "5040", name: "Security", type: "EXPENSE" },
  { code: "5050", name: "Insurance", type: "EXPENSE" },
  { code: "5060", name: "Property management", type: "EXPENSE" },
  { code: "5070", name: "Salaries", type: "EXPENSE" },
  { code: "5080", name: "Contractor costs", type: "EXPENSE" },
  { code: "5090", name: "Professional services", type: "EXPENSE" },
  { code: "5100", name: "Bank and payment fees", type: "EXPENSE" },
  { code: "5110", name: "Taxes", type: "EXPENSE" },
  { code: "5900", name: "Other operating expenses", type: "EXPENSE" },

  // ── equity ──
  { code: "3000", name: "Owner capital", type: "EQUITY" },
  { code: "3900", name: "Retained earnings", type: "EQUITY" },
];

/**
 * Create the starting chart for an organization, if it has none.
 *
 * Idempotent on purpose: onboarding gets re-run, and a second call must not
 * produce a second set of accounts or throw on the unique constraint.
 */
export async function seedChartOfAccounts(db, orgId) {
  if (!orgId) fail("ORG_REQUIRED", "An organization is required to seed a chart of accounts.");

  const existing = await db.ledgerAccount.findMany({
    where: { orgId },
    select: { code: true },
  });
  const have = new Set(existing.map((a) => a.code));

  const created = [];
  // Parents first, so a child can point at one in the same pass.
  const ordered = [...DEFAULT_CHART].sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0));

  for (const a of ordered) {
    if (have.has(a.code)) continue;
    const parent = a.parent
      ? await db.ledgerAccount.findFirst({ where: { orgId, code: a.parent }, select: { id: true } })
      : null;
    created.push(
      await db.ledgerAccount.create({
        data: {
          orgId,
          code: a.code,
          name: a.name,
          type: a.type,
          normal: NORMAL_BALANCE[a.type],
          parentId: parent ? parent.id : null,
          postable: true,
          active: true,
        },
      }),
    );
    have.add(a.code);
  }
  return created;
}

/* --------------------------------------------------------- posting */

const toBig = (v) => {
  if (typeof v === "bigint") return v;
  if (v === null || v === undefined || v === "") return 0n;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) {
      fail("AMOUNT_NOT_MINOR_UNITS", "Amounts are minor units and must be whole numbers.", { value: v });
    }
    return BigInt(v);
  }
  try { return BigInt(String(v)); }
  catch { return fail("AMOUNT_INVALID", "Amount is not a number.", { value: v }); }
};

const sum = (rows, key) => rows.reduce((t, r) => t + toBig(r[key]), 0n);

/**
 * Check a set of lines without touching the database.
 *
 * Exported because the same rules decide whether a DRAFT is postable, and
 * a caller should be able to ask before it tries.
 */
/**
 * Fill in the reporting-currency amounts, and refuse to guess them.
 *
 * When the entry is already in the reporting currency the two are the same
 * figure and restating it on every line is noise. When they DIFFER, an
 * omitted base amount is not a default — assuming 1:1 would quietly invent
 * an exchange rate — so it is refused and the caller has to say.
 */
export function normalizeLines(lines, { currency, baseCurrency } = {}) {
  const same = !currency || !baseCurrency || currency === baseCurrency;
  return (Array.isArray(lines) ? lines : []).map((l, i) => {
    const hasBase = l.baseDebit !== undefined || l.baseCredit !== undefined;
    if (!same && !hasBase) {
      fail("BASE_REQUIRED",
        `This entry is in ${currency} and reports in ${baseCurrency}. Each line needs its converted amount — PALTAS will not assume a rate.`,
        { line: i });
    }
    return {
      ...l,
      baseDebit: hasBase ? (l.baseDebit ?? 0) : l.debit,
      baseCredit: hasBase ? (l.baseCredit ?? 0) : l.credit,
    };
  });
}

export function validateLines(lines, { currency, baseCurrency } = {}) {
  if (!Array.isArray(lines) || lines.length < 2) {
    fail("TOO_FEW_LINES", "A journal entry needs at least two lines.", { count: Array.isArray(lines) ? lines.length : 0 });
  }

  for (const [i, l] of lines.entries()) {
    const d = toBig(l.debit), c = toBig(l.credit);
    if (d < 0n || c < 0n) {
      fail("NEGATIVE_AMOUNT", "Amounts are never negative — direction is which column is filled.", { line: i });
    }
    if (d > 0n && c > 0n) {
      fail("LINE_BOTH_SIDES", "A line is a debit or a credit, not both.", { line: i });
    }
    if (d === 0n && c === 0n) {
      fail("LINE_EMPTY", "A line with no amount says nothing; leave it out.", { line: i });
    }
    if (!l.accountId) fail("LINE_NO_ACCOUNT", "Every line names an account.", { line: i });
  }

  const debit = sum(lines, "debit");
  const credit = sum(lines, "credit");
  if (debit !== credit) {
    fail("UNBALANCED", "Debits and credits must be equal.", {
      debit: debit.toString(), credit: credit.toString(),
      difference: (debit - credit).toString(),
    });
  }

  // The reporting-currency figures have to balance too, or a consolidated
  // report silently invents money the moment two currencies are involved.
  const baseDebit = sum(lines, "baseDebit");
  const baseCredit = sum(lines, "baseCredit");
  if (baseDebit !== baseCredit) {
    fail("UNBALANCED_BASE", "Reporting-currency debits and credits must be equal.", {
      baseDebit: baseDebit.toString(), baseCredit: baseCredit.toString(),
    });
  }
  if (currency && baseCurrency && currency === baseCurrency && baseDebit !== debit) {
    fail("BASE_MISMATCH", "One currency, two different totals.", {
      debit: debit.toString(), baseDebit: baseDebit.toString(),
    });
  }

  return { debit, credit, baseDebit, baseCredit };
}

/** The period a date falls in, and whether it will accept a posting. */
export async function periodFor(db, orgId, date) {
  return db.financialPeriod.findFirst({
    where: { orgId, opensAt: { lte: date }, closesAt: { gte: date } },
  });
}

/**
 * Write a balanced entry and post it, in one transaction.
 *
 * Draft entries are allowed to be incomplete; a POSTED one has passed every
 * rule above. There is no path that writes a posted entry without going
 * through this function.
 */
export async function postJournal(db, {
  orgId, ref, date, memo = "", lines,
  currency, baseCurrency, fxRate = "1", fxSource = null, fxAt = null,
  sourceType = null, sourceId = null,
  postedById = null,
  reversesId = null, reversalReason = null,
}) {
  if (!orgId) fail("ORG_REQUIRED", "An organization is required.");
  if (!ref) fail("REF_REQUIRED", "An entry needs a reference.");
  if (!currency) fail("CURRENCY_REQUIRED", "An entry needs its transaction currency.");
  if (!baseCurrency) fail("BASE_CURRENCY_REQUIRED", "An entry needs the reporting currency.");
  const when = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(when.getTime())) fail("DATE_INVALID", "An entry needs a valid date.", { date });

  const normal = normalizeLines(lines, { currency, baseCurrency });
  validateLines(normal, { currency, baseCurrency });

  // Every account must exist, belong to THIS organization, be postable and
  // active. This is the check that stops one organization's entry touching
  // another's books.
  const ids = [...new Set(normal.map((l) => l.accountId))];
  const accounts = await db.ledgerAccount.findMany({ where: { id: { in: ids } } });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const id of ids) {
    const a = byId.get(id);
    if (!a) fail("ACCOUNT_UNKNOWN", "A line names an account that does not exist.", { accountId: id });
    if (a.orgId !== orgId) {
      fail("CROSS_ORG_ACCOUNT", "A line names an account belonging to another organization.", { accountId: id });
    }
    if (!a.postable) fail("ACCOUNT_NOT_POSTABLE", "That account is a heading, not a posting account.", { code: a.code });
    if (!a.active) fail("ACCOUNT_INACTIVE", "That account has been withdrawn.", { code: a.code });
  }

  const period = await periodFor(db, orgId, when);
  if (period && period.status === "CLOSED") {
    fail("PERIOD_CLOSED", "That period is closed. Post an adjustment in an open period instead.", {
      period: period.label,
    });
  }

  return db.$transaction(async (tx) => {
    const entry = await tx.journalEntry.create({
      data: {
        orgId, ref, date: when, memo,
        periodId: period ? period.id : null,
        status: "POSTED",
        currency, baseCurrency, fxRate, fxSource, fxAt,
        sourceType, sourceId,
        postedAt: new Date(), postedById,
        reversesId, reversalReason,
        lines: {
          create: normal.map((l) => ({
            orgId,
            accountId: l.accountId,
            debit: toBig(l.debit), credit: toBig(l.credit),
            baseDebit: toBig(l.baseDebit),
            baseCredit: toBig(l.baseCredit),
            memo: l.memo || "",
            siteId: l.siteId || null,
            buildingId: l.buildingId || null,
            unitId: l.unitId || null,
            leaseId: l.leaseId || null,
            partyId: l.partyId || null,
          })),
        },
      },
      include: { lines: true },
    });

    if (reversesId) {
      await tx.journalEntry.update({
        where: { id: reversesId },
        data: { status: "REVERSED" },
      });
    }
    return entry;
  });
}

/**
 * Reverse a posted entry by posting its mirror.
 *
 * The original is not edited beyond its status, and its lines are untouched:
 * an auditor sees what was posted, what reversed it and the stated reason.
 */
export async function reverseJournal(db, { orgId, entryId, ref, date, reason, postedById = null }) {
  if (!reason) fail("REASON_REQUIRED", "A reversal states why. An unexplained correction is the thing an audit asks about.");

  const original = await db.journalEntry.findFirst({
    where: { id: entryId, orgId },
    include: { lines: true },
  });
  if (!original) fail("ENTRY_UNKNOWN", "No such entry in this organization.", { entryId });
  /* Asked BEFORE the status check on purpose. A reversed entry is no longer
     POSTED, so checking status first answers "only a posted entry can be
     reversed" — true, and useless. "Already reversed, by JE-000042" is the
     sentence that tells somebody what happened. */
  const already = await db.journalEntry.findFirst({ where: { reversesId: entryId } });
  if (already) fail("ALREADY_REVERSED", "That entry has already been reversed.", { by: already.ref });
  if (original.status !== "POSTED") {
    fail("NOT_POSTED", "Only a posted entry can be reversed.", { status: original.status });
  }

  return postJournal(db, {
    orgId,
    ref,
    date: date || new Date(),
    memo: `Reversal of ${original.ref}`,
    currency: original.currency,
    baseCurrency: original.baseCurrency,
    fxRate: original.fxRate,
    sourceType: original.sourceType,
    sourceId: original.sourceId,
    postedById,
    reversesId: original.id,
    reversalReason: reason,
    // debit becomes credit, credit becomes debit
    lines: original.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit, credit: l.debit,
      baseDebit: l.baseCredit, baseCredit: l.baseDebit,
      memo: l.memo,
      siteId: l.siteId, buildingId: l.buildingId,
      unitId: l.unitId, leaseId: l.leaseId, partyId: l.partyId,
    })),
  });
}

/* --------------------------------------------------------- reading */

/**
 * Balance of one account, from the lines and nothing else.
 *
 * Returned in the account's NORMAL direction, so an income account reads
 * positive when it has earned and an expense account reads positive when it
 * has spent — which is what a reader expects and what a stored sign would
 * eventually get wrong.
 */
export async function accountBalance(db, { orgId, accountId, from = null, to = null }) {
  const account = await db.ledgerAccount.findFirst({ where: { id: accountId, orgId } });
  if (!account) fail("ACCOUNT_UNKNOWN", "No such account in this organization.", { accountId });

  /*
   * POSTED **AND** REVERSED, and the distinction is the whole of rule 2.
   *
   * This read POSTED alone, which looks right and is not. Reversing an entry
   * sets the ORIGINAL to REVERSED and posts a mirror that is POSTED — so a
   * POSTED-only filter drops the original and keeps the mirror, and the
   * account swings by the full amount in the opposite direction instead of
   * netting to nothing. Reverse a 70,000 rent credit and the account reads
   * MINUS 70,000 rather than zero.
   *
   * Worse, the trial balance still said `balanced: true` throughout, because
   * the mirror's own debit and credit agree with each other. The aggregate
   * check passed while every account figure it summarised was wrong.
   *
   * The schema settles it in the enum's own words: REVERSED is "cancelled by
   * a reversing entry — the original rows stay exactly as posted." Staying as
   * posted means still counted; the mirror is what cancels them. A reversal
   * is a correction in the history, not an erasure of it.
   *
   * DRAFT stays out: it need not balance and appears in no report.
   */
  const where = {
    orgId,
    accountId,
    entry: {
      status: { in: ["POSTED", "REVERSED"] },
      ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
  };
  const lines = await db.journalLine.findMany({ where, select: { debit: true, credit: true, baseDebit: true, baseCredit: true } });

  const debit = sum(lines, "debit");
  const credit = sum(lines, "credit");
  const baseDebit = sum(lines, "baseDebit");
  const baseCredit = sum(lines, "baseCredit");

  const signed = account.normal === "DEBIT" ? debit - credit : credit - debit;
  const baseSigned = account.normal === "DEBIT" ? baseDebit - baseCredit : baseCredit - baseDebit;

  return {
    accountId, code: account.code, name: account.name,
    type: account.type, normal: account.normal,
    debit, credit, balance: signed,
    baseDebit, baseCredit, baseBalance: baseSigned,
    lineCount: lines.length,
  };
}

/**
 * The whole organization's trial balance.
 *
 * If this does not sum to zero the books are wrong, and every report built
 * on them is wrong with it — so it is the first thing to check and the
 * cheapest thing to run.
 */
export async function trialBalance(db, { orgId, from = null, to = null }) {
  const accounts = await db.ledgerAccount.findMany({ where: { orgId }, orderBy: { code: "asc" } });
  const rows = [];
  let debit = 0n, credit = 0n;

  for (const a of accounts) {
    const b = await accountBalance(db, { orgId, accountId: a.id, from, to });
    if (b.lineCount === 0) continue;   // an account nobody used is not a row
    rows.push(b);
    debit += b.debit;
    credit += b.credit;
  }

  return { rows, debit, credit, balanced: debit === credit, difference: debit - credit };
}

/* ====================================================================== *
 * THE STATEMENTS.
 *
 * Built from the journal and nothing else. Every figure below traces back
 * through an account to an entry to a line to the invoice, payment or expense
 * that caused it — which is the property the whole ledger exists to have, and
 * the reason these cannot be derived from the payments list the console's
 * other finance screens read.
 * ====================================================================== */

/** Which side of the balance sheet, and whether it belongs there at all. */
const SHEET = { ASSET: "assets", LIABILITY: "liabilities", EQUITY: "equity" };

/**
 * WHAT THE COMPANY OWNS, OWES AND IS WORTH, AT A DATE.
 *
 * ── THE PART THAT IS EASY TO GET WRONG ─────────────────────────────────
 *
 * A balance sheet made only of asset, liability and equity accounts DOES NOT
 * BALANCE, and it is not supposed to: the difference is the profit that has
 * not yet been moved into equity. Income less expenses to the same date IS
 * that difference, and it is reported here as `retained` rather than left for
 * the reader to notice.
 *
 * So the identity this asserts is the real one:
 *
 *     assets  =  liabilities + equity + (income − expenses)
 *
 * `balanced` is returned as its own field for the same reason the trial
 * balance does it: a caller who forgets to check reports a broken sheet as a
 * fact.
 */
export async function balanceSheet(db, { orgId, asAt = null }) {
  const tb = await trialBalance(db, { orgId, to: asAt });

  const side = { assets: [], liabilities: [], equity: [] };
  let income = 0n, expenses = 0n;

  for (const row of tb.rows) {
    const where = SHEET[row.type];
    if (where) { side[where].push(row); continue; }
    if (row.type === "INCOME") income += row.balance;
    if (row.type === "EXPENSE") expenses += row.balance;
  }

  const total = (rows) => rows.reduce((t, r) => t + r.balance, 0n);
  const assets = total(side.assets);
  const liabilities = total(side.liabilities);
  const equity = total(side.equity);
  const retained = income - expenses;

  return {
    asAt: asAt || null,
    assets: side.assets, liabilities: side.liabilities, equity: side.equity,
    totals: { assets, liabilities, equity, retained },
    /* What the two sides come to, and whether they agree. */
    funding: liabilities + equity + retained,
    balanced: assets === liabilities + equity + retained,
    difference: assets - (liabilities + equity + retained),
  };
}

/**
 * WHAT WAS EARNED AND WHAT IT COST, OVER A PERIOD.
 *
 * Income and expense accounts only — a balance sheet account has no place in
 * a P&L, and including one is how "profit" starts including the bank.
 *
 * Both sides read POSITIVE: income positive when it earned, expenses positive
 * when they were spent, because each is in its own account's normal
 * direction. `net` is the subtraction, done once, here.
 */
export async function incomeStatement(db, { orgId, from = null, to = null }) {
  const tb = await trialBalance(db, { orgId, from, to });

  const income = tb.rows.filter((r) => r.type === "INCOME");
  const expenses = tb.rows.filter((r) => r.type === "EXPENSE");
  const total = (rows) => rows.reduce((t, r) => t + r.balance, 0n);

  const earned = total(income);
  const spent = total(expenses);

  return {
    from: from || null, to: to || null,
    income, expenses,
    totals: { income: earned, expenses: spent, net: earned - spent },
  };
}

/**
 * WHERE THE MONEY ACTUALLY WENT — and what this deliberately is not.
 *
 * THIS IS NOT AN IAS 7 CASH FLOW STATEMENT, and calling it one would be the
 * dishonest thing to do. That statement splits movement into operating,
 * investing and financing activities, and nothing in this schema says which
 * of the three a payment was. Inventing that classification from an account
 * code would be a guess presented as a filing.
 *
 * What this is: the movement on the cash and bank accounts over a period —
 * what they opened at, what came in, what went out, what they closed at. It
 * is the question somebody actually asks of a property business, it is
 * answerable from the journal without inventing anything, and `basis` says
 * so in the response.
 */
export async function cashMovement(db, { orgId, from = null, to = null }) {
  /* Cash is an asset account that money physically moves through. The chart
     marks them by code; a company that adds another bank account under the
     same parent is included by being an ASSET with a bankRef, which is what
     that column is for. */
  const cashAccounts = await db.ledgerAccount.findMany({
    where: {
      orgId, type: "ASSET",
      OR: [{ code: { in: ["1000", "1010"] } }, { NOT: { bankRef: null } }],
    },
    orderBy: { code: "asc" },
  });

  const rows = [];
  let opening = 0n, received = 0n, spent = 0n, closing = 0n;

  for (const a of cashAccounts) {
    /* Opening is everything before the window; the window itself is the
       movement. Asking for both separately is two queries and no arithmetic
       anybody has to trust. */
    const before = from
      ? await accountBalance(db, { orgId, accountId: a.id, to: new Date(from.getTime() - 1) })
      : { balance: 0n };
    const during = await accountBalance(db, { orgId, accountId: a.id, from, to });

    const row = {
      accountId: a.id, code: a.code, name: a.name,
      opening: before.balance,
      received: during.debit,
      spent: during.credit,
      closing: before.balance + during.balance,
    };
    if (row.opening === 0n && row.received === 0n && row.spent === 0n) continue;
    rows.push(row);

    opening += row.opening;
    received += row.received;
    spent += row.spent;
    closing += row.closing;
  }

  return {
    from: from || null, to: to || null,
    basis: "movement on cash and bank accounts — not an IAS 7 cash flow statement",
    rows,
    totals: { opening, received, spent, closing },
    /* Opening plus what came in less what went out IS the closing balance.
       Where it is not, the books are wrong. */
    reconciles: opening + received - spent === closing,
  };
}

/**
 * ONE TENANT, ONE OWNER, ONE PROPERTY — the same statement three times.
 *
 * All three are the journal lines carrying that dimension, in date order,
 * with a running balance. They are one function because they are one
 * question: what has this entity been charged, what have they paid, and
 * where does that leave them.
 *
 * It is only answerable because the posting bridge stamps siteId, unitId,
 * leaseId and partyId onto every line it writes. An entry booked against the
 * company alone cannot be attributed to anybody afterwards.
 */
export async function entityStatement(db, { orgId, partyId = null, siteId = null, unitId = null, from = null, to = null }) {
  const dimension = partyId ? { partyId } : siteId ? { siteId } : unitId ? { unitId } : null;
  if (!dimension) {
    fail("DIMENSION_REQUIRED", "A statement is for a party, a property or a unit — name one.");
  }

  const lines = await db.journalLine.findMany({
    where: {
      orgId, ...dimension,
      entry: {
        status: { in: ["POSTED", "REVERSED"] },
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
    },
    include: {
      account: { select: { id: true, code: true, name: true, type: true, normal: true } },
      entry: { select: { id: true, ref: true, date: true, memo: true, status: true, sourceType: true, sourceId: true } },
    },
  });

  /* By date, then by the entry's own reference, so two entries on one day
     always read in the same order twice running. */
  lines.sort((a, b) => (a.entry.date - b.entry.date) || a.entry.ref.localeCompare(b.entry.ref));

  let running = 0n;
  let charged = 0n, paid = 0n;
  const rows = lines.map((l) => {
    /*
     * FROM THE ENTITY'S SIDE, NOT THE COMPANY'S.
     *
     * A tenant's statement is read by the tenant: what they were charged
     * increases what they owe, what they paid reduces it. In the company's
     * books that same charge is a debit to receivable and the payment a
     * credit, so the running balance here is debit-less-credit — which is
     * the tenant's balance, not the account's.
     */
    charged += l.debit;
    paid += l.credit;
    running += l.debit - l.credit;
    return {
      entryId: l.entry.id, ref: l.entry.ref, date: l.entry.date,
      memo: l.memo || l.entry.memo || "",
      account: l.account, status: l.entry.status,
      sourceType: l.entry.sourceType, sourceId: l.entry.sourceId,
      debit: l.debit, credit: l.credit, balance: running,
    };
  });

  return {
    from: from || null, to: to || null,
    of: dimension,
    rows,
    totals: { charged, paid, balance: running },
  };
}
