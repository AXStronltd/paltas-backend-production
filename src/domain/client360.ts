/* ======================================================================
 * ONE CLIENT, EVERYTHING.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────
 *
 * It is not a CRM database. Every record it shows belongs to the system that
 * owns it: leases to property management, invoices and payments to finance,
 * cases to operations, offers and reservations to sales. This assembles the
 * relationship — which is the one thing no single system owns — and stores
 * nothing of its own.
 *
 * buyer360 already does this for a BUYER with a contract: instalments,
 * payments, what is still unbilled. It is the right shape and the wrong scope,
 * because a tenant, an owner, an investor and a plain contact are all clients
 * too and none of them has a contract. This answers the same question for any
 * party, and defers to the services that own each part rather than recomputing
 * them:
 *
 *   arrears        domain/receivables.ts, filtered to this party
 *   live tenancies domain/occupancy.ts's own definition
 *   activity       the AuditEvent table that already records it
 *
 * Recomputing any of those here would eventually disagree with the screen that
 * owns it, and a client screen is the one somebody reads to a customer down
 * the telephone.
 *
 * ── CREDIT IS NEVER NETTED AGAINST ARREARS ─────────────────────────────
 *
 * The same rule buyer360 keeps. Somebody who overpaid one invoice and is late
 * on another owes the late one and is owed the overpayment; showing the
 * difference makes a statement nobody can explain.
 * ====================================================================== */

import type { Db } from "../db.ts";
import { LIVE_LEASE_STATES } from "./occupancy.ts";
import { receivables } from "./receivables.ts";

export interface Client360Query {
  readonly orgId: string;
  readonly partyId: string;
  /** False for a role that may not see money. `finance` is then null. */
  readonly money: boolean;
}

