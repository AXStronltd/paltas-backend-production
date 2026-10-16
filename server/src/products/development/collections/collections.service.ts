/*
 * Collections and handover: buyer money is RECORDED, never processed.
 *
 *   report    a sales agent (one instalment, in full) or finance (any amount) records a payment with its bank or
 *             mobile-money reference; the same reference is never accepted twice;
 *   verify    finance — not the person who reported it — confirms it against the bank: a receipt is issued, the
 *             instalments are paid oldest first, and the money posts:
 *               Dr 1010 Bank — buyer collections / Cr 1170 Buyer receivables (what was billed) and
 *                                                 Cr 2400 Buyer deposits held (paid before it was billed);
 *   bill      instalments due and unpaid are billed once: Dr 1170 / Cr 2400;
 *   handover  a fully paid unit, after practical completion, with the signed certificate: revenue is recognised
 *             (Dr 2400 what this contract holds, Dr 3900 receipts that were in the opening balances of a data
 *             migration / Cr 4600) and the unit's share of the project's WIP becomes cost of sale (Dr 5700 / Cr WIP),
 *             shared by sellable area over the units not yet handed over.
 */
import type { development, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { CoreServices } from "../../../core/core-services.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { addDays } from "../../../lib/dates.js";
import { newId } from "../../../lib/ids.js";
import { ACC } from "../accounts.js";
import { can } from "../shared/access.js";
import { cr, dr, ledgerBalance, post, type Dims } from "../shared/posting.js";
import {
  adoptOpeningArrears,
  createTask,
  findContract,
  findProject,
  findUnit,
  instalments,
  isLive,
  linkDocument,
  requireDocument,
  seesBuyer,
  toInstalment,
  type ContractRow,
} from "../shared/records.js";
import { formatMoney } from "../../../lib/money.js";

type Body<E extends { body: z.ZodType }> = z.output<E["body"]>;
type Out<T extends z.ZodType> = z.input<T>;

interface ReportRow {
  id: string;
  number: string;
  contract_id: string;
  instalment_id: string | null;
  buyer_id: string;
  amount_minor: number;
  method: Out<typeof development.PaymentReport>["method"];
  reference: string;
  date: string;
  proof_document_id: string | null;
  source: string;
  status: Out<typeof development.PaymentReport>["status"];
  reported_by: string;
  verified_by: string | null;
  reason: string | null;
  receipt_no: string | null;
  journal_id: string | null;
  agent_user_id: string | null;
}

const toReport = (r: ReportRow): Out<typeof development.PaymentReport> => ({
  id: r.id,
  number: r.number,
  contractId: r.contract_id,
  instalmentId: r.instalment_id,
  buyerId: r.buyer_id,
  amountMinor: r.amount_minor,
  method: r.method,
  reference: r.reference,
  date: r.date,
  proofDocumentId: r.proof_document_id,
  source: r.source,
  status: r.status,
  reportedBy: r.reported_by,
  verifiedBy: r.verified_by,
  reason: r.reason,
  receiptNumber: r.receipt_no,
  journalId: r.journal_id,
});

const REPORT_SELECT = `SELECT r.*, c.agent_user_id, p.receipt_no, p.journal_id
  FROM dev_payment_reports r JOIN dev_contacts c ON c.id = r.buyer_id LEFT JOIN dev_payments p ON p.id = r.payment_id`;

/** After-sales check-in this many days after a handover. */
const CHECK_IN_DAYS = 30;

const dimsOf = (k: ContractRow): Dims => ({
  project: k.project_id,
  contract: k.id,
  unit: k.unit_id,
  buyer: k.buyer_id,
});

export function collectionsService(core: CoreServices) {
  const { db } = core;

  async function findReport(t: Db, s: OrgScope, id: string, lock = false): Promise<ReportRow> {
    if (lock) await t.run("SELECT 1 FROM dev_payment_reports WHERE org_id = $1 AND id = $2 FOR UPDATE", [s.orgId, id]);
    const r = await t.row<ReportRow>(`${REPORT_SELECT} WHERE r.org_id = $1 AND r.id = $2`, [s.orgId, id]);
    if (!r || !seesBuyer(s, r)) throw fail.notFound("Payment report not found");
    return r;
  }

  // ---------------------------------------------------------------- statement of account
  async function statement(s: OrgScope, contractId: string, asOf?: string): Promise<Out<typeof development.Statement>> {
    const date = asOf ?? s.today;
    const k = await findContract(db, s, contractId);
    const inst = await instalments(db, k.id);
    const buyer = await db.row<{ name: string }>("SELECT name FROM dev_contacts WHERE id = $1", [k.buyer_id]);
    const unit = await findUnit(db, s.orgId, k.unit_id);
    const pays = await db.rows<{
      kind: "receipt" | "refund";
      date: string;
      amount_minor: number;
      reference: string | null;
      receipt_no: string | null;
      method: string | null;
    }>("SELECT * FROM dev_payments WHERE contract_id = $1 AND date <= $2 ORDER BY date, id", [k.id, date]);
    const amendments = await db.rows<{ date: string; description: string; price_change_minor: number | null }>(
      "SELECT * FROM dev_contract_amendments WHERE contract_id = $1 AND date <= $2 ORDER BY date",
      [k.id, date],
    );
    const lines: Out<typeof development.StatementLine>[] = [];
    for (const i of inst)
      if (i.due_date <= date)
        lines.push({
          date: i.due_date,
          kind: "instalment",
          reference: `#${i.seq}`,
          description: i.description ?? `Instalment ${i.seq}`,
          debitMinor: i.amount_minor,
          creditMinor: 0,
        });
    // the schedule already carries price changes; amendments are listed for the record
    for (const a of amendments)
      lines.push({
        date: a.date,
        kind: "amendment",
        reference: "amendment",
        description: `${a.description}${a.price_change_minor ? ` (price ${a.price_change_minor > 0 ? "+" : ""}${a.price_change_minor})` : ""}`,
        debitMinor: 0,
        creditMinor: 0,
      });
    for (const p of pays)
      lines.push({
        date: p.date,
        kind: p.kind,
        reference: p.receipt_no ?? p.reference ?? "",
        description:
          p.kind === "refund"
            ? "Refund"
            : `Receipt${p.method ? ` · ${p.method}` : ""}${p.reference ? ` · ${p.reference}` : ""}`,
        debitMinor: p.kind === "refund" ? p.amount_minor : 0,
        creditMinor: p.kind === "receipt" ? p.amount_minor : 0,
      });
    lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const scheduled = inst.reduce((n, i) => n + i.amount_minor, 0);
    const dueToDate = inst.filter((i) => i.due_date <= date).reduce((n, i) => n + i.amount_minor, 0);
    const paid = pays.reduce((n, p) => n + (p.kind === "refund" ? -p.amount_minor : p.amount_minor), 0);
    return {
      contractId: k.id,
      number: k.number,
      buyer: { id: k.buyer_id, name: buyer?.name ?? "" },
      unit: { id: unit.id, unitNo: unit.unit_no },
      asOf: date,
      priceMinor: scheduled,
      lines,
      instalments: inst.map(toInstalment),
      totals: {
        dueToDateMinor: dueToDate,
        paidMinor: paid,
        overdueMinor: Math.max(0, dueToDate - paid),
        notYetDueMinor: scheduled - dueToDate,
        balanceMinor: scheduled - paid,
      },
    };
  }

  // ---------------------------------------------------------------- report and verify buyer payments
  async function report(s: OrgScope, contractId: string, b: Body<typeof development.reportPayment>) {
    const finance = can(s, "developer.collections");
    if (!finance && !can(s, "developer.sales")) throw fail.roleNotAllowed("Your role cannot record buyer payments");
    if (b.date > s.today) throw fail.invalid("A payment cannot be dated in the future");
    return db.tx(async (t) => {
      const k = await findContract(t, s, contractId, true);
      if (!isLive(k)) throw fail.conflict("The contract is cancelled");
      const used =
        (await t.row(
          "SELECT 1 FROM dev_payment_reports WHERE org_id = $1 AND upper(reference) = upper($2) AND status <> 'rejected'",
          [s.orgId, b.reference],
        )) ??
        (await t.row("SELECT 1 FROM dev_payments WHERE org_id = $1 AND upper(reference) = upper($2)", [
          s.orgId,
          b.reference,
        ]));
      if (used) throw fail.conflict("This reference is already recorded — the same payment cannot be recorded twice");
      const inst = await instalments(t, k.id);
      const open = inst.reduce((n, i) => n + Math.max(0, i.amount_minor - i.paid_minor), 0);
      let instalmentId: string | null = null;
      if (b.instalmentId) {
        const i = inst.find((x) => x.id === b.instalmentId);
        if (!i) throw fail.invalid("That instalment is not on this contract");
        const left = i.amount_minor - i.paid_minor;
        if (left <= 0) throw fail.conflict("That instalment is already paid");
        if (!finance && b.amountMinor !== left)
          throw fail.invalid(
            `The amount must equal the instalment (${formatMoney(left, s.entitlement.org.currency)}); part-payments go through finance`,
            {
              openMinor: left,
            },
          );
        if (b.amountMinor > left) throw fail.invalid("The amount is more than the instalment still owes");
        const waiting = await t.row(
          "SELECT 1 FROM dev_payment_reports WHERE instalment_id = $1 AND status = 'awaiting_verification'",
          [i.id],
        );
        if (waiting) throw fail.conflict("A payment for this instalment is already waiting for verification");
        instalmentId = i.id;
      } else if (!finance) throw fail.invalid("Choose the instalment being paid");
      const pending = await t.row<{ n: number }>(
        "SELECT COALESCE(sum(amount_minor), 0)::bigint AS n FROM dev_payment_reports WHERE contract_id = $1 AND status = 'awaiting_verification'",
        [k.id],
      );
      if (b.amountMinor + (pending?.n ?? 0) > open)
        throw fail.invalid("This is more than the contract still owes", { openMinor: open });
      if (b.proofDocumentId) await requireDocument(t, s.orgId, b.proofDocumentId);
      const id = newId("dpr");
      await t.run(
        `INSERT INTO dev_payment_reports (id, org_id, number, contract_id, instalment_id, buyer_id, amount_minor, method,
           reference, date, proof_document_id, source, status, reported_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'awaiting_verification', $13)`,
        [
          id,
          s.orgId,
          await nextNumber(t, s.orgId, "PMT"),
          k.id,
          instalmentId,
          k.buyer_id,
          b.amountMinor,
          b.method,
          b.reference,
          b.date,
          b.proofDocumentId ?? null,
          finance ? "Recorded by finance" : "Reported by sales",
          s.userId,
        ],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Buyer payment reported",
        target: k.buyer_id,
        detail: `${b.reference} · ${b.amountMinor} · awaiting finance`,
      });
      return toReport(await findReport(t, s, id));
    });
  }

  async function listReports(s: OrgScope, status?: string) {
    const rows = await db.rows<ReportRow>(
      `${REPORT_SELECT} WHERE r.org_id = $1 AND ($2::text IS NULL OR r.status = $2) ORDER BY r.number`,
      [s.orgId, status ?? null],
    );
    return { reports: rows.filter((r) => seesBuyer(s, r)).map(toReport) };
  }

  async function verify(s: OrgScope, id: string, approve: boolean, reason?: string) {
    return db.tx(async (t) => {
      const r = await findReport(t, s, id, true);
      if (r.status !== "awaiting_verification") throw fail.conflict(`The payment is already ${r.status}`);
      if (r.reported_by === s.userId)
        throw fail.separationOfDuties("Someone other than the person who recorded it verifies it");
      if (!approve) {
        if (!reason || reason.length < 5) throw fail.invalid("Give the reason (at least 5 characters)");
        await t.run(
          "UPDATE dev_payment_reports SET status = 'rejected', verified_by = $2, decided_at = now(), reason = $3 WHERE id = $1",
          [id, s.userId, reason],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Buyer payment not verified",
          target: r.buyer_id,
          detail: `${r.reference}: ${reason}`,
        });
        return toReport(await findReport(t, s, id));
      }
      const k = await findContract(t, s, r.contract_id, true);
      await adoptOpeningArrears(t, s.orgId, k.id);
      const inst = await instalments(t, k.id, true);
      // allocate: the reported instalment, otherwise oldest first
      const order = r.instalment_id ? inst.filter((i) => i.id === r.instalment_id) : inst;
      let left = r.amount_minor;
      const allocations: { id: string; amount: number; toReceivable: number }[] = [];
      for (const i of order) {
        const open = i.amount_minor - i.paid_minor;
        if (left <= 0 || open <= 0) continue;
        const a = Math.min(left, open);
        allocations.push({ id: i.id, amount: a, toReceivable: Math.min(a, i.receivable_minor) });
        left -= a;
      }
      if (left > 0) throw fail.conflict("The instalments no longer owe this much — check what was paid meanwhile");
      const paymentId = newId("dpy");
      const receipt = await nextNumber(t, s.orgId, "RCT");
      await t.run(
        `INSERT INTO dev_payments (id, org_id, contract_id, buyer_id, kind, date, amount_minor, method, reference, receipt_no,
           verified_by) VALUES ($1, $2, $3, $4, 'receipt', $5, $6, $7, $8, $9, $10)`,
        [paymentId, s.orgId, k.id, k.buyer_id, r.date, r.amount_minor, r.method, r.reference, receipt, s.userId],
      );
      for (const a of allocations) {
        await t.run(
          "INSERT INTO dev_payment_allocations (id, org_id, payment_id, instalment_id, amount_minor) VALUES ($1, $2, $3, $4, $5)",
          [newId("dal"), s.orgId, paymentId, a.id, a.amount],
        );
        if (a.toReceivable)
          await t.run("UPDATE dev_instalments SET receivable_minor = receivable_minor - $2 WHERE id = $1", [
            a.id,
            a.toReceivable,
          ]);
      }
      const fromReceivable = allocations.reduce((n, a) => n + a.toReceivable, 0);
      const dims = dimsOf(k);
      const journalId = await post(t, core, {
        orgId: s.orgId,
        date: r.date,
        memo: `Buyer receipt ${receipt} · ${r.reference}`,
        ref: `receipt:${paymentId}`,
        lines: [
          dr(ACC.collections, r.amount_minor, `Receipt ${receipt}`, dims),
          cr(ACC.receivables, fromReceivable, "Billed instalments collected", dims),
          cr(ACC.deposits, r.amount_minor - fromReceivable, "Paid before billing: held until handover", dims),
        ],
      });
      await t.run("UPDATE dev_payments SET journal_id = $2 WHERE id = $1", [paymentId, journalId]);
      await t.run(
        "UPDATE dev_payment_reports SET status = 'verified', verified_by = $2, decided_at = now(), payment_id = $3 WHERE id = $1",
        [id, s.userId, paymentId],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Buyer payment verified — receipt issued",
        target: k.buyer_id,
        detail: `${receipt} · ${r.reference} · ${r.amount_minor}`,
      });
      return toReport(await findReport(t, s, id));
    });
  }

  // ---------------------------------------------------------------- billing
  async function bill(s: OrgScope, asOf?: string) {
    const date = asOf ?? s.today;
    if (date > s.today) throw fail.invalid("Instalments are billed when they fall due, not in advance");
    return db.tx(async (t) => {
      const contracts = await t.rows<ContractRow>(
        `SELECT k.*, u.project_id FROM dev_contracts k JOIN dev_units u ON u.id = k.unit_id
         WHERE k.org_id = $1 AND k.status IS DISTINCT FROM 'cancelled'
           AND EXISTS (SELECT 1 FROM dev_instalments i WHERE i.contract_id = k.id AND NOT i.billed AND i.due_date <= $2)
         ORDER BY k.id`,
        [s.orgId, date],
      );
      let billed = 0;
      let amount = 0;
      const journalIds: string[] = [];
      for (const k of contracts) {
        await adoptOpeningArrears(t, s.orgId, k.id);
        for (const i of await instalments(t, k.id, true)) {
          if (i.billed || i.due_date > date) continue;
          const open = Math.max(0, i.amount_minor - i.paid_minor);
          let journal: string | null = null;
          if (open > 0) {
            const dims = dimsOf(k);
            journal = await post(t, core, {
              orgId: s.orgId,
              date: s.today,
              memo: `Instalment due · contract ${k.number ?? k.id} #${i.seq}`,
              ref: `bill:${i.id}`,
              lines: [
                dr(ACC.receivables, open, "Instalment due", dims),
                cr(ACC.deposits, open, "Buyer money for the unit", dims),
              ],
            });
            journalIds.push(journal);
            amount += open;
          }
          await t.run(
            "UPDATE dev_instalments SET billed = true, receivable_minor = $2, bill_journal_id = $3 WHERE id = $1",
            [i.id, open, journal],
          );
          billed++;
        }
      }
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Instalments billed",
        detail: `${billed} instalment(s) due by ${date} · ${amount}`,
      });
      return { billed, amountMinor: amount, journalIds };
    });
  }

  // ---------------------------------------------------------------- handover
  async function handover(s: OrgScope, contractId: string, b: Body<typeof development.recordHandover>) {
    if (b.date > s.today) throw fail.invalid("A handover cannot be dated in the future");
    return db.tx(async (t) => {
      const k = await findContract(t, s, contractId, true);
      if (!isLive(k)) throw fail.conflict("The contract is cancelled");
      const unit = await findUnit(t, s.orgId, k.unit_id, true);
      if (unit.status === "handed_over") throw fail.conflict("This unit is already handed over");
      const inst = await instalments(t, k.id, true);
      const open = inst.filter((i) => i.amount_minor > i.paid_minor);
      if (open.length) throw fail.conflict(`Balance outstanding — ${open.length} instalment(s) not verified as paid`);
      const p = await findProject(t, s.orgId, k.project_id);
      const pc = await t.row<{ completed_date: string | null; forecast_date: string | null }>(
        "SELECT completed_date, forecast_date FROM dev_milestones WHERE project_id = $1 AND practical_completion",
        [p.id],
      );
      if (!pc?.completed_date)
        throw fail.conflict(
          `Practical completion is not reached${pc?.forecast_date ? ` (forecast ${pc.forecast_date})` : ""}`,
        );
      await requireDocument(t, s.orgId, b.certificateDocumentId);
      const dims = dimsOf(k);
      // revenue: the whole price; what this contract holds in 2400 is released, the rest was carried in opening equity
      const price = inst.reduce((n, i) => n + i.amount_minor, 0);
      const held = Math.max(0, -(await ledgerBalance(t, s.orgId, [ACC.deposits], { contract: k.id })));
      const fromDeposits = Math.min(price, held);
      const revenueJournal = await post(t, core, {
        orgId: s.orgId,
        date: b.date,
        memo: `Revenue recognised at handover · unit ${unit.unit_no}`,
        ref: `handover:${k.id}`,
        lines: [
          dr(ACC.deposits, fromDeposits, "Buyer money released at handover", dims),
          dr(ACC.openingEquity, price - fromDeposits, "Receipts before the migration cut-over", dims),
          cr(ACC.revenue, price, `Unit ${unit.unit_no}`, dims),
        ],
      });
      // cost of sale: this unit's share of the project's WIP, by sellable area over units not yet handed over
      const rest = await t.rows<{ id: string; area_sqm: number | null }>(
        "SELECT id, area_sqm FROM dev_units WHERE project_id = $1 AND COALESCE(status, 'available') <> 'handed_over'",
        [p.id],
      );
      const byArea = rest.every((u) => (u.area_sqm ?? 0) > 0);
      const total = byArea ? rest.reduce((n, u) => n + (u.area_sqm ?? 0), 0) : rest.length;
      const mine = byArea ? (unit.area_sqm ?? 0) : 1;
      const wipAccounts = (
        await t.rows<{ account_code: string }>(
          "SELECT DISTINCT account_code FROM dev_cost_codes WHERE org_id = $1 AND account_code LIKE '1%' ORDER BY account_code",
          [s.orgId],
        )
      ).map((r) => r.account_code);
      const credits = [];
      let cost = 0;
      for (const a of wipAccounts) {
        const balance = await ledgerBalance(t, s.orgId, [a], { project: p.id });
        const share = balance > 0 && total > 0 ? Math.round((balance * mine) / total) : 0;
        if (share > 0) {
          credits.push(cr(a, share, `WIP released for unit ${unit.unit_no}`, { project: p.id, unit: unit.id }));
          cost += share;
        }
      }
      const costJournal = cost
        ? await post(t, core, {
            orgId: s.orgId,
            date: b.date,
            memo: `Cost of sale at handover · unit ${unit.unit_no}`,
            ref: `costofsale:${k.id}`,
            lines: [dr(ACC.costOfSales, cost, `Unit ${unit.unit_no}`, { project: p.id, unit: unit.id }), ...credits],
          })
        : null;
      const id = newId("dho");
      await t.run(
        `INSERT INTO dev_handovers (id, org_id, unit_id, contract_id, date, status, certificate_document_id, completed_by,
           revenue_journal_id, cost_journal_id, revenue_minor, cost_minor)
         VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8, $9, $10, $11)`,
        [
          id,
          s.orgId,
          unit.id,
          k.id,
          b.date,
          b.certificateDocumentId,
          s.userId,
          revenueJournal,
          costJournal,
          price,
          cost,
        ],
      );
      await t.run("UPDATE dev_units SET status = 'handed_over' WHERE id = $1", [unit.id]);
      await t.run("UPDATE dev_contracts SET status = 'completed' WHERE id = $1", [k.id]);
      await linkDocument(t, s.orgId, b.certificateDocumentId, "handover", id);
      await createTask(t, s.orgId, {
        title: `After-sales check-in · unit ${unit.unit_no}`,
        dueDate: addDays(b.date, CHECK_IN_DAYS),
        category: "aftersales",
        assignee: k.agent_user_id ?? s.userId,
        createdBy: s.userId,
        buyerId: k.buyer_id,
        unitId: unit.id,
        projectId: p.id,
        contractId: k.id,
        key: `checkin:${unit.id}`,
      });
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Unit handed over",
        target: k.buyer_id,
        detail: `unit ${unit.unit_no} · revenue ${price} · cost of sale ${cost}`,
      });
      return {
        id,
        unitId: unit.id,
        contractId: k.id,
        date: b.date,
        status: "completed",
        certificateDocumentId: b.certificateDocumentId,
        revenueJournalId: revenueJournal,
        costJournalId: costJournal,
        revenueMinor: price,
        costOfSaleMinor: cost,
      };
    });
  }

  return { statement, report, listReports, verify, bill, handover };
}

export type CollectionsService = ReturnType<typeof collectionsService>;
