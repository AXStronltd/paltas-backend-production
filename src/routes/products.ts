/* ====================================================================== *
 * THE SIX PRODUCTS, MOUNTED.
 *
 * Most of what a console does is list, read, create, correct and remove
 * rows that belong to one company, and http/resource.js builds those five
 * endpoints from a declaration with the organization filter, the permission
 * check and the audit entry already in it. So most of this file is a list of
 * paths.
 *
 * What is NOT generic is written out below it, and there are only four
 * kinds of thing:
 *
 *   - MONEY THAT MUST BE COMPUTED BY THE SERVER. An invoice total is the
 *     sum of its lines and a paid figure is the sum of its payments. Both
 *     are recomputed here on every change, and neither can be sent.
 *   - MONEY THAT MUST NOT BE DELETED. A payment is voided, with a reason,
 *     and the row stays.
 *   - A ROW THAT BELONGS TO ANOTHER ROW. A folio belongs to a reservation,
 *     an invoice line to an invoice.
 *   - WORK THAT IS A DECISION. Admitting a visitor, closing an incident.
 *
 * Everything else is a resource, and a resource that needed a special case
 * would be a resource whose declaration is wrong.
 * ====================================================================== */

import { Router } from "express";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Request } from "express";

import type { Act, Area } from "../domain/access.ts";
import type { ModelKey } from "../domain/registry-types.ts";
import type { Actor } from "../http/request.ts";
import { actorOf as sharedActorOf, param } from "../http/request.ts";import type { Row } from "../db.ts";

import { db, delegate } from "../db.ts";
import { RESOURCES } from "../domain/registry.ts";
import { currencyFor } from "../domain/currency.ts";
import { numberFor, resourceRouter } from "../http/resource.ts";
import { BASIS_WORDS, requireReceiptable, whyNotReceiptable } from "../domain/receipts.ts";
import {
  owedOn, refundableOn, requireCreditable, requireRefundable,
  whyNotCreditable, whyNotRefundable,
} from "../domain/credits.ts";
import { postForCreditNote, postForDeposit, postForRefund } from "../domain/posting.ts";
import {
  deductedOn, heldOn, receivedOn, requireDeductible, requireReceivable,
  requireReturnable, returnedOn, statusFor, whyNotAReason,
} from "../domain/deposits.ts";
import { clean } from "../domain/input.ts";
import { allows, whyNotArea } from "../domain/access.ts";
import { scopedTo } from "../domain/scope.ts";
import { badRequest, conflict, forbidden, hidden, isPrismaError, messageOf } from "../http/errors.ts";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.ts";
import { sync as syncChannel, status as channelStatus } from "../domain/channels.ts";
import { postForPayment, reverseFor } from "../domain/posting.ts";
import { rateFor } from "../domain/tax.ts";
import {
  presignUpload, presignDownload, head as storageHead,
  publicDescribe as storagePublicDescribe,
} from "../domain/storage.ts";

export const productRoutes = Router();

/* ====================================================================== *
 * 1. THE TWENTY-EIGHT.
 * ====================================================================== */

for (const slug of Object.keys(RESOURCES)) {
  productRoutes.use(`/${slug}`, resourceRouter(slug));
}

/* ====================================================================== *
 * 2. THE REST OF THIS FILE NEEDS THE SAME THREE GUARDS.
 * ====================================================================== */

const guarded = Router();
guarded.use(requireSession(), requireOrganization(), requireOpenSubscription());
productRoutes.use(guarded);

/*
 * The caller comes from http/request.ts. Everything below is mounted behind
 * `guarded` — requireSession() + requireOrganization() +
 * requireOpenSubscription() — which is the invariant actorOf() checks.
 */
const actorOf = (req: Request): Actor => sharedActorOf(req, "a product route");

/**
 * `_count._all` off a groupBy result.
 *
 * Prisma types `_count` as the union of `true` and a per-column record,
 * because the shape depends on what was asked for. This reads the one that
 * `_count: { _all: true }` produces, and answers 0 for anything else rather
 * than asserting.
 */
function countOf(group: { _count?: unknown } | undefined): number {
  const c = group?._count;
  if (typeof c !== "object" || c === null) return 0;
  const all = (c as Record<string, unknown>)["_all"];
  return typeof all === "number" ? all : 0;
}

/**
 * A membership's remit, as a directory may show it.
 *
 * `sites` is a list of ids and the count is what is shown, because a
 * directory listing every gate each guard covers is a map of the company's
 * weak points.
 */
function scopeSummary(scope: unknown): { all: true } | { sites: number } {
  if (typeof scope !== "object" || scope === null) return { sites: 0 };
  const bag = scope as Record<string, unknown>;
  if (bag["all"] === true) return { all: true };
  const sites = bag["sites"];
  return { sites: Array.isArray(sites) ? sites.length : 0 };
}

/** Role, for the endpoints below, which are not built by the framework. */
function need(req: Request, area: Area, act: Act, label?: string): void {
  const why = whyNotArea(actorOf(req), area, act, label);
  if (why) throw forbidden(why);
}

/**
 * The row type a model's own findFirst yields, without the null.
 *
 * Recovered from the Prisma client rather than written out, so every column
 * and every type comes from the schema.
 */
type RowOf<M extends ModelKey> =
  NonNullable<Awaited<ReturnType<PrismaClient[M]["findFirst"]>>>;

/**
 * A row of this company's, or nothing that admits the row exists.
 *
 * GENERIC OVER THE MODEL, so a caller gets the real columns back.
 * `delegate()` gives up Prisma's argument types — it has to, being generic
 * over 132 models — but the call sites here are not generic: each one names
 * its model as a literal. So the row type is recovered from that literal,
 * and `invoice.total` is a bigint again rather than an unknown.
 *
 * `Extra` is for the callers that pass an `include`. A relation changes the
 * shape and there is no way to derive that from a runtime object, so a caller
 * that joins says what it joined: `own<"invoice", { lines: InvoiceLine[] }>`.
 * Naming it is better than widening every row to allow anything.
 */
async function own<M extends ModelKey, Extra = unknown>(
  model: M,
  id: string,
  orgId: string,
  extra?: Record<string, unknown>,
): Promise<RowOf<M> & Extra> {
  const row = await delegate(model).findFirst({ where: { id, orgId }, ...(extra || {}) });
  if (!row) throw hidden();
  return row as RowOf<M> & Extra;
}

async function audit(
  req: Request,
  action: string,
  entity: string,
  entityId: string,
  detail?: unknown,
): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        orgId: actorOf(req).orgId,
        actorId: actorOf(req).userId,
        actorName: req.view?.user?.name || req.view?.user?.email || "",
        action, entity, entityId, detail: detail || undefined, ip: req.ip || "",
      },
    });
  } catch (e) { console.error("audit write failed", action, entity, messageOf(e)); }
}

/* ====================================================================== *
 * 3. INVOICES — WHERE THE TOTAL COMES FROM.
 *
 * `total` and `paid` are columns, but they are never written by a request.
 * They are recomputed from the lines and the payments every time either
 * changes. A client that can name its own total can name zero, and the
 * customer's own books would then disagree with their bank.
 * ====================================================================== */

/* ====================================================================== *
 * MONEY ARITHMETIC, NOW IN BigInt.
 *
 * Amounts are BigInt since prisma/migrations/…_money_bigint — INT4 could not
 * hold a Nairobi valuation. That changes arithmetic everywhere money is
 * touched, because JavaScript REFUSES to mix the two:
 *
 *     1n + 1        TypeError: Cannot mix BigInt and other types
 *
 * Which is the right behaviour and the reason this is safe to do: there is no
 * silent coercion to find later in a total that is out by a rounding step.
 * Every site below was found by that error.
 * ====================================================================== */

/** A BigInt from whatever the database or a request body supplied. */
const big = (v: unknown): bigint =>
  typeof v === "bigint" ? v : BigInt(Math.round(Number(v) || 0));

/**
 * Tax, in basis points, rounded the way the Number version rounded.
 *
 * BigInt division TRUNCATES toward zero; `Math.round` did not. On a 16% line
 * that is a one-minor-unit difference per line, which is exactly the kind of
 * discrepancy that makes a customer's books disagree with their invoice by a
 * few cents and nobody can say why. So the half is added back explicitly,
 * with the sign handled rather than assumed.
 */
function taxOn(net: bigint, bps: unknown): bigint {
  const x = net * big(bps);
  const half = 5000n;
  return x >= 0n ? (x + half) / 10000n : -((-x + half) / 10000n);
}

/** Absolute value, for a figure that may legitimately be negative. */
const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/**
 * Money going into an audit `detail`, which is a Json column.
 *
 * Prisma cannot serialise a BigInt into Json, and an audit write is
 * best-effort — so a BigInt left in here would turn "record what happened"
 * into a silent catch. Numbers are exact to 9e15 minor units, which every
 * real figure is far below, and the audit trail is a record rather than a
 * ledger the books are reconciled from.
 */
const auditable = (v: unknown): unknown => (typeof v === "bigint" ? Number(v) : v);

/**
 * What the caller is told about the books.
 *
 * Deliberately small and always present: `booked` is the reference if there
 * is one, and `why` is the sentence if there is not. A console that shows
 * "recorded, not booked — no chart of accounts" is telling the truth; one
 * that shows nothing leaves somebody to discover the gap at year end.
 */
interface PostingOutcome {
  readonly posted?: { readonly ref?: string | null } | null;
  readonly skipped?: string | null;
}

const bookingOf = (b: PostingOutcome | null | undefined): {
  booked: string | null;
  why: string | null;
} => (b
  ? { booked: b.posted?.ref ?? null, why: b.skipped ?? null }
  : { booked: null, why: null });

/**
 * Sum the lines, sum the payments, work out the status, write all three.
 *
 * Integer arithmetic throughout — minor units. Tax is basis points, so
 * 16% is 1600 and the division by 10,000 happens once, at the end, on a
 * number that is already an integer count of cents.
 */
