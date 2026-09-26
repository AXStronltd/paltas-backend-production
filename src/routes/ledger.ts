/* ====================================================================== *
 * THE LEDGER, OVER HTTP.
 *
 * `src/domain/ledger.js` has been complete for some time: a chart of
 * accounts with a normal balance per type, balanced double-entry posting,
 * reversal-rather-than-edit, financial periods that refuse postings once
 * closed, per-account balances and a trial balance. It is careful code and
 * it enforces four rules that matter.
 *
 * NOTHING COULD REACH IT. There were no routes, and outside its own file
 * nothing imported it — not one call to postJournal in the whole service.
 * The console's "ledger" screens read a merge of payments, expenses and
 * payouts: a list of money that moved, which is a useful thing, but it is
 * not the books. Nobody could see an account, post an entry, or ask whether
 * the trial balance balanced.
 *
 * This file is the transport and nothing else. Every rule still lives in the
 * domain — this validates shapes, resolves the organization, checks the
 * role, allocates a reference and turns a LedgerError into a status code.
 * There is deliberately no second implementation of "does this balance".
 *
 * ── WHY THE REPORTING CURRENCY IS NOT A CONSTANT ───────────────────────
 *
 * postJournal refuses to post without one, and correctly: an entry with no
 * stated reporting currency is a number nobody can consolidate. This service
 * does NOT default it to KES. It resolves from the company's own country
 * through the market catalogue — the same table the marketplace prices in —
 * so a company in Sweden keeps its books in SEK without anybody configuring
 * anything. A caller may state one explicitly, and must when the country is
 * one the catalogue does not know.
 *
 * ── WHY THIS MOUNTS ABOVE productRoutes ────────────────────────────────
 *
 * routes/products.js does `productRoutes.use(guarded)` with no path and is
 * mounted at "/", so anything reaching it gets requireSession() and a 401 —
 * including paths nobody registered. Registered after it, every route here
 * would answer 401 and look like an auth fault. server.js mounts this above
 * it, and the test suite fails if the order is ever reversed.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import { addRule, endRule, OUT_OF_SCOPE, rateFor, taxOn } from "../domain/tax.ts";
import {
  autoMatch, importStatement, reconcile, unreconcile, unreconciled,
} from "../domain/banking.ts";
import type { Request, RequestHandler, Response } from "express";
import type { Prisma } from "@prisma/client";
import type { Act } from "../domain/access.ts";
import { messageOf } from "../http/errors.ts";
import { actorOf, sessionOf, param } from "../http/request.ts";
import { enumParam } from "../http/errors.ts";
import type { JournalLineInput } from "../domain/ledger.ts";
import { whyNotArea } from "../domain/access.ts";
import { badRequest, conflict, forbidden, hidden } from "../http/errors.ts";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.ts";
import { country as marketCountry } from "../domain/market.ts";
import {
  LedgerError, DEFAULT_CHART, NORMAL_BALANCE,
  seedChartOfAccounts, postJournal, reverseJournal,
  accountBalance, trialBalance, periodFor,
  balanceSheet, incomeStatement, cashMovement, entityStatement,
} from "../domain/ledger.ts";

export const ledgerRoutes = Router();

ledgerRoutes.use(requireSession(), requireOrganization(), requireOpenSubscription());

/* ---------------------------------------------------------------- *
 * THE GUARDS, SPELLED OUT.
 * ---------------------------------------------------------------- */

/** The books are the finance area. Read to look, write to post, manage to close. */
function need(req: Request, act: Act, label?: string): void {
  const why = whyNotArea(actorOf(req, "a ledger route"), "finance", act, label || "the ledger");
  if (why) throw forbidden(why);
}

/**
 * A LedgerError is a REFUSAL, not a crash, and each code means something
 * different to whoever is holding the keyboard.
 *
 * Kept as a translation rather than letting the domain throw HTTP: the
 * ledger has no business knowing what a status code is, and the same rules
 * are used by a background posting path that has no request at all.
 */
const STATE: ReadonlySet<string> = new Set(["PERIOD_CLOSED", "ALREADY_REVERSED", "NOT_POSTED"]);
/* These name a row. Answering 404 rather than 400 keeps the reply from
   confirming that somebody else's account id exists. */
const UNSEEN: ReadonlySet<string> = new Set(["ACCOUNT_UNKNOWN", "ENTRY_UNKNOWN", "CROSS_ORG_ACCOUNT"]);

function translate(e: unknown): unknown {
  if (!(e instanceof LedgerError)) return e;
  if (STATE.has(e.code)) return conflict(`${messageOf(e)}`);
  if (UNSEEN.has(e.code)) return hidden();
  return badRequest(messageOf(e), [e.code, ...Object.entries(e.detail || {}).map(([k, v]) => `${k}: ${v}`)]);
}

/** Every handler is the same shape: do the work, translate what it throws. */
const route = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  async (req, res, next) => {
    try { await fn(req, res); } catch (e) { next(translate(e)); }
  };

async function audit(
  req: Request, action: string, entity: string,
  entityId?: string, detail?: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        orgId: actorOf(req, "a ledger route").orgId,
        actorId: sessionOf(req, "a ledger route").userId,
        actorName: req.view?.user?.name || req.view?.user?.email || "",
        /* entityId is NOT NULL with a "" default — a null here is rejected by
           Prisma, and the rejection is swallowed by the catch below, so the
           write vanishes silently. An action that touches no single row sends
           the empty string, which is what the column already means. */
        action, entity, entityId: entityId || "", detail: detail || undefined, ip: req.ip || "",
      },
    });
  } catch (e) { console.error("audit write failed", action, entity, messageOf(e)); }
}

