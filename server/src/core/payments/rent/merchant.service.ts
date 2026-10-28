import Stripe from "stripe";
import type { Db } from "../../../db/database.js";
import type { Actor } from "../../audit/audit.service.js";
import { SYSTEM } from "../../audit/audit.service.js";
import { rentCollection as api } from "@paltas/contracts";
import type { z } from "@paltas/contracts";
import type { AppContext } from "../../../context.js";
import type { OrgScope } from "../../access/org-access.js";
import { recordAudit } from "../../audit/audit.service.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { RENT_APPLICATION, verifiedRentStripe } from "./stripe-isolation.js";

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
  deauthorized_at: string | null;
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
    paltasAccountId: r.platform_account_id,
    paltasOrgId: r.org_id,
    paltasMerchantId: r.id,
    paltasMode: r.mode,
  });
  async function verifyMerchant(stripe: Stripe, r: MerchantRow) {
    if (!r.account_id || r.account_id === r.platform_account_id)
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
  async function update(t: Db, actor: Actor, r: MerchantRow, a: Stripe.Account) {
    if (r.deauthorized_at)
      throw fail.conflict(
        "Company Stripe access was disconnected. A reviewed reconnection is required; no payment was initiated.",
      );
    const requirements = [...new Set([...(a.requirements?.currently_due ?? []), ...(a.requirements?.past_due ?? [])])];
    const status = a.requirements?.disabled_reason
      ? "restricted"
      : a.charges_enabled && a.payouts_enabled && a.details_submitted && requirements.length === 0
        ? "verified"
        : "onboarding";
    await t.run(
      "UPDATE rent_stripe_merchants SET status=$2,charges_enabled=$3,payouts_enabled=$4,requirements=$5,checked_at=now() WHERE org_id=$1 AND account_id=$6",
      [r.org_id, status, a.charges_enabled, a.payouts_enabled, JSON.stringify(requirements), r.account_id],
    );
    if (status !== r.status || a.charges_enabled !== r.charges_enabled || a.payouts_enabled !== r.payouts_enabled)
      await recordAudit(t, {
        actor,
        orgId: r.org_id,
        action: "Stripe merchant capabilities checked",
        target: r.id,
        detail: status,
      });
  }
  async function refreshLocked(s: OrgScope, stripe: Stripe) {
    await db.tx(async (t) => {
      const r = await t.row<MerchantRow>("SELECT * FROM rent_stripe_merchants WHERE org_id=$1 FOR UPDATE", [s.orgId]);
      if (!r?.account_id) return;
      if (r.deauthorized_at)
        throw fail.conflict(
          "Company Stripe access was disconnected. A reviewed reconnection is required; no payment was initiated.",
        );
      await update(t, s.actor, r, await verifyMerchant(stripe, r));
    });
  }
  return {
    async webhook(raw: Buffer, signature: string | undefined) {
      const secret = ctx.config.stripeRent?.webhookSecret ?? "";
      if (!secret.startsWith("whsec_") || secret === ctx.config.stripe?.webhookSecret)
        throw fail.conflict("A separate Connect webhook signing secret is required");
      if (!signature) throw fail.invalid("Stripe signature is required");
      let event: Stripe.Event;
      try {
        event = new Stripe("sk_test_signature_verification").webhooks.constructEvent(raw, signature, secret, 300);
      } catch {
        throw fail.invalid("Stripe signature could not be verified");
      }
      const { stripe, mode, platformAccountId } = await verifiedRentStripe(
        ctx.config.stripe,
        ctx.config.stripeRent ?? defaultRent,
        ctx.config.signup.appBaseUrl,
        supplied,
        ctx.config.stripeRent?.onboardingEnabled ? "onboarding" : "collection",
      );
      if (event.livemode !== (mode === "live")) throw fail.invalid("Stripe event environment does not match");
      if (!event.account || !["account.updated", "account.application.deauthorized"].includes(event.type))
        return { received: true as const, duplicate: false, ignored: true };
      if (event.type === "account.updated" && event.data.object.id !== event.account)
        throw fail.invalid("Stripe account event identity does not match");
      return db.tx(async (t) => {
        const r = await t.row<MerchantRow>(
          "SELECT * FROM rent_stripe_merchants WHERE account_id=$1 AND platform_account_id=$2 AND mode=$3 FOR UPDATE",
          [event.account, platformAccountId, mode],
        );
        if (!r) return { received: true as const, duplicate: false, ignored: true };
        const previous = await t.row<{ account_id: string; event_type: string }>(
          "SELECT account_id,event_type FROM rent_stripe_merchant_events WHERE platform_account_id=$1 AND mode=$2 AND event_id=$3",
          [platformAccountId, mode, event.id],
        );
        if (previous) {
          if (previous.account_id !== event.account || previous.event_type !== event.type)
            throw fail.invalid("Stripe event identity was reused");
          return { received: true as const, duplicate: true, ignored: false };
        }
        if (event.type === "account.application.deauthorized") {
          await t.run(
            "UPDATE rent_stripe_merchants SET status='restricted',charges_enabled=false,payouts_enabled=false,requirements=$2,deauthorized_at=COALESCE(deauthorized_at,now()),checked_at=now() WHERE org_id=$1",
            [r.org_id, JSON.stringify(["Company Stripe access disconnected; reviewed reconnection required"])],
          );
          if (!r.deauthorized_at)
            await recordAudit(t, {
              actor: SYSTEM,
              orgId: r.org_id,
              action: "Company Stripe access disconnected",
              target: r.id,
              detail: "Verified Connect notification; collection and payout capabilities disabled",
            });
        } else if (!r.deauthorized_at) {
          // Read current provider state rather than trusting an old or out-of-order event snapshot.
          await update(t, SYSTEM, r, await verifyMerchant(stripe, r));
        }
        await t.run(
          "INSERT INTO rent_stripe_merchant_events(platform_account_id,mode,event_id,account_id,event_type,org_id) VALUES($1,$2,$3,$4,$5,$6)",
          [platformAccountId, mode, event.id, event.account, event.type, r.org_id],
        );
        return { received: true as const, duplicate: false, ignored: false };
      });
    },
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
      const { stripe, mode, platformAccountId } = await client();
      if (mode !== r.mode || platformAccountId !== r.platform_account_id)
        throw fail.conflict("This merchant belongs to a different Stripe environment");
      await refreshLocked(s, stripe);
      return this.status(s);
    },
    async onboard(s: OrgScope, b: Input) {
      if (!s.userId) throw fail.forbidden("An authorised company owner must start onboarding");
      const { stripe, mode, platformAccountId } = await client();
      const r = await db.tx(async (t) => {
        await t.run("SELECT pg_advisory_xact_lock(hashtextextended('rent-merchant:'||$1,0))", [s.orgId]);
        let m = await t.row<MerchantRow>("SELECT * FROM rent_stripe_merchants WHERE org_id=$1 FOR UPDATE", [s.orgId]);
        if (
          m &&
          (m.country !== b.country ||
            m.model !== b.model ||
            m.mode !== mode ||
            m.platform_account_id !== platformAccountId)
        )
          throw fail.conflict(
            "The existing company collection setup uses a different country, model or environment. Contact PALTAS for a reviewed change; no second account was created.",
          );
        if (m?.deauthorized_at)
          throw fail.conflict(
            "Company Stripe access was disconnected. A reviewed reconnection is required; no second account was created.",
          );
        if (!m) {
          m = await t.row<MerchantRow>(
            "INSERT INTO rent_stripe_merchants(org_id,id,platform_account_id,country,model,mode,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [s.orgId, newId("rma"), platformAccountId, b.country, b.model, mode, s.userId],
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
        if (a.id === platformAccountId || !/^acct_[A-Za-z0-9]+$/.test(a.id) || a.country !== r.country)
          throw fail.conflict("Stripe did not return the expected company account");
        await db.run(
          "UPDATE rent_stripe_merchants SET account_id=COALESCE(account_id,$2),status='onboarding' WHERE org_id=$1 AND (account_id IS NULL OR account_id=$2)",
          [s.orgId, a.id],
        );
        r.account_id = a.id;
      }
      await refreshLocked(s, stripe);
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
