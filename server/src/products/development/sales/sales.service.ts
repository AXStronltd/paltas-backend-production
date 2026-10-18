/*
 * Sales: buyers (one Development contact list, duplicates refused, agents see only their own buyers), offers with
 * approval levels, buyer responses and counteroffers, reservations with expiry, and the signed sale agreement with its
 * instalment schedule. A unit is never sold twice: the unit row is locked before it changes and the database allows
 * one open reservation and one live contract per unit.
 *
 * Unit journey: available → on_hold (offer accepted, reservation awaiting approval) → reserved (approved, until the
 * expiry date) → sold (signed agreement) → handed_over. Cancelling or expiry makes it available again.
 */
import { createHash } from "node:crypto";
import type { development, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { CoreServices } from "../../../core/core-services.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { addDays, addMonths } from "../../../lib/dates.js";
import { newId } from "../../../lib/ids.js";
import { can } from "../shared/access.js";
import {
  BUYER_SELECT,
  bpOf,
  closeTask,
  contractRows,
  createTask,
  findBuyer,
  findContract,
  findProject,
  findUnit,
  isLive,
  linkDocument,
  requireDocument,
  requireMember,
  seesBuyer,
  toBuyer,
  toContract,
  type BuyerRow,
} from "../shared/records.js";
import { settingsRow, type SettingsRow } from "../shared/rules.js";

type Body<E extends { body: z.ZodType }> = z.output<E["body"]>;
type Out<T extends z.ZodType> = z.input<T>;
type Plan = development.Plan;

const OPEN_OFFER = ["draft", "awaiting_approval", "submitted", "counteroffer"];
const OPEN_RESERVATION = ["awaiting_approval", "active"];

interface OfferRow {
  id: string;
  org_id: string;
  number: string;
  buyer_id: string;
  unit_id: string;
  project_id: string;
  asking_minor: number;
  price_minor: number;
  deposit_bp: number;
  instalments_bp: number;
  months: number;
  completion_bp: number;
  valid_days: number;
  valid_until: string | null;
  conditions: string;
  status: Out<typeof development.Offer>["status"];
  round: number;
  agent_user_id: string | null;
  created_by: string;
  approval_level: "manager" | "executive" | null;
  approval_status: "pending" | "approved" | "declined" | null;
  approval_terms: string | null;
  approval_after: "submit" | "accept" | null;
  approval_requested_by: string | null;
  approval_decided_by: string | null;
  approval_reason: string | null;
  counter: { priceMinor: number; plan: Plan; note: string } | null;
  reservation_id: string | null;
  buyer_agent: string | null;
}

interface ReservationRow {
  id: string;
  unit_id: string;
  buyer_id: string;
  offer_id: string | null;
  date: string;
  expiry_date: string | null;
  status: Out<typeof development.Reservation>["status"];
  deposit_minor: number | null;
  approved_by: string | null;
  requested_by: string | null;
  source_system: string | null;
  agent_user_id: string | null;
  contract_id: string | null;
}

const planOf = (o: OfferRow): Plan => ({
  depositBp: o.deposit_bp,
  instalmentsBp: o.instalments_bp,
  months: o.months,
  completionBp: o.completion_bp,
});

export const discountBp = (asking: number, price: number): number => Math.round(((asking - price) * 10_000) / asking);

/** Which approval the terms need (null: none). Thresholds are the organisation's offer rules. */
export function approvalLevel(o: OfferRow, r: SettingsRow): "manager" | "executive" | null {
  const d = discountBp(o.asking_minor, o.price_minor);
  if (d > r.executive_discount_bp || o.deposit_bp < r.min_deposit_bp || o.months > r.executive_max_months)
    return "executive";
  if (d > r.manager_discount_bp || o.months > r.manager_max_months || o.conditions.trim()) return "manager";
  return null;
}

/** A fingerprint of the terms: an approval applies only to exactly the terms approved. */
const termsOf = (o: OfferRow): string =>
  createHash("sha256")
    .update(JSON.stringify([o.price_minor, planOf(o), o.valid_days, o.conditions]))
    .digest("hex");

const toOffer = (o: OfferRow): Out<typeof development.Offer> => ({
  id: o.id,
  number: o.number,
  buyerId: o.buyer_id,
  unitId: o.unit_id,
  projectId: o.project_id,
  askingMinor: o.asking_minor,
  priceMinor: o.price_minor,
  discountBp: discountBp(o.asking_minor, o.price_minor),
  plan: planOf(o),
  validDays: o.valid_days,
  validUntil: o.valid_until,
  conditions: o.conditions,
  status: o.status,
  round: o.round,
  agentUserId: o.agent_user_id,
  createdBy: o.created_by,
  approval:
    o.approval_level && o.approval_status && o.approval_requested_by
      ? {
          level: o.approval_level,
          status: o.approval_status,
          requestedBy: o.approval_requested_by,
          decidedBy: o.approval_decided_by,
          reason: o.approval_reason,
        }
      : null,
  counter: o.counter,
  reservationId: o.reservation_id,
});

const toReservation = (r: ReservationRow): Out<typeof development.Reservation> => ({
  id: r.id,
  unitId: r.unit_id,
  buyerId: r.buyer_id,
  offerId: r.offer_id,
  date: r.date,
  expiryDate: r.expiry_date,
  status: r.status,
  depositMinor: r.deposit_minor,
  approvedBy: r.approved_by,
  contractId: r.contract_id,
  migrated: r.source_system !== null,
});

const RESERVATION_SELECT = `SELECT r.*, c.agent_user_id,
    (SELECT k.id FROM dev_contracts k WHERE k.reservation_id = r.id ORDER BY k.date LIMIT 1) AS contract_id
  FROM dev_reservations r JOIN dev_contacts c ON c.id = r.buyer_id`;
const OFFER_SELECT =
  "SELECT o.*, c.agent_user_id AS buyer_agent FROM dev_offers o JOIN dev_contacts c ON c.id = o.buyer_id";

const last9 = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-9);
const normId = (v: string | null | undefined) => (v ?? "").replace(/\s/g, "").toUpperCase();