/* ---------------------------------------------------------------- *
 * SMALL READERS.
 * ---------------------------------------------------------------- */

/** A whole number of minor units, or a refusal naming the field. */
function minor(v: unknown, field: string): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw badRequest(`${field} is in minor units and must be a whole number.`, [String(v)]);
  }
  if (n < 0) throw badRequest(`${field} is never negative — direction is which column is filled.`);
  return n;
}

/** A date the caller sent, or a refusal. `null` where one is optional. */
function when(
  v: unknown, field: string, { required = false }: { required?: boolean } = {},
): Date | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw badRequest(`${field} is required.`);
    return null;
  }
  const d = new Date(v as string | number | Date);
  if (Number.isNaN(d.getTime())) throw badRequest(`${field} is not a date this service can read.`, [String(v)]);
  return d;
}

/**
 * The company's reporting currency.
 *
 * From the country the company registered under, through the same catalogue
 * the marketplace prices in. Explicit beats derived, because an accountant
 * reporting in a currency other than their own country's is ordinary.
 */
async function reportingCurrency(orgId: string, stated?: unknown): Promise<string> {
  if (stated) {
    const code = String(stated).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throw badRequest(`"${stated}" is not a three-letter currency code.`);
    return code;
  }
  const org = await db.organization.findFirst({ where: { id: orgId }, select: { country: true } });
  const c = org && org.country ? marketCountry(String(org.country).toUpperCase()) : null;
  if (!c || !c.currency) {
    throw badRequest(
      "This company's reporting currency is not known, so an entry cannot be posted without one. " +
      "Send baseCurrency, or set the company's country to one the market catalogue knows.");
  }
  return c.currency;
}

/**
 * The next reference for this company, allocated by the database.
 *
 * Same arrangement the resource framework uses for invoice and work-order
 * numbers: a counter row per company per series, incremented inside the
 * upsert, so two requests at once cannot be handed the same number.
 */
async function nextRef(orgId: string, series: string, prefix: string): Promise<string> {
  const name = `${series}:${orgId}`;
  const row = await db.counter.upsert({
    where: { name },
    create: { name, value: 1 },
    update: { value: { increment: 1 } },
  });
  return `${prefix}-${String(row.value).padStart(4, "0")}`;
}

/* ====================================================================== *
 * 1. THE CHART OF ACCOUNTS
 * ====================================================================== */

/**
 * GET /ledger/accounts — the chart.
 *
 * The chart only, deliberately: a balance per account is a query per account
 * and this is the list a form's picker loads. /ledger/trial-balance is the
 * one call that carries figures.
 */
ledgerRoutes.get("/ledger/accounts", route(async (req, res) => {
  need(req, "list", "the chart of accounts");
  const { type, active, q } = req.query;

  const where: Prisma.LedgerAccountWhereInput = {
    orgId: actorOf(req, "a ledger route").orgId,
  };
  const t = enumParam("AccountType", type, "account type");
  if (t) {
    if (!NORMAL_BALANCE[t]) {
      throw badRequest(`"${type}" is not an account type.`, Object.keys(NORMAL_BALANCE));
    }
    where.type = t;
  }
  if (active === "true") where.active = true;
  if (active === "false") where.active = false;
  if (q) {
    const s = String(q).trim();
    where.OR = [{ code: { contains: s } }, { name: { contains: s, mode: "insensitive" } }];
  }

  const accounts = await db.ledgerAccount.findMany({ where, orderBy: { code: "asc" } });
  res.json({
    accounts,
    count: accounts.length,
  });
}));

/**
 * POST /ledger/accounts/seed — the starting chart, once.
 *
 * Idempotent in the domain, so a second call adds nothing and does not throw.
 * It answers with what it created, which is empty on the second call — that
 * is the honest reply, and the caller can tell the two apart.
 */
ledgerRoutes.post("/ledger/accounts/seed", route(async (req, res) => {
  need(req, "create", "the chart of accounts");
  const created = await seedChartOfAccounts(db, actorOf(req, "a ledger route").orgId);
  if (created.length) await audit(req, "ledger.chart.seed", "ledgerAccount", "", { created: created.length });
  res.status(created.length ? 201 : 200).json({
    accounts: created,
    created: created.length,
    available: DEFAULT_CHART.length,
    message: created.length
      ? `${created.length} accounts created.`
      : "This company already has a chart of accounts; nothing was changed.",
  });
}));

/** POST /ledger/accounts — one account the client's accountant wants. */
ledgerRoutes.post("/ledger/accounts", route(async (req, res) => {
  need(req, "create", "the chart of accounts");
  const orgId = actorOf(req, "a ledger route").orgId;
  const b = req.body || {};

  const code = String(b.code || "").trim();
  const name = String(b.name || "").trim();
  const type = enumParam("AccountType", b.type, "account type");

  if (!code) throw badRequest("An account needs a code.");
  if (!name) throw badRequest("An account needs a name.");
  if (!type || !NORMAL_BALANCE[type]) {
    throw badRequest(`"${b.type}" is not an account type.`, Object.keys(NORMAL_BALANCE));
  }

  const clash = await db.ledgerAccount.findFirst({ where: { orgId, code }, select: { id: true } });
  if (clash) throw conflict(`This company already has an account ${code}.`);

  /* A parent is named by CODE, not id: a chart is something an accountant
     reads and types, and ids are not in front of them. */
  let parentId = null;
  if (b.parent) {
    const parent = await db.ledgerAccount.findFirst({
      where: { orgId, code: String(b.parent).trim() }, select: { id: true },
    });
    if (!parent) throw badRequest(`No account ${b.parent} to sit under.`);
    parentId = parent.id;
  }

  const account = await db.ledgerAccount.create({
    data: {
      orgId, code, name, type,
      normal: NORMAL_BALANCE[type],
      parentId,
      /* A heading is a place in the tree, not somewhere money lands. */
      postable: b.postable === undefined ? true : !!b.postable,
      active: true,
      bankRef: b.bankRef ? String(b.bankRef).trim() : null,
    },
  });
  await audit(req, "ledger.account.create", "ledgerAccount", account.id, { code, name, type });
  res.status(201).json({ account });
}));

