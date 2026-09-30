/* ====================================================================== *
 * TELLING SOMEBODY BEFORE IT IS TOO LATE.
 *
 * ── WHY THIS IS ONE ENGINE AND NOT TEN JOBS ────────────────────────────
 *
 * The standard names ten reminders: payments due, invoices overdue, leases
 * expiring, documents expiring, inspections, maintenance, task deadlines,
 * project deadlines, offers expiring, permits lapsing. Written as ten jobs
 * they would be ten copies of the same four decisions — what to scan, when it
 * fires, what to say, who to tell — and the tenth would quietly disagree with
 * the first about whether "7 days" means before or after midnight.
 *
 * They are one mechanism with ten declarations. Adding an eleventh is a
 * declaration, which is the point: the next customer who needs a reminder
 * PALTAS does not have should get it without a new job.
 *
 * ── THE ONE HARD PART ──────────────────────────────────────────────────
 *
 * Not finding the rows. Not repeating.
 *
 * A lease expiring in three weeks is still expiring tomorrow, so a daily
 * sweep with no memory tells the same tenant the same thing every morning
 * until they leave. People stop reading a system that does that, and then
 * they miss the one that mattered.
 *
 * So each reminder fires at MILESTONES, and a Reminder row records which
 * milestone has already fired for which record. The unique key
 * (orgId, kind, subjectId, milestone) is the guarantee, in the database,
 * exactly like the scheduler's own claim — two instances sweeping at once
 * both try to insert and one is refused.
 *
 * A milestone is crossed, not matched. Asking "is it exactly 30 days away"
 * misses every record on a day the job did not run, which is the first
 * morning after any outage. Asking "is it 30 days away or less, and has 30
 * not fired yet" catches up instead.
 *
 * ── WHAT IT DOES NOT DECIDE ────────────────────────────────────────────
 *
 * Whether the message is actually delivered. It writes a Dispatch and hands
 * it to the messaging layer, which already answers honestly: a company with
 * no provider connected leaves it QUEUED and says so, rather than reporting
 * a send that did not happen.
 * ====================================================================== */

import type { Db } from "../db.ts";

/** A day, in whole days, from `from` to `to`. Negative once it has passed. */
export function daysBetween(from: Date, to: Date): number {
  const DAY = 86_400_000;
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / DAY);
}

/** One thing worth telling somebody about. */
export interface Subject {
  readonly id: string;
  readonly orgId: string;
  /** The date the reminder counts towards. */
  readonly on: Date;
  /** For the message. */
  readonly what: string;
  readonly toName: string;
  readonly toAddress: string;
  readonly partyId?: string | null;
}

export interface ReminderKind {
  readonly key: string;
  readonly subjectType: string;
  readonly title: string;
  readonly why: string;
  /**
   * Days BEFORE the date, largest first. A negative entry is days AFTER —
   * an overdue chase rather than a warning.
   */
  readonly milestones: readonly number[];
  /** Everything currently inside the widest milestone. */
  readonly find: (db: Db, now: Date) => Promise<Subject[]>;
  /** What the message says, given how many days are left (negative = late). */
  readonly says: (s: Subject, days: number) => { subject: string; body: string };
}

/** "60d" / "7d" / "due" / "30d-late" — the half of the key that stops repeats. */
export function milestoneName(days: number): string {
  if (days > 0) return `${days}d`;
  if (days === 0) return "due";
  return `${-days}d-late`;
}

/**
 * The milestone this record has reached, or null if it has reached none.
 *
 * Crossed, not matched — see the note at the top. The FIRST milestone whose
 * threshold has been passed is the one that fires, and because they are
 * ordered widest-first the earliest unfired warning is the one chosen.
 */
export function milestoneFor(
  milestones: readonly number[], daysLeft: number,
): number | null {
  /*
   * ONE LINE OF ARITHMETIC, AND IT IS THE SAME FOR BOTH DIRECTIONS.
   *
   * Milestones sit on a descending timeline: 60, 30, 7, 0, -1, -7, -30. As a
   * date approaches and then passes, daysLeft walks down it, crossing each in
   * turn. A milestone is "reached" once daysLeft has got to it or past it.
   *
   * The one in force is therefore the SMALLEST reached — the most recently
   * crossed. A lease seven days out has reached 60, 30 and 7, and 7 is the
   * thing to say; an invoice nine days late has reached -1 and -7, and -7 is.
   *
   * Picking by |m| instead reads as "the tightest" and is right for warnings
   * and exactly backwards for chases, which is how the first version of this
   * told somebody their invoice was one day late when it was nine.
   */
  const reached = milestones.filter((m) => daysLeft <= m);
  if (!reached.length) return null;
  return Math.min(...reached);
}

