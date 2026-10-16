/*
 * Folios: every charge, payment, deposit, void, refund and city-ledger transfer is a folio line AND a ledger
 * posting, written in the same transaction, so the folios and Finance always agree to the minor unit.
 *
 *   charge          Dr 1150 guest ledger        Cr 41xx–45xx revenue, 2120 service charge, 2100 VAT, 2110 levy
 *   void            the mirror of the charge
 *   payment         Dr 1000 bank (recorded)     Cr 1150
 *   deposit applied Dr 2350 deposits            Cr 1150
 *   refund          Dr 1150                     Cr 1000 (approved by someone else first; the approver pays it
 *                                                           out, so a cash refund needs the approver's open cashier
 *                                                           shift and comes out of that drawer)
 *   city ledger     Dr 1160 city ledger         Cr 1150 (company folio at check-out, within the credit limit)
 *   allowance       Dr revenue, service charge, VAT, levy (a share of the charge's taxes)   Cr 1150
 *                   — a comp or discount on a charge; approved by someone other than who gave it
 *
 * Transfers between folios move a balance inside 1150 and post nothing.
 *
 * Every transaction that writes folio lines or postings first reads the hotel's business date under FOR SHARE
 * (lockBusinessDate), so nothing is dated a day the night audit has already closed.
 */
import type { hotel, z } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC, REVENUE_ACCOUNT } from "../accounts.js";
import type { HotelDeps, HotelOp } from "../deps.js";
import type { HotelScope } from "../shared/access.js";
import { cr, dr, lockBusinessDate, postToLedger } from "../shared/posting.js";
import { applyTaxes } from "../shared/tax.js";
import * as repo from "./folios.repo.js";
import { formatMoney } from "../../../lib/money.js";

export interface ChargeInput {
  department: hotel.HotelDepartment;
  description: string;
  net: number;
  nights?: number;
  outletId?: string | null;
  stayId?: string | null;
  nightDate?: string | null;
  channelId?: string | null;
}