export async function recomputeInvoice(invoiceId: string, orgId: string) {
  /*
   * IT TAKES THE COMPANY TOO, AND THAT IS NOT BELT AND BRACES.
   *
   * Every caller here has already loaded the invoice through own(), so the
   * id is this company's. But this function also WRITES — it is the only
   * thing that sets a total — and it is exported, so the next caller may
   * not have done that checking. A function that rewrites an invoice total
   * given nothing but an id is one mistaken call away from rewriting
   * somebody else's, so it refuses to work without knowing whose.
   */
  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, orgId },
    include: { lines: true, payments: true, creditNotes: true },
  });
  if (!invoice) return null;

  let total = 0n;
  for (const l of invoice.lines) {
    const net = big(l.unitPrice) * big(l.quantity);
    total += net + taxOn(net, l.taxBps);
  }

  /* A voided payment has not been received. A REFUND is a negative payment —
     the schema says so on the column — so it reduces this by arriving, which
     is exactly right: the money went back, and the invoice is owed again. */
  const paid = invoice.payments
    .filter((p) => !p.voided)
    .reduce((sum, p) => sum + big(p.amount), 0n);

  /*
   * WAIVED, NOT COLLECTED. Kept in its own column for the whole reason
   * CreditNote exists: adding it to `paid` would report cash that never
   * arrived, and every collections figure downstream reads `paid`.
   */
  const credited = invoice.creditNotes
    .filter((c) => !c.voided)
    .reduce((sum, c) => sum + big(c.amount), 0n);

  /*
   * STATUS FOLLOWS THE MONEY, except where a person has decided otherwise.
   * DRAFT and VOID are decisions — an unsent invoice does not become
   * OVERDUE because a date passed, and a cancelled one does not come back
   * to life because somebody paid against it by mistake.
   */
  let status = invoice.status;
  if (status !== "DRAFT" && status !== "VOID") {
    /* Settled is settled, however it was settled — money in or written off.
       An invoice credited in full is not still SENT, and chasing it would be
       chasing somebody for a bill the company itself withdrew. */
    if (paid + credited >= total && total > 0n) status = "PAID";
    else if (paid > 0n || credited > 0n) status = "PART_PAID";
    else if (invoice.dueOn && invoice.dueOn < new Date()) status = "OVERDUE";
    else status = "SENT";
  }

  await db.invoice.updateMany({
    where: { id: invoice.id, orgId },
    data: { total, paid, credited, status },
  });
  return db.invoice.findFirst({
    where: { id: invoice.id, orgId },
    include: { lines: true, party: { select: { id: true, name: true, email: true } } },
  });
}

guarded.post("/invoices/:id/lines", async (req, res, next) => {
  try {
    need(req, "finance", "create", "invoices");
    const invoice = await own("invoice", param(req, "id"), actorOf(req).orgId);
    if (invoice.status === "VOID") throw conflict("That invoice is void. Raise a new one.");
    if (invoice.status === "PAID") {
      throw conflict("That invoice is paid. Adding to it would change what somebody has already settled.");
    }

    const detail = String(req.body?.detail || "").trim();
    if (!detail) throw badRequest("detail is required.");

    const quantity = Math.max(1, Math.round(Number(req.body?.quantity) || 1));
    const unitPrice = Math.round(Number(req.body?.unitPrice) || 0);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw badRequest("unitPrice must be a whole number of minor units, and not negative.");
    }

    /*
     * THE RATE COMES FROM THE RULE TABLE WHEN A CODE IS GIVEN.
     *
     * `taxBps` stays accepted, because every existing caller sends it and
     * breaking them has no business being part of adding a feature. But a raw
     * rate is a number with no provenance: nothing says who decided it or when
     * it started applying. Sending `taxCode` instead resolves it from
     * domain/tax.ts.
     *
     * RESOLVED AGAINST THE INVOICE'S OWN DATE, never today's. An invoice dated
     * in March is taxed at March's rate however late somebody types the line,
     * which is the whole reason the rule table carries dates.
     *
     * The resolved figure is still written to taxBps: this decides it, the
     * line records it. So a rule added next year cannot restate an invoice
     * that was settled last year.
     */
    const taxCode = String(req.body?.taxCode || "").trim();
    let taxBps = Math.max(0, Math.min(10000, Math.round(Number(req.body?.taxBps) || 0)));
    let taxFrom: string | null = null;
    if (taxCode) {
      const org = await db.organization.findFirst({
        where: { id: actorOf(req).orgId }, select: { country: true },
      });
      const answer = await rateFor(db, {
        orgId: actorOf(req).orgId,
        country: (org?.country || "ke").toUpperCase(),
        taxCode,
        on: invoice.issuedOn || invoice.createdAt,
      });
      taxBps = answer.rateBp;
      taxFrom = answer.ruleId;
    }

    await db.invoiceLine.create({
      data: { invoiceId: invoice.id, detail, quantity, unitPrice, taxBps },
    });
    const updated = await recomputeInvoice(invoice.id, actorOf(req).orgId);
    await audit(req, "invoice.line.add", "invoice", invoice.id,
      { detail, quantity, unitPrice, taxBps, ...(taxFrom ? { taxRuleId: taxFrom } : {}) });

    res.status(201).json({ invoice: updated });
  } catch (e) { next(e); }
});