/* ---------------------------------------------------------- what we send */

/*
 * SIX DECLARATIONS, COVERING THE REMINDERS THE STANDARD NAMES THAT HAVE A
 * REAL DATE AND A REAL RECIPIENT BEHIND THEM TODAY.
 *
 * Each one is four answers: what to scan, when it fires, who to tell, what to
 * say. Nothing else about a reminder is a decision, which is why the seventh
 * will be a declaration rather than a job.
 *
 * Deliberately NOT declared yet: bank synchronisation (there is no bank feed
 * to synchronise), scheduled reports (nothing delivers a report on a
 * schedule), and owner statements (an owner statement is not built). A
 * declaration for any of those would be a reminder about something that does
 * not happen.
 */

const ONE = { take: 2_000 } as const;

export const REMINDERS: readonly ReminderKind[] = [
  {
    key: "invoice-due",
    subjectType: "invoice",
    title: "Payment reminders",
    why: "An invoice nobody chases is paid late, and the first chase people "
       + "answer is the one that arrives before the money is late.",
    milestones: [7, 3, 0],
    async find(db, now) {
      const rows = await db.invoice.findMany({
        where: {
          status: { in: ["SENT", "PART_PAID"] },
          dueOn: { not: null, gte: new Date(now.getTime() - 86_400_000) },
        },
        select: {
          id: true, orgId: true, ref: true, dueOn: true, partyId: true,
          party: { select: { id: true, name: true, email: true } },
        },
        ...ONE,
      });
      return rows
        .filter((r) => r.dueOn && r.party?.email)
        .map((r) => ({
          id: r.id, orgId: r.orgId, on: r.dueOn as Date,
          what: r.ref, toName: r.party?.name || "", toAddress: r.party?.email || "",
          partyId: r.partyId,
        }));
    },
    says: (s, d) => ({
      subject: `Invoice ${s.what} is due${d === 0 ? " today" : ` in ${d} days`}`,
      body: `Invoice ${s.what} falls due ${d === 0 ? "today" : `in ${d} days`}. `
          + `If it has already been paid, please ignore this.`,
    }),
  },

  {
    key: "invoice-late",
    subjectType: "invoice",
    title: "Overdue reminders",
    why: "Marking an invoice OVERDUE changes a column. It does not tell "
       + "anybody, and the person who owes the money is the one who needs to know.",
    /* Negative: days AFTER the due date. Three chases and then silence — a
       fourth is a collections decision, not an automation. */
    milestones: [-1, -7, -30],
    async find(db, now) {
      const rows = await db.invoice.findMany({
        where: { status: { in: ["SENT", "PART_PAID", "OVERDUE"] }, dueOn: { not: null, lt: now } },
        select: {
          id: true, orgId: true, ref: true, dueOn: true, partyId: true,
          party: { select: { id: true, name: true, email: true } },
        },
        ...ONE,
      });
      return rows
        .filter((r) => r.dueOn && r.party?.email)
        .map((r) => ({
          id: r.id, orgId: r.orgId, on: r.dueOn as Date,
          what: r.ref, toName: r.party?.name || "", toAddress: r.party?.email || "",
          partyId: r.partyId,
        }));
    },
    says: (s, d) => ({
      subject: `Invoice ${s.what} is ${-d} days late`,
      body: `Invoice ${s.what} passed its due date ${-d} days ago and is still `
          + `showing as unpaid. If it has been paid, please send the reference.`,
    }),
  },

  {
    key: "lease-expiry",
    subjectType: "lease",
    title: "Lease expiry",
    why: "A tenancy that ends without anybody noticing is an empty unit nobody "
       + "advertised. The month before it ends is the only free marketing window a "
       + "landlord gets.",
    milestones: [60, 30, 7],
    async find(db, now) {
      const rows = await db.lease.findMany({
        where: { status: { in: ["ACTIVE", "NOTICE"] }, endsOn: { not: null, gte: now } },
        select: {
          id: true, orgId: true, ref: true, unitRef: true, endsOn: true, tenantId: true,
          tenant: { select: { id: true, name: true, email: true } },
        },
        ...ONE,
      });
      return rows
        .filter((r) => r.endsOn && r.tenant?.email)
        .map((r) => ({
          id: r.id, orgId: r.orgId, on: r.endsOn as Date,
          what: r.unitRef || r.ref,
          toName: r.tenant?.name || "", toAddress: r.tenant?.email || "",
          partyId: r.tenantId,
        }));
    },
    says: (s, d) => ({
      subject: `Your tenancy at ${s.what} ends in ${d} days`,
      body: `The tenancy at ${s.what} is due to end in ${d} days. Please let us `
          + `know whether you intend to renew.`,
    }),
  },

  {
    key: "document-expiry",
    subjectType: "document",
    title: "Document expiry",
    why: "An insurance certificate or a licence that lapses is found out at "
       + "the worst possible moment, usually by somebody else.",
    milestones: [60, 30, 7, 0],
    async find(db, now) {
      const rows = await db.document.findMany({
        where: { expiresAt: { not: null, gte: new Date(now.getTime() - 86_400_000) } },
        select: {
          id: true, orgId: true, name: true, expiresAt: true, partyId: true,
          party: { select: { id: true, name: true, email: true } },
        },
        ...ONE,
      });
      return rows
        .filter((r) => r.expiresAt)
        .map((r) => ({
          id: r.id, orgId: r.orgId, on: r.expiresAt as Date,
          what: r.name,
          /* No address is not a reason to skip it. The reminder is still
             recorded and still shows in the company's own console — see
             sendReminder(), which writes an IN_APP dispatch instead. */
          toName: r.party?.name || "", toAddress: r.party?.email || "",
          partyId: r.partyId,
        }));
    },
    says: (s, d) => ({
      subject: d === 0 ? `${s.what} expires today` : `${s.what} expires in ${d} days`,
      body: `The document "${s.what}" ${d === 0 ? "expires today" : `expires in ${d} days`}. `
          + `Replacing it before it lapses avoids the gap.`,
    }),
  },

  {
    key: "task-due",
    subjectType: "task",
    title: "Task deadlines",
    why: "A task with a date nobody is reminded of is a task with no date.",
    milestones: [3, 0, -7],
    async find(db, now) {
      const rows = await db.task.findMany({
        where: { status: { notIn: ["DONE", "CANCELLED"] }, dueOn: { not: null } },
        select: { id: true, orgId: true, ref: true, title: true, dueOn: true, assigneeName: true },
        ...ONE,
      });
      void now;
      return rows
        .filter((r) => r.dueOn)
        .map((r) => ({
          id: r.id, orgId: r.orgId, on: r.dueOn as Date,
          what: r.title || r.ref, toName: r.assigneeName || "", toAddress: "",
          partyId: null,
        }));
    },
    says: (s, d) => ({
      subject: d < 0 ? `${s.what} is ${-d} days overdue` : `${s.what} is due${d === 0 ? " today" : ` in ${d} days`}`,
      body: `Task "${s.what}" ${d < 0 ? `was due ${-d} days ago` : d === 0 ? "is due today" : `is due in ${d} days`}.`,
    }),
  },

  {
    key: "asset-service",
    subjectType: "asset",
    title: "Maintenance reminders",
    why: "A lift or a generator has a service date. Missing it is how a "
       + "building finds out its plant is out of warranty.",
    milestones: [30, 7, 0],
    async find(db, now) {
      const rows = await db.asset.findMany({
        where: { nextServiceOn: { not: null, gte: new Date(now.getTime() - 86_400_000) } },
        select: { id: true, orgId: true, name: true, place: true, nextServiceOn: true },
        ...ONE,
      });
      return rows
        .filter((r) => r.nextServiceOn)
        .map((r) => ({
          id: r.id, orgId: r.orgId, on: r.nextServiceOn as Date,
          what: r.place ? `${r.name} (${r.place})` : r.name,
          toName: "", toAddress: "", partyId: null,
        }));
    },
    says: (s, d) => ({
      subject: d === 0 ? `${s.what} is due for service today` : `${s.what} is due for service in ${d} days`,
      body: `${s.what} ${d === 0 ? "is due for service today" : `is due for service in ${d} days`}. `
          + `Booking it before the date keeps the record clean.`,
    }),
  },
];