/**
 * PATCH /ledger/accounts/:id — rename, withdraw, or stop it taking postings.
 *
 * `code` and `type` are NOT editable. Every line already posted to this
 * account was posted against that code and that normal balance; changing
 * either would restate history that an auditor has already been shown. A
 * wrong account is withdrawn and a right one opened.
 */
ledgerRoutes.patch("/ledger/accounts/:id", route(async (req, res) => {
  need(req, "update", "the chart of accounts");
  const orgId = actorOf(req, "a ledger route").orgId;
  const account = await db.ledgerAccount.findFirst({ where: { id: param(req, "id"), orgId } });
  if (!account) throw hidden();

  const b = req.body || {};
  for (const forbiddenField of ["code", "type", "normal"]) {
    if (b[forbiddenField] !== undefined) {
      throw badRequest(
        `${forbiddenField} cannot be changed once an account exists — every line already ` +
        `posted to it was posted under the old one. Withdraw this account and open another.`);
    }
  }

  const data: Prisma.LedgerAccountUpdateInput = {};
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) throw badRequest("An account needs a name.");
    data.name = name;
  }
  if (b.active !== undefined) data.active = !!b.active;
  if (b.postable !== undefined) data.postable = !!b.postable;
  if (b.bankRef !== undefined) data.bankRef = b.bankRef ? String(b.bankRef).trim() : null;
  if (!Object.keys(data).length) throw badRequest("Nothing to change.");

  const updated = await db.ledgerAccount.update({ where: { id: account.id }, data });
  await audit(req, "ledger.account.update", "ledgerAccount", account.id, { fields: Object.keys(data) });
  res.json({ account: updated });
}));

/** GET /ledger/accounts/:id/balance — one account, from its lines. */
ledgerRoutes.get("/ledger/accounts/:id/balance", route(async (req, res) => {
  need(req, "get", "the ledger");
  const balance = await accountBalance(db, {
    orgId: actorOf(req, "a ledger route").orgId,
    accountId: param(req, "id"),
    from: when(req.query.from, "from"),
    to: when(req.query.to, "to"),
  });
  res.json({ balance });
}));

/* ====================================================================== *
 * 2. FINANCIAL PERIODS
 * ====================================================================== */

ledgerRoutes.get("/ledger/periods", route(async (req, res) => {
  need(req, "list", "financial periods");
  const periods = await db.financialPeriod.findMany({
    where: { orgId: actorOf(req, "a ledger route").orgId },
    orderBy: { opensAt: "desc" },
  });
  res.json({ periods, count: periods.length });
}));

ledgerRoutes.post("/ledger/periods", route(async (req, res) => {
  need(req, "create", "financial periods");
  const orgId = actorOf(req, "a ledger route").orgId;
  const b = req.body || {};

  const label = String(b.label || "").trim();
  if (!label) throw badRequest("A period needs a label — “March 2026”, “FY26 Q1”.");
  /* `required: true` means when() throws rather than returning null; the
     guard is what tells the compiler so, without a `!` on each use below. */
  const opensAt = when(b.opensAt, "opensAt", { required: true });
  const closesAt = when(b.closesAt, "closesAt", { required: true });
  if (!opensAt || !closesAt) throw badRequest("A period needs both dates.");
  if (closesAt < opensAt) throw badRequest("A period cannot close before it opens.");

  /* Overlapping periods make "which period is this entry in" ambiguous, and
     periodFor() answers with whichever the database returned first. */
  const overlap = await db.financialPeriod.findFirst({
    where: { orgId, opensAt: { lte: closesAt }, closesAt: { gte: opensAt } },
  });
  if (overlap) {
    throw conflict(`That overlaps “${overlap.label}”. Periods may not overlap — an entry has to fall in exactly one.`);
  }

  const period = await db.financialPeriod.create({
    data: { orgId, label, opensAt, closesAt, status: "OPEN" },
  });
  await audit(req, "ledger.period.create", "financialPeriod", period.id, { label });
  res.status(201).json({ period });
}));

/**
 * POST /ledger/periods/:id/close — the books for this period stop moving.
 *
 * Closing is a manage-level act. It is the control that makes a reported
 * figure durable: after it, the domain refuses postings dated inside the
 * period, and a correction has to be an adjustment in an open one.
 */
ledgerRoutes.post("/ledger/periods/:id/close", route(async (req, res) => {
  need(req, "delete", "closing a financial period");
  const orgId = actorOf(req, "a ledger route").orgId;
  const period = await db.financialPeriod.findFirst({ where: { id: param(req, "id"), orgId } });
  if (!period) throw hidden();
  if (period.status === "CLOSED") throw conflict(`“${period.label}” is already closed.`);

  const closed = await db.financialPeriod.update({
    where: { id: period.id },
    data: { status: "CLOSED", closedAt: new Date(), closedById: sessionOf(req, "a ledger route").userId },
  });
  await audit(req, "ledger.period.close", "financialPeriod", period.id, { label: period.label });
  res.json({ period: closed });
}));