export function foliosService(d: HotelDeps) {
  const { core } = d;
  const { db } = core;

  async function open(
    t: Db,
    op: HotelOp,
    f: {
      reservationId?: string | null;
      stayId?: string | null;
      groupBlockId?: string | null;
      name: string;
      payer: "guest" | "company";
      corporateAccountId?: string | null;
    },
  ): Promise<string> {
    const id = newId("hfo");
    await t.run(
      `INSERT INTO hotel_folios (id, org_id, property_id, number, reservation_id, stay_id, group_block_id, name, payer, corporate_account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        op.orgId,
        op.property.id,
        await nextNumber(t, op.orgId, "FOL", 6),
        f.reservationId ?? null,
        f.stayId ?? null,
        f.groupBlockId ?? null,
        f.name,
        f.payer,
        f.corporateAccountId ?? null,
      ],
    );
    await recordAudit(t, { actor: op.actor, orgId: op.orgId, action: "Folio opened", target: id, detail: f.name });
    return id;
  }

  async function insertLine(
    t: Db,
    op: HotelOp,
    folioId: string,
    l: {
      kind: hotel.FolioLineOut["kind"];
      department?: hotel.HotelDepartment | null;
      description: string;
      net: number;
      service?: number;
      vat?: number;
      levy?: number;
      method?: hotel.PaymentMethod | null;
      reference?: string | null;
      shiftId?: string | null;
      stayId?: string | null;
      nightDate?: string | null;
      outletId?: string | null;
      voidsLineId?: string | null;
      journalId?: string | null;
      allowanceKind?: "comp" | "discount" | null;
      allowanceOfLineId?: string | null;
      id?: string;
    },
  ): Promise<string> {
    const id = l.id ?? newId("hfl");
    const service = l.service ?? 0;
    const vat = l.vat ?? 0;
    const levy = l.levy ?? 0;
    await t.run(
      `INSERT INTO hotel_folio_lines (id, org_id, property_id, folio_id, business_date, kind, department, outlet_id, description,
         net_minor, service_minor, vat_minor, levy_minor, total_minor, method, reference, shift_id, stay_id, night_date,
         voids_line_id, journal_id, created_by, allowance_kind, allowance_of_line_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
        id,
        op.orgId,
        op.property.id,
        folioId,
        op.property.business_date,
        l.kind,
        l.department ?? null,
        l.outletId ?? null,
        l.description,
        l.net,
        service,
        vat,
        levy,
        l.net + service + vat + levy,
        l.method ?? null,
        l.reference ?? null,
        l.shiftId ?? null,
        l.stayId ?? null,
        l.nightDate ?? null,
        l.voidsLineId ?? null,
        l.journalId ?? null,
        op.userId,
        l.allowanceKind ?? null,
        l.allowanceOfLineId ?? null,
      ],
    );
    return id;
  }

  /** Post a taxed charge to a folio and to the ledger. Returns the line id. */
  async function charge(t: Db, op: HotelOp, folioId: string, c: ChargeInput): Promise<string> {
    await lockBusinessDate(t, op);
    const f = await repo.folioRow(t, op.property.id, folioId, true);
    if (f.status !== "open") throw fail.conflict(`Folio ${f.number} is closed`);
    const tax = applyTaxes(op.property, c.department, c.net, c.nights ?? 0);
    const id = newId("hfl");
    const journalId = await postToLedger(t, core, {
      orgId: op.orgId,
      propertyId: op.property.id,
      date: op.property.business_date,
      kind: c.nightDate ? "room_night" : "charge",
      memo: `${f.number} · ${c.description}`,
      ref: `line:${id}`,
      channelId: c.channelId ?? null,
      lines: [
        dr(ACC.guestLedger, tax.total),
        cr(REVENUE_ACCOUNT[c.department], tax.net),
        cr(ACC.serviceCharge, tax.service),
        cr(ACC.vat, tax.vat),
        cr(ACC.levy, tax.levy),
      ],
    });
    return insertLine(t, op, folioId, {
      id,
      kind: "charge",
      department: c.department,
      description: c.description,
      net: tax.net,
      service: tax.service,
      vat: tax.vat,
      levy: tax.levy,
      stayId: c.stayId ?? f.stay_id,
      nightDate: c.nightDate ?? null,
      outletId: c.outletId ?? null,
      journalId,
    });
  }

  /** The user's open cashier shift at this hotel, if any. */
  async function openShift(t: Db, op: HotelOp): Promise<string | null> {
    if (!op.userId) return null;
    const r = await t.row<{ id: string }>(
      "SELECT id FROM hotel_cashier_shifts WHERE property_id = $1 AND user_id = $2 AND status = 'open'",
      [op.property.id, op.userId],
    );
    return r?.id ?? null;
  }

  async function payment(
    t: Db,
    op: HotelOp,
    folioId: string,
    p: { method: hotel.PaymentMethod; amountMinor: number; reference: string },
  ): Promise<string> {
    await lockBusinessDate(t, op);
    const f = await repo.folioRow(t, op.property.id, folioId, true);
    if (f.status !== "open") throw fail.conflict(`Folio ${f.number} is closed`);
    const shiftId = await openShift(t, op);
    if (p.method === "cash" && !shiftId) throw fail.conflict("Open your cashier shift before taking cash");
    const id = newId("hfl");
    const journalId = await postToLedger(t, core, {
      orgId: op.orgId,
      propertyId: op.property.id,
      date: op.property.business_date,
      kind: "payment",
      memo: `${f.number} · payment by ${p.method} (ref ${p.reference}) — recorded, not processed`,
      ref: `line:${id}`,
      lines: [dr(ACC.bank, p.amountMinor), cr(ACC.guestLedger, p.amountMinor)],
    });
    await insertLine(t, op, folioId, {
      id,
      kind: "payment",
      description: `Payment — ${p.method.replace("_", " ")}`,
      net: -p.amountMinor,
      method: p.method,
      reference: p.reference,
      shiftId,
      journalId,
    });
    await recordAudit(t, {
      actor: op.actor,
      orgId: op.orgId,
      action: "Payment recorded",
      target: f.number,
      detail: `${p.amountMinor} by ${p.method} (${p.reference})`,
    });
    return id;
  }

  /** Apply a reservation's unapplied advance deposits to a folio (2350 → 1150). */
  async function applyDeposits(t: Db, op: HotelOp, reservationId: string, folioId: string): Promise<number> {
    await lockBusinessDate(t, op);
    const deps = await t.rows<{ id: string; amount_minor: number; method: hotel.PaymentMethod; reference: string }>(
      "SELECT * FROM hotel_deposits WHERE reservation_id = $1 AND applied_folio_id IS NULL ORDER BY received_date FOR UPDATE",
      [reservationId],
    );
    let applied = 0;
    for (const dep of deps) {
      const id = newId("hfl");
      const journalId = await postToLedger(t, core, {
        orgId: op.orgId,
        propertyId: op.property.id,
        date: op.property.business_date,
        kind: "deposit_applied",
        memo: `Advance deposit applied to folio (ref ${dep.reference})`,
        ref: `deposit-applied:${dep.id}`,
        lines: [dr(ACC.deposits, dep.amount_minor), cr(ACC.guestLedger, dep.amount_minor)],
      });
      await insertLine(t, op, folioId, {
        id,
        kind: "deposit",
        description: "Advance deposit applied",
        net: -dep.amount_minor,
        method: dep.method,
        reference: dep.reference,
        journalId,
      });
      await t.run("UPDATE hotel_deposits SET applied_folio_id = $2, applied_at = now() WHERE id = $1", [
        dep.id,
        folioId,
      ]);
      applied += dep.amount_minor;
    }
    return applied;
  }

  /** The folio a stay's charge of this department goes to: its routing rule, else the stay's first guest folio. */
  async function folioFor(t: Db, stayId: string, department: hotel.HotelDepartment): Promise<string> {
    const routed = await t.row<{ folio_id: string }>(
      `SELECT r.folio_id FROM hotel_folio_routing r JOIN hotel_folios f ON f.id = r.folio_id AND f.status = 'open'
       WHERE r.stay_id = $1 AND r.department = $2`,
      [stayId, department],
    );
    if (routed) return routed.folio_id;
    const main = await t.row<{ id: string }>(
      "SELECT id FROM hotel_folios WHERE stay_id = $1 AND status = 'open' ORDER BY (payer = 'guest') DESC, created_at LIMIT 1",
      [stayId],
    );
    if (!main) throw fail.conflict("This stay has no open folio");
    return main.id;
  }

  /** Move a company folio's balance to the company's city-ledger account (within its credit limit). */
  async function toCityLedger(t: Db, op: HotelOp, folioId: string): Promise<number> {
    await lockBusinessDate(t, op);
    const f = await repo.folioRow(t, op.property.id, folioId, true);
    const amount = await repo.balance(t, folioId);
    if (amount <= 0 || !f.corporate_account_id) return 0;
    const a = await t.row<{ name: string; credit_limit_minor: number; owed: number }>(
      `SELECT a.name, a.credit_limit_minor,
         COALESCE((SELECT sum(CASE WHEN kind = 'invoice' THEN amount_minor ELSE -amount_minor END) FROM hotel_city_ledger
                   WHERE account_id = a.id), 0)::bigint AS owed
       FROM hotel_corporate_accounts a WHERE a.org_id = $1 AND a.id = $2 FOR UPDATE`,
      [op.orgId, f.corporate_account_id],
    );
    if (!a) throw fail.notFound("Company account not found");
    if (a.owed + amount > a.credit_limit_minor) {
      throw fail.conflict(
        `${a.name} would exceed its credit limit (${a.credit_limit_minor}; owes ${a.owed}, this folio ${amount}) — take payment instead`,
      );
    }
    const id = newId("hfl");
    const journalId = await postToLedger(t, core, {
      orgId: op.orgId,
      propertyId: op.property.id,
      date: op.property.business_date,
      kind: "city_ledger",
      memo: `${f.number} transferred to the city ledger: ${a.name}`,
      ref: `city-ledger:${folioId}`,
      lines: [dr(ACC.cityLedger, amount), cr(ACC.guestLedger, amount)],
    });
    await insertLine(t, op, folioId, {
      id,
      kind: "city_ledger",
      description: `To city ledger — ${a.name}`,
      net: -amount,
      journalId,
    });
    await t.run(
      `INSERT INTO hotel_city_ledger (id, org_id, property_id, account_id, number, kind, date, amount_minor, folio_id, reference, journal_id, created_by)
       VALUES ($1,$2,$3,$4,$5,'invoice',$6,$7,$8,$9,$10,$11)`,
      [
        newId("hcl"),
        op.orgId,
        op.property.id,
        f.corporate_account_id,
        await nextNumber(t, op.orgId, "CLI", 5),
        op.property.business_date,
        amount,
        folioId,
        f.number,
        journalId,
        op.userId,
      ],
    );
    await recordAudit(t, {
      actor: op.actor,
      orgId: op.orgId,
      action: "Folio transferred to city ledger",
      target: f.number,
      detail: `${amount} to ${a.name}`,
    });
    return amount;
  }

  async function close(t: Db, op: HotelOp, folioId: string): Promise<void> {
    const f = await repo.folioRow(t, op.property.id, folioId, true);
    const bal = await repo.balance(t, folioId);
    if (bal !== 0)
      throw fail.conflict(`Folio ${f.number} does not balance (${formatMoney(bal, op.property.currency)})`);
    await t.run("UPDATE hotel_folios SET status = 'closed', closed_at = now() WHERE id = $1", [folioId]);
    await recordAudit(t, { actor: op.actor, orgId: op.orgId, action: "Folio closed", target: f.number });
  }

  const get = async (propertyId: string, id: string) => repo.toFolio(db, await repo.folioRow(db, propertyId, id));

  async function hasAllowance(t: Db, lineId: string): Promise<boolean> {
    return !!(await t.row("SELECT 1 FROM hotel_folio_lines WHERE kind = 'allowance' AND allowance_of_line_id = $1", [
      lineId,
    ]));
  }

  /**
   * A comp or discount on a charge: a share of the charge's net (all of what is left by default) and the same share
   * of each of its taxes is credited back — revenue, service charge, VAT and levy are debited, the guest ledger
   * credited. Each tax share is rounded once; the allowance that takes the rest of the charge takes exactly the rest.
   */
  async function allowance(
    t: Db,
    op: HotelOp,
    folioId: string,
    lineId: string,
    a: { kind: "comp" | "discount"; amountMinor?: number | undefined; reason: string },
  ): Promise<string> {
    await lockBusinessDate(t, op);
    const f = await repo.folioRow(t, op.property.id, folioId, true);
    if (f.status !== "open") throw fail.conflict(`Folio ${f.number} is closed`);
    const l = (await repo.lines(t, folioId)).find((x) => x.id === lineId);
    if (!l) throw fail.notFound("Line not found");
    if (l.kind !== "charge" || !l.department) throw fail.invalid("Only a charge can be comped or discounted");
    if (l.voided_by) throw fail.conflict("This charge is voided");
    if (await t.row("SELECT 1 FROM hotel_folio_lines WHERE kind = 'transfer' AND reference = $1", [l.id]))
      throw fail.conflict("This charge was moved to another folio — give the allowance there");
    const given = await t.row<{ net: number; service: number; vat: number; levy: number }>(
      `SELECT COALESCE(-sum(net_minor), 0)::bigint AS net, COALESCE(-sum(service_minor), 0)::bigint AS service,
         COALESCE(-sum(vat_minor), 0)::bigint AS vat, COALESCE(-sum(levy_minor), 0)::bigint AS levy
       FROM hotel_folio_lines WHERE kind = 'allowance' AND allowance_of_line_id = $1`,
      [l.id],
    );
    const left = {
      net: l.net_minor - (given?.net ?? 0),
      service: l.service_minor - (given?.service ?? 0),
      vat: l.vat_minor - (given?.vat ?? 0),
      levy: l.levy_minor - (given?.levy ?? 0),
    };
    const net = a.amountMinor ?? left.net;
    if (net <= 0 || net > left.net)
      throw fail.invalid(
        `At most ${formatMoney(left.net, op.property.currency)} of this charge's net can still be comped or discounted`,
      );
    const part = (rest: number, whole: number) =>
      net === left.net ? rest : Math.min(rest, Math.round((whole * net) / l.net_minor));
    const parts = {
      net,
      service: part(left.service, l.service_minor),
      vat: part(left.vat, l.vat_minor),
      levy: part(left.levy, l.levy_minor),
    };
    const total = parts.net + parts.service + parts.vat + parts.levy;
    const id = newId("hfl");
    const label = a.kind === "comp" ? "Comp" : "Discount";
    const journalId = await postToLedger(t, core, {
      orgId: op.orgId,
      propertyId: op.property.id,
      date: op.property.business_date,
      kind: "allowance",
      memo: `${f.number} · ${label} on ${l.description}: ${a.reason}`,
      ref: `allowance:${id}`,
      lines: [
        dr(REVENUE_ACCOUNT[l.department], parts.net),
        dr(ACC.serviceCharge, parts.service),
        dr(ACC.vat, parts.vat),
        dr(ACC.levy, parts.levy),
        cr(ACC.guestLedger, total),
      ],
    });
    await insertLine(t, op, folioId, {
      id,
      kind: "allowance",
      department: l.department,
      description: `${label}: ${l.description} — ${a.reason}`,
      net: -parts.net,
      service: -parts.service,
      vat: -parts.vat,
      levy: -parts.levy,
      outletId: l.outlet_id,
      stayId: l.stay_id,
      allowanceKind: a.kind,
      allowanceOfLineId: l.id,
      journalId,
    });
    await recordAudit(t, {
      actor: op.actor,
      orgId: op.orgId,
      action: `${label} given (awaiting approval)`,
      target: f.number,
      detail: `${l.description} · ${total} · ${a.reason}`,
    });
    return id;
  }

  return {
    open,
    charge,
    payment,
    allowance,
    applyDeposits,
    folioFor,
    toCityLedger,
    close,
    insertLine,
    get,

    async list(s: HotelScope, q: z.output<typeof hotel.listFolios.query>) {
      const rows = await db.rows<repo.FolioRow>(
        `SELECT * FROM hotel_folios WHERE property_id = $1 AND ($2::text IS NULL OR reservation_id = $2)
           AND ($3::text IS NULL OR stay_id = $3) AND ($4::text IS NULL OR status = $4) ORDER BY number`,
        [s.property.id, q.reservationId ?? null, q.stayId ?? null, q.status ?? null],
      );
      const folios = [];
      for (const f of rows) folios.push(await repo.toFolio(db, f));
      return { folios };
    },

    async create(s: HotelScope, b: z.output<typeof hotel.createFolio.body>) {
      if ((b.payer === "company") !== !!b.corporateAccountId)
        throw fail.invalid("A company folio names its company account; a guest folio has none");
      const id = await db.tx(async (t) => {
        const stay = await t.row<{ reservation_id: string; status: string }>(
          "SELECT reservation_id, status FROM hotel_stays WHERE property_id = $1 AND id = $2",
          [s.property.id, b.stayId],
        );
        if (!stay) throw fail.notFound("Stay not found");
        if (!["reserved", "in_house"].includes(stay.status)) throw fail.conflict(`This stay is ${stay.status}`);
        if (
          b.corporateAccountId &&
          !(await t.row("SELECT 1 FROM hotel_corporate_accounts WHERE org_id = $1 AND id = $2", [
            s.orgId,
            b.corporateAccountId,
          ]))
        )
          throw fail.invalid("Unknown company account");
        return open(t, s, {
          reservationId: stay.reservation_id,
          stayId: b.stayId,
          name: b.name,
          payer: b.payer,
          corporateAccountId: b.corporateAccountId ?? null,
        });
      });
      return get(s.property.id, id);
    },

    async setRouting(s: HotelScope, stayId: string, rules: { department: hotel.HotelDepartment; folioId: string }[]) {
      await db.tx(async (t) => {
        const stay = await t.row<{ id: string }>("SELECT id FROM hotel_stays WHERE property_id = $1 AND id = $2", [
          s.property.id,
          stayId,
        ]);
        if (!stay) throw fail.notFound("Stay not found");
        for (const r of rules) {
          const f = await repo.folioRow(t, s.property.id, r.folioId);
          if (f.stay_id !== stayId || f.status !== "open")
            throw fail.invalid(`Folio ${f.number} is not an open folio of this stay`);
        }
        if (new Set(rules.map((r) => r.department)).size !== rules.length)
          throw fail.invalid("One rule per department");
        await t.run("DELETE FROM hotel_folio_routing WHERE stay_id = $1", [stayId]);
        for (const r of rules)
          await t.run("INSERT INTO hotel_folio_routing (stay_id, department, folio_id) VALUES ($1, $2, $3)", [
            stayId,
            r.department,
            r.folioId,
          ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Folio routing set",
          target: stayId,
          after: rules,
        });
      });
      return { rules };
    },

    async postCharge(s: HotelScope, folioId: string, b: z.output<typeof hotel.postCharge.body>) {
      await db.tx(async (t) => {
        await charge(t, s, folioId, { department: b.department, description: b.description, net: b.amountMinor });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Charge posted",
          target: folioId,
          detail: `${b.department} · ${b.description} · ${b.amountMinor}`,
        });
      });
      return get(s.property.id, folioId);
    },

    async transfer(s: HotelScope, folioId: string, b: z.output<typeof hotel.transferLines.body>) {
      if (folioId === b.toFolioId) throw fail.invalid("Choose another folio");
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const from = await repo.folioRow(t, s.property.id, folioId, true);
        const to = await repo.folioRow(t, s.property.id, b.toFolioId, true);
        if (from.status !== "open" || to.status !== "open") throw fail.conflict("Both folios must be open");
        const sameStay = from.reservation_id != null && from.reservation_id === to.reservation_id;
        const sameGroup = from.group_block_id != null && from.group_block_id === to.group_block_id;
        const toMaster =
          to.group_block_id != null &&
          !!(await t.row("SELECT 1 FROM hotel_reservations WHERE id = $1 AND group_block_id = $2", [
            from.reservation_id,
            to.group_block_id,
          ]));
        if (!sameStay && !sameGroup && !toMaster)
          throw fail.invalid("Charges move only between folios of the same reservation or group");
        const ls = (await repo.lines(t, folioId)).filter((l) => b.lineIds.includes(l.id));
        if (ls.length !== new Set(b.lineIds).size) throw fail.invalid("Every line must belong to this folio");
        for (const l of ls) {
          if (l.kind !== "charge" || l.voided_by) throw fail.invalid("Only charges that are not voided can move");
          if (await hasAllowance(t, l.id))
            throw fail.conflict(`"${l.description}" has a comp or discount — it stays on this folio`);
          const moved = await t.row("SELECT 1 FROM hotel_folio_lines WHERE kind = 'transfer' AND reference = $1", [
            l.id,
          ]);
          if (moved) throw fail.conflict(`"${l.description}" was already moved`);
          const parts = { net: l.net_minor, service: l.service_minor, vat: l.vat_minor, levy: l.levy_minor };
          await insertLine(t, s, folioId, {
            kind: "transfer",
            department: l.department,
            description: `Moved to ${to.number}: ${l.description}`,
            net: -parts.net,
            service: -parts.service,
            vat: -parts.vat,
            levy: -parts.levy,
            reference: l.id,
          });
          await insertLine(t, s, b.toFolioId, {
            kind: "transfer",
            department: l.department,
            description: `From ${from.number}: ${l.description}`,
            ...parts,
            reference: l.id,
          });
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Folio charges moved",
          target: from.number,
          detail: `${ls.length} line(s) to ${to.number}`,
        });
      });
      return { from: await get(s.property.id, folioId), to: await get(s.property.id, b.toFolioId) };
    },

    async recordPayment(s: HotelScope, folioId: string, b: z.output<typeof hotel.recordPayment.body>) {
      await db.tx((t) => payment(t, s, folioId, b));
      return get(s.property.id, folioId);
    },

    async block(s: HotelScope, folioId: string, b: { blocked: boolean; reason: string }) {
      await db.tx(async (t) => {
        const f = await repo.folioRow(t, s.property.id, folioId, true);
        await t.run("UPDATE hotel_folios SET blocked = $2, blocked_reason = $3 WHERE id = $1", [
          folioId,
          b.blocked,
          b.blocked ? b.reason : null,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: b.blocked ? "Folio blocked" : "Folio unblocked",
          target: f.number,
          detail: b.reason,
        });
      });
      return get(s.property.id, folioId);
    },

    async voidLine(s: HotelScope, folioId: string, lineId: string, reason: string) {
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const f = await repo.folioRow(t, s.property.id, folioId, true);
        if (f.status !== "open") throw fail.conflict(`Folio ${f.number} is closed`);
        const l = (await repo.lines(t, folioId)).find((x) => x.id === lineId);
        if (!l) throw fail.notFound("Line not found");
        if (l.kind !== "charge") throw fail.invalid("Only a charge can be voided");
        if (l.voided_by) throw fail.conflict("This charge is already voided");
        if (await t.row("SELECT 1 FROM hotel_folio_lines WHERE kind = 'transfer' AND reference = $1", [l.id]))
          throw fail.conflict("This charge was moved to another folio — void it there");
        if (await hasAllowance(t, l.id))
          throw fail.conflict("This charge has a comp or discount — correct it with an allowance, not a void");
        const journal = await core.ledger.getJournal(s.orgId, l.journal_id as string);
        const id = newId("hfl");
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          propertyId: s.property.id,
          date: s.property.business_date,
          kind: "void",
          memo: `Void of ${journal.number}: ${reason}`,
          ref: `void:${l.id}`,
          lines: journal.lines.map((x) => ({
            account: x.account,
            debitMinor: x.creditMinor,
            creditMinor: x.debitMinor,
            memo: "Void",
          })),
        });
        await insertLine(t, s, folioId, {
          id,
          kind: "void",
          department: l.department,
          description: `Void: ${l.description} — ${reason}`,
          net: -l.net_minor,
          service: -l.service_minor,
          vat: -l.vat_minor,
          levy: -l.levy_minor,
          voidsLineId: l.id,
          journalId,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Charge voided (awaiting approval)",
          target: f.number,
          detail: `${l.description} · ${l.total_minor} · ${reason}`,
        });
      });
      return get(s.property.id, folioId);
    },

    async approveVoid(s: HotelScope, folioId: string, lineId: string) {
      await db.tx(async (t) => {
        // the folio and the void are looked up inside this hotel only: another hotel's ids are simply not found
        const f = await repo.folioRow(t, s.property.id, folioId, true);
        const v = await t.row<{ id: string; created_by: string | null; void_approved_by: string | null }>(
          `SELECT id, created_by, void_approved_by FROM hotel_folio_lines
           WHERE property_id = $1 AND folio_id = $2 AND kind = 'void' AND voids_line_id = $3 FOR UPDATE`,
          [s.property.id, f.id, lineId],
        );
        if (!v) throw fail.notFound("No void of this line");
        if (v.void_approved_by) throw fail.conflict("This void is already approved");
        if (v.created_by === s.userId)
          throw fail.separationOfDuties("You made this void — someone else must approve it");
        await t.run("UPDATE hotel_folio_lines SET void_approved_by = $3 WHERE property_id = $1 AND id = $2", [
          s.property.id,
          v.id,
          s.userId,
        ]);
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Void approved", target: v.id });
      });
      return get(s.property.id, folioId);
    },

    async postAllowance(s: HotelScope, folioId: string, lineId: string, b: z.output<typeof hotel.postAllowance.body>) {
      await db.tx((t) => allowance(t, s, folioId, lineId, b));
      return get(s.property.id, folioId);
    },

    async approveAllowance(s: HotelScope, folioId: string, allowanceId: string) {
      await db.tx(async (t) => {
        const f = await repo.folioRow(t, s.property.id, folioId, true);
        const a = await t.row<{ id: string; created_by: string | null; allowance_approved_by: string | null }>(
          `SELECT id, created_by, allowance_approved_by FROM hotel_folio_lines
           WHERE property_id = $1 AND folio_id = $2 AND id = $3 AND kind = 'allowance' FOR UPDATE`,
          [s.property.id, f.id, allowanceId],
        );
        if (!a) throw fail.notFound("No such comp or discount on this folio");
        if (a.allowance_approved_by) throw fail.conflict("This allowance is already approved");
        if (a.created_by === s.userId)
          throw fail.separationOfDuties("You gave this comp or discount — someone else must approve it");
        await t.run("UPDATE hotel_folio_lines SET allowance_approved_by = $3 WHERE property_id = $1 AND id = $2", [
          s.property.id,
          a.id,
          s.userId,
        ]);
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Allowance approved", target: a.id });
      });
      return get(s.property.id, folioId);
    },

    async requestRefund(s: HotelScope, folioId: string, b: z.output<typeof hotel.requestRefund.body>) {
      const id = newId("hrf");
      await db.tx(async (t) => {
        const f = await repo.folioRow(t, s.property.id, folioId, true);
        const bal = await repo.balance(t, folioId);
        if (b.amountMinor > -bal)
          throw fail.invalid(`The folio holds a credit of ${Math.max(0, -bal)}; refund at most that`);
        await t.run(
          `INSERT INTO hotel_refunds (id, org_id, property_id, folio_id, amount_minor, method, reason, requested_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, s.orgId, s.property.id, folioId, b.amountMinor, b.method, b.reason, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Refund requested",
          target: f.number,
          detail: `${b.amountMinor} by ${b.method}: ${b.reason}`,
        });
      });
      return refund(id);
    },

    async approveRefund(s: HotelScope, refundId: string) {
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const r = await t.row<{
          id: string;
          folio_id: string;
          amount_minor: number;
          method: hotel.PaymentMethod;
          reason: string;
          status: string;
          requested_by: string;
        }>("SELECT * FROM hotel_refunds WHERE property_id = $1 AND id = $2 FOR UPDATE", [s.property.id, refundId]);
        if (!r) throw fail.notFound("Refund not found");
        if (r.status !== "requested") throw fail.conflict("This refund is already approved");
        if (r.requested_by === s.userId)
          throw fail.separationOfDuties("You requested this refund — someone else must approve it");
        const f = await repo.folioRow(t, s.property.id, r.folio_id, true);
        if (r.amount_minor > -(await repo.balance(t, r.folio_id)))
          throw fail.conflict("The folio no longer holds that credit");
        // the approver pays the refund out: cash comes out of their own open drawer
        const shiftId = r.method === "cash" ? await openShift(t, s) : null;
        if (r.method === "cash" && !shiftId) throw fail.conflict("Open your cashier shift before paying out cash");
        const lineId = newId("hfl");
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          propertyId: s.property.id,
          date: s.property.business_date,
          kind: "refund",
          memo: `${f.number} · refund by ${r.method}: ${r.reason} — paid out by the hotel, recorded here`,
          ref: `refund:${r.id}`,
          lines: [dr(ACC.guestLedger, r.amount_minor), cr(ACC.bank, r.amount_minor)],
        });
        await insertLine(t, s, r.folio_id, {
          id: lineId,
          kind: "refund",
          description: `Refund — ${r.reason}`,
          net: r.amount_minor,
          method: r.method,
          shiftId,
          journalId,
        });
        await t.run("UPDATE hotel_refunds SET status = 'approved', approved_by = $2, line_id = $3 WHERE id = $1", [
          r.id,
          s.userId,
          lineId,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Refund approved",
          target: f.number,
          detail: `${r.amount_minor} by ${r.method}`,
        });
      });
      return refund(refundId);
    },
  };

  async function refund(id: string): Promise<hotel.RefundOut> {
    const r = await db.row<{
      id: string;
      folio_id: string;
      amount_minor: number;
      method: hotel.PaymentMethod;
      reason: string;
      status: "requested" | "approved";
      requested_by: string;
      approved_by: string | null;
    }>("SELECT * FROM hotel_refunds WHERE id = $1", [id]);
    if (!r) throw fail.notFound("Refund not found");
    return {
      id: r.id,
      folioId: r.folio_id,
      amountMinor: r.amount_minor,
      method: r.method,
      reason: r.reason,
      status: r.status,
      requestedBy: r.requested_by,
      approvedBy: r.approved_by,
    };
  }
}

export type FoliosService = ReturnType<typeof foliosService>;
