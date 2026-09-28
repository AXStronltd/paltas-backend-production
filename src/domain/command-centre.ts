/* ======================================================================
 * THE COMMAND CENTRE — WHAT IS HAPPENING, AND WHAT NEEDS ATTENTION.
 *
 * ── THE DEFECT THIS CLOSES ─────────────────────────────────────────────
 *
 * The console's command screen counted everything THROUGH SITES: units were
 * `sum(properties, p => p.units)`, the rent roll was the sum of each site's
 * roll-up, and the whole content area was gated on whether any site existed.
 *
 * But `Unit.siteId` is optional and `Lease.unitId` is optional. So a company
 * can hold two units and four tenancies with no Site row at all — and did.
 * Everything it owned was invisible, and the screen offered to help it add its
 * first property, which it had been using for weeks.
 *
 * Counting a thing through its parent only works when the parent is required.
 * Here it is not, so this counts each thing where it lives.
 *
 * ── IT AGGREGATES, IT DOES NOT DECIDE ──────────────────────────────────
 *
 * Arrears and ageing come from domain/receivables.ts. Which lease states are
 * live comes from domain/occupancy.ts. Activity comes from the AuditEvent
 * table that already records it. Nothing here is a second opinion about
 * anything — a command centre that worked out its own version of what is owed
 * would eventually disagree with the collections screen, and it would be the
 * one people looked at first.
 *
 * ── MONEY IS NOT FOR EVERYBODY ─────────────────────────────────────────
 *
 * `finance` is null for a role that may not see money, rather than zeroed.
 * Zeros read as "you have none", which is a different and wrong statement.
 * ====================================================================== */

import type { Db } from "../db.ts";
import type { $Enums } from "@prisma/client";
import { LIVE_LEASE_STATES } from "./occupancy.ts";
import { receivables } from "./receivables.ts";

/** How far ahead "expiring soon" looks. */
const EXPIRY_WINDOW_DAYS = 90;

export interface CommandCentreQuery {
  readonly orgId: string;
  /** False for a role that may not see money. `finance` is then null. */
  readonly money: boolean;
  readonly now?: Date;
}

export interface AttentionItem {
  readonly kind: string;
  readonly what: string;
  readonly entity: string;
  readonly entityId: string;
  readonly when: Date | null;
  readonly priority: "high" | "medium" | "low";
  /** Which console screen answers it. */
  readonly screen: string;
}