export async function client360(db: Db, q: Client360Query) {
  const { orgId, partyId } = q;

  const party = await db.party.findFirst({
    where: { id: partyId, orgId },
    select: {
      id: true, name: true, kind: true, email: true, phone: true,
      city: true, country: true, source: true, status: true, tags: true,
      note: true, since: true, createdAt: true, nextFollowUpOn: true,
      assignedTo: { select: { id: true, name: true, email: true } },
    },
  });
  if (!party) return null;

  /*
   * WHAT THIS PERSON IS TO THE BUSINESS, from the tables that say so rather
   * than from `kind`. Somebody recorded as a CONTACT who holds a lease is a
   * tenant whatever the column says, and the relationship is what a person on
   * the telephone needs to know.
   */
  const [leases, contracts, offers, deals, viewings, reservations, leads, documents] =
    await Promise.all([
      db.lease.findMany({
        where: { orgId, tenantId: partyId },
        select: { id: true, ref: true, unitRef: true, status: true, rent: true,
                  currency: true, startsOn: true, endsOn: true },
        orderBy: { createdAt: "desc" }, take: 25,
      }),
      db.contract.findMany({
        where: { orgId, buyerId: partyId },
        select: { id: true, ref: true, status: true, price: true, currency: true },
        orderBy: { createdAt: "desc" }, take: 25,
      }),
      db.offer.findMany({
        where: { orgId, buyerId: partyId },
        select: { id: true, ref: true, status: true, price: true, currency: true,
                  unitId: true, sentAt: true, decidedAt: true },
        orderBy: { createdAt: "desc" }, take: 25,
      }),
      db.deal.findMany({
        where: { orgId, partyId },
        select: { id: true, name: true, stage: true, value: true, currency: true,
                  closesOn: true },
        orderBy: { createdAt: "desc" }, take: 25,
      }),
      db.viewing.findMany({
        where: { orgId, partyId },
        select: { id: true, status: true, at: true },
        orderBy: { at: "desc" }, take: 25,
      }),
      db.reservation.findMany({
        /* A reservation names its person as the guest, not as a party. */
        where: { orgId, guestId: partyId },
        select: { id: true, ref: true, status: true },
        orderBy: { createdAt: "desc" }, take: 25,
      }),
      /* Where the relationship came from. The link that did not exist. */
      db.lead.findMany({
        where: { orgId, partyId },
        select: { id: true, name: true, stage: true, source: true, budget: true,
                  currency: true, nextFollowUpOn: true },
        orderBy: { createdAt: "desc" }, take: 10,
      }),
      /*
       * THEIR DOCUMENTS, asked of the database rather than guessed at.
       *
       * This was absent while Document had only a free-text `about`: matching a
       * name against it would show one client's identity document under
       * another client's name. It has a partyId now, so the question can be
       * asked properly.
       *
       * The bytes are never here — only what the file is and when it expires.
       * Reading it is a signed download from the documents service.
       */
      db.document.findMany({
        where: { orgId, partyId },
        select: { id: true, name: true, kind: true, expiresAt: true,
                  mimeType: true, bytes: true, createdAt: true },
        orderBy: { createdAt: "desc" }, take: 25,
      }),
    ]);



  /*
   * MONEY, WHERE THE ROLE MAY SEE IT — and from finance, which owns it.
   *
   * `outstanding` comes from the receivables service filtered to this party:
   * the same arrears the Collections screen shows, so a client cannot be told
   * one figure here and another there.
   */
  let finance = null;
  if (q.money) {
    const [ar, invoices, payments] = await Promise.all([
      receivables(db, { orgId, partyId }),
      db.invoice.groupBy({
        by: ["currency"],
        where: { orgId, partyId, status: { notIn: ["DRAFT", "VOID"] } },
        _sum: { total: true, paid: true }, _count: { _all: true },
      }),
      db.payment.findMany({
        where: { orgId, voided: false, invoice: { partyId } },
        select: { id: true, receivedAt: true, amount: true, currency: true,
                  method: true, reference: true },
        orderBy: { receivedAt: "desc" }, take: 10,
      }),
    ]);

    finance = {
      /* One row per currency. Nothing is added across them — there is no rate
         here and none is invented. */
      billed: invoices.map((i) => ({
        currency: i.currency,
        invoiced: (i._sum.total ?? 0n).toString(),
        received: (i._sum.paid ?? 0n).toString(),
        invoices: i._count._all,
      })),
      arrears: ar.books.map((b) => ({
        currency: b.currency, outstanding: b.open, overdue: b.overdue,
      })),
      openInvoices: ar.invoiceCount,
      recentPayments: payments.map((p) => ({
        id: p.id, receivedAt: p.receivedAt, amount: p.amount.toString(),
        currency: p.currency, method: p.method, reference: p.reference,
      })),
    };
  }

  /*
   * THE HISTORY, from the audit trail that already records it.
   *
   * Matched on this party AND on the records that belong to them, so "what has
   * happened with this client" includes the invoice that was raised and the
   * lease that was signed, not only the times somebody edited the contact.
   */
  /* Their invoices too: "what has happened with this client" means the invoice
     that was raised and the payment that came in, not only the times somebody
     edited the contact. */
  const theirInvoices = await db.invoice.findMany({
    where: { orgId, partyId }, select: { id: true }, take: 100,
  });
  const ids = [partyId,
    ...leases.map((x) => x.id), ...contracts.map((x) => x.id),
    ...offers.map((x) => x.id), ...deals.map((x) => x.id),
    ...reservations.map((x) => x.id), ...leads.map((x) => x.id),
    ...theirInvoices.map((x) => x.id)];
  const activity = await db.auditEvent.findMany({
    where: { orgId, entityId: { in: ids } },
    select: { id: true, at: true, actorName: true, action: true,
              entity: true, entityId: true },
    orderBy: { at: "desc" }, take: 30,
  });

  return {
    party,
    /* What they ARE, counted rather than declared. */
    relationship: {
      tenant: leases.some((l) => (LIVE_LEASE_STATES as readonly string[]).includes(l.status)),
      buyer: contracts.length > 0 || offers.length > 0,
      lead: leads.length > 0,
      activeLeases: leases.filter(
        (l) => (LIVE_LEASE_STATES as readonly string[]).includes(l.status)).length,
    },
    leases, contracts, offers, deals, viewings, reservations, leads, documents,
    finance,
    activity,
  };
}
