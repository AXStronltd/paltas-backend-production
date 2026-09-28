/* ======================================================================
 * THE SCHEDULER.
 *
 * ── WHAT WAS MISSING ───────────────────────────────────────────────────
 *
 * PALTAS had no scheduler of any kind. Nothing swept, nothing expired,
 * nothing recurred. Three things were blocked on it at once: rent had to be
 * invoiced by hand for every unit every month, nobody was ever reminded of
 * anything, and an invoice that passed its due date was never marked overdue —
 * which is why domain/receivables.ts has to age from `dueOn` rather than trust
 * the status column.
 *
 * ── THE ONE HARD QUESTION, AND ITS ANSWER ──────────────────────────────
 *
 * A scheduler's real problem is not running work. It is running it EXACTLY
 * ONCE across restarts, deploys and more than one instance. Charging a month's
 * rent twice is not a bug somebody shrugs at.
 *
 * So a run is CLAIMED before any work happens, by inserting a JobRun row whose
 * (job, periodKey) is unique in the database. Two processes racing both try to
 * insert; one is let through and the other is refused by the constraint. The
 * claim is the lock, it lives in Postgres, and it therefore survives every
 * failure an in-memory lock does not: a restart mid-run, a second web
 * instance, a deploy at 00:00 on the first of the month.
 *
 * The consequence worth stating plainly: TICKING OFTEN IS HARMLESS. A period
 * already claimed is skipped, so calling tick() every fifteen minutes, or by
 * hand, or twice at once, cannot do the work twice.
 *
 * ── WHAT A JOB MAY ASSUME ──────────────────────────────────────────────
 *
 * That it runs at most once per period, and that it may still be interrupted
 * half way. So a job must be written so that a SECOND attempt at a period it
 * partly finished is safe — the claim protects against concurrency, not
 * against a process dying, and those are different problems. Where that cannot
 * be guaranteed the job does its work in a transaction.
 *
 * ── ONE COMPANY MUST NOT STOP THE OTHERS ───────────────────────────────
 *
 * A run covers every organization. An organization whose work throws is
 * recorded in `detail` and the run carries on — one broken tenant must not
 * stop everybody else's rent. The run only FAILS if the job itself throws
 * outside any one company.
 * ====================================================================== */

import type { Db } from "../db.ts";
import { isPrismaError } from "../http/errors.ts";

/** How long a RUNNING claim is honoured before it is treated as abandoned. */
const STALE_AFTER_MS = 30 * 60_000;

export interface JobContext {
  readonly db: Db;
  readonly now: Date;
  readonly periodKey: string;
  /** Say what happened, one line per notable thing. Ends up in `detail`. */
  readonly note: (line: string) => void;
}

export interface JobResult {
  readonly scanned: number;
  readonly changed: number;
}

export interface Job {
  readonly key: string;
  /** What it is, for the staff console. */
  readonly title: string;
  /** Why it exists, so nobody deletes it wondering what it was for. */
  readonly why: string;
  /** The slice of time a single run covers. Same key twice = run once. */
  readonly period: (now: Date) => string;
  readonly run: (ctx: JobContext) => Promise<JobResult>;
}

/** A day, as the books would write it. */
export const daily = (now: Date) => now.toISOString().slice(0, 10);
/** A month. For anything that recurs monthly, when that arrives. */
export const monthly = (now: Date) => now.toISOString().slice(0, 7);

/* ---------------------------------------------------------------- jobs */

/*
 * INVOICE STATUS FOLLOWS THE DUE DATE.
 *
 * recomputeInvoice already decides an invoice's status from its total, what
 * has been paid and its due date — and it is the ONLY thing that may. This job
 * does not re-implement that rule; it finds the invoices whose answer has gone
 * stale purely because a date passed, and asks recomputeInvoice again.
 *
 * Writing a second status rule here is the obvious shortcut and the one that
 * would eventually disagree with the first.
 *
 * Receivables does not depend on this — it ages from `dueOn` precisely because
 * this sweep did not exist — so a missed run costs an out-of-date column on a
 * list screen, not a wrong arrears figure.
 */
const overdueSweep: Job = {
  key: "invoice-overdue",
  title: "Mark invoices overdue",
  why: "An invoice that passes its due date keeps saying SENT until something "
     + "recomputes it, so every list filtered by status under-reports arrears.",
  period: daily,
  async run({ db, now, note }) {
    const { recomputeInvoice } = await import("../routes/products.ts");

    const due = await db.invoice.findMany({
      where: {
        status: { in: ["SENT", "PART_PAID"] },
        dueOn: { lt: now, not: null },
      },
      select: { id: true, orgId: true },
      /* A bound, so one enormous tenant cannot make a run unbounded. What is
         left is picked up by the next day's run. */
      take: 5_000,
    });

    let changed = 0;
    const broken = new Map<string, string>();

    for (const inv of due) {
      try {
        const after = await recomputeInvoice(inv.id, inv.orgId);
        if (after && after.status === "OVERDUE") changed += 1;
      } catch (e) {
        /* One company's bad row must not stop the rest. Recorded once per
           company rather than once per invoice, or `detail` becomes a log. */
        if (!broken.has(inv.orgId)) {
          broken.set(inv.orgId, e instanceof Error ? e.message : String(e));
        }
      }
    }

    for (const [orgId, why] of broken) note(`company ${orgId}: ${why}`);
    if (due.length === 5_000) note("hit the 5,000 bound — the rest run tomorrow");

    return { scanned: due.length, changed };
  },
};