/**
 * POST /ledger/periods/:id/reopen — and say why.
 *
 * The reason is required and stored. Reopening a closed period changes
 * figures somebody has already been given; an unexplained reopen is exactly
 * what an audit asks about, which is the same reasoning the domain applies
 * to an unexplained reversal.
 */
ledgerRoutes.post("/ledger/periods/:id/reopen", route(async (req, res) => {
  need(req, "delete", "reopening a financial period");
  const orgId = actorOf(req, "a ledger route").orgId;
  const reason = String((req.body || {}).reason || "").trim();
  if (!reason) {
    throw badRequest("Reopening a closed period needs a reason. It changes figures that have already been reported.");
  }
  const period = await db.financialPeriod.findFirst({ where: { id: param(req, "id"), orgId } });
  if (!period) throw hidden();
  if (period.status !== "CLOSED") throw conflict(`“${period.label}” is not closed.`);

  const reopened = await db.financialPeriod.update({
    where: { id: period.id },
    data: {
      status: "OPEN", reopenedAt: new Date(),
      reopenedById: sessionOf(req, "a ledger route").userId, reopenReason: reason,
    },
  });
  await audit(req, "ledger.period.reopen", "financialPeriod", period.id, { label: period.label, reason });
  res.json({ period: reopened });
}));

/* ====================================================================== *
 * 3. THE JOURNAL
 * ====================================================================== */

/** GET /ledger/entries — the journal, newest first. */
ledgerRoutes.get("/ledger/entries", route(async (req, res) => {
  need(req, "list", "the journal");
  const orgId = actorOf(req, "a ledger route").orgId;
  const { status, sourceType, accountId } = req.query;

  const take = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const skip = Math.max(Number(req.query.offset) || 0, 0);

  const from = when(req.query.from, "from");
  const to = when(req.query.to, "to");

  const where: Prisma.JournalEntryWhereInput = { orgId };
  if (from || to) where.date = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  where.status = enumParam("JournalStatus", status, "entry status");
  if (sourceType) where.sourceType = String(sourceType);
  /* "every entry that touched this account" is the question a person asks
     after clicking a figure in a report. */
  if (accountId) where.lines = { some: { accountId: String(accountId), orgId } };

  const [entries, total] = await Promise.all([
    db.journalEntry.findMany({
      where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take, skip,
      include: {
        lines: {
          select: {
            id: true, accountId: true, debit: true, credit: true,
            baseDebit: true, baseCredit: true, memo: true,
            siteId: true, unitId: true, leaseId: true, partyId: true,
            account: { select: { id: true, code: true, name: true, type: true } },
          },
        },
      },
    }),
    db.journalEntry.count({ where }),
  ]);

  res.json({
    entries,
    count: entries.length,
    total,
    limit: take,
    offset: skip,
  });
}));

/** GET /ledger/entries/:id — one entry, with its lines and what it reversed. */
ledgerRoutes.get("/ledger/entries/:id", route(async (req, res) => {
  need(req, "get", "the journal");
  const entry = await db.journalEntry.findFirst({
    where: { id: param(req, "id"), orgId: actorOf(req, "a ledger route").orgId },
    include: {
      lines: {
        include: { account: { select: { id: true, code: true, name: true, type: true, normal: true } } },
      },
    },
  });
  if (!entry) throw hidden();

  /* Both directions of the correction, so a reader never has to search for
     the other half: what this reversed, and what reversed this. */
  const [reverses, reversedBy] = await Promise.all([
    entry.reversesId
      ? db.journalEntry.findFirst({
          where: { id: entry.reversesId, orgId: actorOf(req, "a ledger route").orgId },
          select: { id: true, ref: true, date: true, memo: true },
        })
      : null,
    db.journalEntry.findFirst({
      where: { reversesId: entry.id, orgId: actorOf(req, "a ledger route").orgId },
      select: { id: true, ref: true, date: true, reversalReason: true },
    }),
  ]);

  res.json({ entry, reverses, reversedBy });
}));

/**
 * POST /ledger/entries — post a balanced entry.
 *
 * The reference is allocated here and may not be sent: a caller choosing its
 * own would eventually choose one twice, and a journal with two JE-0007s is
 * a journal nobody can cite.
 *
 * Everything that decides whether this is ALLOWED — balance in both
 * currencies, accounts that exist and are postable and belong to this
 * company, the period being open — is the domain's, and is not repeated here.
 */
