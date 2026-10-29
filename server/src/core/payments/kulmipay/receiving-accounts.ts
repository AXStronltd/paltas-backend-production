/** Bank/M-Pesa registration only. Never activates a provider or transfers funds. */
import type { kulmiPay as api, z } from "@paltas/contracts";
import type { OrgScope } from "../../access/org-access.js";
import { recordAudit } from "../../audit/audit.service.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { Db } from "../../../db/database.js";
import type { PmDeps } from "../../../products/property/deps.js";
import { financeTransaction } from "../../../products/property/shared/finance-transaction.js";
type Input = z.infer<typeof api.saveReceivingAccount.body>;
interface Row {
  id: string;
  org_id: string;
  revision: number;
  kind: Input["kind"];
  details_sealed: string;
  status: "verification_pending" | "paused";
  saved_at: string;
}
interface Details {
  accountHolder: string;
  accountNumber: string;
  bankCode?: string;
  accountReference?: string;
}
export function receivingAccounts(d: PmDeps) {
  const { ctx } = d;
  const latest = (db: Db, org: string) =>
    db.row<Row>("SELECT * FROM pm_receiving_account_versions WHERE org_id=$1 ORDER BY revision DESC LIMIT 1", [org]);
  const dto = (r: Row) => {
    const x = JSON.parse(ctx.secrets.open(r.details_sealed)) as Details;
    return {
      revision: r.revision,
      kind: r.kind,
      accountHolder: x.accountHolder,
      accountMasked: "••••" + x.accountNumber.slice(-4),
      bankCode: x.bankCode ?? null,
      accountReferenceMasked: x.accountReference ? "••••" + x.accountReference.slice(-2) : null,
      status: r.status,
      savedAt: r.saved_at,
    };
  };
  const result = (r: Row) => ({ account: dto(r), automaticSettlementEnabled: false as const });
  const checkRevision = (r: Row | null, n: number) => {
    if ((r?.revision ?? 0) !== n)
      throw fail.conflict("Receiving details changed. Reopen the account before saving; no details were overwritten");
  };
  return {
    async get(s: OrgScope) {
      const r = await latest(ctx.db, s.orgId);
      return { account: r ? dto(r) : null, automaticSettlementEnabled: false as const };
    },
    async save(s: OrgScope, b: Input) {
      return financeTransaction(ctx.db, s.orgId, async (t) => {
        const org = await t.row<{ country: string; currency: string }>(
          "SELECT country,currency FROM organisations WHERE id=$1",
          [s.orgId],
        );
        if (!org || org.currency !== "KES" || !/^KE(?:NYA)?$/i.test(org.country.trim()))
          throw fail.conflict("This receiving-account registration currently supports Kenyan KES destinations only");
        const old = await latest(t, s.orgId);
        checkRevision(old, b.expectedRevision);
        const prior = old ? (JSON.parse(ctx.secrets.open(old.details_sealed)) as Details) : null;
        if (!b.accountNumber && (!old || old.kind !== b.kind || b.bankCode !== (prior?.bankCode ?? undefined)))
          throw fail.conflict("Enter the full account number when adding an account or changing its type or bank");
        const account = b.accountNumber ?? prior?.accountNumber;
        if (!account) throw fail.conflict("Enter the account number before saving");
        if (
          b.kind === "bank"
            ? !/^\d{5,24}$/.test(account) || !b.bankCode
            : b.kind === "mpesa_mobile"
              ? !/^254[17]\d{8}$/.test(account)
              : !/^\d{5,10}$/.test(account)
        )
          throw fail.conflict(
            "Enter a valid bank account and bank code, Kenyan M-Pesa phone, PayBill or Till number for the selected account type",
          );
        if (b.kind !== "bank" && b.bankCode) throw fail.conflict("Bank code applies only to a bank receiving account");
        if (b.kind === "mpesa_paybill" && !b.accountReference)
          throw fail.conflict("Enter the PayBill account reference");
        if (b.kind !== "mpesa_paybill" && b.accountReference)
          throw fail.conflict("Account reference applies only to a PayBill");
        const id = newId("receive"),
          revision = (old?.revision ?? 0) + 1;
        const details: Details = {
          accountHolder: b.accountHolder,
          accountNumber: account,
          ...(b.bankCode ? { bankCode: b.bankCode } : {}),
          ...(b.accountReference ? { accountReference: b.accountReference } : {}),
        };
        await t.run(
          "INSERT INTO pm_receiving_account_versions(id,org_id,revision,kind,details_sealed,status,reason,saved_by) VALUES($1,$2,$3,$4,$5,'verification_pending',$6,$7)",
          [id, s.orgId, revision, b.kind, ctx.secrets.seal(JSON.stringify(details)), b.reason, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Receiving details submitted for verification",
          target: id,
          detail: `Revision ${revision}; ${b.kind}; automatic collection and payouts remain disabled`,
        });
        const saved = await latest(t, s.orgId);
        if (!saved) throw fail.conflict("The receiving details could not be read after saving");
        return result(saved);
      });
    },
    async pause(s: OrgScope, b: z.infer<typeof api.pauseReceivingAccount.body>) {
      return financeTransaction(ctx.db, s.orgId, async (t) => {
        const old = await latest(t, s.orgId);
        checkRevision(old, b.expectedRevision);
        if (!old) throw fail.notFound("Receiving account not found");
        if (old.status === "paused") return result(old);
        const id = newId("receive"),
          revision = old.revision + 1;
        await t.run(
          "INSERT INTO pm_receiving_account_versions(id,org_id,revision,kind,details_sealed,status,reason,saved_by) VALUES($1,$2,$3,$4,$5,'paused',$6,$7)",
          [id, s.orgId, revision, old.kind, old.details_sealed, b.reason, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Receiving destination paused",
          target: id,
          detail: `Revision ${revision}; previous details and financial history retained`,
        });
        const saved = await latest(t, s.orgId);
        if (!saved) throw fail.conflict("The receiving details could not be read after saving");
        return result(saved);
      });
    },
  };
}
