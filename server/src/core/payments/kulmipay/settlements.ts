/** Manual bank-statement settlement matching: prepare, independent approval, then clearing → bank. Never sends money. */
import { createHash } from "node:crypto";
import type { Db } from "../../../db/database.js";
import type { OrgScope } from "../../access/org-access.js";
import { recordAudit } from "../../audit/audit.service.js";
import type { PmDeps } from "../../../products/property/deps.js";
import { financeTransaction } from "../../../products/property/shared/finance-transaction.js";
import { ACC } from "../../../products/property/accounts.js";
import { cr, dr, post } from "../../../products/property/shared/posting.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
interface Line {
  id: string;
  date: string;
  amount_minor: number;
  reference: string;
  account_code: string;
  status: string;
  imported_by: string;
}
interface Request {
  id: string;
  net_minor: number;
  fee_minor: number;
  amount_minor: number;
  ledger_payment_id: string;
  settlement_id: string | null;
  posting_error: string | null;
  state: string;
}
interface Snapshot {
  line: Line;
  requests: Request[];
}
interface Settlement {
  id: string;
  bank_line_id: string;
  amount_minor: number;
  reason: string;
  snapshot_hash: string;
  snapshot_data: Snapshot;
  status: "prepared" | "approved" | "rejected";
  prepared_by: string;
  approved_by: string | null;
  rejected_reason: string | null;
  journal_id: string | null;
}
const hash = (s: Snapshot) => createHash("sha256").update(JSON.stringify(s)).digest("hex");
const dto = (r: Settlement) => ({
  id: r.id,
  bankLineId: r.bank_line_id,
  amountMinor: r.amount_minor,
  reason: r.reason,
  status: r.status,
  preparedBy: r.prepared_by,
  approvedBy: r.approved_by,
  rejectedReason: r.rejected_reason,
  journalId: r.journal_id,
  bankReference: r.snapshot_data.line.reference,
  date: r.snapshot_data.line.date,
  requestIds: r.snapshot_data.requests.map((x) => x.id),
});
export function kulmiSettlements(d: PmDeps) {
  const { db } = d.ctx;
  function scope(s: OrgScope) {
    if (s.propertyIds) throw fail.forbidden("Company-wide bank settlement requires unrestricted finance authority");
    if (s.entitlement.org.currency !== "KES")
      throw fail.invalid("KulmiPay bank settlements require a KES organisation");
  }
  async function snapshot(t: Db, org: string, lineId: string, ids: string[]): Promise<Snapshot> {
    const line = await t.row<Line>(
      "SELECT id,date::text,amount_minor,reference,account_code,status,imported_by FROM pm_bank_lines WHERE org_id=$1 AND id=$2 FOR UPDATE",
      [org, lineId],
    );
    if (!line) throw fail.notFound("Bank statement line not found");
    const requests = await t.rows<Request>(
      "SELECT id,net_minor,fee_minor,amount_minor,ledger_payment_id,settlement_id,posting_error,state FROM pm_kulmipay_requests WHERE org_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE",
      [org, ids],
    );
    if (requests.length !== ids.length) throw fail.notFound("A collection request was not found in this organisation");
    return { line, requests };
  }
  const valid = (s: Snapshot, today: string, ownId?: string) => {
    if (
      s.line.status !== "unmatched" ||
      s.line.account_code !== ACC.clientBank ||
      s.line.date > today ||
      s.line.amount_minor <= 0
    )
      throw fail.conflict("Choose an unmatched incoming client-bank statement line dated today or earlier");
    let total = 0n;
    for (const r of s.requests) {
      if (
        r.state !== "COMPLETE" ||
        !r.ledger_payment_id ||
        r.posting_error ||
        (r.settlement_id && r.settlement_id !== ownId) ||
        r.net_minor <= 0
      )
        throw fail.conflict(
          "Only posted, positive-net collections without unresolved issues or another settlement can be matched",
        );
      total += BigInt(r.net_minor);
    }
    if (total !== BigInt(s.line.amount_minor))
      throw fail.conflict(
        "The selected net collections do not equal this bank statement amount; review fees and the provider payout batch",
      );
  };
  async function get(s: OrgScope, id: string) {
    scope(s);
    const r = await db.row<Settlement>("SELECT * FROM pm_kulmipay_settlements WHERE org_id=$1 AND id=$2", [
      s.orgId,
      id,
    ]);
    if (!r) throw fail.notFound("Settlement review not found");
    return dto(r);
  }
  return {
    get,
    async list(s: OrgScope) {
      scope(s);
      return {
        settlements: (
          await db.rows<Settlement>(
            "SELECT * FROM pm_kulmipay_settlements WHERE org_id=$1 ORDER BY prepared_at DESC,id DESC LIMIT 100",
            [s.orgId],
          )
        ).map(dto),
      };
    },
    async prepare(s: OrgScope, b: { bankLineId: string; requestIds: string[]; reason: string }) {
      scope(s);
      if (!b.requestIds.length || new Set(b.requestIds).size !== b.requestIds.length)
        throw fail.invalid("Choose each collection once");
      const id = newId("kps");
      await financeTransaction(db, s.orgId, async (t) => {
        const snap = await snapshot(t, s.orgId, b.bankLineId, b.requestIds);
        valid(snap, s.today);
        if (
          await t.row(
            "SELECT id FROM pm_kulmipay_settlements WHERE org_id=$1 AND bank_line_id=$2 AND status IN ('prepared','approved')",
            [s.orgId, b.bankLineId],
          )
        )
          throw fail.conflict("This bank line already has a settlement review");
        // Freeze the request membership into the snapshot; rejection can release it without erasing this history.
        snap.requests = snap.requests.map((r) => ({ ...r, settlement_id: id }));
        await t.run(
          "INSERT INTO pm_kulmipay_settlements(id,org_id,bank_line_id,amount_minor,reason,snapshot_hash,snapshot_data,status,prepared_by) VALUES($1,$2,$3,$4,$5,$6,$7,'prepared',$8)",
          [id, s.orgId, b.bankLineId, snap.line.amount_minor, b.reason, hash(snap), JSON.stringify(snap), s.userId],
        );
        await t.run("UPDATE pm_kulmipay_requests SET settlement_id=$3 WHERE org_id=$1 AND id=ANY($2)", [
          s.orgId,
          b.requestIds,
          id,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "KulmiPay bank settlement prepared",
          target: id,
          detail: b.reason,
        });
      });
      return get(s, id);
    },
    async approve(s: OrgScope, id: string) {
      scope(s);
      await financeTransaction(db, s.orgId, async (t) => {
        const r = await t.row<Settlement>(
          "SELECT * FROM pm_kulmipay_settlements WHERE org_id=$1 AND id=$2 FOR UPDATE",
          [s.orgId, id],
        );
        if (!r) throw fail.notFound("Settlement review not found");
        if (r.status === "approved") return;
        if (r.status !== "prepared") throw fail.conflict("This review was rejected; prepare a new review");
        const snap = await snapshot(
          t,
          s.orgId,
          r.bank_line_id,
          r.snapshot_data.requests.map((x) => x.id),
        );
        valid(snap, s.today, id);
        if (r.prepared_by === s.userId || snap.line.imported_by === s.userId)
          throw fail.separationOfDuties(
            "Another authorised person must approve a settlement prepared or imported by you",
          );
        if (hash(snap) !== r.snapshot_hash)
          throw fail.conflict("The source records changed. Reject and prepare a fresh settlement review");
        const journal = await post(t, d.core, {
          orgId: s.orgId,
          date: snap.line.date,
          kind: "provider_settlement",
          memo: `Verified manual bank-statement match for KulmiPay collections: ${snap.line.reference}`,
          ref: `kulmi-settlement:${id}`,
          link: {},
          lines: [
            dr(ACC.clientBank, r.amount_minor, "Net client funds received in bank"),
            cr(ACC.providerClearing, r.amount_minor, "Client-owned KulmiPay funds settled"),
          ],
        });
        await t.run(
          "UPDATE pm_bank_lines SET status='matched',matched_kind='provider_settlement',matched_id=$3,decided_by=$4,decided_at=now() WHERE org_id=$1 AND id=$2",
          [s.orgId, r.bank_line_id, id, s.userId],
        );
        await t.run(
          "UPDATE pm_kulmipay_settlements SET status='approved',approved_by=$3,approved_at=now(),journal_id=$4 WHERE org_id=$1 AND id=$2",
          [s.orgId, id, s.userId, journal],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "KulmiPay bank settlement approved",
          target: id,
          detail:
            "Clearing transferred to bank ledger from an independently reviewed statement match; no provider payout was initiated",
        });
      });
      return get(s, id);
    },
    async reject(s: OrgScope, id: string, reason: string) {
      scope(s);
      await financeTransaction(db, s.orgId, async (t) => {
        const r = await t.row<Settlement>(
          "SELECT * FROM pm_kulmipay_settlements WHERE org_id=$1 AND id=$2 FOR UPDATE",
          [s.orgId, id],
        );
        if (!r) throw fail.notFound("Settlement review not found");
        if (r.status === "approved")
          throw fail.conflict(
            "An approved settlement requires an accountant's correction; it cannot be silently removed",
          );
        if (r.status === "rejected") return;
        await t.run(
          "UPDATE pm_kulmipay_settlements SET status='rejected',rejected_by=$3,rejected_reason=$4 WHERE org_id=$1 AND id=$2",
          [s.orgId, id, s.userId, reason],
        );
        await t.run("UPDATE pm_kulmipay_requests SET settlement_id=NULL WHERE org_id=$1 AND settlement_id=$2", [
          s.orgId,
          id,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "KulmiPay bank settlement rejected",
          target: id,
          detail: reason,
        });
      });
      return get(s, id);
    },
  };
}