ledgerRoutes.post("/ledger/entries", route(async (req, res) => {
  need(req, "create", "the journal");
  const orgId = actorOf(req, "a ledger route").orgId;
  const b = req.body || {};

  if (b.ref) {
    throw badRequest("A reference is allocated by PALTAS, not chosen — two entries sharing one cannot both be cited.");
  }
  if (!Array.isArray(b.lines) || !b.lines.length) {
    throw badRequest("An entry needs its lines.");
  }

  const date = when(b.date, "date") || new Date();
  const baseCurrency = await reportingCurrency(orgId, b.baseCurrency);
  const currency = b.currency ? String(b.currency).trim().toUpperCase() : baseCurrency;

  /* Shapes only. Whether they BALANCE is the domain's question, and asking
     it here as well is how the two answers drift. */
  const lines: JournalLineInput[] = b.lines.map((raw: unknown, i: number) => {
    if (!raw || typeof raw !== "object") throw badRequest(`Line ${i + 1} is not a line.`);
    const l = raw as Record<string, unknown>;
    const out: JournalLineInput & { baseDebit?: number; baseCredit?: number } = {
      accountId: String(l["accountId"] || "").trim(),
      debit: minor(l["debit"], `line ${i + 1} debit`),
      credit: minor(l["credit"], `line ${i + 1} credit`),
      memo: l["memo"] ? String(l["memo"]).slice(0, 500) : "",
      siteId: (l["siteId"] as string) || null,
      buildingId: (l["buildingId"] as string) || null,
      unitId: (l["unitId"] as string) || null,
      leaseId: (l["leaseId"] as string) || null,
      partyId: (l["partyId"] as string) || null,
    };
    /* Sent only when they differ, so an entry in one currency is not made to
       restate the same figure twice. */
    if (l["baseDebit"] !== undefined) out.baseDebit = minor(l["baseDebit"], `line ${i + 1} baseDebit`);
    if (l["baseCredit"] !== undefined) out.baseCredit = minor(l["baseCredit"], `line ${i + 1} baseCredit`);
    return out;
  });

  const ref = await nextRef(orgId, "ledger-entries", "JE");

  const entry = await postJournal(db, {
    orgId, ref, date,
    memo: b.memo ? String(b.memo).slice(0, 1000) : "",
    lines,
    currency, baseCurrency,
    fxRate: b.fxRate ? String(b.fxRate) : "1",
    fxSource: b.fxSource ? String(b.fxSource) : null,
    fxAt: when(b.fxAt, "fxAt"),
    sourceType: b.sourceType ? String(b.sourceType) : null,
    sourceId: b.sourceId ? String(b.sourceId) : null,
    postedById: sessionOf(req, "a ledger route").userId,
  });

  await audit(req, "ledger.entry.post", "journalEntry", entry.id, {
    ref, lines: entry.lines.length, currency, baseCurrency,
  });
  res.status(201).json({ entry });
}));

/**
 * POST /ledger/entries/:id/reverse — correct by mirroring, never by editing.
 *
 * The domain writes the mirror, marks the original REVERSED and records the
 * reason on the new entry. The original's lines are untouched: an auditor
 * sees what was posted, what reversed it, and why.
 */
ledgerRoutes.post("/ledger/entries/:id/reverse", route(async (req, res) => {
  need(req, "create", "the journal");
  const orgId = actorOf(req, "a ledger route").orgId;
  const b = req.body || {};

  const reason = String(b.reason || "").trim();
  if (!reason) {
    throw badRequest("A reversal states why. An unexplained correction is the thing an audit asks about.");
  }

  /* Asked here so an id from another company answers 404 rather than the
     domain's "no such entry", which says the same thing less carefully. */
  const original = await db.journalEntry.findFirst({
    where: { id: param(req, "id"), orgId }, select: { id: true, ref: true },
  });
  if (!original) throw hidden();

  const ref = await nextRef(orgId, "ledger-entries", "JE");
  const entry = await reverseJournal(db, {
    orgId, entryId: original.id, ref,
    date: when(b.date, "date") || new Date(),
    reason,
    postedById: sessionOf(req, "a ledger route").userId,
  });

  await audit(req, "ledger.entry.reverse", "journalEntry", entry.id, {
    ref, reverses: original.ref, reason,
  });
  res.status(201).json({ entry, reversed: original.ref });
}));

/* ====================================================================== *
 * 4. READING THE BOOKS
 * ====================================================================== */

/**
 * GET /ledger/trial-balance — the first thing to check, and the cheapest.
 *
 * If this does not balance the books are wrong and every report built on
 * them is wrong with it. `balanced` is returned as its own field rather than
 * left for the caller to compare two totals, because that comparison is the
 * whole point and a caller who forgets it reports a broken figure as a fact.
 */
ledgerRoutes.get("/ledger/trial-balance", route(async (req, res) => {
  need(req, "list", "the ledger");
  const tb = await trialBalance(db, {
    orgId: actorOf(req, "a ledger route").orgId,
    from: when(req.query.from, "from"),
    to: when(req.query.to, "to"),
  });
  res.json({
    rows: tb.rows,
    debit: tb.debit,
    credit: tb.credit,
    balanced: tb.balanced,
    difference: tb.difference,
    count: tb.rows.length,
  });
}));

/**
 * GET /ledger/period-for?date= — which period a date falls in.
 *
 * Small, and it saves a form from posting an entry only to be told the
 * period is closed. It answers `null` where no period covers the date, which
 * is allowed: the domain only refuses a period that is CLOSED.
 */
ledgerRoutes.get("/ledger/period-for", route(async (req, res) => {
  need(req, "get", "financial periods");
  const date = when(req.query.date, "date") || new Date();
  const period = await periodFor(db, actorOf(req, "a ledger route").orgId, date);
  res.json({
    date,
    period: period || null,
    willAccept: !period || period.status !== "CLOSED",
  });
}));

/* ====================================================================== *
 * 5. THE STATEMENTS
 *
 * Read-only, all of them, and all built from the journal. Nothing here
 * computes a figure a second way: each one asks the domain, which asks the
 * lines. A statement that agreed with itself but not with the trial balance
 * would be the worst of both.
 * ====================================================================== */

/**
 * GET /ledger/balance-sheet?asAt=
 *
 * What the company owns, owes and is worth. `retained` is the profit not yet
 * moved into equity — without it the two sides do not meet, and a reader who
 * does not know that reports a working sheet as broken.
 */
