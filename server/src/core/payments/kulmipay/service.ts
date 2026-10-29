import { kulmiPosting } from "./posting.js";
/** Client-owned collections. Authoritative confirmations post through shared PM receipts; bank settlement stays separate. */
import { createHash } from "node:crypto";
import type { OrgScope } from "../../access/org-access.js";
import { recordAudit } from "../../audit/audit.service.js";
import type { PmDeps } from "../../../products/property/deps.js";
import { financeTransaction } from "../../../products/property/shared/finance-transaction.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import {
  kulmiPayClient,
  KulmiPayError,
  verifyKulmiChallenge,
  type KulmiCollection,
  type KulmiCredentials,
} from "./client.js";
interface Connection {
  org_id: string;
  environment: "sandbox" | "live";
  wallet_id: string;
  secret_sealed: string;
  challenge_sealed: string;
  active: boolean;
  connected_at: string;
}
interface RequestRow {
  id: string;
  org_id: string;
  invoice_id: string;
  property_id: string;
  provider: "M-PESA" | "PESALINK";
  environment: "sandbox" | "live";
  wallet_id: string;
  amount_minor: number;
  provider_invoice_id: string | null;
  state: string;
  fee_minor: number | null;
  net_minor: number | null;
  clearing_status: string | null;
  receipt_reference: string | null;
  checked_at: string | null;
  ledger_payment_id: string | null;
  posting_error: string | null;
  settlement_id: string | null;
  provider_confirmed_at: string | null;
}
const connectionDto = (c: Connection) => ({
  environment: c.environment,
  walletId: c.wallet_id,
  active: c.active,
  connectedAt: c.connected_at,
});
const requestDto = (r: RequestRow) => ({
  id: r.id,
  invoiceId: r.invoice_id,
  provider: r.provider,
  environment: r.environment,
  amountMinor: r.amount_minor,
  state: r.state,
  feeMinor: r.fee_minor,
  netMinor: r.net_minor,
  clearingStatus: r.clearing_status,
  receiptReference: r.receipt_reference,
  checkedAt: r.checked_at,
  ledgerPosted: !!r.ledger_payment_id,
  paymentId: r.ledger_payment_id,
  postingError: r.posting_error,
  settlementId: r.settlement_id,
});
export function kulmiPayService(d: PmDeps, client = kulmiPayClient()) {
  const postConfirmed = kulmiPosting(d);
  const { ctx } = d,
    { db, secrets } = ctx;
  const configured = () => {
    if (!ctx.config.kulmiPay?.enabled) throw fail.conflict("KulmiPay is not enabled on this PALTAS installation");
  };
  const credentials = (c: Connection): KulmiCredentials => ({
    environment: c.environment,
    walletId: c.wallet_id,
    secretKey: secrets.open(c.secret_sealed),
  });
  const connection = async (org: string) => {
    const c = await db.row<Connection>("SELECT * FROM pm_kulmipay_connections WHERE org_id=$1", [org]);
    if (!c) throw fail.notFound("Connect this company's own KulmiPay account first");
    return c;
  };
  const scoped = (s: OrgScope, propertyId: string) => {
    if (s.propertyIds && !s.propertyIds.includes(propertyId)) throw fail.notFound("Collection request not found");
  };
  const get = async (s: OrgScope, id: string) => {
    const r = await db.row<RequestRow>("SELECT * FROM pm_kulmipay_requests WHERE org_id=$1 AND id=$2", [s.orgId, id]);
    if (!r) throw fail.notFound("Collection request not found");
    scoped(s, r.property_id);
    return r;
  };
  async function saveResult(r: RequestRow, v: KulmiCollection) {
    return financeTransaction(db, r.org_id, async (t) => {
      const current = await t.row<RequestRow>(
        "SELECT * FROM pm_kulmipay_requests WHERE org_id=$1 AND id=$2 FOR UPDATE",
        [r.org_id, r.id],
      );
      if (!current) throw fail.notFound("Collection request not found");
      if (
        v.confirmed &&
        v.provider === "M-PESA" &&
        v.receiptReference &&
        (await t.row(
          "SELECT id FROM pm_kulmipay_requests WHERE org_id=$1 AND environment=$2 AND id<>$3 AND state='COMPLETE' AND provider='M-PESA' AND upper(btrim(receipt_reference))=upper(btrim($4))",
          [r.org_id, current.environment, r.id, v.receiptReference],
        ))
      )
        throw fail.conflict(
          "This M-Pesa receipt is already linked to another collection. Investigate before recording money again",
        );
      // Bind once; a delayed response cannot replace the transaction being checked.
      if (current.provider_invoice_id && current.provider_invoice_id !== v.invoiceId)
        throw fail.conflict("Provider invoice binding does not match");
      if (
        current.ledger_payment_id &&
        ((v.state === "COMPLETE" && (current.fee_minor !== v.feeMinor || current.net_minor !== v.netMinor)) ||
          ["FAILED", "CANCELED"].includes(v.state))
      ) {
        await t.run("UPDATE pm_kulmipay_requests SET posting_error=$3 WHERE org_id=$1 AND id=$2", [
          r.org_id,
          r.id,
          "Provider facts changed after receipt posting. Review the provider return or fee adjustment before settlement",
        ]);
        return requestDto({
          ...current,
          posting_error:
            "Provider facts changed after receipt posting. Review the provider return or fee adjustment before settlement",
        });
      }
      // Terminal success never regresses from a late pending/failure notification.
      if (current.state === "COMPLETE" && v.state !== "COMPLETE") return requestDto(current);
      if (
        (current.provider_confirmed_at !== null || v.confirmedAt === null) &&
        current.provider_invoice_id === v.invoiceId &&
        current.state === v.state &&
        current.fee_minor === v.feeMinor &&
        current.net_minor === v.netMinor &&
        current.clearing_status === v.clearingStatus &&
        current.receipt_reference === v.receiptReference
      )
        return requestDto(current);
      const updated = await t.row<RequestRow>(
        `UPDATE pm_kulmipay_requests SET provider_invoice_id=$3,state=$4,fee_minor=$5,net_minor=$6,clearing_status=$7,receipt_reference=$8,provider_confirmed_at=COALESCE(provider_confirmed_at,$9::timestamptz),checked_at=now() WHERE org_id=$1 AND id=$2 RETURNING *`,
        [
          r.org_id,
          r.id,
          v.invoiceId,
          v.state,
          v.feeMinor,
          v.netMinor,
          v.clearingStatus,
          v.receiptReference,
          v.confirmedAt,
        ],
      );
      await recordAudit(t, {
        actor: { userId: null, role: "system:kulmipay" },
        orgId: r.org_id,
        action: "KulmiPay collection status verified",
        target: r.id,
        detail: `${v.state}; verified provider facts; bank settlement remains separate`,
      });
      if (!updated) throw fail.conflict("Collection status could not be saved");
      return requestDto(updated);
    });
  }
  async function refreshRow(c: Connection, r: RequestRow, invoiceId: string) {
    if (c.environment !== r.environment || c.wallet_id !== r.wallet_id)
      throw fail.conflict("The collection's original merchant connection is required");
    const v = await client.status(credentials(c), {
      invoiceId,
      reference: r.id,
      amountMinor: r.amount_minor,
      provider: r.provider,
    });
    await saveResult(r, v);
    await postConfirmed(r.org_id, r.id);
    const updated = await db.row<RequestRow>("SELECT * FROM pm_kulmipay_requests WHERE org_id=$1 AND id=$2", [
      r.org_id,
      r.id,
    ]);
    if (!updated) throw fail.notFound("Collection request not found");
    return requestDto(updated);
  }
  return {
    async status(s: OrgScope) {
      const c = await db.row<Connection>("SELECT * FROM pm_kulmipay_connections WHERE org_id=$1", [s.orgId]);
      return {
        enabled: !!ctx.config.kulmiPay?.enabled,
        sandboxCollectionEnabled:
          !!ctx.config.kulmiPay?.enabled && (ctx.config.env !== "production" || !!s.entitlement.org.demo),
        connection: c ? connectionDto(c) : null,
        liveCollectionEnabled: !!(ctx.config.kulmiPay?.enabled && ctx.config.kulmiPay.liveApproved),
        automaticPostingEnabled: true as const,
      };
    },
    async connect(
      s: OrgScope,
      b: { environment: "sandbox" | "live"; walletId: string; secretKey: string; challenge: string },
    ) {
      configured();
      await client.verifyWallet({ environment: b.environment, walletId: b.walletId, secretKey: b.secretKey });
      return financeTransaction(db, s.orgId, async (t) => {
        const old = await t.row<Connection>("SELECT * FROM pm_kulmipay_connections WHERE org_id=$1 FOR UPDATE", [
          s.orgId,
        ]);
        if (
          old &&
          (old.environment !== b.environment || old.wallet_id !== b.walletId) &&
          (await t.row(
            "SELECT id FROM pm_kulmipay_requests WHERE org_id=$1 AND state NOT IN ('FAILED','CANCELED') LIMIT 1",
            [s.orgId],
          ))
        )
          throw fail.conflict("Existing collection requests must be reviewed before replacing credentials");
        const hash = createHash("sha256").update(b.secretKey).digest("hex");
        if (
          await t.row(
            "SELECT org_id FROM pm_kulmipay_connections WHERE org_id<>$1 AND (credential_hash=$2 OR (environment=$3 AND wallet_id=$4))",
            [s.orgId, hash, b.environment, b.walletId],
          )
        )
          throw fail.conflict("These merchant credentials are already assigned to another workspace");
        const c = await t.row<Connection>(
          `INSERT INTO pm_kulmipay_connections(org_id,environment,wallet_id,secret_sealed,challenge_sealed,credential_hash,connected_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(org_id) DO UPDATE SET environment=excluded.environment,wallet_id=excluded.wallet_id,secret_sealed=excluded.secret_sealed,challenge_sealed=excluded.challenge_sealed,credential_hash=excluded.credential_hash,connected_by=excluded.connected_by,connected_at=now(),active=true RETURNING *`,
          [s.orgId, b.environment, b.walletId, secrets.seal(b.secretKey), secrets.seal(b.challenge), hash, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Client-owned KulmiPay connection saved",
          target: s.orgId,
          detail: `${b.environment}; KES wallet verified; credentials encrypted`,
        });
        if (!c) throw fail.conflict("Merchant connection could not be saved");
        return { connection: connectionDto(c) };
      });
    },
    async pause(s: OrgScope, reason: string) {
      await db.tx(async (t) => {
        await t.run("UPDATE pm_kulmipay_connections SET active=false WHERE org_id=$1", [s.orgId]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "KulmiPay collection paused",
          target: s.orgId,
          detail: reason,
        });
      });
      return { paused: true as const };
    },
    async list(s: OrgScope, q: { propertyId?: string; limit: number }) {
      if (q.propertyId) scoped(s, q.propertyId);
      const rows = await db.rows<RequestRow>(
        "SELECT * FROM pm_kulmipay_requests WHERE org_id=$1 AND ($2::text IS NULL OR property_id=$2) AND ($3::text[] IS NULL OR property_id=ANY($3)) ORDER BY created_at DESC,id DESC LIMIT $4",
        [s.orgId, q.propertyId ?? null, s.propertyIds ?? null, q.limit],
      );
      return { requests: rows.map(requestDto) };
    },
    async request(
      s: OrgScope,
      b: { invoiceId: string; expectedAmountMinor: number; provider: "M-PESA" | "PESALINK"; phone?: string },
    ) {
      configured();
      if (b.provider === "PESALINK")
        throw fail.conflict(
          "PesaLink bank checkout instructions require provider acceptance first. Use M-Pesa or the existing manual bank-payment workflow",
        );
      const c = await connection(s.orgId);
      if (!c.active) throw fail.conflict("KulmiPay collection is paused");
      if (c.environment === "live" && !ctx.config.kulmiPay?.liveApproved)
        throw fail.conflict(
          "Live KulmiPay collection is disabled pending actual merchant acceptance and approved settlement configuration. No live payment request was sent",
        );
      if (ctx.config.env === "production" && c.environment === "sandbox" && !s.entitlement.org.demo)
        throw fail.conflict(
          "Use a dedicated acceptance workspace for sandbox collections; real production tenant records are protected",
        );
      if (s.entitlement.org.currency !== "KES")
        throw fail.invalid("This connector supports KES invoices only; no automatic currency conversion");
      const r = await financeTransaction(db, s.orgId, async (t) => {
        const currentConnection = await t.row<Connection>(
          "SELECT * FROM pm_kulmipay_connections WHERE org_id=$1 FOR UPDATE",
          [s.orgId],
        );
        if (!currentConnection?.active || currentConnection.secret_sealed !== c.secret_sealed)
          throw fail.conflict("The merchant connection changed. Reload before requesting payment");
        const inv = await t.row<{ id: string; property_id: string; amount_minor: number; balance: number }>(
          `SELECT i.*,i.amount_minor-COALESCE((SELECT sum(a.amount_minor) FROM pm_effective_allocations a WHERE a.org_id=i.org_id AND a.invoice_id=i.id),0) AS balance FROM pm_invoices i WHERE i.org_id=$1 AND i.id=$2 FOR UPDATE`,
          [s.orgId, b.invoiceId],
        );
        if (!inv) throw fail.notFound("Invoice not found");
        scoped(s, inv.property_id);
        if (inv.balance <= 0) throw fail.conflict("This invoice has no unpaid balance");
        if (inv.balance !== b.expectedAmountMinor)
          throw fail.conflict("The unpaid balance changed. Review the invoice before requesting payment");
        if (b.provider === "M-PESA" && (!/^254[17]\d{8}$/.test(b.phone ?? "") || inv.balance % 100 !== 0))
          throw fail.invalid(
            "M-Pesa requires a Kenyan phone number and a whole-shilling balance; PALTAS will not round the tenant's charge up",
          );
        const existing = await t.row<RequestRow>(
          "SELECT * FROM pm_kulmipay_requests WHERE org_id=$1 AND invoice_id=$2 AND state NOT IN ('FAILED','CANCELED')",
          [s.orgId, inv.id],
        );
        if (existing)
          throw fail.conflict("A collection request already exists. Refresh or review it; do not charge again");
        const id = newId("kpr");
        const row = await t.row<RequestRow>(
          `INSERT INTO pm_kulmipay_requests(id,org_id,invoice_id,property_id,provider,environment,wallet_id,amount_minor,state,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'initiating',$9) RETURNING *`,
          [id, s.orgId, inv.id, inv.property_id, b.provider, c.environment, c.wallet_id, inv.balance, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "KulmiPay collection requested",
          target: id,
          detail: `${b.provider}; ${inv.balance} KES minor units; no ledger posting`,
        });
        if (!row) throw fail.conflict("Collection request could not be saved");
        return row;
      });
      try {
        return await saveResult(
          r,
          await client.initiate(credentials(c), {
            provider: r.provider,
            amountMinor: r.amount_minor,
            reference: r.id,
            ...(b.phone ? { phone: b.phone } : {}),
          }),
        );
      } catch (e) {
        await db.run(
          "UPDATE pm_kulmipay_requests SET state='uncertain' WHERE org_id=$1 AND id=$2 AND state='initiating'",
          [s.orgId, r.id],
        );
        if (e instanceof KulmiPayError) throw fail.conflict(e.message);
        throw fail.conflict("Collection outcome is uncertain. Refresh or review before retrying");
      }
    },
    async refresh(s: OrgScope, id: string, providerInvoiceId?: string) {
      const r = await get(s, id);
      const invoiceId = r.provider_invoice_id ?? providerInvoiceId;
      if (!invoiceId)
        throw fail.conflict(
          "Provider outcome is uncertain. Await a verified callback or investigate in KulmiPay before charging again",
        );
      return refreshRow(await connection(s.orgId), r, invoiceId);
    },
    async webhook(orgId: string, b: { challenge: string; api_ref: string; invoice_id: string }) {
      const c = await connection(orgId);
      if (!verifyKulmiChallenge(secrets.open(c.challenge_sealed), b.challenge))
        throw fail.notSignedIn("Invalid payment notification");
      const r = await db.row<RequestRow>("SELECT * FROM pm_kulmipay_requests WHERE org_id=$1 AND id=$2", [
        orgId,
        b.api_ref,
      ]);
      if (!r) throw fail.notFound("Collection request not found");
      // The body is a notification only. Retrieve actual facts using THIS client's server credential.
      await refreshRow(c, r, b.invoice_id);
      return { received: true as const };
    },
  };
}