guarded.delete("/invoices/:id/lines/:lineId", async (req, res, next) => {
  try {
    need(req, "finance", "update", "invoices");
    const invoice = await own("invoice", param(req, "id"), actorOf(req).orgId);
    if (invoice.status === "PAID" || invoice.status === "VOID") {
      throw conflict(`That invoice is ${invoice.status.toLowerCase()}; its lines are settled.`);
    }
    const { count } = await db.invoiceLine.deleteMany({
      where: { id: param(req, "lineId"), invoiceId: invoice.id },
    });
    if (!count) throw hidden();

    const updated = await recomputeInvoice(invoice.id, actorOf(req).orgId);
    await audit(req, "invoice.line.remove", "invoice", invoice.id, { lineId: param(req, "lineId") });
    res.json({ invoice: updated });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 4. PAYMENTS — RECEIVED, AND NEVER UNRECEIVED.
 * ====================================================================== */

guarded.post("/payments", async (req, res, next) => {
  try {
    need(req, "finance", "create", "payments");
    /* `payments` is declared in the registry — registry.ts is the file this
       one is mounted beside — and clean() needs the declaration, not a
       maybe-declaration. */
    const declared = RESOURCES["payments"];
    if (!declared) throw new Error("the registry no longer declares `payments`");
    const data = clean(declared, req.body, { partial: false });

    if (!Number.isFinite(data.amount) || data.amount === 0) {
      throw badRequest("amount must be a whole number of minor units, and not zero.");
    }

    let invoice = null;
    if (data["invoiceId"]) {
      invoice = await own("invoice", String(data["invoiceId"]), actorOf(req).orgId);
      if (invoice.status === "VOID") throw conflict("That invoice is void.");
      /* Currency is taken FROM THE INVOICE when one is named. Two numbers in
         two currencies added together is a wrong total that looks right. */
      data["currency"] = invoice.currency;
    }

    /*
     * A PAYMENT WITH NO INVOICE IS STILL IN SOMETHING.
     *
     * The invoice is the best answer and is taken above. Without one the
     * column default applied — 'KES', in every country — so a Swedish
     * company's cash receipt was recorded in the wrong currency and then
     * would not post against SEK books. Resolved from the company, or left
     * to the caller when even that is unknown.
     */
    if (!data["currency"]) {
      const resolved = await currencyFor(db, actorOf(req).orgId, data);
      if (resolved) data["currency"] = resolved;
    }

    let payment;
    try {
      /*
       * clean() returns columns it has already checked against the
       * declaration, which is a stronger guarantee than the shape of this
       * object can express — it knows the FIELD NAMES are writable and their
       * kinds are right, and Prisma's create type knows the columns. The two
       * agree by construction; registry.test.js is what proves it.
       */
      payment = await db.payment.create({
        data: { ...data, orgId: actorOf(req).orgId } as Prisma.PaymentUncheckedCreateInput,
      });
    } catch (e) {
      /*
       * @@unique([orgId, method, reference]) — the same M-Pesa code cannot
       * be banked twice. This is the constraint that catches a double-submit
       * on a phone with a bad signal, which is the ordinary way it happens.
       */
      if (isPrismaError(e) && e.code === "P2002") {
        throw conflict(
          `A ${String(data.method || "").toLowerCase()} payment with reference ` +
          `“${data.reference}” is already recorded. It has not been taken twice.`);
      }
      throw e;
    }

    const updated = invoice ? await recomputeInvoice(invoice.id, actorOf(req).orgId) : null;
    await audit(req, "payment.receive", "payment", payment.id,
      { amount: auditable(payment.amount), currency: payment.currency, method: payment.method });

    /*
     * AND BOOK IT — after the payment is recorded, never before, and never in
     * a way that can undo it.
     *
     * postForPayment does not throw: a company with no chart of accounts, a
     * closed period or a withdrawn account all come back as a stated reason.
     * Refusing money that has already arrived because the books are not set
     * up would be the worse failure by a long way.
     *
     * The reason is not swallowed. It goes back in the response and into the
     * audit log, so a gap between the payments list and the ledger is always
     * visible and always explained.
     */
    const booking = await postForPayment(db, {
      orgId: actorOf(req).orgId, payment, invoice, userId: actorOf(req).userId,
    });
    if (booking.skipped) {
      await audit(req, "payment.not_booked", "payment", payment.id, { why: booking.skipped });
    }

    res.status(201).json({ payment, invoice: updated, booking: bookingOf(booking) });
  } catch (e) { next(e); }
});

guarded.post("/payments/:id/void", async (req, res, next) => {
  try {
    /*
     * VOIDING IS A MANAGE-LEVEL ACT, because it is as close to deleting
     * money as this service allows. The row stays, the reason is required,
     * and both are permanent.
     */
    need(req, "finance", "delete", "payments");

    const why = String(req.body?.reason || "").trim();
    if (why.length < 5) {
      throw badRequest(
        "A void needs a reason. Whoever reads the books in six months will have " +
        "only this sentence to go on.");
    }

    const payment = await own("payment", param(req, "id"), actorOf(req).orgId);
    if (payment.voided) throw conflict("That payment is already void.");

    await db.payment.update({
      where: { id: payment.id },
      data: { voided: true, voidReason: why, voidedAt: new Date() },
    });

    const invoice = payment.invoiceId ? await recomputeInvoice(payment.invoiceId, actorOf(req).orgId) : null;
    await audit(req, "payment.void", "payment", payment.id,
      { reason: why, amount: auditable(payment.amount) });

    /* The books are corrected by a mirror entry, not by deleting the first
       one — so the payment, the void and the reason all stay readable. */
    const booking = await reverseFor(db, {
      orgId: actorOf(req).orgId, sourceType: "payment", sourceId: payment.id,
      reason: why, userId: actorOf(req).userId,
    });
    if (booking.skipped) {
      await audit(req, "payment.void_not_booked", "payment", payment.id, { why: booking.skipped });
    }

    res.json({
      payment: await db.payment.findUnique({ where: { id: payment.id } }),
      invoice,
      booking: bookingOf(booking),
    });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 5. FOLIOS — a hotel bill, which belongs to a stay.
 * ====================================================================== */

guarded.get("/reservations/:id/folio", async (req, res, next) => {
  try {
    need(req, "hotel", "get", "folios");
    const reservation = await own("reservation", param(req, "id"), actorOf(req).orgId);

    let folio = await db.folio.findFirst({
      where: { reservationId: reservation.id, orgId: actorOf(req).orgId },
      include: { lines: { orderBy: { at: "asc" } } },
    });

    /* Opened on first look rather than at check-in, so that a folio always
       exists when somebody goes to charge something to it. */
    if (!folio) {
      folio = await db.folio.create({
        data: {
          orgId: actorOf(req).orgId,
          reservationId: reservation.id,
          currency: reservation.currency,
        },
        include: { lines: true },
      });
    }

    const balance = folio.lines.reduce((sum, l) => sum + big(l.amount), 0n);
    res.json({ folio, balance, currency: folio.currency });
  } catch (e) { next(e); }
});

guarded.post("/reservations/:id/folio/lines", async (req, res, next) => {
  try {
    need(req, "hotel", "create", "folios");
    const reservation = await own("reservation", param(req, "id"), actorOf(req).orgId);
    const folio = await db.folio.findFirst({
      where: { reservationId: reservation.id, orgId: actorOf(req).orgId },
    });
    if (!folio) throw badRequest("That stay has no folio open yet. Read it once to open one.");
    if (folio.closed) throw conflict("That folio is closed. A closed bill is a settled bill.");

    const detail = String(req.body?.detail || "").trim();
    if (!detail) throw badRequest("detail is required.");
    const amount = Math.round(Number(req.body?.amount));
    if (!Number.isFinite(amount)) throw badRequest("amount must be a whole number of minor units.");

    /* NEGATIVE IS ALLOWED HERE, and only here: a payment or a refund on a
       folio is a line with the sign reversed, which is how a hotel bill has
       always worked. */
    const line = await db.folioLine.create({
      data: {
        folioId: folio.id,
        kind: String(req.body?.kind || "charge").trim().toLowerCase(),
        detail, amount,
        postedBy: req.view?.user?.name || req.view?.user?.email || "",
      },
    });

    await audit(req, "folio.post", "folio", folio.id, { detail, amount });
    res.status(201).json({ line });
  } catch (e) { next(e); }
});

guarded.post("/reservations/:id/folio/close", async (req, res, next) => {
  try {
    need(req, "hotel", "update", "folios");
    const reservation = await own("reservation", param(req, "id"), actorOf(req).orgId);
    const folio = await db.folio.findFirst({
      where: { reservationId: reservation.id, orgId: actorOf(req).orgId },
      include: { lines: true },
    });
    if (!folio) throw hidden();
    if (folio.closed) throw conflict("That folio is already closed.");

    const balance = folio.lines.reduce((sum, l) => sum + big(l.amount), 0n);
    if (balance !== 0n && !req.body?.force) {
      throw conflict(
        `That bill does not balance — ${balance > 0n ? "outstanding" : "overpaid by"} ` +
        `${abs(balance)} ${folio.currency} in minor units. Post the payment first, ` +
        `or send force: true to close it anyway and leave the difference on the record.`);
    }

    await db.folio.update({
      where: { id: folio.id },
      data: { closed: true, closedAt: new Date() },
    });
    await audit(req, "folio.close", "folio", folio.id, { balance: auditable(balance) });
    res.json({ closed: folio.id, balance });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 6. THE GATE — admitting somebody is a decision, not an edit.
 * ====================================================================== */

guarded.post("/visits/:id/decide", async (req, res, next) => {
  try {
    need(req, "security", "update", "visits");

    const decision = String(req.body?.decision || "").trim().toUpperCase();
    if (decision !== "APPROVED" && decision !== "REFUSED") {
      throw badRequest('decision must be "approved" or "refused".');
    }
    const why = String(req.body?.reason || "").trim();
    if (decision === "REFUSED" && why.length < 3) {
      throw badRequest("Refusing somebody entry needs a reason on the record.");
    }

    const visit = await own("visit", param(req, "id"), actorOf(req).orgId);
    if (visit.status !== "WAITING") {
      throw conflict(`That visit is already ${visit.status.toLowerCase()}.`);
    }

    const row = await db.visit.update({
      where: { id: visit.id },
      data: {
        status: decision,
        decidedBy: req.view?.user?.name || req.view?.user?.email || "",
        decidedWhy: why,
        admittedAt: decision === "APPROVED" ? new Date() : null,
      },
    });

    await audit(req, "visit." + decision.toLowerCase(), "visit", visit.id,
      { visitor: visit.visitor, reason: why });
    res.json({ visit: row });
  } catch (e) { next(e); }
});

guarded.post("/visits/:id/leave", async (req, res, next) => {
  try {
    need(req, "security", "update", "visits");
    const visit = await own("visit", param(req, "id"), actorOf(req).orgId);
    if (visit.leftAt) throw conflict("That visitor is already signed out.");

    const row = await db.visit.update({
      where: { id: visit.id },
      data: { status: "LEFT", leftAt: new Date() },
    });
    await audit(req, "visit.leave", "visit", visit.id, null);
    res.json({ visit: row });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 6b. TWO LISTS THE FRAMEWORK CANNOT BUILD.
 *
 * Every other list in this file comes from registry.js, which needs a model
 * with an `orgId` of its own. These two do not have one:
 *
 *   Membership  belongs to an organization AND a user, and the generic
 *               framework would happily let somebody PATCH a role — which is
 *               how a member promotes themselves. Read-only, here, on purpose.
 *   FolioLine   belongs to a Folio, which belongs to a Reservation, which
 *               belongs to an organization. The company is two joins away.
 *
 * Both already had a screen waiting for them: the staff directory and the
 * hotel's charge list were drawing invented rows — a fabricated colleague
 * with a role, a fabricated charge against a room.
 * ====================================================================== */

/* The company's own people. Read-only: roles are changed through the
   membership flow, not by PATCHing a directory. */
guarded.get("/members", async (req, res, next) => {
  try {
    need(req, "people", "list", "people");
    const rows = await db.membership.findMany({
      where: { orgId: actorOf(req).orgId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    res.json({
      members: rows.map((m) => ({
        id: m.id,
        userId: m.userId,
        name: m.user.name || m.user.email,
        email: m.user.email,
        role: m.role,
        /* The remit, as stored. `sites` is a list of ids; the console shows
           how MANY, because a directory listing every gate each guard covers
           is a map of the company's weak points. */
        /* A Json column, so narrowed rather than read through. See
           domain/scope.ts, which does the same for the same reason. */
        scope: scopeSummary(m.scope),
        since: m.createdAt,
      })),
    });
  } catch (e) { next(e); }
});

/* Every charge and payment posted to a folio, across the property. */
guarded.get("/folio-lines", async (req, res, next) => {
  try {
    need(req, "hotel", "list", "folio lines");
    if (!actorOf(req).products.includes("HOTEL_MANAGEMENT")) {
      throw forbidden("This company has no hotel management, so it has no folios.");
    }
    const take = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const rows = await db.folioLine.findMany({
      /* FolioLine carries no orgId. It is scoped through its folio, which
         does — the same way every event table in this schema is scoped. */
      where: { folio: { orgId: actorOf(req).orgId } },
      include: {
        folio: {
          select: {
            currency: true, closed: true,
            reservation: { select: { ref: true, roomNumber: true, guestName: true } },
          },
        },
      },
      orderBy: { at: "desc" },
      take,
    });
    res.json({
      "folio-lines": rows.map((l) => ({
        id: l.id, kind: l.kind, detail: l.detail, amount: l.amount, at: l.at,
        currency: l.folio.currency,
        closed: l.folio.closed,
        ref: l.folio.reservation ? l.folio.reservation.ref : "",
        roomNumber: l.folio.reservation ? l.folio.reservation.roomNumber : "",
        guestName: l.folio.reservation ? l.folio.reservation.guestName : "",
        /* postedBy is deliberately absent — see the note in guest.js. Who
           keyed a charge is staff information, not a line on a report. */
      })),
    });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 7. WHAT A CONSOLE OPENS ON.
 *
 * One request rather than nine. A front desk loading nine separate lists to
 * draw one screen is nine round trips on a hotel's wifi, and the screen
 * assembles itself visibly.
 * ====================================================================== */

guarded.get("/summary", async (req, res, next) => {
  try {
    const orgId = actorOf(req).orgId;
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    /*
     * Every count is scoped, and each is skipped entirely when the role
     * cannot see that area — a guard's summary must not carry the number of
     * unpaid invoices, because that number is itself information.
     *
     * AND SCOPED AGAIN BY SITE, where the model carries one.
     *
     * Without this a site manager reads "2 sites" on the tile above a list
     * showing one, and the number they cannot reconcile is the number they
     * stop trusting. A count is information too: "14 open incidents" across
     * a company tells somebody restricted to one gate how busy the others
     * are. `at(model)` returns nothing when the model has no site, which is
     * the same honest limit the lists have — see src/domain/scope.js.
     */
    const at = (model: string): Record<string, unknown> =>
      scopedTo(actorOf(req), model) ?? {};
    const may = (area: Area): boolean => allows(actorOf(req), area, "list");
    const has = (product: string): boolean => actorOf(req).products.includes(product);

    /* Built up conditionally — a tile nobody may see is a query nobody runs,
       not a zero. The keys are whatever this role is allowed to count. */
    const jobs: Record<string, Promise<number>> = {};
    if (may("property") && has("PROPERTY_MANAGEMENT")) {
      jobs["units"] = db.unit.count({ where: { orgId, ...at("unit") } });
      jobs["vacantUnits"] = db.unit.count({ where: { orgId, ...at("unit"), status: "VACANT" } });
      jobs["activeLeases"] = db.lease.count({ where: { orgId, status: "ACTIVE" } });
    }
    if (may("maintenance")) {
      jobs["openWorkOrders"] = db.workOrder.count({
        where: { orgId, ...at("workOrder"),
                 status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS", "BLOCKED"] } },
      });
      jobs["urgentWorkOrders"] = db.workOrder.count({
        where: { orgId, ...at("workOrder"),
                 priority: "URGENT", status: { notIn: ["DONE", "CANCELLED"] } },
      });
    }
    if (may("hotel") && has("HOTEL_MANAGEMENT")) {
      jobs["arrivalsToday"] = db.reservation.count({
        where: { orgId, arriveOn: { gte: startOfDay }, status: { in: ["CONFIRMED", "PENDING"] } },
      });
      jobs["inHouse"] = db.reservation.count({ where: { orgId, status: "CHECKED_IN" } });
      jobs["roomsToClean"] = db.room.count({ where: { orgId, ...at("room"), housekeeping: "DIRTY" } });
    }
    if (may("agent") && has("AGENT_HOST")) {
      jobs["liveListings"] = db.listing.count({ where: { orgId, status: "LIVE" } });
      jobs["openLeads"] = db.lead.count({ where: { orgId, stage: { notIn: ["CLOSED", "LOST"] } } });
    }
    if (may("security") && has("SECURITY_MANAGEMENT")) {
      jobs["visitorsWaiting"] = db.visit.count({ where: { orgId, ...at("visit"), status: "WAITING" } });
      jobs["visitorsInside"] = db.visit.count({ where: { orgId, ...at("visit"), status: "INSIDE" } });
      jobs["openIncidents"] = db.incident.count({
        where: { orgId, ...at("incident"), status: { notIn: ["CLOSED", "RESOLVED"] } },
      });
    }
    if (may("finance")) {
      jobs["unpaidInvoices"] = db.invoice.count({
        where: { orgId, status: { in: ["SENT", "PART_PAID", "OVERDUE"] } },
      });
      jobs["overdueInvoices"] = db.invoice.count({ where: { orgId, status: "OVERDUE" } });
    }

    const keys = Object.keys(jobs);
    const values = await Promise.all(keys.map((k) => jobs[k]));
    const counts = Object.fromEntries(keys.map((k, i) => [k, values[i]]));

    res.json({
      organization: { id: orgId, name: actorOf(req).orgName },
      role: actorOf(req).role,
      products: actorOf(req).products,
      counts,
    });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * PALTAS CONNECT — SYNCING A CHANNEL.
 *
 * The CRUD for `channels` is built by the framework above, because a channel
 * row is a resource like any other. Syncing one is not: it is work against an
 * outside system that either happened or did not, and the operator pressing
 * the button is entitled to know which.
 *
 * Both endpoints go through domain/channels.js, which refuses when no channel
 * manager is attached. That refusal is the correct production behaviour right
 * now — see the header of that file for why it is a 503 and not a quiet
 * success.
 * ====================================================================== */

guarded.post("/channels/:id/sync", async (req, res, next) => {
  try {
    need(req, "hotel", "update", "channels");

    const channel = await own("channel", param(req, "id"), actorOf(req).orgId);
    if (channel.status === "PAUSED") {
      throw conflict(
        `${channel.name} is paused. Resume it before syncing, or it will be ` +
        "handed inventory it is not meant to be selling.");
    }

    /* Throws ChannelUnavailable (503) when nothing is attached. Deliberately
       NOT caught here: the whole point is that the caller hears it. */
    const out = await syncChannel(channel);

    const row = await db.channel.update({
      where: { id: channel.id },
      data: { lastSyncAt: out.at, status: "LIVE" },
    });

    await audit(req, "channel.sync", "channel", channel.id,
      { manager: out.manager, pushed: out.pushed, pulled: out.pulled });
    res.json({ channel: row, sync: out });
  } catch (e) { next(e); }
});

/**
 * POST /channels/sync — every live channel.
 *
 * Reports per channel rather than as one number. "12 channels synced" is the
 * shape of the toast this replaces, and it was wrong precisely because it
 * collapsed twelve outcomes into one cheerful sentence.
 */
guarded.post("/channels/sync", async (req, res, next) => {
  try {
    need(req, "hotel", "update", "channels");

    const rows = await db.channel.findMany({
      where: { orgId: actorOf(req).orgId, status: "LIVE" },
      orderBy: { name: "asc" },
    });
    if (!rows.length) {
      return res.json({ results: [], synced: 0, failed: 0, note: "No channel is live." });
    }

    const results = [];
    for (const channel of rows) {
      try {
        const out = await syncChannel(channel);
        await db.channel.update({
          where: { id: channel.id }, data: { lastSyncAt: out.at },
        });
        results.push({ id: channel.id, name: channel.name, ok: true,
                       pushed: out.pushed, pulled: out.pulled });
      } catch (e) {
        /* One channel refusing must not hide the other eleven. The failure is
           recorded against that channel and the loop continues. */
        await db.channel.update({
          where: { id: channel.id }, data: { status: "ERROR", note: messageOf(e) },
        }).catch(() => {});
        results.push({ id: channel.id, name: channel.name, ok: false, why: messageOf(e) });
      }
    }

    const synced = results.filter((r) => r.ok).length;
    await audit(req, "channel.syncAll", "channel", "", { synced, failed: results.length - synced });
    res.json({ results, synced, failed: results.length - synced });
  } catch (e) { next(e); }
});

/** GET /connect/status — whether a channel manager is attached. No secrets. */
guarded.get("/connect/status", async (req, res, next) => {
  try {
    /* Carries no credential and no company data — but the rule that every
       hand-written endpoint checks a role has no exceptions worth making,
       and whether this hotel's distribution is wired is its own business. */
    need(req, "hotel", "list", "channels");
    res.setHeader("Cache-Control", "no-store, private");
    res.json(channelStatus());
  } catch (e) { next(e); }
});

/**
 * GET /connect/rollup — what each channel actually sold.
 *
 * The console's channel KPIs used to read `res: 0, rev: 0` against real data
 * and plausible numbers against the demo array, because a Reservation had no
 * way to point at a Channel. It has one now, and this is the only place the
 * roll-up is computed — on the server, in minor units, grouped by the foreign
 * key rather than by matching a channel's name against a free-text `source`.
 *
 * Cancellations and no-shows are excluded: a channel is not owed commission
 * on a stay that did not happen, so counting them would overstate both the
 * revenue and the commission the operator thinks they are paying.
 *
 * `unattributed` is reported rather than hidden. A hotel that has just linked
 * its channels will see most of its reservations there, and that is the true
 * state — quietly spreading them across the channels would be the fabrication
 * this endpoint replaces.
 */
guarded.get("/connect/rollup", async (req, res, next) => {
  try {
    /* "list", not "read": ACT_LEVEL maps list/get/create/update/delete, and
       an act it does not name is refused for everyone. */
    need(req, "hotel", "list", "channels");

    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86_400_000);
    /*
     * Typed as Prisma's own filter, so the two strings are checked against
     * ReservationStatus rather than being a widened string[]. A reservation
     * that was cancelled or never turned up is not a booking a channel earned
     * commission on — and a typo in either name would silently count them.
     */
    const countable: Prisma.EnumReservationStatusFilter = {
      notIn: ["CANCELLED", "NO_SHOW"],
    };

    const [channels, grouped, loose] = await Promise.all([
      db.channel.findMany({
        where: { orgId: actorOf(req).orgId },
        orderBy: { name: "asc" },
      }),
      db.reservation.groupBy({
        by: ["channelId"],
        where: {
          orgId: actorOf(req).orgId,
          createdAt: { gte: since },
          status: countable,
          channelId: { not: null },
        },
        _count: { _all: true },
        _sum: { rate: true },
      }),
      db.reservation.count({
        where: {
          orgId: actorOf(req).orgId,
          createdAt: { gte: since },
          status: countable,
          channelId: null,
        },
      }),
    ]);

    const by = new Map(grouped.map((g) => [g.channelId, g]));

    const rows = channels.map((c) => {
      const g = by.get(c.id);
      /* `rate` is BigInt minor units. Number() only after summing, and the
         commission is taken from the same integer — never from a float that
         has already been divided for display. */
      const revenue = g?._sum?.rate ? Number(g._sum.rate) : 0;
      return {
        id: c.id,
        name: c.name,
        mark: c.mark || "",
        status: c.status,
        mapped: c.mapped || 0,
        total: c.total || 0,
        lastSyncAt: c.lastSyncAt,
        note: c.note || "",
        /*
         * groupBy with `_count: { _all: true }` yields `_all`; Prisma's type
         * for `_count` is the union of "true" and the per-column shape, so it
         * is read through the shape that was actually asked for.
         */
        reservations: countOf(g),
        revenueMinor: revenue,
        commissionMinor: Math.round((revenue * (c.commissionBps || 0)) / 10_000),
        commissionBps: c.commissionBps || 0,
      };
    });

    res.setHeader("Cache-Control", "no-store, private");
    res.json({
      days,
      since: since.toISOString(),
      channels: rows,
      unattributed: loose,
      basis: "Reservations booked in the window, excluding cancellations and no-shows, grouped by the channel recorded against each one.",
    });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * DOCUMENTS — ATTACHING THE ACTUAL FILE.
 *
 * The Document row has always described a file. These three endpoints are how
 * the file gets there, and they exist because a company being asked to supply
 * a certificate of incorporation could previously only type its name.
 *
 * The bytes never pass through PALTAS. The browser is given a short-lived,
 * single-purpose URL and uploads straight to storage:
 *
 *   1. POST /documents/:id/upload-url   permission to write ONE object
 *   2. the browser PUTs the file to that URL
 *   3. POST /documents/:id/attached     confirm, and record what is really there
 *   4. GET  /documents/:id/download-url a short-lived link to read it back
 *
 * Step 3 is not a formality. It asks STORAGE what was stored rather than
 * believing the browser that said it finished, because a client reporting a
 * size and type it did not upload is the easiest possible thing to do.
 * ====================================================================== */

guarded.get("/storage/status", (req, res, next) => {
  try {
    /* Behind the same permission as documents themselves. Someone who cannot
       see this company's documents has no business knowing how they are
       stored — and routing.test.js is right to insist every hand-written
       endpoint answers the question rather than assuming it is harmless. */
    need(req, "documents", "get", "documents");
    /* Whether uploads work, without naming a missing environment variable to a
       customer — they cannot act on one. An operator reads describe(). */
    res.json({ storage: storagePublicDescribe() });
  } catch (e) { next(e); }
});

guarded.post("/documents/:id/upload-url", async (req, res, next) => {
  try {
    need(req, "documents", "update", "documents");
    const orgId = actorOf(req).orgId;
    const doc = await own("document", String(param(req, "id")), orgId);

    const out = presignUpload({
      orgId, documentId: doc.id,
      filename: String(req.body?.filename || doc.name || "file"),
      contentType: req.body?.contentType,
      bytes: req.body?.bytes,
    });
    if (!out.ok) throw badRequest(out.why ?? "That upload could not be prepared.");

    /*
     * The key is recorded NOW, before the upload, so a file that lands in
     * storage always has a row pointing at it. The other order leaves an
     * orphan whenever a browser uploads and then closes.
     *
     * bytes/mimeType stay at zero until confirmed — the row says "a file was
     * started here", not "a file is here".
     */
    await db.document.updateMany({
      where: { id: doc.id, orgId },
      data: { storageKey: out.storageKey, bytes: 0, checksum: "", mimeType: "" },
    });
    await audit(req, "document.upload.begin", "document", doc.id,
      { filename: out.headers?.["Content-Type"] });

    res.json({
      upload: {
        url: out.url, method: out.method, headers: out.headers,
        expiresIn: out.expiresIn,
      },
      note: "PUT the file to this URL with exactly these headers, then call " +
            "/documents/" + doc.id + "/attached.",
    });
  } catch (e) { next(e); }
});

guarded.post("/documents/:id/attached", async (req, res, next) => {
  try {
    need(req, "documents", "update", "documents");
    const orgId = actorOf(req).orgId;
    const doc = await own("document", String(param(req, "id")), orgId);
    if (!doc.storageKey) throw badRequest("No upload was started for this document.");

    const found = await storageHead({ storageKey: doc.storageKey, orgId });
    if (!found.ok) throw badRequest(found.why ?? "That upload could not be confirmed.");

    const row = await db.document.update({
      where: { id: doc.id },
      data: { bytes: found.bytes, mimeType: found.mimeType, checksum: found.checksum },
    });
    await audit(req, "document.upload.finish", "document", doc.id,
      { bytes: found.bytes, mimeType: found.mimeType });
    res.json({ document: row });
  } catch (e) { next(e); }
});

guarded.get("/documents/:id/download-url", async (req, res, next) => {
  try {
    need(req, "documents", "get", "documents");
    const orgId = actorOf(req).orgId;
    const doc = await own("document", String(param(req, "id")), orgId);

    /*
     * own() has already established the row is this company's. The key is
     * checked AGAIN inside presignDownload, against the same organization.
     * Two independent guards on the same question, because a storage key that
     * escaped its tenant is the failure that would be silent.
     */
    const out = presignDownload({ storageKey: doc.storageKey, orgId, filename: doc.name });
    if (!out.ok) throw badRequest(out.why ?? "That upload could not be prepared.");

    /* Reading somebody's title deed is a thing that should be answerable
       later, so it is recorded at the time. */
    await audit(req, "document.download", "document", doc.id, { name: doc.name });
    res.set("Cache-Control", "no-store, private");
    res.json({ download: { url: out.url, expiresIn: out.expiresIn } });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * RECEIPTS — the proof handed to whoever paid.
 *
 * See domain/receipts.js for why a receipt copies its fields instead of
 * rendering the payment, and for what counts as confirmation given that
 * Payment deliberately has no status column.
 * ====================================================================== */

guarded.post("/payments/:id/receipt", async (req, res, next) => {
  try {
    /*
     * Issuing is a CREATE on receipts, not on payments. Somebody who may
     * record money taken at a desk may hand over the receipt for it; nothing
     * about issuing one changes the books.
     */
    need(req, "finance", "create", "receipts");

    /* The invoice comes with it, because the payer's name and the invoice
       reference are printed on the document and must be copied, not looked
       up again later when the party may have been renamed. */
    type WithInvoice = {
      invoice: { id: string; ref: string; party: { id: string; name: string } | null } | null;
    };
    const payment = await own<"payment", WithInvoice>(
      "payment", param(req, "id"), actorOf(req).orgId,
      { include: { invoice: { select: { id: true, ref: true, party: { select: { id: true, name: true } } } } } },
    );

    /*
     * ALREADY ISSUED IS NOT AN ERROR.
     *
     * "One receipt per payment" is a unique constraint, so a second press
     * cannot make a second document. Returning the existing one with 200 is
     * the honest answer to what the person actually asked — they want the
     * receipt, and it exists. A 409 here would send somebody hunting for a
     * problem that is really the guarantee working.
     */
    const already = await db.receipt.findFirst({
      where: { paymentId: payment.id, orgId: actorOf(req).orgId },
    });
    if (already) {
      res.json({ receipt: already, basisWords: BASIS_WORDS[already.basis], reissued: false });
      return;
    }

    const basis = requireReceiptable(payment);

    const invoice = payment.invoice;

    const receipt = await db.receipt.create({
      data: {
        orgId: actorOf(req).orgId,
        ref: await numberFor("receipts", actorOf(req).orgId),
        paymentId: payment.id,
        /* Copied, all of it. The payment may be corrected tomorrow; what the
           customer is holding may not change underneath them. */
        amount: payment.amount,
        currency: payment.currency,
        method: payment.method,
        reference: payment.reference,
        paidOn: payment.receivedAt,
        payerName: invoice?.party?.name || payment.receivedBy || "",
        partyId: invoice?.party?.id || null,
        invoiceRef: invoice?.ref || "",
        invoiceId: invoice?.id || null,
        basis,
        issuedById: actorOf(req).userId,
        issuedByName: actorOf(req).userName,
      },
    });

    await audit(req, "receipt.issue", "receipt", receipt.id, {
      ref: receipt.ref, paymentId: payment.id,
      amount: auditable(receipt.amount), currency: receipt.currency, basis,
    });

    res.status(201).json({
      receipt, basisWords: BASIS_WORDS[basis], reissued: false,
    });
  } catch (e) { next(e); }
});

/**
 * Whether a receipt could be issued, and why not when it could not.
 *
 * So a payments list can show the right control on every row without asking
 * the server once per row and without reimplementing the rule in the console
 * — a second copy of "what counts as confirmed" is how the two start
 * disagreeing about which payments are real.
 */
guarded.get("/payments/:id/receipt", async (req, res, next) => {
  try {
    need(req, "finance", "get", "receipts");
    const payment = await own("payment", param(req, "id"), actorOf(req).orgId);
    const receipt = await db.receipt.findFirst({
      where: { paymentId: payment.id, orgId: actorOf(req).orgId },
    });
    const why = whyNotReceiptable(payment);
    res.json({
      receipt,
      canIssue: !receipt && !why,
      why: receipt ? null : why,
      basisWords: receipt ? BASIS_WORDS[receipt.basis] : null,
    });
  } catch (e) { next(e); }
});

guarded.post("/receipts/:id/void", async (req, res, next) => {
  try {
    /* Same level as voiding the payment: this withdraws a document somebody
       outside the company is holding. */
    need(req, "finance", "delete", "receipts");

    const why = String(req.body?.reason || "").trim();
    if (why.length < 5) {
      throw badRequest(
        "A void needs a reason. The customer still has their copy, and whoever " +
        "they show it to will have only this sentence to go on.");
    }

    const receipt = await own("receipt", param(req, "id"), actorOf(req).orgId);
    if (receipt.voided) throw conflict("That receipt is already void.");

    const voided = await db.receipt.update({
      where: { id: receipt.id },
      data: { voided: true, voidReason: why, voidedAt: new Date() },
    });

    await audit(req, "receipt.void", "receipt", receipt.id,
      { ref: receipt.ref, reason: why, amount: auditable(receipt.amount) });

    /* The number is NOT freed. A reissue gets the next one, so two documents
       never share a number and the voided one stays findable when somebody
       brings their copy back. */
    res.json({ receipt: voided });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * CREDIT NOTES AND REFUNDS — the two ways an invoice is undone.
 *
 * See domain/credits.js for why they are different acts with different
 * ceilings, and domain/posting.js for how each reaches the ledger.
 * ====================================================================== */

guarded.post("/invoices/:id/credit-notes", async (req, res, next) => {
  try {
    /*
     * A CREDIT NOTE IS A MANAGE-LEVEL ACT. It decides that money owed is no
     * longer owed, which is as close to giving it away as this service gets
     * without the bank moving.
     */
    need(req, "finance", "delete", "credit-notes");

    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 5) {
      throw badRequest(
        "A credit note needs a reason. Whoever reads the books in six months " +
        "will have only this sentence to explain why somebody stopped owing money.");
    }

    const invoice = await own("invoice", param(req, "id"), actorOf(req).orgId, {
      include: { lines: true },
    });
    const amount = requireCreditable(invoice, Math.round(Number(req.body?.amount)));

    /* The tax rate of the invoice it credits, unless told otherwise. Guessing
       zero would quietly keep the VAT on revenue that has been given back. */
    const lines = (invoice as unknown as { lines?: { taxBps?: number }[] }).lines || [];
    const taxBps = req.body?.taxBps === undefined
      ? Math.round(Number(lines[0]?.taxBps || 0))
      : Math.round(Number(req.body.taxBps));
    if (!Number.isFinite(taxBps) || taxBps < 0) throw badRequest("taxBps must not be negative.");

    const note = await db.creditNote.create({
      data: {
        orgId: actorOf(req).orgId,
        ref: await numberFor("credit-notes", actorOf(req).orgId),
        invoiceId: invoice.id,
        partyId: invoice.partyId,
        currency: invoice.currency,
        amount, taxBps, reason,
        issuedById: actorOf(req).userId,
        issuedByName: actorOf(req).userName,
      },
    });

    const after = await recomputeInvoice(invoice.id, actorOf(req).orgId);
    await audit(req, "credit-note.issue", "creditNote", note.id, {
      ref: note.ref, invoiceId: invoice.id,
      amount: auditable(amount), currency: invoice.currency, reason,
    });

    const booking = await postForCreditNote(db, {
      orgId: actorOf(req).orgId, note,
      invoice: after || invoice, userId: actorOf(req).userId,
    });
    if (booking.skipped) {
      await audit(req, "credit-note.not_booked", "creditNote", note.id, { why: booking.skipped });
    }

    res.status(201).json({ creditNote: note, invoice: after, booking: bookingOf(booking) });
  } catch (e) { next(e); }
});

/** What could still be credited, and why not when nothing can. */
guarded.get("/invoices/:id/credit-notes", async (req, res, next) => {
  try {
    need(req, "finance", "get", "credit-notes");
    const invoice = await own("invoice", param(req, "id"), actorOf(req).orgId);
    const notes = await db.creditNote.findMany({
      where: { invoiceId: invoice.id, orgId: actorOf(req).orgId },
      orderBy: { issuedOn: "desc" },
    });
    res.json({
      creditNotes: notes,
      /* The ceiling, so a screen can offer the right maximum without a second
         copy of the rule in the browser. */
      creditable: owedOn(invoice).toString(),
      why: whyNotCreditable(invoice, 1),
    });
  } catch (e) { next(e); }
});

guarded.post("/credit-notes/:id/void", async (req, res, next) => {
  try {
    need(req, "finance", "delete", "credit-notes");

    const why = String(req.body?.reason || "").trim();
    if (why.length < 5) throw badRequest("A void needs a reason.");

    const note = await own("creditNote", param(req, "id"), actorOf(req).orgId);
    if (note.voided) throw conflict("That credit note is already void.");

    const voided = await db.creditNote.update({
      where: { id: note.id },
      data: { voided: true, voidReason: why, voidedAt: new Date() },
    });

    /* The money is owed again, so the invoice has to say so before anybody
       reads it. */
    const after = await recomputeInvoice(note.invoiceId, actorOf(req).orgId);
    await audit(req, "credit-note.void", "creditNote", note.id,
      { ref: note.ref, reason: why, amount: auditable(note.amount) });

    const booking = await reverseFor(db, {
      orgId: actorOf(req).orgId, sourceType: "credit-note", sourceId: note.id,
      reason: why, userId: actorOf(req).userId,
    });
    if (booking.skipped) {
      await audit(req, "credit-note.void_not_booked", "creditNote", note.id, { why: booking.skipped });
    }

    res.json({ creditNote: voided, invoice: after, booking: bookingOf(booking) });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- refunds */

/** What is left of this payment to give back, and why not when nothing is. */
guarded.get("/payments/:id/refund", async (req, res, next) => {
  try {
    need(req, "finance", "get", "payments");
    const payment = await own("payment", param(req, "id"), actorOf(req).orgId);
    const refunded = await refundedAgainst(payment.id, actorOf(req).orgId);
    const shape = { ...payment, refunded };
    res.json({
      refundable: refundableOn(shape).toString(),
      why: whyNotRefundable(shape, 1),
    });
  } catch (e) { next(e); }
});

/**
 * What has already gone back against one payment.
 *
 * A refund is a negative payment carrying the original's reference, which is
 * how the two are tied together without a column that older rows would not
 * have. See the note on Payment.amount.
 */
async function refundedAgainst(paymentId: string, orgId: string): Promise<bigint> {
  const rows = await db.payment.findMany({
    where: { orgId, voided: false, providerRef: `refund-of:${paymentId}` },
    select: { amount: true },
  });
  return rows.reduce((t, r) => t + -BigInt(r.amount), 0n);
}

guarded.post("/payments/:id/refund", async (req, res, next) => {
  try {
    /* Sending money out is the same level as voiding it. */
    need(req, "finance", "delete", "payments");

    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 5) {
      throw badRequest(
        "A refund needs a reason. It is money leaving the company, and the " +
        "books will carry only this sentence about why.");
    }

    const payment = await own("payment", param(req, "id"), actorOf(req).orgId);
    const refunded = await refundedAgainst(payment.id, actorOf(req).orgId);
    const amount = requireRefundable({ ...payment, refunded }, Math.round(Number(req.body?.amount)));

    const refund = await db.payment.create({
      data: {
        orgId: actorOf(req).orgId,
        invoiceId: payment.invoiceId,
        /* NEGATIVE. The column's own comment: positive for a receipt,
           negative for a refund. */
        amount: -amount,
        currency: payment.currency,
        method: payment.method,
        reference: reason.slice(0, 120),
        /* The tie back to what is being refunded. Not a new column, because
           every payment written before today would have it empty and the
           sum below would then be quietly wrong for exactly the rows that
           matter most. */
        providerRef: `refund-of:${payment.id}`,
        receivedBy: actorOf(req).userName,
      },
    });

    const after = payment.invoiceId
      ? await recomputeInvoice(payment.invoiceId, actorOf(req).orgId) : null;
    await audit(req, "payment.refund", "payment", refund.id, {
      of: payment.id, amount: auditable(amount), currency: payment.currency, reason,
    });

    const booking = await postForRefund(db, {
      orgId: actorOf(req).orgId, payment: refund,
      invoice: after, userId: actorOf(req).userId,
    });
    if (booking.skipped) {
      await audit(req, "payment.refund_not_booked", "payment", refund.id, { why: booking.skipped });
    }

    res.status(201).json({ refund, invoice: after, booking: bookingOf(booking) });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * DEPOSITS — money the company is holding, and does not own
 *
 * A tenancy deposit is the TENANT's money. Everything below follows from that
 * and from one more fact: the person whose money it is is not in the room when
 * any of these decisions is taken. So every act names who did it, every
 * deduction carries the sentence explaining itself, and nothing is ever
 * deleted.
 *
 * WHAT IS HELD IS NEVER STORED — it is the sum of the movements, every time.
 * `status` is the only derived thing written down, and it is recomputed here
 * on every write and never accepted from a request body.
 * ====================================================================== */

/** Everything a deposit screen needs, computed in one place. */
async function depositState(id: string, orgId: string) {
  const deposit = await db.deposit.findFirst({
    where: { id, orgId },
    include: {
      movements: { orderBy: { at: "asc" } },
      lease: { select: { id: true, ref: true, tenantName: true, unitRef: true, status: true } },
      party: { select: { id: true, name: true } },
      heldIn: { select: { id: true, name: true, currency: true } },
    },
  });
  if (!deposit) throw hidden();
  return deposit;
}

/**
 * THE STATUS, RECOMPUTED FROM WHAT ACTUALLY HAPPENED.
 *
 * Called after every movement and after every dispute change, so there is no
 * window in which a deposit's status disagrees with its own movements. It
 * returns the fresh row because every caller wants it.
 */
async function syncDeposit(id: string, orgId: string) {
  const deposit = await db.deposit.findFirst({
    where: { id, orgId }, include: { movements: true },
  });
  if (!deposit) throw hidden();
  const status = statusFor(deposit, deposit.movements);
  if (status === deposit.status) return deposit;
  return db.deposit.update({
    where: { id: deposit.id }, data: { status }, include: { movements: true },
  });
}

/** The figures a screen prints, as strings — BigInt does not survive JSON. */
function depositFigures(
  deposit: { required: bigint; currency: string; disputed: boolean },
  movements: readonly { kind: string; amount: bigint; voided: boolean }[],
) {
  return {
    required: deposit.required.toString(),
    received: receivedOn(movements).toString(),
    deducted: deductedOn(movements).toString(),
    returned: returnedOn(movements).toString(),
    /* THE ONE FIGURE THE WHOLE FEATURE EXISTS FOR. */
    held: heldOn(movements).toString(),
    /* Both ceilings are the same number, which is the point: a deduction and
       a return come out of the same pot. */
    deductible: deposit.disputed ? "0" : heldOn(movements).toString(),
    returnable: heldOn(movements).toString(),
    currency: deposit.currency,
  };
}

/**
 * OPEN A DEPOSIT AGAINST A TENANCY.
 *
 * The lease is where the agreed figure and the currency come from, which is
 * why this hangs off the lease rather than standing on its own. Opening one
 * records NOTHING as received — a deposit that says it holds money the moment
 * it is created is the first way this feature could lie.
 */
guarded.post("/leases/:id/deposit", async (req, res, next) => {
  try {
    need(req, "finance", "create", "deposits");

    const lease = await own("lease", param(req, "id"), actorOf(req).orgId);

    const already = await db.deposit.findFirst({
      where: { leaseId: lease.id, orgId: actorOf(req).orgId },
    });
    if (already) {
      /* Said in words rather than as a unique-key error: one tenancy holds one
         deposit, and a top-up is a movement on this one. */
      throw conflict(
        `${already.ref} is already open against this tenancy. A deposit that `
        + `has grown is a receipt on the same deposit (POST /deposits/`
        + `${already.id}/receive), not a second one.`);
    }

    /*
     * WHAT WAS AGREED, from the lease unless the caller says otherwise. A
     * company migrating in real tenancies often knows the deposit it holds
     * before it has typed the figure onto the lease.
     */
    const asked = req.body?.required === undefined
      ? big(lease.deposit)
      : BigInt(Math.round(Number(req.body.required)));
    if (!Number.isSafeInteger(Number(asked)) || asked < 0n) {
      throw badRequest("The agreed deposit is a whole number of minor units, and not negative.");
    }

    const currency = String(req.body?.currency || lease.currency || "").trim().toUpperCase();
    if (!currency) {
      throw badRequest(
        "A deposit needs a currency. It is held, deducted and returned in one "
        + "currency, and this service has no exchange rate it would stand behind.");
    }

    /* Where it sits, if they already know. Checked to be this company's. */
    let heldInId: string | null = null;
    if (req.body?.heldInId) {
      const account = await own("bankAccount", String(req.body.heldInId), actorOf(req).orgId);
      heldInId = account.id;
    }

    const deposit = await db.deposit.create({
      data: {
        orgId: actorOf(req).orgId,
        ref: await numberFor("deposits", actorOf(req).orgId),
        leaseId: lease.id,
        partyId: lease.tenantId,
        required: asked,
        currency,
        heldInId,
        note: String(req.body?.note || "").slice(0, 2000),
        /* DUE, because nothing has arrived. Not accepted from the body. */
        status: "DUE",
      },
      include: { movements: true },
    });

    await audit(req, "deposit.open", "deposit", deposit.id, {
      ref: deposit.ref, leaseId: lease.id, leaseRef: lease.ref,
      required: auditable(asked), currency, heldInId,
    });

    res.status(201).json({
      deposit,
      figures: depositFigures(deposit, deposit.movements),
    });
  } catch (e) { next(e); }
});

/** What is held against this tenancy, and what can be done with it. */
guarded.get("/leases/:id/deposit", async (req, res, next) => {
  try {
    need(req, "finance", "get", "deposits");
    const lease = await own("lease", param(req, "id"), actorOf(req).orgId);
    const deposit = await db.deposit.findFirst({
      where: { leaseId: lease.id, orgId: actorOf(req).orgId },
      include: { movements: { orderBy: { at: "asc" } } },
    });
    if (!deposit) {
      /*
       * NOT A 404, because the tenancy exists and the answer is meaningful:
       * nothing is being held. A screen asking "what do we hold for this
       * tenant" deserves "nothing, and the agreement asks for X" rather than
       * an error it has to interpret.
       */
      res.json({
        deposit: null,
        required: big(lease.deposit).toString(),
        currency: lease.currency,
        why: "No deposit has been opened against this tenancy yet.",
      });
      return;
    }
    res.json({ deposit, figures: depositFigures(deposit, deposit.movements) });
  } catch (e) { next(e); }
});

/**
 * MONEY ARRIVED, AND IS NOW BEING HELD.
 *
 * Dr bank, Cr deposits held — never income. The company owes this back.
 */
guarded.post("/deposits/:id/receive", async (req, res, next) => {
  try {
    /* Recording money that has ALREADY arrived is a create, not a manage act:
       refusing it to the person who took the cash is how a record goes
       unwritten. */
    need(req, "finance", "create", "deposits");

    const deposit = await depositState(param(req, "id"), actorOf(req).orgId);
    const currency = req.body?.currency ? String(req.body.currency).toUpperCase() : null;
    /*
     * NOT Math.round(). Every other money route in this file rounds a request's
     * amount to the nearest minor unit, and that is fine for a figure the
     * company is naming about itself. This is somebody else's money: quietly
     * turning 1.5 into 2 changes what a tenant is told was taken, by a number
     * nobody typed. The guard refuses a fraction instead and says so.
     */
    const amount = requireReceivable(deposit, Number(req.body?.amount), currency);

    const movement = await db.depositMovement.create({
      data: {
        orgId: actorOf(req).orgId, depositId: deposit.id,
        kind: "RECEIVED", amount, currency: deposit.currency,
        reason: String(req.body?.reason || "").slice(0, 2000),
        at: req.body?.at ? new Date(String(req.body.at)) : new Date(),
        method: req.body?.method ? String(req.body.method) as never : "BANK",
        reference: String(req.body?.reference || "").slice(0, 120),
        byId: actorOf(req).userId, byName: actorOf(req).userName,
      },
    });

    const after = await syncDeposit(deposit.id, actorOf(req).orgId);
    await audit(req, "deposit.receive", "deposit", deposit.id, {
      ref: deposit.ref, movementId: movement.id,
      amount: auditable(amount), currency: deposit.currency, status: after.status,
    });

    const booking = await postForDeposit(db, {
      orgId: actorOf(req).orgId, movement, userId: actorOf(req).userId,
    });
    if (booking.skipped) {
      await audit(req, "deposit.receive_not_booked", "deposit", deposit.id, { why: booking.skipped });
    }

    res.status(201).json({
      movement, deposit: after,
      figures: depositFigures(after, after.movements),
      booking: bookingOf(booking),
    });
  } catch (e) { next(e); }
});

/**
 * KEEP SOME OF IT — the act this whole file is careful about.
 *
 * A deduction is a company keeping somebody else's money while they are not
 * in the room. So: the manage level of rights, a required reason, a hard
 * ceiling at what is actually held, and nothing at all while a dispute is
 * open.
 *
 * NAMING AN INVOICE IS THE COMMON CASE and it does more than record a link:
 * it SETTLES the arrears. A deduction that leaves the invoice outstanding
 * leaves Collections chasing a tenant for money the company has already
 * taken — which is the single worst thing this feature could do.
 */
guarded.post("/deposits/:id/deduct", async (req, res, next) => {
  try {
    need(req, "finance", "delete", "deposits");

    const reason = String(req.body?.reason || "").trim();
    const noReason = whyNotAReason(reason, "A deduction");
    if (noReason) throw badRequest(noReason);

    const deposit = await depositState(param(req, "id"), actorOf(req).orgId);
    const currency = req.body?.currency ? String(req.body.currency).toUpperCase() : null;
    /*
     * NOT Math.round(). Every other money route in this file rounds a request's
     * amount to the nearest minor unit, and that is fine for a figure the
     * company is naming about itself. This is somebody else's money: quietly
     * turning 1.5 into 2 changes what a tenant is told was taken, by a number
     * nobody typed. The guard refuses a fraction instead and says so.
     */
    const amount = requireDeductible(
      deposit, deposit.movements, Number(req.body?.amount), currency);

    /* ---- the arrears it covers, if it covers arrears ---- */
    let invoice = null;
    if (req.body?.invoiceId) {
      invoice = await own("invoice", String(req.body.invoiceId), actorOf(req).orgId);

      /*
       * THE INVOICE HAS TO BE THIS TENANT'S.
       *
       * Without this, one tenant's deposit could settle another's rent — the
       * company would be taking money from somebody who owes nothing to pay
       * somebody else's debt. The lease is the first test and the party the
       * second, because a tenant may be billed for something outside the
       * tenancy (a service, a damage charge) and that is still their debt.
       */
      const sameLease = invoice.leaseId && invoice.leaseId === deposit.leaseId;
      const sameParty = invoice.partyId && deposit.partyId && invoice.partyId === deposit.partyId;
      if (!sameLease && !sameParty) {
        throw badRequest(
          `${invoice.ref} is not against this tenancy or this tenant. A deposit `
          + `can only settle what the person it belongs to owes.`);
      }
      if (invoice.currency !== deposit.currency) {
        throw badRequest(
          `${invoice.ref} is in ${invoice.currency} and this deposit is held in `
          + `${deposit.currency}. That needs an exchange rate somebody stands behind.`);
      }
      const owed = owedOn(invoice);
      if (owed <= 0n) {
        throw badRequest(
          `Nothing is owed on ${invoice.ref}, so taking it out of the deposit `
          + `would overpay it and leave the tenant owed money twice.`);
      }
      if (amount > owed) {
        throw badRequest(
          `That is more than ${invoice.ref} still owes (${owed}). Deduct what is `
          + `owed and record the rest separately, with its own reason.`);
      }
    }

    const movement = await db.depositMovement.create({
      data: {
        orgId: actorOf(req).orgId, depositId: deposit.id,
        kind: "DEDUCTED", amount, currency: deposit.currency,
        reason,
        at: req.body?.at ? new Date(String(req.body.at)) : new Date(),
        /* NO METHOD. A deduction moves no money — it reclassifies money that
           is already in the account. Naming a method would claim a transfer
           that nobody will find on a statement. */
        method: null,
        invoiceId: invoice ? invoice.id : null,
        byId: actorOf(req).userId, byName: actorOf(req).userName,
      },
    });

    /*
     * THE PAYMENT THAT SETTLES THE ARREARS.
     *
     * Created directly rather than through POST /payments on purpose: that
     * route posts its own journal entry (Dr bank, Cr receivable), and no bank
     * account received anything here. The movement's own entry — Dr deposits
     * held, Cr receivable — is the true one, and posting both would show cash
     * arriving that never did.
     *
     * `reference` is the movement's id because it is exactly what makes this
     * payment checkable against something else's record, which is what that
     * column is for; `receivedBy` carries the part a person reads.
     */
    let settled = null;
    if (invoice) {
      settled = await db.payment.create({
        data: {
          orgId: actorOf(req).orgId,
          invoiceId: invoice.id,
          amount, currency: deposit.currency,
          method: "OTHER",
          reference: movement.id,
          receivedBy: `Deposit ${deposit.ref}`,
          fromDepositId: deposit.id,
        },
      });
    }

    const [after, invoiceAfter] = await Promise.all([
      syncDeposit(deposit.id, actorOf(req).orgId),
      invoice ? recomputeInvoice(invoice.id, actorOf(req).orgId) : Promise.resolve(null),
    ]);

    await audit(req, "deposit.deduct", "deposit", deposit.id, {
      ref: deposit.ref, movementId: movement.id,
      amount: auditable(amount), currency: deposit.currency, reason,
      invoiceId: invoice ? invoice.id : null, invoiceRef: invoice ? invoice.ref : null,
      paymentId: settled ? settled.id : null,
      status: after.status,
    });

    const booking = await postForDeposit(db, {
      orgId: actorOf(req).orgId, movement, userId: actorOf(req).userId,
    });
    if (booking.skipped) {
      await audit(req, "deposit.deduct_not_booked", "deposit", deposit.id, { why: booking.skipped });
    }

    res.status(201).json({
      movement, deposit: after, invoice: invoiceAfter, payment: settled,
      figures: depositFigures(after, after.movements),
      booking: bookingOf(booking),
    });
  } catch (e) { next(e); }
});

/**
 * GIVE IT BACK.
 *
 * Dr deposits held, Cr bank. Never touches income in either direction — the
 * company is discharging a liability, not spending.
 *
 * DELIBERATELY NOT BLOCKED BY A DISPUTE. Giving money back is never the
 * harmful direction, and several jurisdictions require the undisputed part to
 * be returned promptly whatever else is unresolved.
 */
guarded.post("/deposits/:id/return", async (req, res, next) => {
  try {
    need(req, "finance", "delete", "deposits");

    const reason = String(req.body?.reason || "").trim();
    const noReason = whyNotAReason(reason, "A deposit return");
    if (noReason) throw badRequest(noReason);

    const deposit = await depositState(param(req, "id"), actorOf(req).orgId);
    const currency = req.body?.currency ? String(req.body.currency).toUpperCase() : null;
    /*
     * NOT Math.round(). Every other money route in this file rounds a request's
     * amount to the nearest minor unit, and that is fine for a figure the
     * company is naming about itself. This is somebody else's money: quietly
     * turning 1.5 into 2 changes what a tenant is told was taken, by a number
     * nobody typed. The guard refuses a fraction instead and says so.
     */
    const amount = requireReturnable(
      deposit, deposit.movements, Number(req.body?.amount), currency);

    const movement = await db.depositMovement.create({
      data: {
        orgId: actorOf(req).orgId, depositId: deposit.id,
        kind: "RETURNED", amount, currency: deposit.currency,
        reason,
        at: req.body?.at ? new Date(String(req.body.at)) : new Date(),
        method: req.body?.method ? String(req.body.method) as never : "BANK",
        reference: String(req.body?.reference || "").slice(0, 120),
        byId: actorOf(req).userId, byName: actorOf(req).userName,
      },
    });

    const after = await syncDeposit(deposit.id, actorOf(req).orgId);
    await audit(req, "deposit.return", "deposit", deposit.id, {
      ref: deposit.ref, movementId: movement.id,
      amount: auditable(amount), currency: deposit.currency, reason,
      status: after.status,
    });

    const booking = await postForDeposit(db, {
      orgId: actorOf(req).orgId, movement, userId: actorOf(req).userId,
    });
    if (booking.skipped) {
      await audit(req, "deposit.return_not_booked", "deposit", deposit.id, { why: booking.skipped });
    }

    res.status(201).json({
      movement, deposit: after,
      figures: depositFigures(after, after.movements),
      booking: bookingOf(booking),
    });
  } catch (e) { next(e); }
});

/**
 * THE TENANT IS CONTESTING SOMETHING.
 *
 * An update-level act, on purpose: recording that somebody objects must be
 * the easiest thing on this screen to do. A company whose staff cannot write
 * down a complaint without a manager is a company whose complaints go
 * unwritten.
 *
 * While it stands, nothing further may be deducted. Returns stay open.
 */
guarded.post("/deposits/:id/dispute", async (req, res, next) => {
  try {
    need(req, "finance", "update", "deposits");

    const reason = String(req.body?.reason || "").trim();
    const noReason = whyNotAReason(reason, "A dispute");
    if (noReason) throw badRequest(noReason);

    const deposit = await own("deposit", param(req, "id"), actorOf(req).orgId);
    if (deposit.disputed) throw conflict("That deposit is already in dispute.");

    await db.deposit.update({
      where: { id: deposit.id },
      data: { disputed: true, disputeReason: reason, disputedAt: new Date(), resolvedAt: null },
    });
    const after = await syncDeposit(deposit.id, actorOf(req).orgId);

    await audit(req, "deposit.dispute", "deposit", deposit.id,
      { ref: deposit.ref, reason, status: after.status });

    res.json({ deposit: after, figures: depositFigures(after, after.movements) });
  } catch (e) { next(e); }
});

/**
 * THE DISPUTE IS OVER.
 *
 * Manage level, unlike raising one, because resolving it lets deductions
 * resume — so it is a decision about somebody else's money rather than a note
 * about a conversation. The status goes back to whatever the figures say,
 * which may well be PARTIAL or SETTLED rather than HELD.
 */
guarded.post("/deposits/:id/resolve", async (req, res, next) => {
  try {
    need(req, "finance", "delete", "deposits");

    const reason = String(req.body?.reason || "").trim();
    const noReason = whyNotAReason(reason, "Resolving a dispute");
    if (noReason) throw badRequest(noReason);

    const deposit = await own("deposit", param(req, "id"), actorOf(req).orgId);
    if (!deposit.disputed) throw conflict("That deposit is not in dispute.");

    await db.deposit.update({
      where: { id: deposit.id },
      data: {
        disputed: false,
        /* The reason is KEPT, with the outcome appended. A dispute that
           happened and then left no trace is the record a tenant will ask
           for. */
        disputeReason: `${deposit.disputeReason} — resolved: ${reason}`.slice(0, 2000),
        resolvedAt: new Date(),
      },
    });
    const after = await syncDeposit(deposit.id, actorOf(req).orgId);

    await audit(req, "deposit.resolve", "deposit", deposit.id,
      { ref: deposit.ref, reason, status: after.status });

    res.json({ deposit: after, figures: depositFigures(after, after.movements) });
  } catch (e) { next(e); }
});

/**
 * WHICH ACCOUNT IT SITS IN.
 *
 * Several jurisdictions require a deposit to be held in a designated or
 * protected account, and every one of them requires the company to be able to
 * say which. PALTAS administers no country's scheme — it records the answer,
 * so a company that has to produce it can.
 */
guarded.patch("/deposits/:id/held-in", async (req, res, next) => {
  try {
    need(req, "finance", "update", "deposits");

    const deposit = await own("deposit", param(req, "id"), actorOf(req).orgId);

    let heldInId: string | null = null;
    if (req.body?.heldInId) {
      const account = await own("bankAccount", String(req.body.heldInId), actorOf(req).orgId);
      /*
       * THE ACCOUNT HAS TO BE IN THE DEPOSIT'S CURRENCY.
       *
       * Saying a KES deposit sits in a USD account is either a mistake or a
       * conversion nobody recorded, and the whole reason to name the account
       * is to be able to point at the money.
       */
      if (account.currency && account.currency !== deposit.currency) {
        throw badRequest(
          `${account.name} is a ${account.currency} account and this deposit is `
          + `held in ${deposit.currency}.`);
      }
      heldInId = account.id;
    }

    const after = await db.deposit.update({
      where: { id: deposit.id }, data: { heldInId },
      include: { movements: true, heldIn: { select: { id: true, name: true, currency: true } } },
    });

    await audit(req, "deposit.held_in", "deposit", deposit.id,
      { ref: deposit.ref, heldInId, was: deposit.heldInId });

    res.json({ deposit: after, figures: depositFigures(after, after.movements) });
  } catch (e) { next(e); }
});

/**
 * UNDO A MOVEMENT.
 *
 * Voided, never deleted. A void is excluded from every sum, so voiding a
 * mistaken deduction gives the tenant their money back in the only sense that
 * matters — and the row stays, saying what was tried and who undid it.
 */
guarded.post("/deposit-movements/:id/void", async (req, res, next) => {
  try {
    need(req, "finance", "delete", "deposits");

    const reason = String(req.body?.reason || "").trim();
    const noReason = whyNotAReason(reason, "A void");
    if (noReason) throw badRequest(noReason);

    const movement = await own("depositMovement", param(req, "id"), actorOf(req).orgId);
    if (movement.voided) throw conflict("That movement is already void.");

    const voided = await db.depositMovement.update({
      where: { id: movement.id },
      data: { voided: true, voidReason: reason, voidedAt: new Date() },
    });

    /*
     * THE ARREARS ARE OWED AGAIN.
     *
     * Voiding a deduction that settled an invoice has to void the payment it
     * created too, or the invoice stays settled out of money the company has
     * just given back — a debt that disappeared because of a correction.
     */
    let invoiceAfter = null;
    if (movement.invoiceId) {
      await db.payment.updateMany({
        where: { orgId: actorOf(req).orgId, reference: movement.id, fromDepositId: movement.depositId },
        data: { voided: true, voidReason: reason, voidedAt: new Date() },
      });
      invoiceAfter = await recomputeInvoice(movement.invoiceId, actorOf(req).orgId);
    }

    const after = await syncDeposit(movement.depositId, actorOf(req).orgId);
    await audit(req, "deposit.movement_void", "depositMovement", movement.id, {
      depositRef: after.ref, kind: movement.kind,
      amount: auditable(movement.amount), reason, status: after.status,
      invoiceId: movement.invoiceId,
    });

    const booking = await reverseFor(db, {
      orgId: actorOf(req).orgId, sourceType: "deposit-movement", sourceId: movement.id,
      reason, userId: actorOf(req).userId,
    });
    if (booking.skipped) {
      await audit(req, "deposit.movement_void_not_booked", "depositMovement", movement.id,
        { why: booking.skipped });
    }

    res.json({
      movement: voided, deposit: after, invoice: invoiceAfter,
      figures: depositFigures(after, after.movements),
      booking: bookingOf(booking),
    });
  } catch (e) { next(e); }
});

/**
 * WHAT THIS COMPANY IS HOLDING, IN TOTAL.
 *
 * Per currency, because there is no rate to add across them with. The figure
 * a balance sheet needs and a bank balance hides: part of the money in the
 * account belongs to the tenants.
 */
/* NOT /deposits/held: the generated resource router mounts first and its
   GET /deposits/:id would swallow it, answering "no deposit with id 'held'". */
guarded.get("/deposits-held", async (req, res, next) => {
  try {
    need(req, "finance", "get", "deposits");
    const deposits = await db.deposit.findMany({
      where: { orgId: actorOf(req).orgId },
      include: { movements: true },
    });

    const by = new Map<string, { held: bigint; required: bigint; count: number }>();
    for (const d of deposits) {
      const row = by.get(d.currency) || { held: 0n, required: 0n, count: 0 };
      row.held += heldOn(d.movements);
      row.required += d.required;
      row.count += 1;
      by.set(d.currency, row);
    }

    res.json({
      currencies: [...by.entries()].map(([currency, row]) => ({
        currency, held: row.held.toString(), required: row.required.toString(),
        deposits: row.count,
      })),
      /* The states, so a screen can say what needs chasing without a second
         pass over every movement. */
      states: deposits.reduce<Record<string, number>>((out, d) => {
        out[d.status] = (out[d.status] || 0) + 1; return out;
      }, {}),
    });
  } catch (e) { next(e); }
});