ledgerRoutes.get("/ledger/balance-sheet", route(async (req, res) => {
  need(req, "list", "the ledger");
  const sheet = await balanceSheet(db, {
    orgId: actorOf(req, "a ledger route").orgId,
    asAt: when(req.query.asAt, "asAt"),
  });
  /*
   * `rows` IS THE SAME SHEET, FLAT, and it exists for the console.
   *
   * The three lists above are the right shape to read; a client that renders
   * one array is the shape the console's adapter layer actually has. Sending
   * only the structured form meant a screen reading `assets` silently dropped
   * the liabilities, the equity and the totals — a balance sheet showing half
   * of itself and no sign that it had.
   *
   * Retained earnings is a row here rather than a separate total, because on
   * the flat form it belongs to equity: summing the rows by side then gives a
   * sheet that balances without the reader having to know to add the profit.
   */
  const rows = [
    ...sheet.assets.map((r) => ({ ...r, side: "assets" })),
    ...sheet.liabilities.map((r) => ({ ...r, side: "liabilities" })),
    ...sheet.equity.map((r) => ({ ...r, side: "equity" })),
    {
      accountId: null, code: "", name: "Retained earnings", type: "EQUITY",
      normal: "CREDIT", balance: sheet.totals.retained, side: "equity",
      computed: true,
    },
  ];

  res.json({
    asAt: sheet.asAt,
    rows,
    assets: sheet.assets,
    liabilities: sheet.liabilities,
    equity: sheet.equity,
    totals: sheet.totals,
    funding: sheet.funding,
    balanced: sheet.balanced,
    difference: sheet.difference,
  });
}));

/** GET /ledger/income-statement?from=&to= — earned, spent, and the difference. */
ledgerRoutes.get("/ledger/income-statement", route(async (req, res) => {
  need(req, "list", "the ledger");
  const pl = await incomeStatement(db, {
    orgId: actorOf(req, "a ledger route").orgId,
    from: when(req.query.from, "from"),
    to: when(req.query.to, "to"),
  });
  /* Flat, for the same reason the balance sheet is — see there. `kind` is
     what the row is, so a screen can group without a second request. */
  const rows = [
    ...pl.income.map((r) => ({ ...r, kind: "income" })),
    ...pl.expenses.map((r) => ({ ...r, kind: "expense" })),
  ];

  res.json({
    from: pl.from,
    to: pl.to,
    rows,
    income: pl.income,
    expenses: pl.expenses,
    totals: pl.totals,
  });
}));

/**
 * GET /ledger/cash-movement?from=&to=
 *
 * Named for what it is. An IAS 7 cash flow splits movement into operating,
 * investing and financing, and nothing in this schema says which of the three
 * a payment was — so the response carries a `basis` line saying as much
 * rather than letting a reader assume they are holding a filing.
 */
ledgerRoutes.get("/ledger/cash-movement", route(async (req, res) => {
  need(req, "list", "the ledger");
  const cash = await cashMovement(db, {
    orgId: actorOf(req, "a ledger route").orgId,
    from: when(req.query.from, "from"),
    to: when(req.query.to, "to"),
  });
  res.json({
    from: cash.from,
    to: cash.to,
    basis: cash.basis,
    rows: cash.rows,
    totals: cash.totals,
    reconciles: cash.reconciles,
  });
}));

/**
 * GET /ledger/statement?partyId= | ?siteId= | ?unitId=
 *
 * An owner's, a tenant's or a property's statement — the same shape for all
 * three, because it is the same question asked of a different dimension.
 */
ledgerRoutes.get("/ledger/statement", route(async (req, res) => {
  need(req, "list", "the ledger");
  const { partyId, siteId, unitId } = req.query;
  if (!partyId && !siteId && !unitId) {
    throw badRequest("A statement is for somebody or something — send partyId, siteId or unitId.");
  }

  /* Asked here so an id belonging to another company answers 404 rather than
     an empty statement, which reads as "they owe nothing". */
  if (partyId) {
    const p = await db.party.findFirst({ where: { id: String(partyId), orgId: actorOf(req, "a ledger route").orgId }, select: { id: true } });
    if (!p) throw hidden();
  }
  if (siteId) {
    const site = await db.site.findFirst({ where: { id: String(siteId), orgId: actorOf(req, "a ledger route").orgId }, select: { id: true } });
    if (!site) throw hidden();
  }
  if (unitId) {
    const unit = await db.unit.findFirst({ where: { id: String(unitId), orgId: actorOf(req, "a ledger route").orgId }, select: { id: true } });
    if (!unit) throw hidden();
  }

  const st = await entityStatement(db, {
    orgId: actorOf(req, "a ledger route").orgId,
    partyId: partyId ? String(partyId) : null,
    siteId: siteId ? String(siteId) : null,
    unitId: unitId ? String(unitId) : null,
    from: when(req.query.from, "from"),
    to: when(req.query.to, "to"),
  });

  res.json({
    from: st.from,
    to: st.to,
    of: st.of,
    rows: st.rows,
    totals: st.totals,
  });
}));

/* ====================================================================== *
 * TAX RULES.
 *
 * In the finance area rather than a product route, because a rate belongs
 * to the company and every product that invoices reads the same one. The
 * chain is deliberately the same as the chart of accounts above: a thing
 * only finance may change, that everything else consumes.
 *
 * See domain/tax.ts for why a rate is a dated row and not a number.
 * ====================================================================== */

