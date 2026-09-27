/* ======================================================================
 * WHAT CURRENCY A NEW RECORD IS IN.
 *
 * ── THE DEFECT THIS CLOSES ─────────────────────────────────────────────
 *
 * Thirty-one models carry `currency String @default("KES")`. The column
 * default is right for storage — it is what keeps a historical row saying
 * what it always said — and wrong for creation, because it applies to every
 * country. A Swedish company raising an invoice without naming a currency got
 * KES.
 *
 * That is not merely a wrong label. The books resolve their own currency from
 * the company's country (see reportingCurrencyFor), so the records said KES
 * while the ledger said SEK — and domain/posting.ts then REFUSED to post,
 * correctly and by design:
 *
 *     "this is in KES and the books are in SEK — post it by hand with the
 *      rate used"
 *
 * So the accounting chain simply stopped for every organization outside
 * Kenya, honestly and invisibly. Resolving the currency at the moment of
 * creation is what makes the rest of that machinery reachable.
 *
 * ── WHY IT WALKS UP RATHER THAN READING THE COMPANY ────────────────────
 *
 * The company's country is the LAST answer, not the first. A multinational is
 * the ordinary case this has to get right: a Kenyan tower held by a Swedish
 * company bills in KES, and asking the company would say SEK. So the chain
 * runs from the most specific thing that already knows to the least:
 *
 *     invoice → lease → contract → unit → project → bank account → site
 *             → the site's own country → the company's country
 *
 * Each step reads a row that has ALREADY had its own currency resolved this
 * way, so the chain is one hop deep in practice and terminates.
 *
 * ── IT MAY RETURN NULL, AND THAT IS A REAL ANSWER ──────────────────────
 *
 * A company whose country is not in the market catalogue has no default
 * anybody can infer. Returning null leaves the column default in place and
 * lets the caller decide — which for the ledger means demanding an explicit
 * currency rather than guessing. Inventing one here is the failure this file
 * exists to prevent.
 * ====================================================================== */

import type { Db } from "../db.ts";
import { country as marketCountry } from "./market.ts";

/** The currency a country keeps its books in, or null if we do not know it. */
export function currencyOfCountry(code: unknown): string | null {
  const c = code ? marketCountry(code) : null;
  return c && c.currency ? String(c.currency) : null;
}

/**
 * Whatever a new row can be told about where it belongs.
 *
 * These are the columns the registry already collects, so a create body IS a
 * hint object — no caller has to assemble one.
 */
export interface CurrencyHints {
  readonly invoiceId?: unknown;
  readonly leaseId?: unknown;
  readonly contractId?: unknown;
  readonly unitId?: unknown;
  readonly siteId?: unknown;
  /** A development. It carries its own currency and stands in one country. */
  readonly projectId?: unknown;
  /** BankTransaction names its account this way. */
  readonly accountId?: unknown;
  /** A site states its own country before anything else knows it. */
  readonly country?: unknown;
  readonly [key: string]: unknown;
}

/** A stored currency, or null when the column holds the "not set" blank. */
function stated(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? s.toUpperCase() : null;
}

/**
 * The currency a new record should carry.
 *
 * Every lookup is org-scoped. A hint naming another company's row resolves to
 * nothing rather than to that company's currency.
 */
export async function currencyFor(
  db: Db, orgId: string, hints: CurrencyHints = {},
): Promise<string | null> {
  const id = (v: unknown) => (typeof v === "string" && v ? v : null);

  const invoiceId = id(hints.invoiceId);
  if (invoiceId) {
    const row = await db.invoice.findFirst({
      where: { id: invoiceId, orgId }, select: { currency: true },
    });
    const c = stated(row?.currency);
    if (c) return c;
  }

  const leaseId = id(hints.leaseId);
  if (leaseId) {
    const row = await db.lease.findFirst({
      where: { id: leaseId, orgId }, select: { currency: true },
    });
    const c = stated(row?.currency);
    if (c) return c;
  }

  const contractId = id(hints.contractId);
  if (contractId) {
    const row = await db.contract.findFirst({
      where: { id: contractId, orgId }, select: { currency: true },
    });
    const c = stated(row?.currency);
    if (c) return c;
  }

  const unitId = id(hints.unitId);
  if (unitId) {
    const row = await db.unit.findFirst({
      where: { id: unitId, orgId }, select: { currency: true, siteId: true },
    });
    const c = stated(row?.currency);
    if (c) return c;
    /* A unit knows its property even when it has no currency of its own. */
    if (row?.siteId) {
      const fromSite = await siteCurrency(db, orgId, row.siteId);
      if (fromSite) return fromSite;
    }
  }

  const projectId = id(hints.projectId);
  if (projectId) {
    const row = await db.project.findFirst({
      where: { id: projectId, orgId }, select: { currency: true, siteId: true },
    });
    const c = stated(row?.currency);
    if (c) return c;
    /* A development knows the property it is being built on. */
    if (row?.siteId) {
      const fromSite = await siteCurrency(db, orgId, row.siteId);
      if (fromSite) return fromSite;
    }
  }

  const accountId = id(hints.accountId);
  if (accountId) {
    const row = await db.bankAccount.findFirst({
      where: { id: accountId, orgId }, select: { currency: true },
    });
    const c = stated(row?.currency);
    if (c) return c;
  }

  const siteId = id(hints.siteId);
  if (siteId) {
    const fromSite = await siteCurrency(db, orgId, siteId);
    if (fromSite) return fromSite;
  }

  /* A site being created states its own country before any row knows it. */
  const own = currencyOfCountry(hints.country);
  if (own) return own;

  return companyCurrency(db, orgId);
}

/** A property's currency, or the currency of the country it stands in. */
async function siteCurrency(
  db: Db, orgId: string, siteId: string,
): Promise<string | null> {
  const row = await db.site.findFirst({
    where: { id: siteId, orgId }, select: { currency: true, country: true },
  });
  if (!row) return null;
  return stated(row.currency) || currencyOfCountry(row.country);
}

/** The company's own, from its country. Null when the catalogue has no entry. */
export async function companyCurrency(db: Db, orgId: string): Promise<string | null> {
  const org = await db.organization.findFirst({
    where: { id: orgId }, select: { country: true },
  });
  return org ? currencyOfCountry(org.country) : null;
}
