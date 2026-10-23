/** Read-only analytics over existing rent invoices and effective allocations, including reversals/credits. */
import type { property as P } from "@paltas/contracts";
import type { InvoiceRow } from "../shared/records.js";
import { balanceOf } from "../shared/records.js";
import { addDays, daysBetween, sum } from "../shared/util.js";

export function rentAnalysis(invoices: InvoiceRow[], month: string, today: string, currency: string): P.RentAnalysis {
  const rent = invoices.filter((i) => i.kind === "rent" && i.issue_date <= today);
  const cohort = rent.filter((i) => i.issue_date.slice(0, 7) === month);
  const open = rent.filter((i) => balanceOf(i) > 0);
  const overdue = open.filter((i) => i.due_date < today);
  const billed = sum(cohort, (i) => i.amount_minor);
  const paid = sum(cohort, (i) => i.paid_minor);
  const credited = sum(cohort, (i) => i.credited_minor);
  const collectible = billed - credited;
  const ageing = ["Not overdue", "1–30 days", "31–60 days", "61–90 days", "Over 90 days"].map((label) => ({
    label,
    amountMinor: 0,
  }));
  const people = new Map<string, P.RentAnalysis["followUp"][number]>();
  for (const i of open) {
    const age = daysBetween(i.due_date, today);
    const bucket = ageing[age <= 0 ? 0 : age <= 30 ? 1 : age <= 60 ? 2 : age <= 90 ? 3 : 4];
    if (bucket) bucket.amountMinor += balanceOf(i);
    if (age <= 0) continue;
    const person = people.get(i.tenant_id) ?? {
      tenantId: i.tenant_id,
      tenantName: i.tenant_name,
      overdueMinor: 0,
      oldestDueDate: i.due_date,
      invoiceCount: 0,
    };
    person.overdueMinor += balanceOf(i);
    person.invoiceCount++;
    if (i.due_date < person.oldestDueDate) person.oldestDueDate = i.due_date;
    people.set(i.tenant_id, person);
  }
  return {
    currency,
    billedMinor: billed,
    paidMinor: paid,
    creditedMinor: credited,
    outstandingMinor: sum(cohort, balanceOf),
    collectionRatePct: collectible > 0 ? Math.round((paid * 10_000) / collectible) / 100 : null,
    invoiceCount: cohort.length,
    settledCount: cohort.filter((i) => balanceOf(i) <= 0).length,
    partiallyPaidCount: cohort.filter((i) => balanceOf(i) > 0 && i.paid_minor + i.credited_minor > 0).length,
    unpaidCount: cohort.filter((i) => i.paid_minor + i.credited_minor === 0 && balanceOf(i) > 0).length,
    overdueMinor: sum(overdue, balanceOf),
    dueSoonMinor: sum(
      open.filter((i) => i.due_date >= today && i.due_date <= addDays(today, 7)),
      balanceOf,
    ),
    overdueTenants: people.size,
    ageing,
    followUp: [...people.values()]
      .sort(
        (a, b) =>
          b.overdueMinor - a.overdueMinor ||
          a.oldestDueDate.localeCompare(b.oldestDueDate) ||
          a.tenantId.localeCompare(b.tenantId),
      )
      .slice(0, 10),
  };
}