export async function commandCentre(db: Db, q: CommandCentreQuery) {
  const now = q.now || new Date();
  const orgId = q.orgId;

  /*
   * COUNTED WHERE THEY LIVE, not through a parent that may not exist.
   * groupBy rather than a row-by-row read: a portfolio of ten thousand units
   * must not become ten thousand objects to count five numbers.
   */
  const [sites, buildings, unitsByStatus, leasesByStatus, cases] = await Promise.all([
    db.site.count({ where: { orgId } }),
    db.building.count({ where: { orgId } }),
    db.unit.groupBy({ by: ["status"], where: { orgId }, _count: { _all: true } }),
    db.lease.groupBy({ by: ["status"], where: { orgId }, _count: { _all: true } }),
    /* Grouped by both, so "open" and "urgent and open" are one query rather
       than two passes over the same table. */
    db.workOrder.groupBy({ by: ["status", "priority"], where: { orgId }, _count: { _all: true } }),
  ]);

  const unitCount = (s: $Enums.UnitStatus) =>
    unitsByStatus.find((g) => g.status === s)?._count._all || 0;
  const units = unitsByStatus.reduce((t, g) => t + g._count._all, 0);
  const occupied = unitCount("OCCUPIED");
  const vacant = unitCount("VACANT");

  const liveLeases = leasesByStatus
    .filter((g) => (LIVE_LEASE_STATES as readonly string[]).includes(g.status))
    .reduce((t, g) => t + g._count._all, 0);

  /* Leases running out, soonest first — the thing a landlord acts on. */
  const horizon = new Date(now.getTime() + EXPIRY_WINDOW_DAYS * 86_400_000);
  const expiring = await db.lease.findMany({
    where: {
      orgId, status: { in: [...LIVE_LEASE_STATES] },
      endsOn: { not: null, gte: now, lte: horizon },
    },
    select: { id: true, ref: true, unitRef: true, tenantName: true, endsOn: true,
              rent: true, currency: true },
    orderBy: { endsOn: "asc" },
    take: 10,
  });

  const attention: AttentionItem[] = [];

  /*
   * FOLLOW-UPS THAT HAVE COME DUE.
   *
   * A follow-up date nobody is shown is a note somebody has to remember. These
   * are the ones whose day has arrived or passed, on both a client and a lead —
   * the two places a relationship is worked from.
   */
  const [dueClients, dueLeads] = await Promise.all([
    db.party.findMany({
      where: { orgId, nextFollowUpOn: { not: null, lte: now } },
      select: { id: true, name: true, nextFollowUpOn: true },
      orderBy: { nextFollowUpOn: "asc" }, take: 10,
    }),
    db.lead.findMany({
      where: { orgId, nextFollowUpOn: { not: null, lte: now },
               stage: { notIn: ["CLOSED", "LOST"] } },
      select: { id: true, name: true, nextFollowUpOn: true, stage: true },
      orderBy: { nextFollowUpOn: "asc" }, take: 10,
    }),
  ]);
  const lateBy = (d: Date) => Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  for (const c of dueClients) {
    attention.push({
      kind: "follow-up-due",
      what: `${c.name} — follow-up due ${c.nextFollowUpOn!.toISOString().slice(0, 10)}`,
      entity: "party", entityId: c.id, when: c.nextFollowUpOn,
      priority: lateBy(c.nextFollowUpOn!) > 7 ? "high" : "medium",
      screen: "pm_buyers",
    });
  }
  for (const l of dueLeads) {
    attention.push({
      kind: "lead-follow-up-due",
      what: `${l.name} — ${String(l.stage).toLowerCase()} lead, follow-up due`,
      entity: "lead", entityId: l.id, when: l.nextFollowUpOn,
      priority: lateBy(l.nextFollowUpOn!) > 7 ? "high" : "medium",
      screen: "ag_leads",
    });
  }
  for (const l of expiring) {
    attention.push({
      kind: "lease-expiring",
      what: `${l.tenantName || l.ref} — lease ends ${l.endsOn!.toISOString().slice(0, 10)}`,
      entity: "lease", entityId: l.id, when: l.endsOn,
      priority: (l.endsOn!.getTime() - now.getTime()) < 30 * 86_400_000 ? "high" : "medium",
      screen: "rentals",
    });
  }

  /*
   * MONEY, WHERE THE ROLE MAY SEE IT.
   *
   * Arrears come from the receivables service — the same one Collections
   * reads, so the two cannot disagree. Its books are per currency and are
   * passed through as such; nothing is added across currencies here, because
   * there is no rate to add them with.
   */
  let finance = null;
  if (q.money) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [ar, collected, spent] = await Promise.all([
      receivables(db, { orgId, asAt: now }),
      db.payment.groupBy({
        by: ["currency"],
        where: { orgId, voided: false, receivedAt: { gte: monthStart, lte: now } },
        _sum: { amount: true }, _count: { _all: true },
      }),
      db.expense.groupBy({
        by: ["currency"],
        where: { orgId, spentOn: { gte: monthStart, lte: now } },
        _sum: { amount: true }, _count: { _all: true },
      }),
    ]);

    finance = {
      books: ar.books.map((b) => ({
        currency: b.currency, outstanding: b.open,
        overdue: b.overdue, notYetDue: b.notYetDue, aging: b.aging,
      })),
      mixed: ar.mixed,
      openInvoices: ar.invoiceCount,
      collectedThisMonth: collected.map((c) => ({
        currency: c.currency, amount: (c._sum.amount ?? 0n).toString(), count: c._count._all,
      })),
      expensesThisMonth: spent.map((c) => ({
        currency: c.currency, amount: (c._sum.amount ?? 0n).toString(), count: c._count._all,
      })),
    };

    /* The worst arrears, as things to do rather than a number. */
    for (const inv of ar.invoices.filter((i) => i.bucket !== "CURRENT").slice(0, 10)) {
      attention.push({
        kind: "rent-overdue",
        what: `${inv.partyName} — ${inv.ref} is ${inv.daysLate} day${inv.daysLate === 1 ? "" : "s"} late`,
        entity: "invoice", entityId: inv.invoiceId, when: inv.dueOn,
        priority: (inv.daysLate ?? 0) > 30 ? "high" : "medium",
        screen: "fin_collect",
      });
    }
  }

  /*
   * ACTIVITY, FROM THE TABLE THAT ALREADY RECORDS IT.
   *
   * AuditEvent is the platform's activity engine. A second one would be a
   * second version of what happened.
   */
  const activity = await db.auditEvent.findMany({
    where: { orgId },
    /* `at`, not `createdAt`: the column records when the ACTION happened,
       which is the instant somebody is looking for. */
    select: { id: true, at: true, actorName: true, action: true,
              entity: true, entityId: true },
    orderBy: { at: "desc" },
    take: 20,
  });

  const stillOpen = cases.filter((g) => g.status !== "DONE" && g.status !== "CANCELLED");
  const openCases = stillOpen.reduce((t, g) => t + g._count._all, 0);
  const urgentCases = stillOpen
    .filter((g) => g.priority === "URGENT" || g.priority === "HIGH")
    .reduce((t, g) => t + g._count._all, 0);

  return {
    asAt: now,
    portfolio: {
      sites, buildings, units,
      occupied, vacant,
      reserved: unitCount("RESERVED"),
      offMarket: unitCount("OFF_MARKET"),
      notice: unitCount("NOTICE"),
      /* Null rather than 0 when there are no units: "0% occupied" and "no
         units yet" are different things and only one of them is a problem. */
      occupancyPct: units ? Math.round((occupied / units) * 100) : null,
    },
    leases: {
      live: liveLeases,
      expiringSoon: expiring.map((l) => ({
        id: l.id, ref: l.ref, unitRef: l.unitRef, tenantName: l.tenantName,
        endsOn: l.endsOn, rent: l.rent.toString(), currency: l.currency,
      })),
    },
    operations: { openCases, urgentCases },
    finance,
    attention: attention
      .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "high" ? -1 : 1))
      .slice(0, 12),
    activity,
  };
}