ledgerRoutes.get("/tax/rules", route(async (req, res) => {
  need(req, "list", "the tax rules");
  const orgId = actorOf(req, "a ledger route").orgId;

  const rules = await db.taxRule.findMany({
    where: { orgId },
    orderBy: [{ country: "asc" }, { taxCode: "asc" }, { effectiveFrom: "desc" }],
  });

  /* Which rule is in force TODAY, said out loud rather than left for the
     reader to work out from two dates and a null. */
  const today = new Date();
  res.json({
    rules: rules.map((r) => ({
      ...r,
      inForce: r.effectiveFrom <= today && (!r.effectiveTo || today <= r.effectiveTo),
    })),
  });
}));

ledgerRoutes.post("/tax/rules", route(async (req, res) => {
  need(req, "create", "the tax rules");
  const orgId = actorOf(req, "a ledger route").orgId;
  const b = req.body || {};

  const country = String(b.country || "").trim().toUpperCase();
  const taxCode = String(b.taxCode || "").trim().toUpperCase();
  if (country.length !== 2) {
    throw badRequest("A country is its two-letter code — KE, TZ, AE.");
  }
  if (!taxCode) {
    throw badRequest("A rule needs a tax code, such as VAT_STANDARD.");
  }
  if (taxCode === OUT_OF_SCOPE) {
    throw badRequest(
      `"${OUT_OF_SCOPE}" already means outside the scope of tax and needs no ` +
      `rule. A rate for it would never be read.`);
  }

  const from = new Date(String(b.effectiveFrom || ""));
  if (Number.isNaN(from.getTime())) {
    throw badRequest("A rule needs the date its rate starts applying.");
  }
  const to = b.effectiveTo ? new Date(String(b.effectiveTo)) : null;
  if (to && Number.isNaN(to.getTime())) throw badRequest("effectiveTo is not a date.");

  const kind = b.kind ? enumParam("TaxKind", b.kind, "tax kind") : undefined;
  if (b.kind && !kind) throw badRequest(`"${b.kind}" is not a kind of tax.`, ["OUTPUT", "WITHHOLDING"]);

  const rule = await addRule(db, orgId, {
    country, taxCode, rateBp: Number(b.rateBp),
    effectiveFrom: from, effectiveTo: to,
    confirmedBy: String(b.confirmedBy || ""),
    label: String(b.label || "").trim(),
    ...(kind ? { kind } : {}),
  });

  await audit(req, "tax.rule.add", "taxRule", rule.id, {
    country, taxCode, rateBp: rule.rateBp,
    from: from.toISOString().slice(0, 10), confirmedBy: rule.confirmedBy,
  });

  res.status(201).json({ rule });
}));

/* The only edit a rule allows. Everything else about a rule that has been
   applied to an invoice is history — see domain/tax.ts. */
ledgerRoutes.post("/tax/rules/:id/end", route(async (req, res) => {
  need(req, "update", "the tax rules");
  const orgId = actorOf(req, "a ledger route").orgId;

  const on = new Date(String(req.body?.effectiveTo || ""));
  if (Number.isNaN(on.getTime())) {
    throw badRequest("Ending a rule needs the last date it applies.");
  }

  const rule = await endRule(db, orgId, param(req, "id"), on);
  await audit(req, "tax.rule.end", "taxRule", rule.id,
    { to: on.toISOString().slice(0, 10) });

  res.json({ rule });
}));

/* What rate would be applied, without raising anything. The screen that
   asks before it commits, and the answer a person can check. */
ledgerRoutes.get("/tax/rate", route(async (req, res) => {
  need(req, "get", "the tax rules");
  const orgId = actorOf(req, "a ledger route").orgId;

  const org = await db.organization.findFirst({
    where: { id: orgId }, select: { country: true },
  });
  const on = req.query["on"] ? new Date(String(req.query["on"])) : new Date();
  if (Number.isNaN(on.getTime())) throw badRequest("`on` is not a date.");

  const answer = await rateFor(db, {
    orgId,
    country: String(req.query["country"] || org?.country || "ke").toUpperCase(),
    taxCode: String(req.query["taxCode"] || "").trim().toUpperCase(),
    on,
  });

  const base = BigInt(Math.max(0, Math.round(Number(req.query["base"]) || 0)));
  res.json({ ...answer, base: String(base), tax: String(taxOn(base, answer.rateBp)) });
}));

/* ====================================================================== *
 * BANKING AND RECONCILIATION.
 *
 * In the finance area for the obvious reason: this is the company's money,
 * and comparing the books against the bank is the most sensitive read in
 * the service. See domain/banking.ts for what each refusal protects.
 * ====================================================================== */

ledgerRoutes.get("/banking/accounts", route(async (req, res) => {
  need(req, "list", "the bank accounts");
  const orgId = actorOf(req, "a ledger route").orgId;

  const accounts = await db.bankAccount.findMany({
    where: { orgId },
    include: { ledgerAccount: { select: { code: true, name: true } } },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });

  /* The unmatched count per account, because "is this reconciled" is the
     only question anybody opens this screen to ask. */
  const withCounts = await Promise.all(accounts.map(async (a) => ({
    ...a,
    unmatched: await db.bankTransaction.count({
      where: { orgId, bankAccountId: a.id, matchedPaymentId: null, amount: { gt: 0n } },
    }),
  })));

  res.json({ accounts: withCounts });
}));

