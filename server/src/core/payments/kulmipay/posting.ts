/** Confirmed client-owned collections reuse PM allocation, receipts and owner/deposit accounting. */
import { createHash } from "node:crypto";
import { resolveEntitlement } from "../../subscriptions/entitlement.service.js";
import { ensureAccounts } from "../../ledger/default-chart.js";
import { recordAudit } from "../../audit/audit.service.js";
import { ApiError, fail, fromDatabaseError } from "../../../http/errors.js";
import { ACC, PM_ACCOUNTS } from "../../../products/property/accounts.js";
import { paymentsService } from "../../../products/property/payments/payments.service.js";
import { financeTransaction } from "../../../products/property/shared/finance-transaction.js";
import type { PmDeps } from "../../../products/property/deps.js";

export function kulmiPosting(d: PmDeps) {
  const { ctx } = d,
    { db } = ctx;
  return async (orgId: string, requestId: string) => {
    try {
      const en = await resolveEntitlement(db, ctx.products, ctx.clock.today(), orgId, "property");
      if (!en || en.org.currency !== "KES")
        throw fail.conflict("The original KES organisation must be available before posting this receipt");
      await financeTransaction(db, orgId, async (t) => {
        const r = await t.row<{
          id: string;
          environment: string;
          state: string;
          amount_minor: number;
          fee_minor: number | null;
          net_minor: number | null;
          provider_invoice_id: string | null;
          invoice_id: string;
          ledger_payment_id: string | null;
          requested_by: string;
          provider: string;
          receipt_reference: string | null;
          provider_confirmed_at: string | null;
        }>("SELECT * FROM pm_kulmipay_requests WHERE org_id=$1 AND id=$2 FOR UPDATE", [orgId, requestId]);
        if (!r || r.state !== "COMPLETE" || r.ledger_payment_id) return;
        if (ctx.config.env === "production" && r.environment === "sandbox" && !en.org.demo)
          throw fail.conflict("Sandbox confirmations cannot create financial records in a real production workspace");
        if (
          r.fee_minor === null ||
          r.net_minor === null ||
          r.fee_minor + r.net_minor !== r.amount_minor ||
          !r.provider_invoice_id
        )
          throw fail.conflict("KulmiPay must report an exact fee and net breakdown before posting");
        if (!r.provider_confirmed_at)
          throw fail.conflict("KulmiPay must report the confirmed transaction timestamp before posting");
        const date = String(r.provider_confirmed_at).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > ctx.clock.today())
          throw fail.conflict("The provider confirmation date needs finance review");
        const inv = await t.row<{ tenant_id: string; balance: number }>(
          `SELECT i.tenant_id,greatest(0,i.amount_minor-COALESCE((SELECT sum(a.amount_minor) FROM pm_effective_allocations a WHERE a.org_id=i.org_id AND a.invoice_id=i.id),0)) AS balance FROM pm_invoices i WHERE i.org_id=$1 AND i.id=$2 FOR UPDATE`,
          [orgId, r.invoice_id],
        );
        if (!inv) throw fail.notFound("The original invoice was not found");
        const seeds = PM_ACCOUNTS.filter((a) => a.code === ACC.providerClearing || a.code === ACC.providerFees);
        await ensureAccounts(t, orgId, seeds);
        for (const a of seeds) {
          const account = await t.row<{ type: string; system: boolean }>(
            "SELECT type,system FROM ledger_accounts WHERE org_id=$1 AND code=$2",
            [orgId, a.code],
          );
          if (!account?.system || account.type !== a.type)
            throw fail.conflict("The provider clearing accounts require accountant review");
        }
        const aliases = [r.provider_invoice_id, r.receipt_reference]
          .filter((x): x is string => !!x?.trim())
          .map((x) => x.trim().toUpperCase());
        const manual = await t.row<{ receipt_number: string }>(
          "SELECT receipt_number FROM pm_effective_payments WHERE org_id=$1 AND upper(btrim(reference))=ANY($2)",
          [orgId, aliases],
        );
        if (manual)
          throw fail.conflict(
            `This transaction may already be recorded as ${manual.receipt_number}. Review and correct that receipt before retrying provider posting`,
          );
        const allocate = Math.min(inv.balance, r.amount_minor);
        const reference =
          "KULMI-" +
          createHash("sha256")
            .update(r.environment + ":" + r.provider_invoice_id)
            .digest("hex")
            .slice(0, 40);
        const paymentId = await paymentsService(d).recordIn(
          t,
          {
            orgId,
            userId: r.requested_by,
            today: ctx.clock.today(),
            actor: { userId: null, role: "system:kulmipay" },
            entitlement: en,
          },
          {
            tenantId: inv.tenant_id,
            date,
            amountMinor: r.amount_minor,
            method: r.provider === "M-PESA" ? "mobile_money" : "bank_transfer",
            reference,
            note: `Verified client-owned KulmiPay collection ${r.provider_invoice_id}. Net funds remain with KulmiPay until a bank settlement is approved. Processing fees are borne by the company.`,
            allocations: allocate > 0 ? [{ invoiceId: r.invoice_id, amountMinor: allocate }] : [],
          },
          { provider: "kulmipay", feeMinor: r.fee_minor },
        );
        await t.run(
          "UPDATE pm_kulmipay_requests SET ledger_payment_id=$3,posted_at=now(),posting_error=NULL WHERE org_id=$1 AND id=$2",
          [orgId, r.id, paymentId],
        );
        await recordAudit(t, {
          actor: { userId: null, role: "system:kulmipay" },
          orgId,
          action: "Verified KulmiPay receipt posted",
          target: r.id,
          detail: `${r.amount_minor} gross; ${r.fee_minor} company processing fee; ${r.net_minor} provider clearing; no bank settlement`,
        });
      });
    } catch (e) {
      const safe = e instanceof ApiError ? e : fromDatabaseError(e);
      await db.run(
        "UPDATE pm_kulmipay_requests SET posting_error=$3 WHERE org_id=$1 AND id=$2 AND ledger_payment_id IS NULL",
        [
          orgId,
          requestId,
          safe?.message.slice(0, 500) ??
            "Receipt posting failed. Finance can review and retry; no partial receipt or journal was committed",
        ],
      );
    }
  };
}
