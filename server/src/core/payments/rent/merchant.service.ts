import type Stripe from "stripe";
import { rentCollection as api } from "@paltas/contracts";
import type { z } from "@paltas/contracts";
import type { AppContext } from "../../../context.js";
import type { OrgScope } from "../../access/org-access.js";
import { recordAudit } from "../../audit/audit.service.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { PALTAS_STRIPE_ACCOUNT, RENT_APPLICATION, verifiedRentStripe } from "./stripe-isolation.js";

type Input = z.infer<typeof api.onboardMerchant.body>;
interface MerchantRow {
  org_id: string;
  id: string;
  account_id: string | null;
  platform_account_id: string;
  country: Input["country"];
  model: Input["model"];
  mode: "test" | "live";
  status: "pending" | "onboarding" | "restricted" | "verified";
  charges_enabled: boolean;
  payouts_enabled: boolean;
  requirements: string[];
  created_at: string;
  checked_at: string | null;
}
const defaultRent = { enabled: false, webhookSecret: "", liveApproved: false };
const note =
  "Stripe verifies your company and payout details. Rent collection, payment methods and owner distributions require separate activation and verification; returning from Stripe does not confirm approval.";
export function rentMerchantService(ctx: AppContext, supplied?: Stripe) {
  const { db } = ctx;
  const enabled = () => !!ctx.config.stripeRent?.onboardingEnabled;
  const client = () =>
    verifiedRentStripe(
      ctx.config.stripe,
      ctx.config.stripeRent ?? defaultRent,
      ctx.config.signup.appBaseUrl,
      supplied,
      "onboarding",
    );
  const row = (orgId: string) => db.row<MerchantRow>("SELECT * FROM rent_stripe_merchants WHERE org_id=$1", [orgId]);
  const dto = (r: MerchantRow) => ({
    country: r.country,
    model: r.model,
    status: r.status,
    chargesEnabled: r.charges_enabled,
    payoutsEnabled: r.payouts_enabled,
    testMode: r.mode === "test",
    requirements: r.requirements,
    checkedAt: r.checked_at,
  });
  const metadata = (r: MerchantRow) => ({
    paltasApplication: RENT_APPLICATION,
    paltasAccountId: PALTAS_STRIPE_ACCOUNT,
    paltasOrgId: r.org_id,
    paltasMerchantId: r.id,
    paltasMode: r.mode,
  });
  async function verifyMerchant(stripe: Stripe, r: MerchantRow) {
    if (!r.account_id || r.account_id === PALTAS_STRIPE_ACCOUNT)
      throw fail.conflict("Company Stripe account verification is incomplete");
    let a: Stripe.Account;
    try {
      a = await stripe.accounts.retrieve(r.account_id);
    } catch {
      throw fail.conflict(
        "Company Stripe account is unavailable. Retry verification or contact PALTAS; no payment was initiated.",
      );
    }
    const m = metadata(r);
    if (a.country !== r.country || Object.entries(m).some(([k, v]) => a.metadata?.[k] !== v))
      throw fail.conflict("Company Stripe account identity does not match this workspace");
    return a;
  }
  async function update(s: OrgScope, r: MerchantRow, a: Stripe.Account) {
    const requirements = [...new Set([...(a.requirements?.currently_due ?? []), ...(a.requirements?.past_due ?? [])])];
    const status = a.requirements?.disabled_reason
      ? "restricted"
      : a.charges_enabled && a.payouts_enabled && a.details_submitted && requirements.length === 0
        ? "verified"
        : "onboarding";
    await db.tx(async (t) => {
      await t.run(
        "UPDATE rent_stripe_merchants SET status=$2,charges_enabled=$3,payouts_enabled=$4,requirements=$5,checked_at=now() WHERE org_id=$1 AND account_id=$6",
        [s.orgId, status, a.charges_enabled, a.payouts_enabled, JSON.stringify(requirements), r.account_id],
      );
      if (status !== r.status || a.charges_enabled !== r.charges_enabled || a.payouts_enabled !== r.payouts_enabled)
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Stripe merchant capabilities checked",
          target: r.id,
          detail: status,
        });
    });
  }
  return {
    async status(s: OrgScope) {
      const r = await row(s.orgId);
      return {
        enabled: enabled(),
        merchant: r ? dto(r) : null,
        countries: [...api.RentMerchantCountry.options],
        collectionOperational: false as const,
        note,
      };
    },
    async refresh(s: OrgScope) {
      const r = await row(s.orgId);
      if (!r?.account_id) return this.status(s);
      const { stripe, mode } = await client();
      if (mode !== r.mode) throw fail.conflict("This merchant belongs to a different Stripe environment");
      await update(s, r, await verifyMerchant(stripe, r));
      return this.status(s);
    },
    async onboard(s: OrgScope, b: Input) {
      if (!s.userId) throw fail.forbidden("An authorised company owner must start onboarding");
      const { stripe, mode } = await client();
      const r = await db.tx(async (t) => {
        await t.run("SELECT pg_advisory_xact_lock(hashtextextended('rent-merchant:'||$1,0))", [s.orgId]);
        let m = await t.row<MerchantRow>("SELECT * FROM rent_stripe_merchants WHERE org_id=$1 FOR UPDATE", [s.orgId]);
        if (
          m &&
          (m.country !== b.country ||
            m.model !== b.model ||
            m.mode !== mode ||
            m.platform_account_id !== PALTAS_STRIPE_ACCOUNT)
        )
          throw fail.conflict(
            "The existing company collection setup uses a different country, model or environment. Contact PALTAS for a reviewed change; no second account was created.",
          );
        if (!m) {
          m = await t.row<MerchantRow>(
            "INSERT INTO rent_stripe_merchants(org_id,id,platform_account_id,country,model,mode,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [s.orgId, newId("rma"), PALTAS_STRIPE_ACCOUNT, b.country, b.model, mode, s.userId],
          );
          if (!m) throw new Error("Merchant setup not saved");
          await recordAudit(t, {
            actor: s.actor,
            orgId: s.orgId,
            action: "Company Stripe onboarding requested",
            target: m.id,
            detail: b.country + " · " + b.model,
          });
        }
        return m;
      });
      if (!r.account_id) {
        // Provider idempotency retention is finite. Do not risk recreating an account after an uncertain old request.
        if (ctx.clock.now().getTime() - new Date(r.created_at).getTime() > 23 * 60 * 60 * 1000)
          throw fail.conflict(
            "This pending setup needs account reconciliation before retrying. Contact PALTAS; no duplicate account was created.",
          );
        let a: Stripe.Account;
        try {
          a = await stripe.accounts.create(
            {
              country: r.country,
              business_type: "company",
              controller: {
                fees: { payer: "account" },
                losses: { payments: "stripe" },
                stripe_dashboard: { type: "full" },
              },
              metadata: metadata(r),
            },
            { idempotencyKey: "paltas-rent-merchant-" + r.id },
          );
        } catch {
          throw fail.conflict(
            "Stripe could not start company onboarding. Check that this legal company country and Connect configuration are eligible, then retry or contact PALTAS. No payment was initiated.",
          );
        }
        if (a.id === PALTAS_STRIPE_ACCOUNT || !/^acct_[A-Za-z0-9]+$/.test(a.id) || a.country !== r.country)
          throw fail.conflict("Stripe did not return the expected company account");
        await db.run(
          "UPDATE rent_stripe_merchants SET account_id=COALESCE(account_id,$2),status='onboarding' WHERE org_id=$1 AND (account_id IS NULL OR account_id=$2)",
          [s.orgId, a.id],
        );
        r.account_id = a.id;
      }
      const a = await verifyMerchant(stripe, r);
      await update(s, r, a);
      const back = ctx.config.signup.appBaseUrl + "/account.html?org=" + encodeURIComponent(s.orgId);
      let link: Stripe.AccountLink;
      try {
        link = await stripe.accountLinks.create({
          account: r.account_id,
          type: "account_onboarding",
          refresh_url: back + "&connect=refresh#collections",
          return_url: back + "&connect=return#collections",
        });
      } catch {
        throw fail.conflict(
          "Company setup was retained, but Stripe could not open onboarding. Retry from this workspace; do not register another account.",
        );
      }
      const url = new URL(link.url);
      if (url.protocol !== "https:" || url.hostname !== "connect.stripe.com" || url.username || url.password)
        throw fail.conflict("Stripe returned an unexpected onboarding destination");
      return { url: link.url, testMode: mode === "test" };
    },
  };
}