/** Everything the scheduler knows how to do. */
export const JOBS: readonly Job[] = [overdueSweep];

export function jobByKey(key: string): Job | null {
  return JOBS.find((j) => j.key === key) || null;
}

/* --------------------------------------------------------------- running */

export interface RunOutcome {
  readonly job: string;
  readonly periodKey: string;
  readonly ran: boolean;
  /** Why it did not run, when it did not. */
  readonly skipped: string | null;
  readonly scanned: number;
  readonly changed: number;
  readonly detail: string;
  readonly error: string | null;
}

/**
 * CLAIM A PERIOD, OR FIND SOMEBODY ALREADY HAS IT.
 *
 * Returns the claimed row's id, or null when this period is spoken for. The
 * insert IS the lock — see the header.
 */
async function claim(
  db: Db, job: string, periodKey: string, now: Date,
): Promise<string | null> {
  try {
    const row = await db.jobRun.create({
      data: { job, periodKey, startedAt: now, status: "RUNNING" },
      select: { id: true },
    });
    return row.id;
  } catch (e) {
    if (!isPrismaError(e) || e.code !== "P2002") throw e;
  }

  /*
   * SOMEBODY HAS IT. Usually that is the right answer and this run stops.
   *
   * The exception is a claim left RUNNING by a process that died — a deploy in
   * the middle of a run is the ordinary way that happens. Left alone it would
   * block this period for ever, so a stale claim is taken over. The window is
   * long enough that a slow run is never mistaken for a dead one.
   */
  const held = await db.jobRun.findUnique({
    where: { job_periodKey: { job, periodKey } },
    select: { id: true, status: true, startedAt: true },
  });
  if (!held) return null;                       /* raced and then deleted */
  if (held.status !== "RUNNING") return null;   /* finished: nothing to do */
  if (now.getTime() - held.startedAt.getTime() < STALE_AFTER_MS) return null;

  /*
   * Taking over is itself a race, so it is a conditional update: only the
   * process that still sees the OLD startedAt wins. A plain update would let
   * two takers both proceed.
   */
  const taken = await db.jobRun.updateMany({
    where: { id: held.id, status: "RUNNING", startedAt: held.startedAt },
    data: { startedAt: now, error: "" },
  });
  return taken.count === 1 ? held.id : null;
}

/** Run one job for the period it is in, if nobody else has. */
export async function runJob(
  db: Db, job: Job, now: Date = new Date(),
): Promise<RunOutcome> {
  const periodKey = job.period(now);
  const nothing = {
    job: job.key, periodKey, scanned: 0, changed: 0, detail: "", error: null,
  };

  const id = await claim(db, job.key, periodKey, now);
  if (!id) return { ...nothing, ran: false, skipped: "already done for this period" };

  const notes: string[] = [];
  try {
    const out = await job.run({
      db, now, periodKey, note: (line) => { notes.push(line); },
    });
    const detail = notes.join(" · ").slice(0, 2000);
    await db.jobRun.update({
      where: { id },
      data: {
        status: "SUCCEEDED", finishedAt: new Date(),
        scanned: out.scanned, changed: out.changed, detail,
      },
    });
    return { job: job.key, periodKey, ran: true, skipped: null,
             scanned: out.scanned, changed: out.changed, detail, error: null };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    /*
     * A FAILED run keeps its claim rather than releasing it. Retrying a broken
     * job every fifteen minutes turns one fault into a stampede, and the row
     * is the record of what went wrong. A person clears it, or tomorrow's
     * period comes round.
     */
    await db.jobRun.update({
      where: { id },
      data: { status: "FAILED", finishedAt: new Date(), error,
              detail: notes.join(" · ").slice(0, 2000) },
    });
    return { job: job.key, periodKey, ran: true, skipped: null,
             scanned: 0, changed: 0, detail: notes.join(" · "), error };
  }
}

/**
 * ONE PASS OVER EVERY JOB.
 *
 * Never throws. A scheduler that can take the process down with it is worse
 * than no scheduler, because it takes the website with it too.
 */
export async function tick(db: Db, now: Date = new Date()): Promise<RunOutcome[]> {
  const out: RunOutcome[] = [];
  for (const job of JOBS) {
    try {
      out.push(await runJob(db, job, now));
    } catch (e) {
      out.push({
        job: job.key, periodKey: job.period(now), ran: false,
        skipped: "could not be started", scanned: 0, changed: 0, detail: "",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}