ledgerRoutes.post("/banking/accounts", route(async (req, res) => {
  need(req, "create", "the bank accounts");
  const orgId = actorOf(req, "a ledger route").orgId;
  const b = req.body || {};

  const name = String(b.name || "").trim();
  if (!name) throw badRequest("A bank account needs a name somebody will recognise.");

  const kind = b.kind ? enumParam("BankAccountKind", b.kind, "account kind") : "BANK";
  if (b.kind && !kind) {
    throw badRequest(`"${b.kind}" is not a kind of account.`,
      ["BANK", "MOBILE_MONEY", "CARD_PROCESSOR"]);
  }

  /* The ledger account is named by CODE, as everywhere else in this file: a
     chart is what an accountant reads and types, and ids are not in front
     of them. */
  let ledgerAccountId: string | null = null;
  if (b.ledgerAccount) {
    const account = await db.ledgerAccount.findFirst({
      where: { orgId, code: String(b.ledgerAccount).trim() },
      select: { id: true },
    });
    if (!account) {
      throw badRequest(`There is no account ${b.ledgerAccount} in the chart.`);
    }
    ledgerAccountId = account.id;
  }

  const account = await db.bankAccount.create({
    data: {
      orgId, name, kind: kind as never,
      currency: String(b.currency || "KES").toUpperCase(),
      externalRef: String(b.externalRef || "").trim(),
      ledgerAccountId,
    },
  });
  await audit(req, "banking.account.add", "bankAccount", account.id,
    { name, kind: account.kind, currency: account.currency });

  res.status(201).json({ account });
}));

/* A statement in. See domain/banking.ts on why a duplicate line is reported
   rather than thrown. */
ledgerRoutes.post("/banking/accounts/:id/statement", route(async (req, res) => {
  need(req, "create", "a bank statement");
  const orgId = actorOf(req, "a ledger route").orgId;

  const raw = Array.isArray(req.body?.lines) ? req.body.lines : null;
  if (!raw) throw badRequest("Send `lines`: the statement, one object per row.");
  if (!raw.length) throw badRequest("That statement has no lines in it.");
  if (raw.length > 2000) {
    throw badRequest(
      "That is more than two thousand lines. Split the file by month — a " +
      "single import that fails half way is harder to reason about than two " +
      "that do not.");
  }

  const lines = raw.map((l: Record<string, unknown>, i: number) => {
    const valueOn = new Date(String(l["valueOn"] ?? l["date"] ?? ""));
    if (Number.isNaN(valueOn.getTime())) {
      throw badRequest(`Line ${i + 1} has no value date.`);
    }
    const amount = Math.round(Number(l["amount"]));
    if (!Number.isFinite(amount)) {
      throw badRequest(`Line ${i + 1} has no amount in minor units.`);
    }
    return {
      valueOn, amount: BigInt(amount),
      reference: String(l["reference"] ?? ""),
      payerName: String(l["payerName"] ?? ""),
      ...(l["currency"] ? { currency: String(l["currency"]) } : {}),
    };
  });

  const out = await importStatement(db, orgId, param(req, "id"), lines);
  await audit(req, "banking.statement.import", "bankAccount", param(req, "id"),
    { imported: out.imported, duplicates: out.duplicates.length });

  res.status(201).json({
    ...out,
    said: out.duplicates.length
      ? `${out.imported} lines imported. ${out.duplicates.length} were already ` +
        `on file and were left alone.`
      : `${out.imported} lines imported.`,
  });
}));

ledgerRoutes.get("/banking/unreconciled", route(async (req, res) => {
  need(req, "get", "the reconciliation");
  const orgId = actorOf(req, "a ledger route").orgId;
  const account = req.query["bankAccountId"] ? String(req.query["bankAccountId"]) : undefined;
  res.json(await unreconciled(db, orgId, account));
}));

ledgerRoutes.post("/banking/accounts/:id/auto-match", route(async (req, res) => {
  need(req, "update", "the reconciliation");
  const orgId = actorOf(req, "a ledger route").orgId;

  const out = await autoMatch(db, orgId, param(req, "id"), "auto");
  await audit(req, "banking.automatch", "bankAccount", param(req, "id"),
    { matched: out.matched.length, ambiguous: out.ambiguous.length });

  res.json({
    ...out,
    said: out.ambiguous.length
      ? `${out.matched.length} matched. ${out.ambiguous.length} could be more ` +
        `than one payment and were left for somebody to decide — a wrong match ` +
        `sends the receipt to the wrong buyer.`
      : `${out.matched.length} matched, ${out.unmatchedLines} still unclaimed.`,
  });
}));

ledgerRoutes.post("/banking/match", route(async (req, res) => {
  need(req, "update", "the reconciliation");
  const orgId = actorOf(req, "a ledger route").orgId;

  const paymentId = String(req.body?.paymentId || "").trim();
  const transactionId = String(req.body?.transactionId || "").trim();
  if (!paymentId || !transactionId) {
    throw badRequest("Matching needs both a paymentId and a transactionId.");
  }

  const who = req.view?.user?.name || req.view?.user?.email || "a person";
  const out = await reconcile(db, orgId, paymentId, transactionId, who);
  await audit(req, "banking.match", "payment", paymentId,
    { transactionId, amount: out.amount, reference: out.reference });

  res.json({ matched: out });
}));

ledgerRoutes.post("/banking/transactions/:id/unmatch", route(async (req, res) => {
  need(req, "update", "the reconciliation");
  const orgId = actorOf(req, "a ledger route").orgId;

  const out = await unreconcile(db, orgId, param(req, "id"));
  await audit(req, "banking.unmatch", "payment", out.paymentId,
    { transactionId: param(req, "id") });

  res.json({ unmatched: out });
}));
