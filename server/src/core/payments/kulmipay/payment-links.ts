/** Expiring invoice capabilities. Tokens never authorize arbitrary charges or expose other records. */
import { randomBytes, createHash } from "node:crypto";
import type { rentPaymentLinks as api, z } from "@paltas/contracts";
import type { OrgScope } from "../../access/org-access.js";
import { memberProductRole } from "../../access/product-role.js";
import { memberCan, managerGrant } from "../../access/manager-access.js";
import { resolveEntitlement } from "../../subscriptions/entitlement.service.js";
import { recordAudit } from "../../audit/audit.service.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../../../products/property/deps.js";
import { invoiceRow, balanceOf } from "../../../products/property/shared/records.js";
import { financeTransaction } from "../../../products/property/shared/finance-transaction.js";
import { kulmiPayService } from "./service.js";
interface Link {
  id: string;
  org_id: string;
  invoice_id: string;
  property_id: string;
  receiving_version_id: string | null;
  created_by: string;
  expires_at: string;
  revoked_at: string | null;
  request_id: string | null;
}
interface Destination {
  id: string;
  revision: number;
  kind: "bank" | "mpesa_mobile" | "mpesa_paybill" | "mpesa_till";
  details_sealed: string;
  status: string;
}
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
export function paymentLinks(d: PmDeps, collections = kulmiPayService(d)) {
  const { ctx } = d,
    { db } = ctx;
  const latest = (org: string) =>
    db.row<Destination>("SELECT * FROM pm_receiving_account_versions WHERE org_id=$1 ORDER BY revision DESC LIMIT 1", [
      org,
    ]);
  const property = (s: OrgScope, p: string) => {
    if (s.propertyIds && !s.propertyIds.includes(p)) throw fail.notFound("Invoice not found");
  };
  async function issuer(l: Link): Promise<OrgScope> {
    const role = await memberProductRole(db, l.org_id, l.created_by, "property"),
      en = await resolveEntitlement(db, ctx.products, ctx.clock.today(), l.org_id, "property");
    const org = await db.row<{ suspended: boolean }>(
      "SELECT suspended_at IS NOT NULL AS suspended FROM organisations WHERE id=$1",
      [l.org_id],
    );
    if (
      !role ||
      !en?.ent.usable ||
      !en.ent.modules.finance ||
      !org ||
      org.suspended ||
      !(await memberCan(db, l.org_id, l.created_by, role, "property", "property.payments.record"))
    )
      throw fail.notFound("This payment link is unavailable. Contact the business for a new request");
    const s: OrgScope = {
      orgId: l.org_id,
      userId: l.created_by,
      role,
      product: "property",
      entitlement: en,
      today: ctx.clock.today(),
      actor: { userId: null, role: "customer:payment-link" },
      ...(role === "main_manager"
        ? { propertyIds: (await managerGrant(db, l.org_id, l.created_by, "property"))?.propertyIds ?? [] }
        : {}),
    };
    property(s, l.property_id);
    return s;
  }
  async function load(token: string) {
    const l = await db.row<Link>("SELECT * FROM pm_invoice_payment_links WHERE token_hash=$1", [hash(token)]);
    if (!l || l.revoked_at || new Date(l.expires_at).getTime() <= ctx.clock.now().getTime())
      throw fail.notFound("This payment link has expired or is unavailable. Ask the business for a new link");
    const s = await issuer(l),
      inv = await invoiceRow(db, l.org_id, l.invoice_id);
    if (!inv.property_id)
      throw fail.conflict("A property must be assigned to the invoice before creating a payment link");
    property(s, inv.property_id);
    return { l, s, inv };
  }
  async function view(token: string): Promise<z.infer<typeof api.preview.response>> {
    const { l, s, inv } = await load(token),
      c = await collections.status(s),
      balance = Math.max(0, balanceOf(inv));
    let instructions: z.infer<typeof api.preview.response>["manualInstructions"] = null;
    if (l.receiving_version_id) {
      const dest = await latest(l.org_id),
        confirmation = await db.row(
          "SELECT receiving_version_id FROM pm_receiving_instruction_confirmations WHERE org_id=$1 AND receiving_version_id=$2",
          [l.org_id, l.receiving_version_id],
        );
      if (!dest || dest.id !== l.receiving_version_id || dest.status === "paused" || !confirmation)
        throw fail.conflict("The business changed its payment instructions. Request a new payment link before paying");
      const x = JSON.parse(ctx.secrets.open(dest.details_sealed)) as {
        accountHolder: string;
        accountNumber: string;
        bankCode?: string;
        accountReference?: string;
      };
      instructions = {
        kind: dest.kind,
        accountHolder: x.accountHolder,
        accountNumber: x.accountNumber,
        bankCode: x.bankCode ?? null,
        accountReference: x.accountReference ?? null,
      };
    }
    const payment = l.request_id
      ? await db.row<{ state: string; posted: boolean }>(
          "SELECT state,ledger_payment_id IS NOT NULL AS posted FROM pm_kulmipay_requests WHERE org_id=$1 AND id=$2",
          [l.org_id, l.request_id],
        )
      : null;
    return {
      business: s.entitlement.org.name,
      invoiceNumber: inv.number,
      currency: s.entitlement.org.currency,
      balanceMinor: balance,
      dueDate: inv.due_date,
      expiresAt: l.expires_at,
      manualInstructions: instructions,
      mpesaAvailable:
        balance > 0 &&
        balance % 100 === 0 &&
        s.entitlement.org.currency === "KES" &&
        !!c.connection?.active &&
        (c.connection.environment === "live" ? c.liveCollectionEnabled : c.sandboxCollectionEnabled),
      paymentState: payment?.state ?? null,
      receiptRecorded: payment?.posted ?? false,
    };
  }
  return {
    async list(s: OrgScope, invoiceId: string) {
      const inv = await invoiceRow(db, s.orgId, invoiceId);
      if (!inv.property_id) throw fail.conflict("Assign a property to this invoice first");
      property(s, inv.property_id);
      return {
        links: await db.rows<{ id: string; createdAt: string; expiresAt: string; revokedAt: string | null }>(
          `SELECT id,created_at AS "createdAt",expires_at AS "expiresAt",revoked_at AS "revokedAt" FROM pm_invoice_payment_links WHERE org_id=$1 AND invoice_id=$2 ORDER BY created_at DESC LIMIT 50`,
          [s.orgId, invoiceId],
        ),
      };
    },
    async confirmInstructions(s: OrgScope, b: z.infer<typeof api.confirmInstructions.body>) {
      return financeTransaction(db, s.orgId, async (t) => {
        const dest = await t.row<Destination>(
          "SELECT * FROM pm_receiving_account_versions WHERE org_id=$1 ORDER BY revision DESC LIMIT 1",
          [s.orgId],
        );
        if (!dest || dest.revision !== b.expectedRevision || dest.status === "paused")
          throw fail.conflict("Reopen the current receiving details before confirming instructions");
        const r = await t.row(
          "INSERT INTO pm_receiving_instruction_confirmations(receiving_version_id,org_id,confirmed_by,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING receiving_version_id",
          [dest.id, s.orgId, s.userId, b.reason],
        );
        if (r)
          await recordAudit(t, {
            actor: s.actor,
            orgId: s.orgId,
            action: "Manual receiving instructions authorised for sharing",
            target: dest.id,
            detail: "Business-supplied instructions only; bank ownership and automatic payouts are not verified",
          });
        return { manualInstructionsEnabled: true as const };
      });
    },
    async create(s: OrgScope, invoiceId: string, b: z.infer<typeof api.create.body>) {
      const inv = await invoiceRow(db, s.orgId, invoiceId);
      if (!inv.property_id)
        throw fail.conflict("A property must be assigned to the invoice before creating a payment link");
      property(s, inv.property_id);
      if (balanceOf(inv) <= 0) throw fail.conflict("This invoice has no unpaid balance");
      let dest: Destination | null = null;
      if (b.includeManualInstructions) {
        dest = await latest(s.orgId);
        if (
          !dest ||
          dest.status === "paused" ||
          !(await db.row(
            "SELECT receiving_version_id FROM pm_receiving_instruction_confirmations WHERE org_id=$1 AND receiving_version_id=$2",
            [s.orgId, dest.id],
          ))
        )
          throw fail.conflict(
            "The company owner must confirm the manual receiving instructions before they can be shared",
          );
      }
      const c = await collections.status(s);
      if (
        !dest &&
        (!c.connection?.active ||
          (c.connection.environment === "live" ? !c.liveCollectionEnabled : !c.sandboxCollectionEnabled) ||
          s.entitlement.org.currency !== "KES" ||
          balanceOf(inv) % 100 !== 0)
      )
        throw fail.conflict(
          "No payment method is ready. Confirm manual receiving instructions or enable a verified collection method first",
        );
      const token = randomBytes(32).toString("base64url"),
        id = newId("paylink"),
        expiresAt = new Date(ctx.clock.now().getTime() + b.expiresDays * 86400000).toISOString();
      await db.tx(async (t) => {
        await t.run(
          "INSERT INTO pm_invoice_payment_links(id,org_id,invoice_id,property_id,token_hash,receiving_version_id,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [id, s.orgId, inv.id, inv.property_id, hash(token), dest?.id ?? null, s.userId, expiresAt],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Invoice payment link created",
          target: id,
          detail: `Invoice ${inv.number}; expires ${expiresAt}; no payment or notification sent`,
        });
      });
      const url = new URL("/pay.html", ctx.config.signup.appBaseUrl);
      url.hash = token;
      return { id, url: url.toString(), expiresAt };
    },
    async revoke(s: OrgScope, id: string, reason: string) {
      const l = await db.row<Link>("SELECT * FROM pm_invoice_payment_links WHERE org_id=$1 AND id=$2", [s.orgId, id]);
      if (!l) throw fail.notFound("Payment link not found");
      property(s, l.property_id);
      await db.tx(async (t) => {
        await t.run(
          "UPDATE pm_invoice_payment_links SET revoked_at=COALESCE(revoked_at,now()) WHERE org_id=$1 AND id=$2",
          [s.orgId, id],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Invoice payment link revoked",
          target: id,
          detail: reason,
        });
      });
      return { revoked: true as const };
    },
    preview: view,
    async collect(b: z.infer<typeof api.collect.body>) {
      const { l, s } = await load(b.token),
        preview = await view(b.token);
      if (!preview.mpesaAvailable)
        throw fail.conflict(
          "Automatic M-Pesa collection is unavailable. Use an enabled manual method or contact the business",
        );
      if (preview.balanceMinor !== b.expectedAmountMinor)
        throw fail.conflict("The invoice balance changed. Refresh before confirming payment");
      const allowed = await db.row(
        "UPDATE pm_invoice_payment_links SET attempts=CASE WHEN attempt_date=$2 THEN attempts+1 ELSE 1 END,attempt_date=$2 WHERE id=$1 AND revoked_at IS NULL AND expires_at>$3 AND (attempt_date IS DISTINCT FROM $2 OR attempts<5) RETURNING id",
        [l.id, ctx.clock.today(), ctx.clock.now().toISOString()],
      );
      if (!allowed)
        throw fail.conflict("Payment request limit reached. Contact the business; no additional prompt was sent");
      try {
        await collections.request(s, {
          invoiceId: l.invoice_id,
          expectedAmountMinor: b.expectedAmountMinor,
          provider: "M-PESA",
          phone: b.phone,
        });
      } finally {
        await db.run(
          "UPDATE pm_invoice_payment_links SET request_id=(SELECT id FROM pm_kulmipay_requests WHERE org_id=$2 AND invoice_id=$3 AND state NOT IN ('FAILED','CANCELED') ORDER BY created_at DESC LIMIT 1) WHERE id=$1",
          [l.id, l.org_id, l.invoice_id],
        );
      }
      return view(b.token);
    },
    async refresh(token: string) {
      const { l, s } = await load(token);
      await view(token);
      if (l.request_id) await collections.refresh(s, l.request_id);
      return view(token);
    },
  };
}