/** Instalment schedule: deposit on signing, equal monthly instalments, the balance on completion. */
export function schedule(price: number, plan: Plan, start: string, end: string) {
  const dep = bpOf(price, plan.depositBp);
  const during = bpOf(price, plan.instalmentsBp);
  const out: { due: string; amount: number; description: string }[] = [];
  if (dep > 0) out.push({ due: start, amount: dep, description: `Deposit ${plan.depositBp / 100}%` });
  for (let k = 1; k <= plan.months && during > 0; k++) {
    const base = Math.floor(during / plan.months);
    out.push({
      due: addMonths(start, k),
      amount: k === plan.months ? during - base * (plan.months - 1) : base,
      description: `Instalment ${k} of ${plan.months}`,
    });
  }
  const rest = price - dep - during;
  // the balance falls due at the project's completion date, as the workspace's payment plans do
  if (plan.completionBp > 0)
    out.push({ due: end > start ? end : start, amount: rest, description: "Balance on completion" });
  else {
    const last = out.at(-1);
    if (last) last.amount += rest;
  }
  return out.filter((i) => i.amount > 0);
}

export function salesService(core: CoreServices) {
  const { db } = core;

  // ---------------------------------------------------------------- expiry (offers past validity, reservations past expiry)
  async function expireDue(t: Db, orgId: string, today: string) {
    const offers = await t.rows<{ id: string }>(
      `UPDATE dev_offers SET status = 'expired'
       WHERE org_id = $1 AND status IN ('submitted', 'counteroffer') AND valid_until < $2 RETURNING id`,
      [orgId, today],
    );
    const res = await t.rows<{ id: string; unit_id: string; offer_id: string | null }>(
      `SELECT id, unit_id, offer_id FROM dev_reservations WHERE org_id = $1 AND status = 'active' AND expiry_date < $2
       ORDER BY unit_id FOR UPDATE`,
      [orgId, today],
    );
    for (const r of res) {
      await t.run("UPDATE dev_reservations SET status = 'expired' WHERE id = $1", [r.id]);
      await t.run("UPDATE dev_units SET status = 'available' WHERE id = $1 AND status IN ('reserved', 'on_hold')", [
        r.unit_id,
      ]);
      if (r.offer_id) await t.run("UPDATE dev_offers SET status = 'expired' WHERE id = $1", [r.offer_id]);
    }
    for (const o of offers)
      await recordAudit(t, { actor: null, orgId, action: "Offer expired", target: o.id, detail: "validity ended" });
    for (const r of res)
      await recordAudit(t, {
        actor: null,
        orgId,
        action: "Reservation expired",
        target: r.id,
        detail: "unit released",
      });
    return { offersExpired: offers.length, reservationsExpired: res.length };
  }

  // ---------------------------------------------------------------- buyers
  async function findDuplicate(
    t: Db,
    orgId: string,
    b: { email?: string | null; phone?: string | null; nationalId?: string | null },
    except?: string,
  ) {
    const rows = await t.rows<{
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
      national_id: string | null;
    }>(
      `SELECT id, name, email, phone, national_id FROM dev_contacts
       WHERE org_id = $1 AND kind = 'buyer' AND status <> 'merged' AND ($2::text IS NULL OR id <> $2)`,
      [orgId, except ?? null],
    );
    const e = (b.email ?? "").toLowerCase();
    const p = last9(b.phone);
    const n = normId(b.nationalId);
    for (const r of rows) {
      const why =
        e && r.email && r.email.toLowerCase() === e
          ? "same email"
          : p.length === 9 && last9(r.phone) === p
            ? "same phone"
            : n && normId(r.national_id) === n
              ? "same ID number"
              : null;
      if (why) return { id: r.id, name: r.name, why };
    }
    return null;
  }

  /** The sales agent with the fewest active buyers (a member whose role sells but does not see every buyer). */
  async function leastLoadedAgent(t: Db, orgId: string): Promise<string | null> {
    const r = await t.row<{ user_id: string }>(
      `SELECT m.user_id FROM memberships m
       WHERE m.org_id = $1 AND m.status = 'active' AND m.role = 'sales_agent'
       ORDER BY (SELECT count(*) FROM dev_contacts c WHERE c.org_id = m.org_id AND c.agent_user_id = m.user_id
                 AND c.status = 'active'), m.user_id LIMIT 1`,
      [orgId],
    );
    return r?.user_id ?? null;
  }

  /**
   * The buyer in the organisation's ONE contact store: found by email or phone (or added as a prospect) and linked.
   * Buyers brought over by data migration are linked the first time they are worked on.
   */
  async function linkContact(t: Db, s: OrgScope, id: string): Promise<void> {
    const b = await t.row<BuyerRow>("SELECT * FROM dev_contacts WHERE id = $1", [id]);
    if (!b || b.contact_id || (!b.email && !b.phone)) return;
    const { contact } = await core.contacts.findOrCreate(
      t,
      s.orgId,
      {
        name: b.name,
        partyType: b.party_type === "company" ? "company" : "individual",
        email: b.email,
        phone: b.phone,
        address: b.address,
        types: ["prospect"],
      },
      s.actor,
    );
    await t.run("UPDATE dev_contacts SET contact_id = $2 WHERE id = $1", [id, contact.id]);
  }

  async function buyerOut(t: Db, s: OrgScope, id: string) {
    return toBuyer(await findBuyer(t, s, id));
  }

  async function moveBuyerStage(s: OrgScope, id: string, b: Body<typeof development.moveBuyerStage>) {
    return db.tx(async (t) => {
      const before = await findBuyer(t, s, id, true);
      if (before.pipeline_version !== b.version)
        throw fail.conflict("This lead changed. Refresh the board and try again.");
      if (!["enquiry", "contacted", "site_visit"].includes(before.stage))
        throw fail.conflict("This buyer has an offer, reservation or contract. Use the sales workflow to change it.");
      await t.run(
        "UPDATE dev_contacts SET pipeline_stage=$3,pipeline_version=pipeline_version+1 WHERE org_id=$1 AND id=$2",
        [s.orgId, id, b.stage],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Developer lead stage changed",
        target: id,
        before: { stage: before.stage, version: b.version },
        after: { stage: b.stage, version: b.version + 1 },
      });
      return toBuyer(await findBuyer(t, s, id));
    });
  }

  async function listBuyers(s: OrgScope, q?: string) {
    const rows = await db.rows<BuyerRow>(
      `${BUYER_SELECT} WHERE c.org_id = $1 AND c.kind = 'buyer' AND c.status <> 'merged'
         AND ($2::text IS NULL OR c.name ILIKE '%' || $2 || '%' OR c.email ILIKE '%' || $2 || '%' OR c.phone ILIKE '%' || $2 || '%')
       ORDER BY c.name`,
      [s.orgId, q ?? null],
    );
    return { buyers: rows.filter((b) => seesBuyer(s, b)).map(toBuyer) };
  }

  async function createBuyer(s: OrgScope, b: Body<typeof development.createBuyer>) {
    return db.tx(async (t) => {
      const d = await findDuplicate(t, s.orgId, b);
      if (d)
        throw fail.conflict(`Possible duplicate of ${d.name} (${d.why}) — open that buyer instead`, {
          duplicateId: d.id,
        });
      let agent: string | null;
      if (!can(s, "developer.buyers.all")) {
        // a sales agent's buyers are their own
        if (b.agentUserId && b.agentUserId !== s.userId) throw fail.forbidden("A sales agent records their own buyers");
        agent = s.userId;
      } else if (b.agentUserId) {
        await requireMember(t, s.orgId, b.agentUserId, "developer.sales");
        agent = b.agentUserId;
      } else agent = await leastLoadedAgent(t, s.orgId);
      const id = newId("dby");
      await t.run(
        `INSERT INTO dev_contacts (id, org_id, kind, name, email, phone, national_id, party_type, address, source,
           agent_user_id, status, next_follow_up, created_by)
         VALUES ($1, $2, 'buyer', $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11, $12)`,
        [
          id,
          s.orgId,
          b.name,
          b.email ?? null,
          b.phone ?? null,
          b.nationalId ?? null,
          b.partyType ?? "individual",
          b.address ?? null,
          b.source ?? null,
          agent,
          s.today,
          s.userId,
        ],
      );
      if (agent)
        await createTask(t, s.orgId, {
          title: `First contact with ${b.name}`,
          dueDate: s.today,
          priority: "high",
          category: "sales",
          assignee: agent,
          createdBy: s.userId,
          buyerId: id,
          key: `first:${id}`,
        });
      await linkContact(t, s, id);
      await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Buyer created", target: id, detail: b.name });
      return buyerOut(t, s, id);
    });
  }

  async function updateBuyer(s: OrgScope, id: string, b: Body<typeof development.updateBuyer>) {
    return db.tx(async (t) => {
      const cur = await findBuyer(t, s, id, true);
      if (cur.status === "merged") throw fail.conflict("This buyer was merged into another record");
      const merged = {
        email: b.email === undefined ? cur.email : b.email,
        phone: b.phone === undefined ? cur.phone : b.phone,
        nationalId: b.nationalId === undefined ? cur.national_id : b.nationalId,
      };
      if (!merged.email && !merged.phone) throw fail.invalid("Keep a phone number or an email");
      const d = await findDuplicate(t, s.orgId, merged, id);
      if (d) throw fail.conflict(`Would duplicate ${d.name} (${d.why})`, { duplicateId: d.id });
      if (b.nextFollowUp && b.nextFollowUp < s.today) throw fail.invalid("A follow-up cannot be in the past");
      const cols: Record<string, unknown> = {
        name: b.name,
        email: b.email,
        phone: b.phone,
        national_id: b.nationalId,
        party_type: b.partyType,
        address: b.address,
        source: b.source,
        status: b.status,
        next_follow_up: b.nextFollowUp,
      };
      const set = Object.entries(cols).filter(([, v]) => v !== undefined);
      if (!set.length) throw fail.invalid("Nothing to change");
      await t.run(`UPDATE dev_contacts SET ${set.map(([c], i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`, [
        id,
        ...set.map(([, v]) => v),
      ]);
      if (b.nextFollowUp && cur.agent_user_id)
        await createTask(t, s.orgId, {
          title: `Follow up with ${cur.name}`,
          dueDate: b.nextFollowUp,
          category: "sales",
          assignee: cur.agent_user_id,
          createdBy: s.userId,
          buyerId: id,
          key: `follow:${id}:${b.nextFollowUp}`,
        });
      await linkContact(t, s, id);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Buyer details changed",
        target: id,
        before: Object.fromEntries(set.map(([c]) => [c, (cur as unknown as Record<string, unknown>)[c]])),
        after: Object.fromEntries(set),
      });
      return buyerOut(t, s, id);
    });
  }

  async function assignBuyer(s: OrgScope, id: string, agent: string) {
    return db.tx(async (t) => {
      const b = await findBuyer(t, s, id, true);
      await requireMember(t, s.orgId, agent, "developer.sales");
      if (b.agent_user_id === agent) throw fail.conflict("The buyer is already assigned to that agent");
      await t.run("UPDATE dev_contacts SET agent_user_id = $2 WHERE id = $1", [id, agent]);
      // open work on the buyer follows them
      if (b.agent_user_id)
        await t.run(
          "UPDATE dev_tasks SET assignee_user_id = $3 WHERE org_id = $1 AND buyer_id = $2 AND status = 'open' AND assignee_user_id = $4",
          [s.orgId, id, agent, b.agent_user_id],
        );
      await t.run(
        "UPDATE dev_offers SET agent_user_id = $2 WHERE buyer_id = $1 AND status IN ('draft', 'awaiting_approval', 'submitted', 'counteroffer')",
        [id, agent],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Buyer reassigned",
        target: id,
        before: { agent: b.agent_user_id },
        after: { agent },
      });
      return buyerOut(t, s, id);
    });
  }

  async function mergeBuyers(s: OrgScope, keepId: string, dupId: string, reason: string) {
    if (keepId === dupId) throw fail.invalid("Pick two different buyers");
    return db.tx(async (t) => {
      const keep = await findBuyer(t, s, keepId, true);
      const dup = await findBuyer(t, s, dupId, true);
      if (keep.status === "merged" || dup.status === "merged")
        throw fail.conflict("One of these buyers is already merged");
      for (const table of [
        "dev_offers",
        "dev_reservations",
        "dev_contracts",
        "dev_payments",
        "dev_payment_reports",
        "dev_tasks",
        "dev_disputes",
        "dev_correspondence",
      ])
        await t.run(`UPDATE ${table} SET buyer_id = $2 WHERE org_id = $3 AND buyer_id = $1`, [dupId, keepId, s.orgId]);
      await t.run("UPDATE dev_contacts SET status = 'merged', merged_into = $2 WHERE id = $1", [dupId, keepId]);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Buyers merged",
        target: keepId,
        detail: `${dup.name} (${dupId}) merged in: ${reason}`,
      });
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Merged into another buyer",
        target: dupId,
        detail: keepId,
      });
      return buyerOut(t, s, keepId);
    });
  }

  // ---------------------------------------------------------------- correspondence and disputes
  const DELIVERY_NOTE = {
    sent: "Recorded — not sent: no e-mail, SMS or WhatsApp provider is connected",
    logged: "Recorded",
  };
  interface CorrRow {
    id: string;
    buyer_id: string | null;
    contract_id: string | null;
    date: string;
    channel: string | null;
    subject: string;
    summary: string | null;
  }
  const toCorr = (c: CorrRow): Out<typeof development.Correspondence> => ({
    id: c.id,
    buyerId: c.buyer_id,
    contractId: c.contract_id,
    date: c.date,
    channel: c.channel,
    subject: c.subject,
    summary: c.summary,
    delivery: ["email", "sms", "whatsapp"].includes(c.channel ?? "") ? DELIVERY_NOTE.sent : DELIVERY_NOTE.logged,
  });

  async function contractOfBuyer(t: Db, s: OrgScope, buyerId: string, contractId: string | null | undefined) {
    if (!contractId) return null;
    const k = await findContract(t, s, contractId);
    if (k.buyer_id !== buyerId) throw fail.invalid("That contract belongs to another buyer");
    return k.id;
  }

  async function recordCorrespondence(s: OrgScope, buyerId: string, b: Body<typeof development.recordCorrespondence>) {
    return db.tx(async (t) => {
      await findBuyer(t, s, buyerId);
      const contractId = await contractOfBuyer(t, s, buyerId, b.contractId);
      if (b.date && b.date > s.today) throw fail.invalid("Record what has happened (the date is in the future)");
      const id = newId("dco");
      await t.run(
        `INSERT INTO dev_correspondence (id, org_id, buyer_id, contract_id, date, channel, subject, summary, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, s.orgId, buyerId, contractId, b.date ?? s.today, b.channel, b.subject, b.summary ?? null, s.userId],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Contact recorded",
        target: buyerId,
        detail: `${b.channel}: ${b.subject}`,
      });
      return toCorr((await t.row<CorrRow>("SELECT * FROM dev_correspondence WHERE id = $1", [id])) as CorrRow);
    });
  }

  interface DisputeRow {
    id: string;
    buyer_id: string;
    contract_id: string | null;
    opened_date: string;
    subject: string;
    status: string | null;
    amount_minor: number | null;
    resolution: string | null;
  }
  const toDispute = (d: DisputeRow): Out<typeof development.Dispute> => ({
    id: d.id,
    buyerId: d.buyer_id,
    contractId: d.contract_id,
    openedDate: d.opened_date,
    subject: d.subject,
    status: d.status,
    amountMinor: d.amount_minor,
    resolution: d.resolution,
  });

  async function openDispute(s: OrgScope, buyerId: string, b: Body<typeof development.openDispute>) {
    return db.tx(async (t) => {
      await findBuyer(t, s, buyerId);
      const contractId = await contractOfBuyer(t, s, buyerId, b.contractId);
      const id = newId("dds");
      await t.run(
        `INSERT INTO dev_disputes (id, org_id, buyer_id, contract_id, opened_date, subject, status, amount_minor)
         VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)`,
        [id, s.orgId, buyerId, contractId, s.today, b.subject, b.amountMinor ?? null],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Dispute opened",
        target: buyerId,
        detail: b.subject,
      });
      return toDispute((await t.row<DisputeRow>("SELECT * FROM dev_disputes WHERE id = $1", [id])) as DisputeRow);
    });
  }

  async function resolveDispute(s: OrgScope, id: string, resolution: string) {
    return db.tx(async (t) => {
      const d = await t.row<DisputeRow>("SELECT * FROM dev_disputes WHERE org_id = $1 AND id = $2 FOR UPDATE", [
        s.orgId,
        id,
      ]);
      if (!d) throw fail.notFound("Dispute not found");
      await findBuyer(t, s, d.buyer_id);
      if (d.status !== "open") throw fail.conflict(`The dispute is already ${d.status ?? "closed"}`);
      await t.run("UPDATE dev_disputes SET status = 'resolved', resolution = $2, resolved_by = $3 WHERE id = $1", [
        id,
        resolution,
        s.userId,
      ]);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Dispute resolved",
        target: d.buyer_id,
        detail: resolution,
      });
      return toDispute((await t.row<DisputeRow>("SELECT * FROM dev_disputes WHERE id = $1", [id])) as DisputeRow);
    });
  }

  // ---------------------------------------------------------------- buyer profile
  async function getBuyer(s: OrgScope, id: string): Promise<Out<typeof development.BuyerProfile>> {
    const b = await findBuyer(db, s, id);
    const contracts = await Promise.all(
      (await contractRows(db, s, "AND k.buyer_id = $2", [id])).map((k) => toContract(db, k)),
    );
    const offers = await db.rows<OfferRow>(
      `${OFFER_SELECT} WHERE o.org_id = $1 AND o.buyer_id = $2 ORDER BY o.number`,
      [s.orgId, id],
    );
    const reservations = await db.rows<ReservationRow>(
      `${RESERVATION_SELECT} WHERE r.org_id = $1 AND r.buyer_id = $2 ORDER BY r.date, r.id`,
      [s.orgId, id],
    );
    const disputes = await db.rows<DisputeRow>(
      "SELECT * FROM dev_disputes WHERE org_id = $1 AND buyer_id = $2 ORDER BY opened_date",
      [s.orgId, id],
    );
    const corr = await db.rows<CorrRow>(
      "SELECT * FROM dev_correspondence WHERE org_id = $1 AND buyer_id = $2 ORDER BY date, id",
      [s.orgId, id],
    );
    const history = await db.rows<{ at: string; action: string; detail: string; actor_user: string | null }>(
      "SELECT at, action, detail, actor_user FROM audit_log WHERE org_id = $1 AND target = $2 ORDER BY id",
      [s.orgId, id],
    );
    let due = 0;
    let paid = 0;
    let overdue = 0;
    let outstanding = 0;
    for (const k of contracts.filter(isLive))
      for (const i of k.instalments) {
        paid += i.paidMinor;
        outstanding += i.openMinor;
        if (i.dueDate <= s.today) {
          due += i.amountMinor;
          overdue += i.openMinor;
        }
      }
    return {
      ...toBuyer(b),
      contracts,
      offers: offers.map(toOffer),
      reservations: reservations.map(toReservation),
      disputes: disputes.map(toDispute),
      correspondence: corr.map(toCorr),
      money: { dueMinor: due, paidMinor: paid, overdueMinor: overdue, outstandingMinor: outstanding },
      history: history.map((h) => ({ at: h.at, action: h.action, detail: h.detail, actorUserId: h.actor_user })),
    };
  }

  // ---------------------------------------------------------------- offers
  async function findOffer(t: Db, s: OrgScope, id: string, lock = false): Promise<OfferRow> {
    if (lock) await t.run("SELECT 1 FROM dev_offers WHERE org_id = $1 AND id = $2 FOR UPDATE", [s.orgId, id]);
    const o = await t.row<OfferRow>(`${OFFER_SELECT} WHERE o.org_id = $1 AND o.id = $2`, [s.orgId, id]);
    if (!o || !seesBuyer(s, { agent_user_id: o.buyer_agent })) throw fail.notFound("Offer not found");
    return o;
  }
  const reload = async (t: Db, s: OrgScope, id: string) => toOffer(await findOffer(t, s, id));

  async function listOffers(s: OrgScope, q: { status?: string | undefined; buyerId?: string | undefined }) {
    await db.tx((t) => expireDue(t, s.orgId, s.today));
    const rows = await db.rows<OfferRow>(
      `${OFFER_SELECT} WHERE o.org_id = $1 AND ($2::text IS NULL OR o.status = $2) AND ($3::text IS NULL OR o.buyer_id = $3)
       ORDER BY o.number`,
      [s.orgId, q.status ?? null, q.buyerId ?? null],
    );
    return { offers: rows.filter((o) => seesBuyer(s, { agent_user_id: o.buyer_agent })).map(toOffer) };
  }

  async function createOffer(s: OrgScope, b: Body<typeof development.createOffer>) {
    return db.tx(async (t) => {
      const buyer = await findBuyer(t, s, b.buyerId);
      if (buyer.status !== "active") throw fail.conflict(`This buyer is ${buyer.status}`);
      await linkContact(t, s, buyer.id);
      const u = await findUnit(t, s.orgId, b.unitId, true);
      if (u.status !== "available")
        throw fail.conflict(`Unit ${u.unit_no} is ${u.status.replace("_", " ")} — it cannot take a new offer`);
      if (!u.list_price_minor) throw fail.conflict(`Unit ${u.unit_no} has no list price`);
      const open = await t.row("SELECT 1 FROM dev_offers WHERE buyer_id = $1 AND unit_id = $2 AND status = ANY($3)", [
        buyer.id,
        u.id,
        OPEN_OFFER,
      ]);
      if (open) throw fail.conflict("This buyer already has an open offer on this unit");
      // a typing slip of an extra digit is caught here
      if (b.priceMinor > Math.round(u.list_price_minor * 1.2))
        throw fail.invalid("The price is far above the asking price — check the figure");
      const id = newId("dof");
      await t.run(
        `INSERT INTO dev_offers (id, org_id, number, buyer_id, unit_id, project_id, asking_minor, price_minor, deposit_bp,
           instalments_bp, months, completion_bp, valid_days, conditions, status, agent_user_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'draft', $15, $16)`,
        [
          id,
          s.orgId,
          await nextNumber(t, s.orgId, "OFR"),
          buyer.id,
          u.id,
          u.project_id,
          u.list_price_minor,
          b.priceMinor,
          b.plan.depositBp,
          b.plan.instalmentsBp,
          b.plan.months,
          b.plan.completionBp,
          b.validDays,
          b.conditions,
          buyer.agent_user_id ?? s.userId,
          s.userId,
        ],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Offer drafted",
        target: buyer.id,
        detail: `${id} on ${u.unit_no}`,
      });
      return reload(t, s, id);
    });
  }

  async function reviseOffer(s: OrgScope, id: string, b: Body<typeof development.reviseOffer>) {
    return db.tx(async (t) => {
      const o = await findOffer(t, s, id, true);
      if (!["draft", "counteroffer"].includes(o.status))
        throw fail.conflict("Only a draft or countered offer can be revised");
      const next: OfferRow = {
        ...o,
        price_minor: b.priceMinor ?? o.price_minor,
        deposit_bp: b.plan?.depositBp ?? o.deposit_bp,
        instalments_bp: b.plan?.instalmentsBp ?? o.instalments_bp,
        months: b.plan?.months ?? o.months,
        completion_bp: b.plan?.completionBp ?? o.completion_bp,
        valid_days: b.validDays ?? o.valid_days,
        conditions: b.conditions ?? o.conditions,
      };
      if (termsOf(next) === termsOf(o)) throw fail.invalid("Nothing changed");
      await t.run(
        `UPDATE dev_offers SET price_minor = $2, deposit_bp = $3, instalments_bp = $4, months = $5, completion_bp = $6,
           valid_days = $7, conditions = $8, round = round + $9, status = 'draft', approval_level = NULL,
           approval_status = NULL, approval_terms = NULL, approval_after = NULL, approval_requested_by = NULL,
           approval_decided_by = NULL, approval_reason = NULL
         WHERE id = $1`,
        [
          id,
          next.price_minor,
          next.deposit_bp,
          next.instalments_bp,
          next.months,
          next.completion_bp,
          next.valid_days,
          next.conditions,
          o.status === "counteroffer" ? 1 : 0,
        ],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Offer revised",
        target: o.buyer_id,
        detail: o.number,
        before: toOffer(o),
        after: toOffer(next),
      });
      return reload(t, s, id);
    });
  }

  /** Send for approval when the terms need it (and are not approved exactly as they stand); null otherwise. */
  async function needsApproval(t: Db, s: OrgScope, o: OfferRow, after: "submit" | "accept"): Promise<boolean> {
    const level = approvalLevel(o, await settingsRow(t, s.orgId));
    if (!level) return false;
    if (o.approval_status === "approved" && o.approval_terms === termsOf(o) && o.approval_level === level) return false;
    await t.run(
      `UPDATE dev_offers SET status = 'awaiting_approval', approval_level = $2, approval_status = 'pending',
         approval_terms = $3, approval_after = $4, approval_requested_by = $5, approval_decided_by = NULL,
         approval_reason = NULL WHERE id = $1`,
      [o.id, level, termsOf(o), after, s.userId],
    );
    await recordAudit(t, {
      actor: s.actor,
      orgId: s.orgId,
      action: "Offer sent for approval",
      target: o.buyer_id,
      detail: `${o.number}: ${level === "executive" ? "chief executive" : "sales manager"} — ${(discountBp(o.asking_minor, o.price_minor) / 100).toFixed(2)}% discount`,
    });
    return true;
  }

  async function submit(t: Db, s: OrgScope, o: OfferRow) {
    const u = await findUnit(t, s.orgId, o.unit_id);
    if (u.status !== "available") throw fail.conflict(`Unit ${u.unit_no} is ${u.status.replace("_", " ")}`);
    if (await needsApproval(t, s, o, "submit")) return;
    await t.run("UPDATE dev_offers SET status = 'submitted', valid_until = $2 WHERE id = $1", [
      o.id,
      addDays(s.today, o.valid_days),
    ]);
    await recordAudit(t, {
      actor: s.actor,
      orgId: s.orgId,
      action: "Offer sent to the buyer",
      target: o.buyer_id,
      detail: o.number,
    });
  }

  async function submitOffer(s: OrgScope, id: string) {
    return db.tx(async (t) => {
      const o = await findOffer(t, s, id, true);
      if (o.status !== "draft") throw fail.conflict("Only a draft offer can be submitted");
      await submit(t, s, o);
      return reload(t, s, id);
    });
  }

  async function decideOffer(s: OrgScope, id: string, approve: boolean, reason?: string) {
    return db.tx(async (t) => {
      const o = await findOffer(t, s, id, true);
      if (o.status !== "awaiting_approval" || !o.approval_level)
        throw fail.conflict("This offer is not awaiting approval");
      const ok = can(s, "developer.executive") || (o.approval_level === "manager" && can(s, "developer.sales.manage"));
      if (!ok)
        throw fail.roleNotAllowed(
          o.approval_level === "executive"
            ? "These terms need the chief executive"
            : "These terms need a sales manager",
        );
      if ([o.created_by, o.agent_user_id, o.approval_requested_by].includes(s.userId))
        throw fail.separationOfDuties("You prepared or own this offer — someone else approves it");
      if (!approve) {
        if (!reason || reason.length < 5) throw fail.invalid("Give the reason for declining (at least 5 characters)");
        await t.run(
          `UPDATE dev_offers SET approval_status = 'declined', approval_decided_by = $2, approval_reason = $3,
             status = CASE WHEN approval_after = 'accept' THEN 'counteroffer' ELSE 'draft' END WHERE id = $1`,
          [id, s.userId, reason],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Offer terms declined",
          target: o.buyer_id,
          detail: `${o.number}: ${reason}`,
        });
        return reload(t, s, id);
      }
      await t.run(
        `UPDATE dev_offers SET approval_status = 'approved', approval_decided_by = $2, approval_reason = $3 WHERE id = $1`,
        [id, s.userId, reason ?? null],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Offer terms approved",
        target: o.buyer_id,
        detail: o.number,
      });
      const fresh = await findOffer(t, s, id);
      if (o.approval_after === "accept") await accept(t, s, fresh);
      else await submit(t, s, fresh);
      return reload(t, s, id);
    });
  }

  /** The buyer accepted: the unit goes on hold and a reservation awaits a sales manager's approval. */
  async function accept(t: Db, s: OrgScope, o: OfferRow) {
    const level = approvalLevel(o, await settingsRow(t, s.orgId));
    if (level && !(o.approval_status === "approved" && o.approval_terms === termsOf(o)))
      throw fail.conflict("These terms are not approved");
    const u = await findUnit(t, s.orgId, o.unit_id, true);
    if (u.status !== "available")
      throw fail.conflict(`Unit ${u.unit_no} is already ${u.status.replace("_", " ")} — no double booking`);
    const rid = newId("drs");
    await t.run(
      `INSERT INTO dev_reservations (id, org_id, unit_id, buyer_id, date, status, offer_id, requested_by)
       VALUES ($1, $2, $3, $4, $5, 'awaiting_approval', $6, $7)`,
      [rid, s.orgId, u.id, o.buyer_id, s.today, o.id, s.userId],
    );
    await t.run("UPDATE dev_units SET status = 'on_hold' WHERE id = $1", [u.id]);
    await t.run("UPDATE dev_offers SET status = 'accepted', reservation_id = $2 WHERE id = $1", [o.id, rid]);
    if (o.agent_user_id)
      await createTask(t, s.orgId, {
        title: `Prepare the sale agreement for unit ${u.unit_no}`,
        dueDate: addDays(s.today, 3),
        priority: "high",
        category: "sales",
        assignee: o.agent_user_id,
        createdBy: s.userId,
        buyerId: o.buyer_id,
        unitId: u.id,
        projectId: u.project_id,
        key: `contract:${o.id}`,
      });
    await recordAudit(t, {
      actor: s.actor,
      orgId: s.orgId,
      action: "Offer accepted",
      target: o.buyer_id,
      detail: `${o.number} · unit ${u.unit_no} on hold`,
    });
  }

  async function respond(s: OrgScope, id: string, b: Body<typeof development.respondToOffer>) {
    return db.tx(async (t) => {
      await expireDue(t, s.orgId, s.today);
      const o = await findOffer(t, s, id, true);
      if (o.status === "expired") throw fail.conflict("The offer has expired");
      if (o.status !== "submitted") throw fail.conflict("The buyer can only answer a submitted offer");
      if (b.response === "accept") await accept(t, s, o);
      else if (b.response === "reject") {
        await t.run("UPDATE dev_offers SET status = 'rejected' WHERE id = $1", [id]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Offer rejected by the buyer",
          target: o.buyer_id,
          detail: `${o.number} ${b.note ?? ""}`.trim(),
        });
      } else {
        if (!b.counter) throw fail.invalid("Give the buyer's counteroffer");
        await t.run("UPDATE dev_offers SET status = 'counteroffer', counter = $2 WHERE id = $1", [
          id,
          JSON.stringify(b.counter),
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Buyer counteroffer",
          target: o.buyer_id,
          detail: `${o.number}: ${b.counter.priceMinor}`,
        });
      }
      return reload(t, s, id);
    });
  }

  async function acceptCounter(s: OrgScope, id: string) {
    return db.tx(async (t) => {
      const o = await findOffer(t, s, id, true);
      if (o.status !== "counteroffer" || !o.counter) throw fail.conflict("There is no counteroffer to accept");
      const c = o.counter;
      await t.run(
        `UPDATE dev_offers SET price_minor = $2, deposit_bp = $3, instalments_bp = $4, months = $5, completion_bp = $6,
           counter = NULL WHERE id = $1`,
        [id, c.priceMinor, c.plan.depositBp, c.plan.instalmentsBp, c.plan.months, c.plan.completionBp],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Counteroffer terms adopted",
        target: o.buyer_id,
        detail: o.number,
      });
      const fresh = await findOffer(t, s, id);
      if (!(await needsApproval(t, s, fresh, "accept"))) await accept(t, s, fresh);
      return reload(t, s, id);
    });
  }

  async function withdrawOffer(s: OrgScope, id: string, reason: string) {
    return db.tx(async (t) => {
      const o = await findOffer(t, s, id, true);
      if (!OPEN_OFFER.includes(o.status)) throw fail.conflict("The offer is not open");
      await t.run("UPDATE dev_offers SET status = 'withdrawn' WHERE id = $1", [id]);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Offer withdrawn",
        target: o.buyer_id,
        detail: `${o.number}: ${reason}`,
      });
      return reload(t, s, id);
    });
  }

  // ---------------------------------------------------------------- reservations
  async function findReservation(t: Db, s: OrgScope, id: string, lock = false): Promise<ReservationRow> {
    if (lock) await t.run("SELECT 1 FROM dev_reservations WHERE org_id = $1 AND id = $2 FOR UPDATE", [s.orgId, id]);
    const r = await t.row<ReservationRow>(`${RESERVATION_SELECT} WHERE r.org_id = $1 AND r.id = $2`, [s.orgId, id]);
    if (!r || !seesBuyer(s, r)) throw fail.notFound("Reservation not found");
    return r;
  }

  async function listReservations(s: OrgScope, status?: string) {
    await db.tx((t) => expireDue(t, s.orgId, s.today));
    const rows = await db.rows<ReservationRow>(
      `${RESERVATION_SELECT} WHERE r.org_id = $1 AND ($2::text IS NULL OR r.status = $2) ORDER BY r.date, r.id`,
      [s.orgId, status ?? null],
    );
    return { reservations: rows.filter((r) => seesBuyer(s, r)).map(toReservation) };
  }

  async function approveReservation(s: OrgScope, id: string) {
    return db.tx(async (t) => {
      const r = await findReservation(t, s, id, true);
      if (r.status !== "awaiting_approval") throw fail.conflict("This reservation is not awaiting approval");
      const o = r.offer_id ? await findOffer(t, s, r.offer_id) : null;
      if ([o?.agent_user_id, o?.created_by, r.requested_by].includes(s.userId))
        throw fail.separationOfDuties("You own this sale — another manager approves the reservation");
      const u = await findUnit(t, s.orgId, r.unit_id, true);
      if (u.status !== "on_hold") throw fail.conflict(`Unit ${u.unit_no} is not on hold for this offer`);
      const days = (await settingsRow(t, s.orgId)).reservation_days;
      const expiry = addDays(s.today, days);
      await t.run("UPDATE dev_reservations SET status = 'active', expiry_date = $2, approved_by = $3 WHERE id = $1", [
        id,
        expiry,
        s.userId,
      ]);
      await t.run("UPDATE dev_units SET status = 'reserved' WHERE id = $1", [u.id]);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Reservation approved",
        target: r.buyer_id,
        detail: `unit ${u.unit_no} reserved until ${expiry}`,
      });
      return toReservation(await findReservation(t, s, id));
    });
  }

  async function cancelReservation(s: OrgScope, id: string, reason: string) {
    return db.tx(async (t) => {
      const r = await findReservation(t, s, id, true);
      if (!OPEN_RESERVATION.includes(r.status)) throw fail.conflict("The reservation is not open");
      await t.run("UPDATE dev_reservations SET status = 'cancelled', cancel_reason = $2 WHERE id = $1", [id, reason]);
      await t.run("UPDATE dev_units SET status = 'available' WHERE id = $1 AND status IN ('on_hold', 'reserved')", [
        r.unit_id,
      ]);
      if (r.offer_id) await t.run("UPDATE dev_offers SET status = 'withdrawn' WHERE id = $1", [r.offer_id]);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Reservation cancelled",
        target: r.buyer_id,
        detail: reason,
      });
      return toReservation(await findReservation(t, s, id));
    });
  }

  // ---------------------------------------------------------------- the signed sale agreement
  async function signContract(s: OrgScope, reservationId: string, b: Body<typeof development.signContract>) {
    return db.tx(async (t) => {
      await expireDue(t, s.orgId, s.today);
      const r = await findReservation(t, s, reservationId, true);
      if (r.status === "expired") throw fail.conflict("The reservation has expired");
      if (r.status !== "active") throw fail.conflict("The reservation must be approved and active");
      if (b.date > s.today) throw fail.invalid("The signing date cannot be in the future");
      await requireDocument(t, s.orgId, b.signedDocumentId);
      let price: number;
      let plan: Plan;
      if (r.offer_id) {
        if (b.priceMinor !== undefined || b.plan) throw fail.invalid("The price and plan come from the accepted offer");
        const o = await findOffer(t, s, r.offer_id);
        price = o.price_minor;
        plan = planOf(o);
      } else {
        // a reservation brought over by data migration has no offer: the agreed terms are given here
        if (b.priceMinor === undefined || !b.plan) throw fail.invalid("Give the agreed price and payment plan");
        price = b.priceMinor;
        plan = b.plan;
      }
      const u = await findUnit(t, s.orgId, r.unit_id, true);
      if (u.status !== "reserved") throw fail.conflict(`Unit ${u.unit_no} is ${u.status.replace("_", " ")}`);
      const live = await t.row(
        "SELECT 1 FROM dev_contracts WHERE unit_id = $1 AND status IS DISTINCT FROM 'cancelled'",
        [u.id],
      );
      if (live) throw fail.conflict("A contract already exists for this unit");
      const p = await findProject(t, s.orgId, u.project_id);
      const end = p.end_date ?? p.forecast_end_date ?? addMonths(b.date, plan.months + 1);
      const id = newId("dct");
      await t.run(
        `INSERT INTO dev_contracts (id, org_id, unit_id, buyer_id, reservation_id, offer_id, number, date, price_minor, status,
           deposit_bp, instalments_bp, months, completion_bp, signed_document_id, signed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11, $12, $13, $14, $15)`,
        [
          id,
          s.orgId,
          u.id,
          r.buyer_id,
          r.id,
          r.offer_id,
          b.number ?? (await nextNumber(t, s.orgId, "SA")),
          b.date,
          price,
          plan.depositBp,
          plan.instalmentsBp,
          plan.months,
          plan.completionBp,
          b.signedDocumentId,
          s.userId,
        ],
      );
      let seq = 0;
      for (const i of schedule(price, plan, b.date, end))
        await t.run(
          `INSERT INTO dev_instalments (id, org_id, contract_id, seq, due_date, amount_minor, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [newId("din"), s.orgId, id, ++seq, i.due, i.amount, i.description],
        );
      await t.run("UPDATE dev_reservations SET status = 'converted' WHERE id = $1", [r.id]);
      await t.run("UPDATE dev_units SET status = 'sold' WHERE id = $1", [u.id]);
      await linkDocument(t, s.orgId, b.signedDocumentId, "contract", id);
      if (r.offer_id) await closeTask(t, s.orgId, `contract:${r.offer_id}`, s.userId, "agreement signed");
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Sale agreement signed",
        target: r.buyer_id,
        detail: `unit ${u.unit_no} · ${price} · ${seq} instalments`,
      });
      return toContract(t, await findContract(t, s, id));
    });
  }

  async function listContracts(s: OrgScope, q: { projectId?: string | undefined; buyerId?: string | undefined }) {
    const rows = await contractRows(
      db,
      s,
      "AND ($2::text IS NULL OR u.project_id = $2) AND ($3::text IS NULL OR k.buyer_id = $3)",
      [q.projectId ?? null, q.buyerId ?? null],
    );
    return { contracts: await Promise.all(rows.map((k) => toContract(db, k))) };
  }

  return {
    expire: (s: OrgScope) => db.tx((t) => expireDue(t, s.orgId, s.today)),
    listBuyers,
    moveBuyerStage,
    createBuyer,
    getBuyer,
    updateBuyer,
    assignBuyer,
    mergeBuyers,
    recordCorrespondence,
    openDispute,
    resolveDispute,
    listOffers,
    createOffer,
    reviseOffer,
    submitOffer,
    decideOffer,
    respond,
    acceptCounter,
    withdrawOffer,
    listReservations,
    approveReservation,
    cancelReservation,
    signContract,
    listContracts,
  };
}

export type SalesService = ReturnType<typeof salesService>;