/* ------------------------------------------------------------- the sweep */

export interface ReminderRun {
  readonly scanned: number;
  readonly sent: number;
  readonly notes: readonly string[];
}

/**
 * Fire every reminder that has newly come due.
 *
 * Safe to call twice, at once, or after a half-finished run — the Reminder
 * row is inserted BEFORE the message is built, so the unique key is what
 * decides, not a check. A racing instance is refused by the database and
 * simply moves on.
 */
export async function runReminders(
  db: Db,
  { now, kinds = REMINDERS }: { now: Date; kinds?: readonly ReminderKind[] },
): Promise<ReminderRun> {
  const notes: string[] = [];
  let scanned = 0;
  let sent = 0;

  for (const kind of kinds) {
    let subjects: Subject[];
    try {
      subjects = await kind.find(db, now);
    } catch (e) {
      /* One reminder's query failing must not stop the other nine. */
      notes.push(`${kind.key}: could not scan — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    scanned += subjects.length;

    /*
     * WHAT HAS ALREADY FIRED, READ ONCE.
     *
     * The unique key is still the guarantee — two instances sweeping at the
     * same moment are separated by the database, not by this. But relying on
     * it ALONE means a refused insert per already-reminded record, and Prisma
     * logs every one: a company with four hundred live leases would print
     * four hundred errors a morning for working correctly. Nobody reads a log
     * like that, which is how the real error in it gets missed.
     *
     * So: read what is known, skip it quietly, and keep the constraint for
     * the race it actually exists for.
     */
    const already = new Set(
      (await db.reminder.findMany({
        where: { kind: kind.key, subjectId: { in: subjects.map((x) => x.id) } },
        select: { subjectId: true, milestone: true },
      })).map((r) => `${r.subjectId}:${r.milestone}`),
    );

    for (const s of subjects) {
      const daysLeft = daysBetween(now, s.on);
      const milestone = milestoneFor(kind.milestones, daysLeft);
      if (milestone === null) continue;

      const name = milestoneName(milestone);
      if (already.has(`${s.id}:${name}`)) continue;

      /*
       * CLAIM FIRST, THEN SPEAK.
       *
       * If the message were built first and the row written after, a crash in
       * between would send it again tomorrow. This way the worst case is a
       * reminder recorded that never went out — which the company can see and
       * act on, rather than one its customer receives twice.
       */
      let reminderId: string;
      try {
        const row = await db.reminder.create({
          data: {
            orgId: s.orgId, kind: kind.key,
            subjectType: kind.subjectType, subjectId: s.id,
            milestone: name,
          },
        });
        reminderId = row.id;
      } catch {
        /* Already fired for this record at this milestone. The only expected
           outcome here, and the whole reason the key exists. */
        continue;
      }

      const { subject, body } = kind.says(s, daysLeft);
      /* EMAIL where there is somewhere to send it, IN_APP where there is not.
         A reminder about a document has no customer to write to; it belongs
         in the company's own console, and IN_APP is exactly that. */
      const channel = s.toAddress ? "EMAIL" : "IN_APP";

      try {
        const { numberFor } = await import("../http/resource.ts");
        const { deliver } = await import("./messaging.ts");

        const dispatch = await db.dispatch.create({
          data: {
            orgId: s.orgId,
            ref: await numberFor("dispatches", s.orgId),
            channel, toName: s.toName, toAddress: s.toAddress,
            partyId: s.partyId || null,
            subject, body,
            status: "QUEUED",
          },
        });

        const out = await deliver(channel, { to: s.toAddress, subject, body });
        await db.dispatch.update({
          where: { id: dispatch.id },
          data: {
            status: out.outcome === "delivered" ? "DELIVERED"
                  : out.outcome === "accepted" ? "SUBMITTED"
                  /* refused is a provider saying no; unconfigured is there
                     being no provider. Only the first is a failure. */
                  : out.outcome === "refused" ? "FAILED" : "QUEUED",
            provider: out.provider || "",
            providerRef: out.providerRef || "",
            submittedAt: out.outcome === "accepted" ? now : undefined,
            deliveredAt: out.outcome === "delivered" ? now : undefined,
            failedAt: out.outcome === "refused" ? now : undefined,
            /* The provider's own sentence, kept — "no email provider is
               connected" is the answer somebody will need. */
            error: out.outcome === "refused" || out.outcome === "unconfigured"
              ? out.detail : "",
          },
        });
        await db.reminder.update({
          where: { id: reminderId }, data: { dispatchId: dispatch.id },
        });
        sent += 1;
      } catch (e) {
        /* The reminder stays recorded so it is not retried tomorrow, and the
           run says what went wrong. Silently retrying a send that throws is
           how a customer gets thirty copies. */
        notes.push(`${kind.key} ${s.id}: recorded but not sent — ${
          e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return { scanned, sent, notes };
}
